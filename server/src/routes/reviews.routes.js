import { Router } from 'express';
import { setMaxListeners } from 'node:events';
import { requireAuth } from '../middleware/auth.js';
import { parsePrUrl, runReview } from '../agent/agentLoop.js';
import { reviewEventBus } from '../sockets/eventBus.js';
import { runWithUserContext } from '../utils/userContext.js';
import { runWithAbortContext } from '../utils/abortContext.js';
import {
  getPullRequest,
  getPullRequestFiles,
  postIssueComment,
  createPullRequestReview,
} from '../services/github.service.js';
import {
  renderReviewMarkdown,
  renderReviewForPRReview,
} from '../utils/reviewMarkdown.js';
import Review from '../models/Review.js';

const router = Router();

// In-memory map of in-flight review AbortControllers, keyed by reviewId.
// Set when a review starts, deleted when it terminates (any status). When
// a Stop request comes in, we look up the controller and abort it.
// Lost on server restart — acceptable for a portfolio app; production
// would persist intent and the orchestrator would re-check on resume.
const inFlightReviews = new Map();

// -----------------------------------------------------------------------
// POST /api/reviews — kick off a review
// Body: { prUrl: "https://github.com/owner/repo/pull/123", preferProvider? }
// Returns: 202 + the queued Review doc immediately. The agent runs in the
// background via setImmediate; the client polls GET /api/reviews/:id (and
// in Phase 10 will subscribe to live socket events on review:<id>).
// -----------------------------------------------------------------------
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { prUrl, preferProvider } = req.body ?? {};
    if (!prUrl) {
      return res.status(400).json({ error: 'missing_pr_url' });
    }
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'invalid_pr_url' });
    }

    // Pure BYOK gate — no fallback to admin keys. Block early so we don't
    // create a Review doc that's guaranteed to fail.
    if (!req.user.hasUsableProvider()) {
      return res.status(403).json({
        error: 'no_api_key_configured',
        message:
          'Add an API key in Settings before submitting a review. The app needs at least one enabled provider (Gemini, Claude, or Groq) with a key configured.',
      });
    }

    const accessToken = req.user.getAccessToken();

    // Probe the PR via GitHub API BEFORE creating a Review doc. This catches:
    //   - PRs that don't exist (404 — typo, dummy URL)
    //   - Repos / PRs the user doesn't have access to (404 from GitHub for
    //     private repos they can't see, or 403 when their token's scopes
    //     don't cover the resource)
    //   - GitHub being down (502/503)
    // Surfacing these synchronously means the user sees a clean error
    // instead of a half-baked review record stuck in "running".
    let prMeta;
    try {
      prMeta = await getPullRequest(
        parsed.owner,
        parsed.repo,
        parsed.prNumber,
        accessToken
      );
    } catch (err) {
      const status = err.status ?? err.response?.status ?? 502;
      if (status === 404) {
        return res.status(404).json({
          error: 'pr_not_found',
          message: `PR not found: ${parsed.owner}/${parsed.repo}#${parsed.prNumber}. Check the URL or your access to this repo.`,
        });
      }
      if (status === 403) {
        return res.status(403).json({
          error: 'pr_access_denied',
          message: `Your GitHub token doesn't have access to this PR. Make sure it includes the 'repo' scope.`,
        });
      }
      return res.status(502).json({
        error: 'github_error',
        message: `GitHub returned ${status}: ${err.message?.slice(0, 200) ?? 'unknown error'}`,
      });
    }

    // PR exists and is accessible. Create the Review with metadata
    // pre-populated so the UI can render the title + SHAs immediately.
    const review = await Review.create({
      userId: req.userId,
      prUrl,
      prOwner: parsed.owner,
      prRepo: parsed.repo,
      prNumber: parsed.prNumber,
      prTitle: prMeta.title,
      baseSha: prMeta.base?.sha ?? null,
      headSha: prMeta.head?.sha ?? null,
      status: 'queued',
    });
    // Snapshot the user's BYOK context so the background agent uses the
    // SAME keys/models the user has configured RIGHT NOW. Subsequent
    // setting changes don't affect in-flight reviews.
    const userCtx = req.userContext;

    // AbortController for the Stop button. Stored in the in-flight map so
    // POST /:id/stop can look it up and call .abort(). Removed in finally.
    const controller = new AbortController();
    // The signal is shared across every LLM call + throttle wait + phase
    // boundary check for the WHOLE review. Easily 30+ subscribers. Node's
    // default warning threshold of 10 is for unbounded loops; for our
    // bounded fan-out we just bump it on this specific signal.
    setMaxListeners(50, controller.signal);
    const reviewIdStr = String(review._id);
    inFlightReviews.set(reviewIdStr, controller);
    console.log(`[review:${reviewIdStr}] registered controller (inFlight now: ${inFlightReviews.size})`);

    // Fire-and-forget. The orchestrator persists everything to the Review
    // doc; events publish to the EventBus so Socket.IO subscribers get
    // live updates without polling.
    setImmediate(() => {
      // Re-establish BOTH user context AND abort context inside the new
      // async chain — setImmediate can lose ALS frames on some Node versions.
      runWithUserContext(userCtx, () => {
        runWithAbortContext(controller.signal, () => {
          runReview({
            reviewId: review._id,
            accessToken,
            signal: controller.signal,
            emitter: (ev) => {
              if (ev.type !== 'iteration_start' && ev.type !== 'llm_response') {
                console.log(`[review:${reviewIdStr}] ${ev.type}`, ev.phase ?? '');
              }
              reviewEventBus.publish(reviewIdStr, ev);
            },
          })
            .catch((err) => {
              console.error(`[review:${reviewIdStr}] runReview crashed:`, err);
            })
            .finally(() => {
              inFlightReviews.delete(reviewIdStr);
              console.log(`[review:${reviewIdStr}] unregistered controller`);
            });
        });
      });
    });

    res.status(202).json({ review });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /api/reviews — list the authenticated user's reviews, newest first.
// -----------------------------------------------------------------------
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const reviews = await Review.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      // Heavy fields (toolCalls, phases) excluded from the list view.
      .select('-toolCalls -phases');
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/reviews/:id/stop — request cancellation of an in-flight review.
// Marks the review 'stopped' if it's currently queued/running. Idempotent:
// stopping an already-terminal review is a no-op (returns the doc).
// -----------------------------------------------------------------------
router.post('/:id/stop', requireAuth, async (req, res, next) => {
  try {
    const review = await Review.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!review) return res.status(404).json({ error: 'review_not_found' });

    if (review.status !== 'queued' && review.status !== 'running') {
      // Already terminal — just echo the doc back, no-op.
      return res.json({ review, alreadyTerminal: true });
    }

    const controller = inFlightReviews.get(String(review._id));
    if (controller) {
      // Triggers the agent's signal.aborted checks → status='stopped' is
      // set inside runReview's catch block once it unwinds.
      controller.abort();
      // The agent will set the final status. Respond optimistically with
      // 'stopped' so the UI doesn't show stale 'running' while waiting.
      review.status = 'stopped';
      review.statusMessage = 'Stopped by user';
      await review.save();
    } else {
      // No controller — server probably restarted while this review was
      // in flight. Force-mark stopped so the UI doesn't get stuck.
      review.status = 'stopped';
      review.statusMessage = 'Stopped by user (server had no live controller)';
      await review.save();
    }

    // Notify the live socket subscribers too.
    reviewEventBus.publish(String(review._id), {
      type: 'review_stopped',
      reviewId: String(review._id),
    });

    res.json({ review });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// PUT /api/reviews/:id/visibility — flip a review between public and
// private. Public reviews can be read by anyone via /api/public/reviews/:id
// without authentication, which is what makes the URL we post into the PR
// comment actually usable by the PR author.
// Body: { isPublic: boolean }
// -----------------------------------------------------------------------
router.put('/:id/visibility', requireAuth, async (req, res, next) => {
  try {
    const review = await Review.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!review) return res.status(404).json({ error: 'review_not_found' });

    const wantPublic = !!req.body?.isPublic;
    review.isPublic = wantPublic;
    if (wantPublic && !review.publishedAt) review.publishedAt = new Date();
    await review.save();
    res.json({ review });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/reviews/:id/comment — post the review back to the source PR.
// Body: { style: 'issue' | 'review' } (default 'issue').
//   - 'issue':  single markdown comment on the PR conversation tab
//   - 'review': a GitHub PR Review with inline line-level comments where
//               the finding line falls inside a PR hunk; remaining findings
//               summarized in the review body.
// -----------------------------------------------------------------------
router.post('/:id/comment', requireAuth, async (req, res, next) => {
  try {
    const review = await Review.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!review) return res.status(404).json({ error: 'review_not_found' });

    if (review.status !== 'complete') {
      return res.status(400).json({
        error: 'review_not_complete',
        message: 'Only completed reviews can be posted to GitHub.',
      });
    }

    const style = req.body?.style === 'review' ? 'review' : 'issue';
    const accessToken = req.user.getAccessToken();

    // The link we render into the PR comment points at /reviews/:id on the
    // frontend. For that link to work for the PR author (who probably isn't
    // a SecureReview AI user), the review needs to be publicly readable.
    // Flip it on auto — owners can flip back to private from Review Theater.
    if (!review.isPublic) {
      review.isPublic = true;
      review.publishedAt = review.publishedAt ?? new Date();
      await review.save();
    }

    if (style === 'issue') {
      const body = renderReviewMarkdown(review);
      const result = await postIssueComment(
        review.prOwner,
        review.prRepo,
        review.prNumber,
        body,
        accessToken
      );
      return res.json({
        style,
        comment: result,
        inlineCount: 0,
        findingsCount: review.findings.length,
      });
    }

    // style === 'review' — need PR files to know which findings can be
    // anchored inline.
    let prFiles = [];
    try {
      prFiles = await getPullRequestFiles(
        review.prOwner,
        review.prRepo,
        review.prNumber,
        accessToken
      );
    } catch (err) {
      console.warn(
        `[reviews] /comment: failed to refetch PR files (${err.message}); ` +
          'falling back to body-only review.'
      );
    }

    const { body, comments, inlineCount, skipped } = renderReviewForPRReview(
      review,
      prFiles
    );

    try {
      const result = await createPullRequestReview(
        review.prOwner,
        review.prRepo,
        review.prNumber,
        {
          body,
          comments,
          commitId: review.headSha ?? undefined,
          event: 'COMMENT', // never auto-approve / request changes
        },
        accessToken
      );
      return res.json({
        style,
        comment: result,
        inlineCount,
        skippedCount: skipped.length,
        findingsCount: review.findings.length,
      });
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const ghMsg =
        err.response?.data?.message ??
        err.response?.data?.errors?.[0]?.message ??
        err.message;
      console.warn(
        `[reviews] createPullRequestReview failed (status=${status}): ${ghMsg}`
      );
      // Common failure: stale commit SHA (force-push after review started)
      // or all inline comments rejected. Fall back to a plain issue comment
      // so the user still gets the review on the PR.
      if (status === 422 || status === 404) {
        const fallbackBody = renderReviewMarkdown(review);
        const fb = await postIssueComment(
          review.prOwner,
          review.prRepo,
          review.prNumber,
          fallbackBody,
          accessToken
        );
        return res.json({
          style: 'issue',
          fallback: true,
          fallbackReason: `PR Review API rejected: ${ghMsg?.slice(0, 200)}`,
          comment: fb,
          inlineCount: 0,
          findingsCount: review.findings.length,
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /api/reviews/:id — fetch a single review with all detail.
// -----------------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const review = await Review.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!review) return res.status(404).json({ error: 'review_not_found' });
    res.json({ review });
  } catch (err) {
    next(err);
  }
});

export default router;

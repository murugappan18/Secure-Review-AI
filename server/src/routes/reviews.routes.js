import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parsePrUrl, runReview } from '../agent/agentLoop.js';
import { reviewEventBus } from '../sockets/eventBus.js';
import { runWithUserContext } from '../utils/userContext.js';
import { runWithAbortContext } from '../utils/abortContext.js';
import { getPullRequest } from '../services/github.service.js';
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

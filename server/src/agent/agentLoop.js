// The review orchestrator. Walks the 5 phases in sequence, persists each
// phase's output and tool calls to the Review document, applies an overall
// timeout, and emits live events for the WebSocket layer (Phase 10) to relay
// to the frontend.
//
// Failure handling philosophy:
//   - LLM JSON parse failure on one phase → log it on review.phases[].error,
//     continue with whatever we have. Don't fail the whole review.
//   - Final-phase schema validation failure → salvage valid findings if any.
//   - Per-phase exception → mark review failed, but keep partial phase data
//     so the user can see what we managed to do.
//   - Whole-review timeout → mark failed with a clear message.

import Review, {
  ReviewOutputSchema,
  FindingSchema,
} from '../models/Review.js';
import Repo from '../models/Repo.js';
import {
  understandDiff,
  gatherContext,
  reasonExploitability,
  comparePatterns,
  generateReview,
} from './phases.js';
import {
  getPullRequest,
  getPullRequestFiles,
} from '../services/github.service.js';

// Lazy read — env vars aren't populated at module-load time under ESM
// (loadDotenv() runs AFTER imports are processed).
function getAgentTimeoutMs() {
  return Number(process.env.AGENT_TIMEOUT_MS) || 180_000;
}

// Pull (owner, repo, prNumber) out of a github.com PR URL.
export function parsePrUrl(url) {
  const m = String(url ?? '').match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), prNumber: Number(m[3]) };
}

// Convenience: AbortError so the outer catch can distinguish "user stopped
// the review" from "agent loop genuinely failed". Status flips to 'stopped'
// vs 'failed' accordingly.
export class ReviewStoppedError extends Error {
  constructor(message = 'Review stopped by user') {
    super(message);
    this.name = 'ReviewStoppedError';
    this.code = 'REVIEW_STOPPED';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ReviewStoppedError();
  }
}

// ---------------------------------------------------------------------
// runReview — top-level orchestrator
// ---------------------------------------------------------------------
export async function runReview({
  reviewId,
  accessToken,
  emitter = () => {},
  signal, // optional AbortSignal — when aborted, the loop short-circuits between phases.
}) {
  const startedAt = new Date();
  const review = await Review.findById(reviewId);
  if (!review) throw new Error(`review not found: ${reviewId}`);

  // Look up the indexed Repo doc, if any. The agent still works against an
  // unindexed repo (the codebase tools just return empty); but Phase 2 + 3
  // quality is much higher with the index present.
  const repo = await Repo.findOne({
    userId: review.userId,
    fullName: `${review.prOwner}/${review.prRepo}`,
  });

  const ctx = {
    reviewId: String(reviewId),
    accessToken,
    owner: review.prOwner,
    repo: review.prRepo,
    prNumber: review.prNumber,
    prTitle: review.prTitle,
    prUrl: review.prUrl,
    repoId: repo?._id ?? null,
  };

  const runOpts = {
    onEvent: (ev) => emitter({ ...ev, reviewId: String(reviewId) }),
    signal,
  };

  // Phase / tool / token accumulators for the Review doc.
  const allToolCalls = [];
  const providersUsed = new Set();
  let totalTokens = 0;

  // Wrapper that times one phase, persists its result, emits events.
  async function runPhase(name, phaseFn) {
    const startedPhase = new Date();
    emitter({ type: 'phase_start', phase: name, reviewId: String(reviewId) });

    let phaseRecord = { name, startedAt: startedPhase };
    try {
      const out = await phaseFn(ctx, runOpts);
      const completedAt = new Date();
      phaseRecord = {
        ...phaseRecord,
        completedAt,
        durationMs: completedAt - startedPhase,
        output: out.parsed ?? null,
        error: out.parseError ?? null,
      };

      if (out.runResult) {
        for (const tc of out.runResult.toolCalls) {
          allToolCalls.push({
            phase: name,
            tool: tc.tool,
            arguments: tc.arguments,
            result: tc.result,
            durationMs: tc.durationMs,
            timestamp: tc.timestamp,
            error: tc.error,
          });
        }
        for (const p of out.runResult.providers ?? []) providersUsed.add(p);
        totalTokens +=
          (out.runResult.usage?.inputTokens ?? 0) +
          (out.runResult.usage?.outputTokens ?? 0);
      }

      review.phases.push(phaseRecord);
      await review.save();

      emitter({
        type: 'phase_complete',
        phase: name,
        durationMs: phaseRecord.durationMs,
        output: out.parsed,
        reviewId: String(reviewId),
      });
      return out;
    } catch (err) {
      const completedAt = new Date();
      phaseRecord = {
        ...phaseRecord,
        completedAt,
        durationMs: completedAt - startedPhase,
        error: (err.message ?? String(err)).slice(0, 500),
      };
      review.phases.push(phaseRecord);
      await review.save();
      emitter({
        type: 'phase_error',
        phase: name,
        error: err.message,
        reviewId: String(reviewId),
      });
      throw err;
    }
  }

  // --- Start ---
  review.status = 'running';
  review.startedAt = startedAt;
  await review.save();
  emitter({
    type: 'review_start',
    reviewId: String(reviewId),
    pr: `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`,
  });

  try {
    const timeoutMs = getAgentTimeoutMs();
    console.log(`[agent] timeout budget: ${timeoutMs}ms`);
    await runWithTimeout(
      async () => {
        // Pre-step: fetch PR metadata + file patches up front. This serves
        // two purposes:
        //   1. Populates review.prTitle / SHAs immediately for the UI.
        //   2. Loads the FULL patch content into ctx.prFiles so every phase
        //      can reason from the actual diff text — not just from indexed
        //      chunks, which won't contain files added by this PR.
        try {
          const meta = await getPullRequest(
            ctx.owner,
            ctx.repo,
            ctx.prNumber,
            accessToken
          );
          if (!review.prTitle) review.prTitle = meta.title;
          review.baseSha = meta.base?.sha ?? null;
          review.headSha = meta.head?.sha ?? null;
          ctx.prTitle = review.prTitle;
          ctx.prBody = meta.body ?? '';
          await review.save();
          emitter({
            type: 'pr_metadata',
            title: meta.title,
            reviewId: String(reviewId),
          });
        } catch (err) {
          console.warn(`[agent] PR metadata prefetch failed: ${err.message}`);
        }

        // The PR was already validated by the route before this Review doc
        // was created. If files prefetch fails NOW, it means the PR was
        // deleted, closed-as-private, or GitHub is having an outage — in
        // any case, the agent can't produce a meaningful review without
        // the patches, so fail loud rather than running on empty.
        try {
          ctx.prFiles = await getPullRequestFiles(
            ctx.owner,
            ctx.repo,
            ctx.prNumber,
            accessToken
          );
          if (!ctx.prFiles || ctx.prFiles.length === 0) {
            throw new Error('PR has no file changes (empty patch)');
          }
          console.log(`[agent] prefetched ${ctx.prFiles.length} PR files`);
        } catch (err) {
          const status = err.status ?? err.response?.status;
          const reason =
            status === 404
              ? 'PR not found anymore — was it deleted between submission and review?'
              : status === 403
                ? "GitHub denied access to the PR's files (token scopes may have changed)"
                : `Failed to fetch PR files: ${err.message?.slice(0, 200) ?? 'unknown'}`;
          const fatal = new Error(reason);
          fatal.status = status;
          throw fatal; // Propagates to outer catch → review.status='failed'
        }

        // --- The 5 phases --- (abort check between each)
        throwIfAborted(signal);
        const p1 = await runPhase('understand_diff', understandDiff);
        ctx.diffSummary = p1.parsed;

        throwIfAborted(signal);
        const p2 = await runPhase('gather_context', gatherContext);
        ctx.gatheredContext = p2.parsed;

        throwIfAborted(signal);
        const p3 = await runPhase('reason_exploitability', reasonExploitability);
        ctx.candidatesPhase = p3.parsed;

        throwIfAborted(signal);
        // Phase 4 is REFINEMENT. Two failure modes:
        //   (a) it THROWS — quota exhausted, network died, etc.
        //   (b) it returns null or empty output — LLM produced no parseable
        //       JSON, common with smaller "lite" models.
        // In both cases, fall back to Phase 3 candidates as the findings,
        // so we always produce SOMETHING from a partially-successful run.
        const hasCandidates =
          (ctx.candidatesPhase?.candidates?.length ?? 0) > 0;

        try {
          const p4 = await runPhase('compare_patterns', comparePatterns);
          const refinedFindings = p4.parsed?.findings ?? [];
          if (refinedFindings.length === 0 && hasCandidates) {
            console.warn(
              `[agent] Phase 4 produced no findings (parseError: ${p4.parseError ?? 'empty'}); ` +
                `falling back to Phase 3 candidates.`
            );
            ctx.refinedPhase = {
              findings: ctx.candidatesPhase.candidates,
              degraded: true,
              phase4Error: p4.parseError ?? 'phase 4 returned no findings',
            };
          } else {
            ctx.refinedPhase = p4.parsed;
          }
        } catch (err) {
          console.warn(
            `[agent] Phase 4 threw (${err.message?.slice(0, 100)}); ` +
              `falling back to Phase 3 candidates as findings.`
          );
          ctx.refinedPhase = {
            findings: ctx.candidatesPhase?.candidates ?? [],
            degraded: true,
            phase4Error: err.message?.slice(0, 200),
          };
        }

        throwIfAborted(signal);
        const p5 = await runPhase('generate_review', generateReview);

        // Validate the final-phase output, salvage what we can on partial fail.
        const final = p5.parsed;
        const v = ReviewOutputSchema.safeParse(final);
        if (v.success) {
          review.summary = v.data.summary;
          review.riskAssessment = v.data.riskAssessment;
          review.findings = v.data.findings;
        } else {
          const partial = (final?.findings ?? []).filter(
            (f) => FindingSchema.safeParse(f).success
          );
          review.summary =
            final?.summary ?? 'Review completed with partial schema validation.';
          review.riskAssessment = final?.riskAssessment ?? 'medium';
          review.findings = partial;
          review.statusMessage =
            'Phase 5 output partially valid: ' +
            v.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ');
        }
      },
      timeoutMs,
      `agent timeout exceeded (${timeoutMs}ms)`
    );

    review.status = 'complete';
    review.completedAt = new Date();
    review.durationMs = review.completedAt - startedAt;
    review.modelUsed = [...providersUsed].join('+');
    review.providersTried = [...providersUsed];
    review.toolCalls = allToolCalls;
    review.tokensUsed = totalTokens;
    await review.save();

    emitter({
      type: 'review_complete',
      reviewId: String(reviewId),
      findings: review.findings.length,
      durationMs: review.durationMs,
      tokensUsed: totalTokens,
    });

    return review;
  } catch (err) {
    // Distinguish "user stopped this" from a real failure. status='stopped'
    // surfaces in the UI as a neutral gray pill, not the alarming red of a
    // genuine error.
    const isStopped = err instanceof ReviewStoppedError || err.code === 'REVIEW_STOPPED';
    review.status = isStopped ? 'stopped' : 'failed';
    review.statusMessage = (err.message ?? String(err)).slice(0, 500);
    review.completedAt = new Date();
    review.durationMs = review.completedAt - startedAt;
    review.modelUsed = [...providersUsed].join('+');
    review.toolCalls = allToolCalls;
    review.tokensUsed = totalTokens;
    await review.save();

    emitter({
      type: isStopped ? 'review_stopped' : 'review_failed',
      reviewId: String(reviewId),
      error: err.message,
    });
    if (!isStopped) throw err; // Stopped is a clean exit; failure should still throw
    return review;
  }
}

// Race a promise against a timer.
function runWithTimeout(fn, ms, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve()
      .then(fn)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { parsePrUrl, runReview } from '../agent/agentLoop.js';
import Review from '../models/Review.js';

const router = Router();

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

    const review = await Review.create({
      userId: req.userId,
      prUrl,
      prOwner: parsed.owner,
      prRepo: parsed.repo,
      prNumber: parsed.prNumber,
      status: 'queued',
    });

    const accessToken = req.user.getAccessToken();

    // Fire-and-forget. The orchestrator persists everything to the Review
    // doc, and clients poll for status.
    setImmediate(() => {
      runReview({
        reviewId: review._id,
        accessToken,
        emitter: (ev) => {
          // Phase 10 will replace this with io.to(`review:${reviewId}`).emit(...).
          // For now, log to console for debugging.
          if (
            ev.type !== 'iteration_start' &&
            ev.type !== 'llm_response'
          ) {
            console.log(`[review:${review._id}] ${ev.type}`, ev.phase ?? '');
          }
        },
      }).catch((err) => {
        console.error(`[review:${review._id}] runReview crashed:`, err);
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

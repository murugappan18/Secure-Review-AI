import { Router } from 'express';
import Review from '../models/Review.js';

const router = Router();

// -----------------------------------------------------------------------
// GET /api/public/reviews/:id
// Public read endpoint — NO authentication required. Used so that a link
// posted into a GitHub PR comment is openable by anyone (the PR author,
// reviewers, casual visitors) without forcing them to sign in.
//
// Returns the review ONLY if it's been explicitly marked isPublic=true by
// its owner (auto-set when they post to GitHub, or via the visibility
// toggle in the Review Theater). Otherwise returns 404 to avoid leaking
// the existence of private reviews.
//
// Sensitive owner-only fields (userId, accessToken-derived data) are
// stripped before sending.
// -----------------------------------------------------------------------
router.get('/reviews/:id', async (req, res, next) => {
  try {
    // Cheap shape check before hitting Mongo: 24 hex chars.
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(404).json({ error: 'review_not_found' });
    }

    const review = await Review.findOne({
      _id: req.params.id,
      isPublic: true,
    }).lean();

    if (!review) {
      // Treat "private" and "doesn't exist" identically — no info leak.
      return res.status(404).json({ error: 'review_not_found' });
    }

    // Strip fields the public viewer has no business seeing.
    delete review.userId;
    delete review.__v;

    res.json({ review, public: true });
  } catch (err) {
    next(err);
  }
});

export default router;

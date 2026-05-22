import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listUserRepos } from '../services/github.service.js';

const router = Router();

// GET /api/repos — list the authenticated user's GitHub repos.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const accessToken = req.user.getAccessToken();
    const repos = await listUserRepos(accessToken);
    res.json({ repos });
  } catch (err) {
    next(err);
  }
});

export default router;

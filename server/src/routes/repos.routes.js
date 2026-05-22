import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listUserRepos, getRepoMetadata } from '../services/github.service.js';
import { indexRepo } from '../services/indexer.service.js';
import Repo from '../models/Repo.js';
import CodeChunk from '../models/CodeChunk.js';

const router = Router();

// -----------------------------------------------------------------------
// GET /api/repos — list the authenticated user's GitHub repos.
// -----------------------------------------------------------------------
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const accessToken = req.user.getAccessToken();
    const ghRepos = await listUserRepos(accessToken);

    // Decorate with our index status so the dashboard can render "Indexed",
    // "Indexing 42%", "Index" buttons accordingly.
    const ours = await Repo.find({ userId: req.userId }).select(
      'fullName indexStatus indexProgress chunkCount lastIndexedAt'
    );
    const byFullName = new Map(ours.map((r) => [r.fullName, r]));

    const enriched = ghRepos.map((r) => ({
      ...r,
      indexStatus: byFullName.get(r.fullName)?.indexStatus ?? 'not_indexed',
      indexProgress: byFullName.get(r.fullName)?.indexProgress ?? 0,
      chunkCount: byFullName.get(r.fullName)?.chunkCount ?? 0,
      repoId: byFullName.get(r.fullName)?._id ?? null,
    }));

    res.json({ repos: enriched });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/repos/:owner/:name/index — kick off background indexing.
// Returns the Repo doc immediately; the client polls GET /api/repos/:id
// to watch progress.
// -----------------------------------------------------------------------
router.post('/:owner/:name/index', requireAuth, async (req, res, next) => {
  try {
    const { owner, name } = req.params;
    const fullName = `${owner}/${name}`;
    const accessToken = req.user.getAccessToken();

    // Pull GitHub metadata to populate language / defaultBranch / size.
    const meta = await getRepoMetadata(owner, name, accessToken);

    // Upsert the Repo doc.
    const repo = await Repo.findOneAndUpdate(
      { userId: req.userId, fullName },
      {
        userId: req.userId,
        owner,
        name,
        fullName,
        defaultBranch: meta.default_branch,
        language: meta.language,
        size: meta.size,
        indexStatus: 'pending',
        indexProgress: 0,
        indexError: null,
      },
      { new: true, upsert: true }
    );

    // Fire-and-forget. We don't await the indexer here — the route returns
    // immediately so the UI can switch into polling mode. Errors are caught
    // and persisted to Repo.indexError inside indexRepo() itself.
    setImmediate(() => {
      indexRepo({ repoId: repo._id, fullName, accessToken }).catch((err) => {
        console.error(`[route] indexRepo background error: ${err.message}`);
      });
    });

    res.status(202).json({ repo });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /api/repos/:id — fetch a single repo's index status / progress.
// -----------------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.userId });
    if (!repo) return res.status(404).json({ error: 'repo_not_found' });
    res.json({ repo });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /api/repos/:id/chunks — paginated chunks for debugging.
// Useful for spot-checking what the chunker captured during verification.
// -----------------------------------------------------------------------
router.get('/:id/chunks', requireAuth, async (req, res, next) => {
  try {
    const repo = await Repo.findOne({ _id: req.params.id, userId: req.userId });
    if (!repo) return res.status(404).json({ error: 'repo_not_found' });

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const skip = Number(req.query.skip) || 0;

    const [chunks, total] = await Promise.all([
      CodeChunk.find({ repoId: repo._id })
        .select('-content') // keep the response light; content can be huge
        .sort({ filepath: 1, startLine: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CodeChunk.countDocuments({ repoId: repo._id }),
    ]);

    res.json({ total, skip, limit, chunks });
  } catch (err) {
    next(err);
  }
});

export default router;

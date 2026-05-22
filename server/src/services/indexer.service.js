import simpleGit from 'simple-git';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { chunkFile, isSupportedFile } from '../chunker/parser.js';
import { embedBatch } from './embedding.service.js';
import Repo from '../models/Repo.js';
import CodeChunk from '../models/CodeChunk.js';

const CLONE_ROOT = path.resolve(process.env.REPO_CLONE_DIR || './tmp/repos');

// Directory names we never descend into. Keeps the index lean and skips
// vendored / generated / test code that would mostly add noise for security
// review. Hidden dotfile directories (e.g. .git, .vscode) are skipped too.
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.idea',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '__tests__',
  'test',
  'tests',
  'spec',
  '__mocks__',
  '.husky',
  'tmp',
  'temp',
  'public', // static assets
]);

// Skip absurdly large files — they're usually generated or minified.
const MAX_FILE_BYTES = 500_000;
// Concurrency for file parsing + embedding. Modest so we don't hammer
// Gemini's rate limits when indexing larger repos (doc-recommended §3.1).
const PARSE_CONCURRENCY = 4;

// Text-to-embed for a chunk. Includes name + filepath + content so that
// natural-language queries (e.g., "auth middleware") line up well against
// chunks whose identifiers/paths suggest the same concept, not just whose
// raw code happens to contain matching words.
function embedTextForChunk(chunk, filepath) {
  const label = `${chunk.type} ${chunk.name ?? 'anonymous'} in ${filepath}`;
  return `${label}\n${chunk.content}`;
}

// -----------------------------------------------------------------------
// Clone
// -----------------------------------------------------------------------

export async function cloneRepo(fullName, accessToken, destDir) {
  // x-access-token is the standard placeholder username for token auth.
  const authUrl = `https://x-access-token:${accessToken}@github.com/${fullName}.git`;

  // Wipe any prior clone — re-indexing the same repo should be idempotent.
  await fs.rm(destDir, { recursive: true, force: true, maxRetries: 3 });
  await fs.mkdir(destDir, { recursive: true });

  const git = simpleGit();
  await git.clone(authUrl, destDir, ['--depth=1', '--single-branch']);

  // Capture HEAD SHA so we can detect whether to re-index next time.
  const repoGit = simpleGit(destDir);
  const sha = (await repoGit.revparse(['HEAD'])).trim();
  return { sha, destDir };
}

// -----------------------------------------------------------------------
// File discovery
// -----------------------------------------------------------------------

export async function discoverFiles(repoDir) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip dotfile directories and known excluded dirs.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const fullPath = path.join(dir, entry.name);
      if (!isSupportedFile(fullPath)) continue;

      // Cheap size guard — avoid pulling a 5 MB minified bundle into memory.
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size <= MAX_FILE_BYTES) results.push(fullPath);
      } catch {
        // If the stat fails (race, permission), just skip the file.
      }
    }
  }

  await walk(repoDir);
  return results;
}

// -----------------------------------------------------------------------
// Index orchestrator
// -----------------------------------------------------------------------

// Fire-and-forget from the route handler — see the catch in the route.
// Updates Repo.indexStatus / indexProgress as it goes so the frontend
// can poll for live progress.
export async function indexRepo({ repoId, fullName, accessToken }) {
  const destDir = path.join(CLONE_ROOT, String(repoId));
  console.log(`[indexer] starting index of ${fullName} (repoId=${repoId})`);

  try {
    await Repo.findByIdAndUpdate(repoId, {
      indexStatus: 'indexing',
      indexProgress: 0,
      indexError: null,
    });

    // Wipe any chunks from a prior run — simpler than diffing.
    await CodeChunk.deleteMany({ repoId });

    // ---- clone ----
    const { sha } = await cloneRepo(fullName, accessToken, destDir);

    // ---- discover ----
    const files = await discoverFiles(destDir);
    console.log(`[indexer] ${fullName}: ${files.length} files to chunk`);

    if (files.length === 0) {
      await Repo.findByIdAndUpdate(repoId, {
        indexStatus: 'ready',
        indexProgress: 100,
        chunkCount: 0,
        lastIndexedAt: new Date(),
        commitSha: sha,
      });
      return { chunkCount: 0 };
    }

    // ---- parse + persist with bounded concurrency ----
    const limit = pLimit(PARSE_CONCURRENCY);
    let processedFiles = 0;
    let totalChunks = 0;
    let lastReportedProgress = 0;

    async function maybeBumpProgress() {
      processedFiles++;
      const progress = Math.round((processedFiles / files.length) * 100);
      // Throttle DB writes — only push when progress moves by 5+ points
      // or we've processed the last file.
      if (progress >= lastReportedProgress + 5 || processedFiles === files.length) {
        lastReportedProgress = progress;
        await Repo.findByIdAndUpdate(repoId, { indexProgress: progress });
      }
    }

    await Promise.all(
      files.map((file) =>
        limit(async () => {
          try {
            const source = await fs.readFile(file, 'utf8');
            // Use POSIX separators in the stored filepath — friendlier for
            // cross-platform display and matches the diff format from GitHub.
            const filepath = path.relative(destDir, file).split(path.sep).join('/');
            const chunks = chunkFile(source, filepath);

            if (chunks.length > 0) {
              // One batch embed call per file. Per-file batches are small
              // (1-10 chunks usually) but Gemini's batch API handles up to
              // 100 in a single request, so this is well within limits.
              const embedTexts = chunks.map((c) => embedTextForChunk(c, filepath));
              const embeddings = await embedBatch(embedTexts);

              const docs = chunks.map((c, i) => ({
                ...c,
                repoId,
                filepath,
                embedding: embeddings[i],
                indexedAt: new Date(),
              }));
              await CodeChunk.insertMany(docs, { ordered: false });
              totalChunks += chunks.length;
            }
          } catch (err) {
            // Don't fail the whole index over one weird file — log and move on.
            console.error(`[indexer] failed on ${file}: ${err.message}`);
          } finally {
            await maybeBumpProgress();
          }
        })
      )
    );

    // ---- finalize ----
    await Repo.findByIdAndUpdate(repoId, {
      indexStatus: 'ready',
      indexProgress: 100,
      chunkCount: totalChunks,
      lastIndexedAt: new Date(),
      commitSha: sha,
    });
    console.log(`[indexer] ${fullName} done: ${totalChunks} chunks`);
    return { chunkCount: totalChunks };
  } catch (err) {
    console.error(`[indexer] indexRepo failed for ${fullName}:`, err);
    await Repo.findByIdAndUpdate(repoId, {
      indexStatus: 'failed',
      indexError: err.message?.slice(0, 500) ?? 'unknown error',
    });
    throw err;
  } finally {
    // Clean up the clone — saves disk on Render's free tier.
    // Re-clone on next index is fine for portfolio scale.
    try {
      await fs.rm(destDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      console.error(`[indexer] failed to clean ${destDir}: ${e.message}`);
    }
  }
}

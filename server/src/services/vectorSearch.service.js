import mongoose from 'mongoose';
import CodeChunk from '../models/CodeChunk.js';
import { embedQuery } from './embedding.service.js';

const VECTOR_INDEX = 'code_vector_index';

// Fields we return to callers — never the raw 768-dim embedding (too big to
// ship around) but everything the agent needs to reason about a chunk.
const PROJECTION = {
  _id: 1,
  repoId: 1,
  filepath: 1,
  type: 1,
  name: 1,
  language: 1,
  startLine: 1,
  endLine: 1,
  content: 1,
  imports: 1,
  calls: 1,
  exports: 1,
  metadata: 1,
};

function toObjectId(value) {
  return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value;
}

// -----------------------------------------------------------------------
// Pure vector search via Atlas $vectorSearch.
// -----------------------------------------------------------------------
export async function searchByVector(query, { repoId, limit = 6, languages, types } = {}) {
  if (!query || !query.trim()) return [];
  const qVec = await embedQuery(query);

  const filter = { repoId: toObjectId(repoId) };
  if (languages?.length) filter.language = { $in: languages };
  if (types?.length) filter.type = { $in: types };

  // numCandidates: Atlas-recommended 10x-20x the requested limit. Higher
  // values mean better recall, slower queries. 10x is the sweet spot.
  const results = await CodeChunk.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: 'embedding',
        queryVector: qVec,
        numCandidates: Math.max(limit * 10, 50),
        limit,
        filter,
      },
    },
    {
      $project: {
        ...PROJECTION,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  return results;
}

// -----------------------------------------------------------------------
// Pure text search via Atlas $search (BM25-ish across name + content).
// Used to complement vector search — text catches exact identifiers that
// embeddings sometimes blur, vector catches paraphrases that text misses.
// -----------------------------------------------------------------------
export async function searchByText(query, { repoId, limit = 6, languages, types } = {}) {
  if (!query || !query.trim()) return [];

  // We rely on Atlas's default search index for code_chunks (collection-wide
  // dynamic mapping). If it doesn't exist yet, this stage returns empty,
  // which is fine — hybrid search gracefully degrades to vector-only.
  const filter = { repoId: toObjectId(repoId) };
  if (languages?.length) filter.language = { $in: languages };
  if (types?.length) filter.type = { $in: types };

  try {
    return await CodeChunk.aggregate([
      {
        $search: {
          index: 'default',
          compound: {
            should: [
              { text: { query, path: 'name', score: { boost: { value: 3 } } } },
              { text: { query, path: 'content' } },
            ],
          },
        },
      },
      { $match: filter },
      { $limit: limit },
      {
        $project: {
          ...PROJECTION,
          score: { $meta: 'searchScore' },
        },
      },
    ]);
  } catch (err) {
    // If the default search index isn't set up, don't fail — vector alone
    // still works. This is expected on first-run before user creates it.
    console.warn(`[vectorSearch] text search unavailable: ${err.message}`);
    return [];
  }
}

// -----------------------------------------------------------------------
// Hybrid: vector + text, dedup by _id, re-rank as weighted combination.
// This is the public entry point the agent (Phase 5+) will call.
// -----------------------------------------------------------------------
export async function searchCode(query, opts = {}) {
  const { vectorWeight = 0.7, textWeight = 0.3, ...rest } = opts;

  const [vectorHits, textHits] = await Promise.all([
    searchByVector(query, rest),
    searchByText(query, rest),
  ]);

  // Min-max normalize each result set's scores into [0, 1] so we can
  // combine them. Atlas vector cosine scores are in (0, 1] already; Atlas
  // text scores are unbounded BM25-style. Normalize separately, weight, sum.
  const normalize = (hits, key) => {
    if (hits.length === 0) return new Map();
    const scores = hits.map((h) => h.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    return new Map(
      hits.map((h) => [String(h._id), { ...h, [key]: (h.score - min) / range }])
    );
  };

  const vMap = normalize(vectorHits, 'vectorNorm');
  const tMap = normalize(textHits, 'textNorm');

  const allIds = new Set([...vMap.keys(), ...tMap.keys()]);
  const merged = [...allIds].map((id) => {
    const v = vMap.get(id);
    const t = tMap.get(id);
    const base = v ?? t; // either has the chunk data
    const vScore = v?.vectorNorm ?? 0;
    const tScore = t?.textNorm ?? 0;
    return {
      ...base,
      vectorScore: vScore,
      textScore: tScore,
      hybridScore: vectorWeight * vScore + textWeight * tScore,
    };
  });

  merged.sort((a, b) => b.hybridScore - a.hybridScore);
  return merged.slice(0, opts.limit ?? 6);
}

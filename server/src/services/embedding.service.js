// Embeddings via Google's gemini-embedding-001 (Matryoshka — full 3072 dims,
// truncated to 768 by passing outputDimensionality).
//
// We originally targeted Xenova/bge-small-en-v1.5 (local, 384-dim, free) per
// INSTRUCTIONS.md, but Cognizant's Zscaler agent blocks huggingface.co at the
// OS level, preventing the model from downloading. Gemini API runs through.
//
// Free tier (as of 2026): generous daily quotas with no per-token cost.
// gemini-embedding-001 token limit is 2048 per input; we cap chars more
// conservatively. Up to 100 inputs per batch request.

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EXPECTED_DIM = Number(process.env.EMBEDDING_DIM) || 768;
const MAX_BATCH = 100; // Google's per-request limit for batchEmbedContents
const MAX_INPUT_CHARS = 6000; // ~1500 tokens; safe under 2048 limit

function getApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('[embed] GEMINI_API_KEY is required for embeddings');
  }
  return key;
}

function prep(text) {
  if (text == null) return '';
  const s = String(text);
  return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
}

// Single-text embed. Returns number[768].
export async function embed(text) {
  const url = `${ENDPOINT_BASE}/models/${MODEL}:embedContent?key=${getApiKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${MODEL}`,
      content: { parts: [{ text: prep(text) }] },
      // RETRIEVAL_DOCUMENT for indexed chunks; we use RETRIEVAL_QUERY in vector search.
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EXPECTED_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[embed] Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const vec = data.embedding?.values;
  if (!Array.isArray(vec) || vec.length !== EXPECTED_DIM) {
    throw new Error(
      `[embed] unexpected response shape: dim ${vec?.length}, expected ${EXPECTED_DIM}`
    );
  }
  return vec;
}

// Batch embed. Internally chunks into groups of MAX_BATCH and concatenates.
// Same caller interface as before; the indexer can stay the same.
export async function embedBatch(texts) {
  if (!texts || texts.length === 0) return [];

  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const slice = texts.slice(i, i + MAX_BATCH);
    const url = `${ENDPOINT_BASE}/models/${MODEL}:batchEmbedContents?key=${getApiKey()}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: slice.map((t) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text: prep(t) }] },
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality: EXPECTED_DIM,
        })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[embed] Gemini batch ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const vecs = data.embeddings ?? [];
    if (vecs.length !== slice.length) {
      throw new Error(
        `[embed] batch mismatch: got ${vecs.length}, expected ${slice.length}`
      );
    }
    for (let j = 0; j < vecs.length; j++) {
      out[i + j] = vecs[j].values;
    }
  }

  return out;
}

// Query-time embeddings use a different taskType for better retrieval.
// Same shape as embed(), just RETRIEVAL_QUERY semantics.
export async function embedQuery(text) {
  const url = `${ENDPOINT_BASE}/models/${MODEL}:embedContent?key=${getApiKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${MODEL}`,
      content: { parts: [{ text: prep(text) }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: EXPECTED_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[embed] Gemini query ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.embedding?.values;
}

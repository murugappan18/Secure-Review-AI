// Seed the SecurityKB collection from the JSON data files. Idempotent —
// re-running updates existing entries by (source, identifier) without
// creating duplicates.
//
// Usage:
//   node --use-system-ca scripts/seedSecurityKB.js

import { loadDotenv } from '../src/utils/env.js';
loadDotenv();

import { promises as fs } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import SecurityKB from '../src/models/SecurityKB.js';
import { embedBatch } from '../src/services/embedding.service.js';

const DATA_DIR = path.resolve('./data/security_kb');
const SOURCE_FILES = ['owasp.json', 'cwe.json', 'best_practices.json'];

// Build the text we embed for each entry. Includes identifier + title +
// description + both code examples — the agent's natural-language queries
// ("eval injection", "missing authentication", etc.) match well against
// this combined representation.
function buildEmbedText(entry) {
  const parts = [
    `# ${entry.identifier}: ${entry.title}`,
    entry.description,
  ];
  if (entry.examples?.vulnerable) {
    parts.push(`\nVulnerable example:\n${entry.examples.vulnerable}`);
  }
  if (entry.examples?.safe) {
    parts.push(`\nSafe example:\n${entry.examples.safe}`);
  }
  return parts.join('\n');
}

async function main() {
  // Load all entries from disk first so we can batch-embed in one shot.
  const entries = [];
  for (const file of SOURCE_FILES) {
    const fullPath = path.join(DATA_DIR, file);
    try {
      const raw = await fs.readFile(fullPath, 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error(`${file} is not a JSON array`);
      entries.push(...arr);
      console.log(`Loaded ${arr.length} entries from ${file}`);
    } catch (err) {
      console.error(`Failed to load ${file}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`Total entries to seed: ${entries.length}\n`);

  // Embed them all.
  console.log('Embedding via Gemini...');
  const t0 = Date.now();
  const texts = entries.map(buildEmbedText);
  const embeddings = await embedBatch(texts);
  console.log(`Embedded ${embeddings.length} entries in ${Date.now() - t0}ms\n`);

  if (embeddings.length !== entries.length) {
    throw new Error(
      `Embedding count mismatch: ${embeddings.length} vectors vs ${entries.length} entries`
    );
  }

  // Connect and upsert.
  await mongoose.connect(process.env.MONGO_URI);

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const result = await SecurityKB.findOneAndUpdate(
      { source: e.source, identifier: e.identifier },
      {
        source: e.source,
        identifier: e.identifier,
        title: e.title,
        description: e.description,
        language: e.language ?? 'all',
        examples: e.examples ?? null,
        references: e.references ?? [],
        severity: e.severity ?? 'medium',
        embedding: embeddings[i],
      },
      { upsert: true, new: false, includeResultMetadata: true }
    );
    if (result.lastErrorObject?.upserted) inserted++;
    else updated++;
  }

  console.log(`Inserted ${inserted}, updated ${updated}`);
  console.log(`SecurityKB total documents: ${await SecurityKB.estimatedDocumentCount()}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});

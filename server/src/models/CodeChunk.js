import mongoose from 'mongoose';

export const CHUNK_TYPES = ['function', 'class', 'method', 'block', 'module'];

const codeChunkSchema = new mongoose.Schema(
  {
    // Used as a filter on the Atlas vector index (Phase 4).
    repoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Repo',
      required: true,
      index: true,
    },
    filepath: { type: String, required: true },
    type: { type: String, enum: CHUNK_TYPES, required: true },
    name: { type: String, default: null }, // identifier (null for anonymous fns)
    content: { type: String, required: true }, // raw source for this chunk
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },

    // Vector-index filter field — populated in Phase 4.
    language: { type: String, required: true, index: true },

    // Lightweight static-analysis metadata, populated by the chunkers.
    imports: { type: [String], default: [] },
    calls: { type: [String], default: [] },
    exports: { type: [String], default: [] },

    // SHA-256 of `content`. Lets the next indexing run skip unchanged chunks.
    contentHash: { type: String, required: true, index: true },

    // Filled in Phase 4. 384-dim from Xenova/bge-small-en-v1.5.
    embedding: { type: [Number], default: undefined },

    metadata: {
      isAsync: { type: Boolean, default: false },
      isExported: { type: Boolean, default: false },
      hasErrorHandling: { type: Boolean, default: false },
    },

    indexedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

// Common access pattern: list/search chunks within one repo, often filtered by
// language or filepath. Atlas Vector Search will add its own index in Phase 4.
codeChunkSchema.index({ repoId: 1, filepath: 1 });
codeChunkSchema.index({ repoId: 1, language: 1 });

const CodeChunk = mongoose.model('CodeChunk', codeChunkSchema);
export default CodeChunk;

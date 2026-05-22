import mongoose from 'mongoose';

export const INDEX_STATUSES = ['pending', 'indexing', 'ready', 'failed'];

const repoSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    owner: { type: String, required: true },
    name: { type: String, required: true },
    fullName: { type: String, required: true }, // owner/name
    defaultBranch: { type: String, default: 'main' },
    language: { type: String, default: null }, // primary language per GitHub

    indexStatus: {
      type: String,
      enum: INDEX_STATUSES,
      default: 'pending',
      index: true,
    },
    indexProgress: { type: Number, default: 0, min: 0, max: 100 },
    indexError: { type: String, default: null },

    chunkCount: { type: Number, default: 0 },
    lastIndexedAt: { type: Date, default: null },
    commitSha: { type: String, default: null }, // HEAD SHA at last index
    size: { type: Number, default: 0 }, // KB, per GitHub metadata
  },
  { timestamps: true }
);

// One repo per user — re-indexing updates the existing doc, doesn't duplicate.
repoSchema.index({ userId: 1, fullName: 1 }, { unique: true });

const Repo = mongoose.model('Repo', repoSchema);
export default Repo;

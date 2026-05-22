import mongoose from 'mongoose';

export const KB_SOURCES = ['owasp', 'cwe', 'cve_pattern', 'best_practice'];
export const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

const securityKbSchema = new mongoose.Schema(
  {
    source: { type: String, enum: KB_SOURCES, required: true, index: true },
    identifier: { type: String, required: true, index: true }, // e.g. CWE-89, OWASP-A03
    title: { type: String, required: true },
    description: { type: String, required: true },
    language: { type: String, default: 'all', index: true },
    examples: {
      vulnerable: { type: String, default: null },
      safe: { type: String, default: null },
    },
    references: { type: [String], default: [] },
    severity: { type: String, enum: SEVERITY_LEVELS, default: 'medium' },
    // 768-dim from gemini-embedding-001 (matches code chunks for consistency).
    // A separate Atlas vector index `security_kb_vector_index` is created on
    // this collection in Phase 8 once data is seeded.
    embedding: { type: [Number], default: undefined },
  },
  { timestamps: true }
);

securityKbSchema.index({ source: 1, identifier: 1 }, { unique: true });

const SecurityKB = mongoose.model('SecurityKB', securityKbSchema);
export default SecurityKB;

import mongoose from 'mongoose';
import { z } from 'zod';

export const REVIEW_STATUSES = ['queued', 'running', 'complete', 'failed', 'stopped'];
export const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'];

// Zod schema for what the final phase MUST produce — validates LLM output
// before we accept it into the DB. The agent loop reprompts if parsing fails.
export const FindingSchema = z.object({
  severity: z.enum(SEVERITY_LEVELS),
  category: z.string().min(1).max(64), // 'xss', 'sql_injection', etc
  title: z.string().min(5).max(200),
  description: z.string().min(20),
  filepath: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  codeSnippet: z.string().default(''),
  suggestedFix: z.string().default(''),
  references: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  exploitabilityNotes: z.string().default(''),
});

export const ReviewOutputSchema = z.object({
  summary: z.string().min(20),
  riskAssessment: z.enum(RISK_LEVELS),
  findings: z.array(FindingSchema),
});

const phaseSubSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    output: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
  },
  { _id: false }
);

const toolCallSubSchema = new mongoose.Schema(
  {
    phase: { type: String, required: true },
    tool: { type: String, required: true },
    arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    durationMs: { type: Number, default: null },
    timestamp: { type: Date, default: () => new Date() },
    error: { type: String, default: null },
  },
  { _id: false }
);

const findingSubSchema = new mongoose.Schema(
  {
    severity: { type: String, enum: SEVERITY_LEVELS, required: true },
    category: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    filepath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    codeSnippet: { type: String, default: '' },
    suggestedFix: { type: String, default: '' },
    references: { type: [String], default: [] },
    confidence: { type: Number, default: 0.5 },
    exploitabilityNotes: { type: String, default: '' },
  },
  { _id: false }
);

const reviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    repoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Repo', default: null, index: true },
    // PR coordinates
    prUrl: { type: String, required: true },
    prOwner: { type: String, required: true },
    prRepo: { type: String, required: true },
    prNumber: { type: Number, required: true },
    prTitle: { type: String, default: null },
    baseSha: { type: String, default: null },
    headSha: { type: String, default: null },

    status: { type: String, enum: REVIEW_STATUSES, default: 'queued', index: true },
    statusMessage: { type: String, default: null },

    // Which LLM(s) answered. The router's triedProviders[] gets aggregated here.
    modelUsed: { type: String, default: null },
    providersTried: { type: [mongoose.Schema.Types.Mixed], default: [] },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    phases: { type: [phaseSubSchema], default: [] },
    toolCalls: { type: [toolCallSubSchema], default: [] },
    findings: { type: [findingSubSchema], default: [] },

    summary: { type: String, default: null },
    riskAssessment: { type: String, enum: [...RISK_LEVELS, null], default: null },

    tokensUsed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Review = mongoose.model('Review', reviewSchema);
export default Review;

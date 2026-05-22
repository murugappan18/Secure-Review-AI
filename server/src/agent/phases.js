// The 5 review phases. Each takes (context, runOptions) and returns
// { runResult, parsed, parseError } where:
//   runResult: full output from runWithTools (text, iterations, toolCalls, usage)
//   parsed:    JSON value parsed from runResult.text, or null on parse failure
//   parseError: error message if JSON parsing failed
//
// The orchestrator (agentLoop.js) calls them in sequence, accumulating their
// outputs into the shared context object. Tool palettes per phase are chosen
// to minimize prompt size and focus the LLM on the right exploration surface.

import { runWithTools, parsePhaseJson } from './runWithTools.js';
import { getGenericTools } from '../mcp/registry.js';
import {
  SYSTEM_PROMPT,
  PHASE_1_PROMPT,
  PHASE_2_PROMPT,
  PHASE_3_PROMPT,
  PHASE_4_PROMPT,
  PHASE_5_PROMPT,
} from './prompts.js';

// Simple {name} substitution for prompts that need variables baked in.
function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`
  );
}

// Build a single user message containing the verbatim PR patches. Files
// added by this PR aren't in indexed chunks, so the agent has no other
// reliable way to see their code. Capped per file so a huge PR doesn't
// blow context.
function patchesMessage(prFiles) {
  if (!prFiles?.length) return null;
  const blocks = prFiles
    .map((f) => {
      if (!f.patch) {
        return `## ${f.filename} (${f.status}) — binary or unavailable patch`;
      }
      const patch =
        f.patch.length > 6000 ? f.patch.slice(0, 6000) + '\n... [truncated]' : f.patch;
      return `## ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join('\n\n');
  return {
    role: 'user',
    content: `### CANONICAL PR PATCHES (use these for verbatim code references)\n${blocks}`,
  };
}

// Shared post-processing: parse JSON, attach parsing diagnostics.
function finalize(runResult) {
  const parsed = parsePhaseJson(runResult.text);
  return {
    runResult,
    parsed: parsed.ok ? parsed.value : null,
    parseError: parsed.ok ? null : parsed.error,
  };
}

// -------------------------------------------------------------------------
// PHASE 1: Understand the diff
// -------------------------------------------------------------------------
export async function understandDiff(ctx, runOpts) {
  const userPrompt = fmt(PHASE_1_PROMPT, {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    prTitle: ctx.prTitle ?? '(unknown)',
  });

  const result = await runWithTools({
    phaseName: 'understand_diff',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    tools: getGenericTools({ servers: ['github'] }),
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
  });

  return finalize(result);
}

// -------------------------------------------------------------------------
// PHASE 2: Gather context
// -------------------------------------------------------------------------
export async function gatherContext(ctx, runOpts) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: PHASE_2_PROMPT },
    {
      role: 'user',
      content: `Phase 1 produced this diff summary:\n${JSON.stringify(
        ctx.diffSummary,
        null,
        2
      )}`,
    },
  ];
  const patches = patchesMessage(ctx.prFiles);
  if (patches) messages.push(patches);

  const result = await runWithTools({
    phaseName: 'gather_context',
    messages,
    // Codebase only. Phase 1 already pulled all GitHub data into context;
    // exposing github tools here invites hallucinated re-fetches.
    tools: getGenericTools({ servers: ['codebase'] }),
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
  });

  return finalize(result);
}

// -------------------------------------------------------------------------
// PHASE 3: Reason about exploitability
// -------------------------------------------------------------------------
export async function reasonExploitability(ctx, runOpts) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: PHASE_3_PROMPT },
    {
      role: 'user',
      content:
        `Phase 1 (diff summary):\n${JSON.stringify(ctx.diffSummary, null, 2)}` +
        `\n\nPhase 2 (surrounding context):\n${JSON.stringify(
          ctx.gatheredContext,
          null,
          2
        )}`,
    },
  ];
  const patches = patchesMessage(ctx.prFiles);
  if (patches) messages.push(patches);

  const result = await runWithTools({
    phaseName: 'reason_exploitability',
    messages,
    tools: getGenericTools({ servers: ['codebase', 'security'] }),
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
  });

  return finalize(result);
}

// -------------------------------------------------------------------------
// PHASE 4: Compare patterns
// -------------------------------------------------------------------------
export async function comparePatterns(ctx, runOpts) {
  // Short-circuit if Phase 3 returned no candidates — nothing to compare.
  const candidates = ctx.candidatesPhase?.candidates ?? [];
  if (candidates.length === 0) {
    return {
      runResult: null,
      parsed: { findings: [] },
      parseError: null,
      shortCircuited: true,
    };
  }

  const result = await runWithTools({
    phaseName: 'compare_patterns',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: PHASE_4_PROMPT },
      {
        role: 'user',
        content: `Phase 3 produced these candidates:\n${JSON.stringify(
          ctx.candidatesPhase,
          null,
          2
        )}`,
      },
    ],
    tools: getGenericTools({ servers: ['codebase'] }),
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
  });

  return finalize(result);
}

// -------------------------------------------------------------------------
// PHASE 5: Generate the final review (no tool calls)
// -------------------------------------------------------------------------
export async function generateReview(ctx, runOpts) {
  // If we have nothing to report, fabricate the empty review here without
  // burning an LLM call.
  const findings = ctx.refinedPhase?.findings ?? [];
  if (findings.length === 0) {
    return {
      runResult: null,
      parsed: {
        summary:
          'No security vulnerabilities were identified by the agent during this review.',
        riskAssessment: 'low',
        findings: [],
      },
      parseError: null,
      shortCircuited: true,
    };
  }

  const result = await runWithTools({
    phaseName: 'generate_review',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: PHASE_5_PROMPT },
      {
        role: 'user',
        content:
          `Diff summary:\n${JSON.stringify(ctx.diffSummary, null, 2)}` +
          `\n\nRefined findings from Phase 4:\n${JSON.stringify(
            ctx.refinedPhase,
            null,
            2
          )}`,
      },
    ],
    // No tools — pure synthesis. LLM can only respond with text.
    tools: [],
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
    maxIterations: 1,
  });

  return finalize(result);
}

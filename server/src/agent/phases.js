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

// Map Phase 3 confidence + impact-text to a coarse severity for the
// graceful-degradation path. Conservative: only "critical" when it's clearly
// RCE-ish, else "high"/"medium" by confidence.
function severityFromConfidence(confidence, impact = '') {
  const i = String(impact).toLowerCase();
  if (i.includes('rce') || i.includes('arbitrary code') || i.includes('full takeover')) {
    return 'critical';
  }
  if ((confidence ?? 0) >= 0.85) return 'high';
  if ((confidence ?? 0) >= 0.6) return 'medium';
  return 'low';
}

function humanizeCategory(slug) {
  return String(slug)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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

  const out = finalize(result);

  // If the first pass produced parseable JSON, we're done.
  if (!out.parseError) return out;
  // If there's nothing the LLM looked at, no point retrying — it has no
  // evidence to synthesize from.
  if (!result.toolCalls?.length) return out;

  // ---- Forced-synthesis retry --------------------------------------------
  // Common failure mode (esp. Gemini Flash Lite): the agent burns all
  // iterations on lookup_cwe / search_code calls but never produces the
  // final JSON. We have rich tool-call evidence on hand — fold it back into
  // the prompt and ask the LLM to emit ONLY the JSON now, no more tools.
  console.warn(
    `[agent] Phase 3 first pass produced no parseable JSON (${out.parseError}); ` +
      `retrying with ${result.toolCalls.length} tool-call summary, no tools.`
  );

  const toolSummary = result.toolCalls
    .map((tc, i) => {
      const args = safeStringify(tc.arguments);
      const res = safeStringify(tc.result, 1000);
      return `${i + 1}. ${tc.tool}(${args})\n   → ${res}`;
    })
    .join('\n\n');

  const forced = await runWithTools({
    phaseName: 'reason_exploitability_retry',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: PHASE_3_PROMPT },
      ...messages.slice(2), // diff summary + context + patches blocks
      {
        role: 'user',
        content:
          `You already made ${result.toolCalls.length} tool calls. ` +
          `Summary of what they returned:\n\n${toolSummary}\n\n` +
          `Now produce the STRICT JSON specified in the Phase 3 instructions above. ` +
          `Do NOT call more tools. Do NOT add prose or markdown fences. ` +
          `Emit only the JSON object with the "candidates" array. ` +
          `If, given this evidence, you cannot identify any real vulnerability with ` +
          `confidence ≥ 0.5, return {"candidates": []}.`,
      },
    ],
    tools: [], // hard-disable tools — force a text answer
    ctx,
    preferProvider: runOpts.preferProvider,
    onEvent: runOpts.onEvent,
    maxIterations: 1,
  });

  const forcedOut = finalize(forced);

  // Merge: keep the original tool calls (so the UI still shows what was
  // gathered) but use the retry's text as the parsed output.
  return {
    runResult: {
      ...forced,
      toolCalls: [...result.toolCalls, ...(forced.toolCalls ?? [])],
      usage: {
        inputTokens:
          (result.usage?.inputTokens ?? 0) + (forced.usage?.inputTokens ?? 0),
        outputTokens:
          (result.usage?.outputTokens ?? 0) + (forced.usage?.outputTokens ?? 0),
      },
      providers: [
        ...new Set([
          ...(result.providers ?? []),
          ...(forced.providers ?? []),
        ]),
      ],
    },
    parsed: forcedOut.parsed,
    parseError: forcedOut.parseError
      ? `phase 3 retry also failed: ${forcedOut.parseError}`
      : null,
  };
}

// Safely stringify possibly-huge / circular tool results for prompt inclusion.
function safeStringify(value, maxLen = 500) {
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? s.slice(0, maxLen) + '…[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
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

  // If Phase 4 degraded (e.g. quota exhausted), synthesize findings from the
  // Phase 3 candidates WITHOUT a Phase 5 LLM call. The candidates already
  // have the key fields; we just need to reshape them into the final schema.
  // This means even a partially-rate-limited review still produces findings.
  if (ctx.refinedPhase?.degraded) {
    console.warn('[agent] Phase 5: synthesizing locally from Phase 3 (Phase 4 was degraded)');
    const synthesized = findings.map((c) => ({
      severity: severityFromConfidence(c.confidence, c.impact),
      category: c.category ?? 'unknown',
      title: c.category
        ? `${humanizeCategory(c.category)} in ${c.filepath}`
        : `Potential vulnerability in ${c.filepath}`,
      description:
        `${c.impact ?? 'Potential security issue.'} ${c.attackVector ? 'Attack vector: ' + c.attackVector + '.' : ''}`.trim(),
      filepath: c.filepath ?? 'unknown',
      startLine: c.startLine ?? 0,
      endLine: c.endLine ?? c.startLine ?? 0,
      codeSnippet: Array.isArray(c.evidence) ? c.evidence.join('\n') : (c.evidence ?? ''),
      suggestedFix: '',
      references: c.cwe ? [`https://cwe.mitre.org/data/definitions/${String(c.cwe).replace(/^CWE-/i, '')}.html`] : [],
      confidence: c.confidence ?? 0.6,
      exploitabilityNotes: c.impact ?? '',
    }));
    return {
      runResult: null,
      parsed: {
        summary: `Review partially completed — Phase 4 (codebase comparison) skipped due to: ${ctx.refinedPhase.phase4Error ?? 'unknown error'}. ${synthesized.length} candidate finding(s) from Phase 3 are reported below.`,
        riskAssessment: synthesized.some((f) => f.severity === 'critical')
          ? 'critical'
          : synthesized.some((f) => f.severity === 'high')
            ? 'high'
            : 'medium',
        findings: synthesized,
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

// The per-phase inner agentic loop.
//
// One call to runWithTools represents one PHASE of the review. The phase has:
//   - a starting message stack (system + user instructions + any prior context)
//   - a tool palette (a subset of registered MCP tools, in generic shape)
//   - a context (repoId, accessToken) used when tools fire
//
// Loop semantics:
//   1. Call the LLM with the current messages + tools.
//   2. If the LLM returns tool calls, execute each, append the result, loop.
//   3. If the LLM returns text (no tool calls), that's the final answer for
//      this phase — return it.
//   4. Bounded by maxIterations to prevent runaway loops on a confused model.
//
// Telemetry: the optional `onEvent` callback fires for every meaningful
// transition (iteration start, tool call, tool result, finish, timeout). The
// orchestrator hooks this to persist tool calls on the Review doc and to
// forward live events to the WebSocket (Phase 10).

import { chat } from '../services/llm/llmRouter.js';
import { executeToolCall } from '../mcp/registry.js';

const DEFAULT_MAX_ITER = Number(process.env.MAX_AGENT_ITERATIONS) || 6;

export async function runWithTools({
  phaseName,
  messages,
  tools,
  ctx,
  preferProvider,
  model,
  maxIterations = DEFAULT_MAX_ITER,
  onEvent = () => {},
}) {
  const trace = [...messages];
  const toolCallRecords = [];
  let lastResponse = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const providersUsed = new Set();

  for (let iter = 1; iter <= maxIterations; iter++) {
    onEvent({ type: 'iteration_start', phase: phaseName, iter });

    let response;
    try {
      response = await chat({ messages: trace, tools, preferProvider, model });
    } catch (err) {
      onEvent({ type: 'llm_error', phase: phaseName, iter, error: err.message });
      throw err;
    }

    lastResponse = response;
    providersUsed.add(response.provider);
    totalInputTokens += response.usage?.inputTokens ?? 0;
    totalOutputTokens += response.usage?.outputTokens ?? 0;

    onEvent({
      type: 'llm_response',
      phase: phaseName,
      iter,
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      hasText: !!response.text,
      toolCallCount: response.toolCalls.length,
      usage: response.usage,
    });

    // No more tool calls — the LLM has produced its final answer for this phase.
    if (response.toolCalls.length === 0) {
      onEvent({ type: 'phase_final', phase: phaseName, iter });
      return {
        response,
        text: response.text ?? '',
        iterations: iter,
        toolCalls: toolCallRecords,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        providers: [...providersUsed],
        hitMaxIter: false,
      };
    }

    // Append the assistant turn carrying the tool_call payloads.
    trace.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    // Execute every requested tool call in order.
    for (const tc of response.toolCalls) {
      onEvent({
        type: 'tool_call',
        phase: phaseName,
        iter,
        tool: tc.name,
        arguments: tc.arguments,
      });

      const t0 = Date.now();
      const result = await executeToolCall(tc.name, tc.arguments, ctx);
      const durationMs = Date.now() - t0;

      const record = {
        phase: phaseName,
        tool: tc.name,
        arguments: tc.arguments,
        result,
        durationMs,
        timestamp: new Date(),
        error: result?.error ?? null,
      };
      toolCallRecords.push(record);

      onEvent({ type: 'tool_result', phase: phaseName, iter, tool: tc.name, durationMs, result });

      trace.push({
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  // Reached max iterations without a final text answer. The orchestrator will
  // decide whether to treat this as a phase failure or a partial result.
  onEvent({ type: 'max_iter', phase: phaseName, iterations: maxIterations });
  return {
    response: lastResponse,
    text: lastResponse?.text ?? '',
    iterations: maxIterations,
    toolCalls: toolCallRecords,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    providers: [...providersUsed],
    hitMaxIter: true,
  };
}

// Find the first complete JSON value in `text` using a brace-matching scan.
// Handles strings + escapes so braces inside quoted strings don't confuse us.
// Returns the substring (still raw JSON text) or null if no balanced value.
function extractBalancedJson(text) {
  // Find the first { or [.
  let firstAt = -1;
  let openChar = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      firstAt = i;
      openChar = text[i];
      break;
    }
  }
  if (firstAt < 0) return null;

  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstAt; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(firstAt, i + 1);
      }
    }
  }
  return null;
}

// Parse the LLM's text as JSON. Tolerates:
//  - markdown code fences (```json ... ```)
//  - leading/trailing prose
//  - multiple JSON objects concatenated (we take the first balanced one)
// Returns { ok: true, value } or { ok: false, error, raw }.
export function parsePhaseJson(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'empty response', raw: text };
  }

  // Strip markdown fences if present.
  const stripped = text
    .replace(/^\s*```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  const candidate = extractBalancedJson(stripped);
  if (!candidate) {
    return { ok: false, error: 'no balanced JSON value found', raw: text };
  }

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (err) {
    return { ok: false, error: err.message, raw: text };
  }
}

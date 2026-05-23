import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import { synthToolCallId, parseArgs } from './types.js';
import { getUserApiKey, getUserModel } from '../../utils/userContext.js';
import { getCurrentAbortSignal } from '../../utils/abortContext.js';

// Proactive throttling. Gemini Flash free tier is 15 RPM — one request every
// 4 seconds. We enforce a 4.5s minimum gap between requests so we NEVER trip
// the limit, instead of paying the much larger cost of a 60s 429 retry.
// All Gemini requests funnel through this gate.
let lastRequestAt = 0;
const MIN_REQUEST_INTERVAL_MS = 4500;

async function throttleGemini() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const wait = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

// Same as throttleGemini, but interruptible by an AbortSignal. Used by
// the agent loop so the Stop button doesn't have to wait up to 4.5s for
// the in-flight throttle sleep to finish.
async function throttleGeminiAbortable(signal) {
  if (!signal) return throttleGemini();
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const wait = MIN_REQUEST_INTERVAL_MS - elapsed;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted_during_throttle'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  lastRequestAt = Date.now();
}

// Convert our normalized message list into Gemini's contents[] format.
// Gemini uses 'user' and 'model' roles; tool results come back as
// 'function' role parts; the system message is set separately.
//
// IMPORTANT for Gemini 3.x: when we feed a previous tool_use response back,
// we MUST preserve the per-tool-call `thoughtSignature` the model returned.
// We stash it on each tool call as `_thoughtSignature` when receiving, and
// re-emit it in the same position when sending. Missing this returns:
//   400 "Function call is missing a thought_signature"
function toGeminiContents(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = m.content;
      continue;
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          const part = { functionCall: { name: tc.name, args: tc.arguments } };
          if (tc._thoughtSignature) part.thoughtSignature = tc._thoughtSignature;
          parts.push(part);
        }
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      // Gemini expects a 'function' role with a functionResponse part. The
      // `response` field is a Struct proto — must be a plain object. Arrays,
      // strings, numbers all need to be wrapped, otherwise the API returns
      // "Proto field is not repeating, cannot start list".
      let parsed;
      try {
        parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
      } catch {
        parsed = String(m.content);
      }
      const response =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : { result: parsed };

      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: m.name, response } }],
      });
    }
  }

  return { contents, systemInstruction };
}

function toGeminiTools(tools) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

export async function chat({ messages, tools, model }) {
  // Pure BYOK — no env fallback. Routes pre-flight users, so reaching this
  // path without a key is a code bug (or a dev script that should set its
  // own context).
  const apiKey = getUserApiKey('gemini');
  if (!apiKey) {
    const err = new Error('[gemini] no Gemini API key configured for this user');
    err.code = 'NO_USER_API_KEY';
    throw err;
  }

  // Model: explicit arg > user preference > sensible default.
  const modelName = model || getUserModel('gemini') || 'gemini-3.1-flash-lite';
  const genai = new GoogleGenerativeAI(apiKey);
  const { contents, systemInstruction } = toGeminiContents(messages);

  const generativeModel = genai.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction ?? undefined,
    tools: toGeminiTools(tools),
    toolConfig: tools?.length
      ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
      : undefined,
  });

  const signal = getCurrentAbortSignal();
  await throttleGeminiAbortable(signal);
  if (signal?.aborted) {
    const err = new Error('aborted_before_llm_call');
    err.code = 'REVIEW_STOPPED';
    throw err;
  }
  // @google/generative-ai v0.24+ accepts a signal on SingleRequestOptions —
  // this lets us interrupt an in-flight generateContent call, not just the
  // gap between calls.
  let result;
  try {
    result = await generativeModel.generateContent(
      { contents },
      signal ? { signal } : undefined
    );
  } catch (err) {
    // If the SDK surfaced an abort error, normalize it to our code.
    if (signal?.aborted || err.name === 'AbortError') {
      const stop = new Error('aborted_during_llm_call');
      stop.code = 'REVIEW_STOPPED';
      throw stop;
    }
    throw err;
  }
  const response = result.response;

  // Walk the candidate parts directly so we can capture the per-tool-call
  // `thoughtSignature` that Gemini 3.x requires we echo back next turn.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const toolCalls = [];
  let text = null;
  let idx = 0;
  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        id: synthToolCallId(p.functionCall.name, idx++),
        name: p.functionCall.name,
        arguments: parseArgs(p.functionCall.args),
        _thoughtSignature: p.thoughtSignature ?? null,
      });
    } else if (p.text && !p.thought) {
      text = (text ?? '') + p.text;
    }
  }

  const finishReason =
    toolCalls.length > 0
      ? 'tool_use'
      : response.candidates?.[0]?.finishReason === 'MAX_TOKENS'
        ? 'length'
        : 'stop';

  return {
    provider: 'gemini',
    model: modelName,
    text,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import { synthToolCallId, parseArgs } from './types.js';

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('[gemini] GEMINI_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const modelName = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

  await throttleGemini();
  const result = await generativeModel.generateContent({ contents });
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

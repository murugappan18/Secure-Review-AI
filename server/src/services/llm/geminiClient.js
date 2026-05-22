import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai';
import { synthToolCallId, parseArgs } from './types.js';

// Convert our normalized message list into Gemini's contents[] format.
// Gemini uses 'user' and 'model' roles; tool results come back as
// 'function' role parts; the system message is set separately.
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
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
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

  const result = await generativeModel.generateContent({ contents });
  const response = result.response;

  // Pull tool calls (if any) out of the response candidates.
  const functionCalls = response.functionCalls?.() ?? [];
  const toolCalls = functionCalls.map((fc, i) => ({
    id: synthToolCallId(fc.name, i),
    name: fc.name,
    arguments: parseArgs(fc.args),
  }));

  // Text is best-effort — when the model only returned function calls,
  // calling .text() can throw. Guard it.
  let text = null;
  try {
    text = response.text() ?? null;
  } catch {
    text = null;
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

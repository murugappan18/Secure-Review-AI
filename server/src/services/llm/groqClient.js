import Groq from 'groq-sdk';
import { parseArgs, synthToolCallId } from './types.js';
import {
  getUserApiKey,
  getUserModel,
  hasUserContext,
} from '../../utils/userContext.js';

// Groq exposes an OpenAI-compatible chat completions API, so the message and
// tool-call shapes are essentially OpenAI's.
//
// NOTE: Groq's API endpoint (api.groq.com) is blocked by Zscaler on the
// developer's Cognizant laptop, so this client will fail locally with a
// network error. It still works on Render. Kept here for portability.

function toGroqMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'system' || m.role === 'user') {
      return { role: m.role, content: m.content };
    }
    if (m.role === 'assistant') {
      const base = { role: 'assistant', content: m.content ?? null };
      if (m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      return base;
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content:
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }
    return m;
  });
}

function toGroqTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function chat({ messages, tools, model }) {
  // BYOK in HTTP requests; env fallback for dev scripts only.
  const apiKey = hasUserContext()
    ? getUserApiKey('groq')
    : process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('[groq] no Groq API key available');
    err.code = 'NO_USER_API_KEY';
    throw err;
  }

  const modelName =
    model ||
    (hasUserContext() ? getUserModel('groq') : null) ||
    process.env.GROQ_MODEL ||
    'llama-3.3-70b-versatile';
  const client = new Groq({ apiKey });

  let response;
  try {
    response = await client.chat.completions.create({
      model: modelName,
      messages: toGroqMessages(messages),
      tools: toGroqTools(tools),
      tool_choice: tools?.length ? 'auto' : undefined,
    });
  } catch (err) {
    // Llama-3.x on Groq occasionally emits tool calls as raw text in the
    // shape   <function=NAME{...JSON...}</function>   instead of the
    // proper OpenAI `tool_calls` structure. Groq's server detects this
    // and rejects with 400 / code='tool_use_failed', stashing the
    // malformed output in `failed_generation`. We recover by parsing
    // that text ourselves and synthesising a normal tool-call response.
    const recovered = tryRecoverFromToolUseFailure(err, modelName);
    if (recovered) return recovered;
    throw err;
  }

  const choice = response.choices?.[0];
  const msg = choice?.message;

  const toolCalls =
    msg?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseArgs(tc.function.arguments),
    })) ?? [];

  const finishReason =
    choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice?.finish_reason === 'length'
        ? 'length'
        : 'stop';

  return {
    provider: 'groq',
    model: modelName,
    text: msg?.content ?? null,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- Llama-on-Groq tool-use recovery -----------------------------------
// When a Llama 3.x model emits a tool call in its own bespoke text
// format instead of the proper OpenAI `tool_calls` array, Groq's server
// rejects the response with HTTP 400 + code 'tool_use_failed' and
// includes the raw text in `failed_generation`. We catch that error,
// parse the text back into structured tool calls, and return them as if
// the model had emitted them correctly the first time. Callers above
// don't need to know any of this happened.

function tryRecoverFromToolUseFailure(err, modelName) {
  // The Groq SDK shape: err.status, err.error = { message, code, failed_generation }.
  // Fall back to err.response?.data for the raw axios case just in case.
  const status = err?.status ?? err?.response?.status;
  const errBody = err?.error ?? err?.response?.data?.error;
  if (status !== 400 || errBody?.code !== 'tool_use_failed') return null;

  const failed = errBody.failed_generation;
  const parsed = parseLlamaToolUseFailure(failed);
  if (!parsed || parsed.length === 0) return null;

  console.warn(
    `[groq] recovered ${parsed.length} tool call(s) from tool_use_failed: ` +
      parsed.map((c) => c.name).join(', ')
  );

  return {
    provider: 'groq',
    model: modelName,
    text: null,
    toolCalls: parsed.map((c, i) => ({
      id: synthToolCallId(c.name, i),
      name: c.name,
      arguments: c.arguments,
    })),
    finishReason: 'tool_use',
    // Groq didn't report usage on the failed response.
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// Parse one-or-more <function=NAME{...JSON...}</function> blocks out of
// the text Llama produced. Tolerates: multiple calls in the same blob,
// whitespace between </function> blocks, trailing junk after the last
// closing tag.
function parseLlamaToolUseFailure(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];
  // Match the opening <function=NAME up to (but not including) the {.
  const re = /<function=([\w.-]+)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    // The brace that triggered the regex is the start of the args JSON.
    const braceStart = m.index + m[0].length - 1;
    const argsJson = extractBalancedJson(text.slice(braceStart));
    if (!argsJson) continue;
    let args = {};
    try {
      args = JSON.parse(argsJson);
    } catch {
      // Args weren't strict JSON — skip this call rather than guess.
      continue;
    }
    calls.push({ name, arguments: args });
    // Advance the regex past this match so we don't re-match the same one.
    re.lastIndex = braceStart + argsJson.length;
  }
  return calls;
}

// Walk a string starting at a '{' and return the balanced JSON object,
// honoring string-literal escapes. Returns null if no balanced object.
function extractBalancedJson(text) {
  if (!text || text[0] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
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
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

import Groq from 'groq-sdk';
import { parseArgs } from './types.js';
import { getUserApiKey, getUserModel } from '../../utils/userContext.js';

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
  // Pure BYOK — no env fallback.
  const apiKey = getUserApiKey('groq');
  if (!apiKey) {
    const err = new Error('[groq] no Groq API key configured for this user');
    err.code = 'NO_USER_API_KEY';
    throw err;
  }

  const modelName = model || getUserModel('groq') || 'llama-3.3-70b-versatile';
  const client = new Groq({ apiKey });

  const response = await client.chat.completions.create({
    model: modelName,
    messages: toGroqMessages(messages),
    tools: toGroqTools(tools),
    tool_choice: tools?.length ? 'auto' : undefined,
  });

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

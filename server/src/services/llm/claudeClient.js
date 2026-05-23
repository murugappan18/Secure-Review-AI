import Anthropic from '@anthropic-ai/sdk';
import { getUserApiKey, getUserModel } from '../../utils/userContext.js';

// Claude's messages API takes a separate `system` parameter (not a message)
// and represents tool use as `tool_use` / `tool_result` content blocks
// rather than separate roles.

function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled separately

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    if (m.role === 'tool') {
      // Tool results in Claude live inside a user-role message as
      // tool_result content blocks. We can either merge multiple tool
      // results into one user message or send them individually; the API
      // accepts both. We send individually for simplicity.
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content:
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content),
          },
        ],
      });
    }
  }
  return out;
}

function extractSystem(messages) {
  const sys = messages.find((m) => m.role === 'system');
  return sys?.content;
}

function toClaudeTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export async function chat({ messages, tools, model }) {
  // Pure BYOK — no env fallback.
  const apiKey = getUserApiKey('claude');
  if (!apiKey) {
    const err = new Error('[claude] no Claude API key configured for this user');
    err.code = 'NO_USER_API_KEY';
    throw err;
  }

  const modelName = model || getUserModel('claude') || 'claude-sonnet-4-5';
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelName,
    max_tokens: 4096,
    system: extractSystem(messages),
    messages: toClaudeMessages(messages),
    tools: toClaudeTools(tools),
  });

  // Walk the content blocks to separate text from tool_use.
  let text = null;
  const toolCalls = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      text = (text ?? '') + block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
    }
  }

  const finishReason =
    response.stop_reason === 'tool_use'
      ? 'tool_use'
      : response.stop_reason === 'max_tokens'
        ? 'length'
        : 'stop';

  return {
    provider: 'claude',
    model: modelName,
    text,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}

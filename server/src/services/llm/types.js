// Shared types and helpers for the LLM client layer.
//
// All three clients (gemini, groq, claude) accept the same input shape and
// return the same output shape. This keeps the agent loop (Phase 7) provider-
// agnostic — it only knows about "an LLM with tools".
//
// --- INPUT ---
//
// chat({ messages, tools, model? })
//
//   messages: [
//     { role: 'system', content: string }
//     { role: 'user',   content: string }
//     { role: 'assistant', content?: string, toolCalls?: [{id,name,arguments}] }
//     { role: 'tool', toolCallId: string, name: string, content: string }
//   ]
//
//   tools: [
//     { name, description, parameters: <JSON Schema object> }
//   ]
//
// --- OUTPUT ---
//
//   {
//     provider: 'gemini' | 'groq' | 'claude',
//     model:    string,                // the model name that actually answered
//     text:     string | null,         // assistant text, if any
//     toolCalls:[{ id, name, arguments }],  // arguments parsed to JS object
//     finishReason: 'stop' | 'tool_use' | 'length' | 'error',
//     usage:    { inputTokens, outputTokens }
//   }

// Tiny utility: synthesize a tool-call id where the provider didn't give us
// one (Gemini doesn't). The id is only used for correlation across one round
// trip; it doesn't need to be globally unique.
export function synthToolCallId(name, index) {
  return `tc_${name}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

// Safe JSON parse with a default. Some providers occasionally return slightly
// malformed JSON for tool arguments under load; we don't want to crash.
export function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: String(raw), _parseError: true };
  }
}

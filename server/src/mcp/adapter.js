// MCP ↔ provider adapter.
//
// Our MCP tool shape (see types.js) uses `inputSchema`. Each LLM provider
// has its own preferred field name and surrounding envelope:
//
//   MCP        → { name, description, inputSchema, handler }
//   Generic    → { name, description, parameters }              ← our LLM clients
//   Gemini     → { name, description, parameters }              ← functionDeclarations[]
//   Claude     → { name, description, input_schema }
//   OpenAI/Groq→ { type: 'function', function: { name, description, parameters } }
//
// The LLM clients in src/services/llm/* already accept the GENERIC shape and
// handle provider-specific envelope-wrapping internally. So the adapter's
// primary job here is the MCP → Generic conversion. The per-provider helpers
// are kept for documentation, debugging, and any future caller that bypasses
// our generic clients (e.g., a Claude Desktop integration speaking real MCP).

// --- Generic (consumable by our llmRouter) ---
export function mcpToGenericTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,
  };
}

export function mcpToGenericTools(mcpTools) {
  return mcpTools.map(mcpToGenericTool);
}

// --- Provider-native variants (for direct SDK use without our llm clients) ---

export function mcpToGeminiFunction(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,
  };
}

export function mcpToClaudeTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    input_schema: mcpTool.inputSchema,
  };
}

export function mcpToOpenAiTool(mcpTool) {
  return {
    type: 'function',
    function: {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
    },
  };
}

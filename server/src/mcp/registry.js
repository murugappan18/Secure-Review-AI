// Tool registry — single source of truth for every MCP tool the agent can
// call. Bootstraps all three MCP servers in-process at import time.
//
// On in-process vs stdio (per INSTRUCTIONS.md §6.1 step 6):
//
//   For a monolithic backend like ours, running MCP servers as separate
//   stdio child processes adds latency and complexity for zero functional
//   benefit. What matters architecturally is that our tools FOLLOW the MCP
//   tool spec (name + description + JSON-Schema input + handler). That
//   contract is what makes the codebase portable: someone could later wrap
//   any of these "servers" in a real MCP `Server` + `StdioServerTransport`
//   and plug them into Claude Desktop or Cursor with ~30 lines of glue.

import { codebaseTools, codebaseServerInfo } from './servers/codebase/server.js';
import { securityTools, securityServerInfo } from './servers/security/server.js';
import { githubTools, githubServerInfo } from './servers/github/server.js';
import { validateArgs } from './types.js';
import { mcpToGenericTools } from './adapter.js';

// name → { tool, serverName }
const REGISTRY = new Map();

function register(tool, serverName) {
  if (REGISTRY.has(tool.name)) {
    throw new Error(`[mcp] duplicate tool name across servers: ${tool.name}`);
  }
  REGISTRY.set(tool.name, { tool, serverName });
}

for (const t of codebaseTools) register(t, 'codebase');
for (const t of securityTools) register(t, 'security');
for (const t of githubTools) register(t, 'github');

export const SERVERS = [codebaseServerInfo, securityServerInfo, githubServerInfo];

// --- Public API --------------------------------------------------------

// Get the MCP tool definitions (untouched, with handlers attached). Filter
// by which server(s) you care about — e.g. omit github for a non-PR flow.
export function getMcpTools({ servers } = {}) {
  let entries = [...REGISTRY.values()];
  if (servers?.length) {
    entries = entries.filter((e) => servers.includes(e.serverName));
  }
  return entries.map((e) => e.tool);
}

// Convenience: get tools in the generic shape (`parameters` instead of
// `inputSchema`) that our LLM clients consume. Hands-off conversion via
// the adapter.
export function getGenericTools(opts) {
  return mcpToGenericTools(getMcpTools(opts));
}

// Execute a tool by name. Validates args against its inputSchema, then
// calls the handler with the supplied context. Errors come back as
// { error: string } so the agent loop can feed them to the LLM rather than
// crashing the whole review.
export async function executeToolCall(name, args, ctx = {}) {
  const entry = REGISTRY.get(name);
  if (!entry) {
    return { error: `unknown tool: ${name}` };
  }
  const issues = validateArgs(entry.tool, args);
  if (issues.length) {
    return { error: 'invalid_arguments', issues };
  }
  try {
    return await entry.tool.handler(args, ctx);
  } catch (err) {
    console.error(`[mcp] tool ${name} threw:`, err);
    return { error: err.message?.slice(0, 300) ?? 'unknown error' };
  }
}

// Inspection helper — used by the test script and the future debug UI to
// dump "what tools does this agent have, grouped by server".
export function describeRegistry() {
  const byServer = {};
  for (const { tool, serverName } of REGISTRY.values()) {
    byServer[serverName] ??= [];
    byServer[serverName].push({
      name: tool.name,
      description: tool.description.slice(0, 120),
    });
  }
  return byServer;
}

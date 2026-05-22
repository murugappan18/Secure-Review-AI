// Shared MCP tool definition shape.
//
// We follow the Model Context Protocol's tool spec:
//
//   {
//     name:        string                 // unique identifier
//     description: string                 // when to call this tool (the LLM reads this)
//     inputSchema: { type, properties, required }   // JSON Schema for arguments
//     handler:     async (args, ctx) => result      // not part of MCP spec but
//                                                   // we attach it so the
//                                                   // registry can invoke directly
//   }
//
// The `handler` is our local extension — real MCP servers separate the tool
// declaration from the request handler. In-process we can fuse them and the
// registry just calls handler(args, ctx) when the LLM requests a tool.
//
// Context (`ctx`) is whatever the calling layer wants to pass through —
// most commonly the authenticated user (for the GitHub access token) and
// the current review's repo id. Tools declare in their description which
// context fields they need.

import { z } from 'zod';

// Validate an MCP tool definition at registration time so typos surface
// immediately rather than at first invocation.
export const McpToolSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  description: z.string().min(20),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()).optional(),
  }),
  handler: z.function(),
});

// Helper that runtime-validates a tool's args against its inputSchema.
// JSON Schema validation in JS without a heavyweight Ajv dep — we only check
// the common cases (required fields, type=string|number|boolean|array|object).
export function validateArgs(tool, args = {}) {
  const issues = [];
  const schema = tool.inputSchema ?? {};
  const required = schema.required ?? [];
  const props = schema.properties ?? {};

  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      issues.push(`missing required field: ${field}`);
    }
  }

  for (const [field, value] of Object.entries(args)) {
    const spec = props[field];
    if (!spec) continue; // unknown fields are tolerated — LLMs sometimes add extras
    if (value == null) continue;
    if (spec.type === 'string' && typeof value !== 'string') {
      issues.push(`${field} should be string, got ${typeof value}`);
    } else if (spec.type === 'number' && typeof value !== 'number') {
      issues.push(`${field} should be number, got ${typeof value}`);
    } else if (spec.type === 'boolean' && typeof value !== 'boolean') {
      issues.push(`${field} should be boolean, got ${typeof value}`);
    } else if (spec.type === 'array' && !Array.isArray(value)) {
      issues.push(`${field} should be array, got ${typeof value}`);
    } else if (spec.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      issues.push(`${field} should be object, got ${typeof value}`);
    }
  }

  return issues;
}

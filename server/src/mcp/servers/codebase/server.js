// Codebase MCP server — tools for the agent to explore the indexed codebase.
//
// All tools take a context object with at least `{ repoId }` — the registry
// passes this through from whatever review is currently being run. Tools do
// NOT trust LLM-supplied repoIds; the agent only sees the one it's working on.
//
// Each tool follows the MCP tool shape from types.js: name, description,
// inputSchema (JSON Schema), handler. The registry adapts these to Gemini /
// Claude function-call formats at call time.

import CodeChunk from '../../../models/CodeChunk.js';
import { searchCode as hybridSearch } from '../../../services/vectorSearch.service.js';

// Escape a string for safe use inside a RegExp source.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compact projection used for "list" results — drops the heavy fields.
const LIST_SELECT = '-embedding -content';

// ---------------------------------------------------------------------
// search_code — hybrid (vector + text) retrieval
// ---------------------------------------------------------------------
const SEARCH_CODE = {
  name: 'search_code',
  description:
    'Hybrid semantic + text search over the indexed code chunks of the ' +
    'current repository. Use this when you need to FIND code by meaning ' +
    '("authentication middleware", "input validation", "where SQL queries ' +
    'are built"). Returns up to `limit` chunks ranked by relevance with ' +
    'filepath, name, line range, and a snippet.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language search query.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 6, cap 20.',
      },
      language: {
        type: 'string',
        description:
          'Optional filter — javascript | typescript | tsx | python.',
      },
      type: {
        type: 'string',
        description:
          'Optional filter on chunk type — function | class | method | block | module.',
      },
    },
    required: ['query'],
  },
  async handler(args, ctx) {
    const limit = Math.min(args.limit ?? 6, 20);
    const hits = await hybridSearch(args.query, {
      repoId: ctx.repoId,
      limit,
      languages: args.language ? [args.language] : undefined,
      types: args.type ? [args.type] : undefined,
    });
    return hits.map((r) => ({
      filepath: r.filepath,
      name: r.name,
      type: r.type,
      language: r.language,
      lines: `${r.startLine}-${r.endLine}`,
      snippet: r.content?.slice(0, 600),
      score: Number(r.hybridScore?.toFixed?.(3)) || 0,
    }));
  },
};

// ---------------------------------------------------------------------
// get_file — fetch all chunks for a specific filepath
// ---------------------------------------------------------------------
const GET_FILE = {
  name: 'get_file',
  description:
    'Fetch every indexed chunk belonging to a specific file path. Use ' +
    'when you have a known filepath (from a diff hunk or a previous search ' +
    'result) and want to see the file\'s structure. Returns ordered chunks ' +
    'with full content — can be large.',
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Repo-relative path with POSIX separators, e.g. "src/auth/login.js".',
      },
    },
    required: ['filepath'],
  },
  async handler(args, ctx) {
    const chunks = await CodeChunk.find({
      repoId: ctx.repoId,
      filepath: args.filepath,
    })
      .sort({ startLine: 1 })
      .select('-embedding')
      .lean();
    return {
      filepath: args.filepath,
      chunkCount: chunks.length,
      chunks: chunks.map((c) => ({
        type: c.type,
        name: c.name,
        lines: `${c.startLine}-${c.endLine}`,
        content: c.content,
        calls: c.calls,
        metadata: c.metadata,
      })),
    };
  },
};

// ---------------------------------------------------------------------
// get_function — fetch a specific named function or class
// ---------------------------------------------------------------------
const GET_FUNCTION = {
  name: 'get_function',
  description:
    'Fetch a specific function or class chunk by its identifier name. ' +
    'Returns the first match; if the same name exists in multiple files, ' +
    'use search_code or pass `type` to disambiguate.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The identifier of the function/class/method to fetch.',
      },
      type: {
        type: 'string',
        description: 'Optional filter — function | class | method.',
      },
    },
    required: ['name'],
  },
  async handler(args, ctx) {
    const q = { repoId: ctx.repoId, name: args.name };
    if (args.type) q.type = args.type;
    const chunk = await CodeChunk.findOne(q).select('-embedding').lean();
    if (!chunk) return { found: false, name: args.name };
    return {
      found: true,
      filepath: chunk.filepath,
      type: chunk.type,
      name: chunk.name,
      lines: `${chunk.startLine}-${chunk.endLine}`,
      content: chunk.content,
      calls: chunk.calls,
      imports: chunk.imports,
      metadata: chunk.metadata,
    };
  },
};

// ---------------------------------------------------------------------
// find_callers — chunks whose `calls` array references the target
// ---------------------------------------------------------------------
const FIND_CALLERS = {
  name: 'find_callers',
  description:
    'Find every chunk that calls a given function. Matches both bare ' +
    '`foo()` and dotted forms like `obj.foo()` / `this.foo()`. Useful for ' +
    'tracing where sensitive functions get invoked (e.g. auth, exec, query).',
  inputSchema: {
    type: 'object',
    properties: {
      functionName: {
        type: 'string',
        description: 'The function/method name to find callers of (no parentheses).',
      },
    },
    required: ['functionName'],
  },
  async handler(args, ctx) {
    const escaped = escapeRegex(args.functionName);
    const pattern = new RegExp(`(^|\\.)${escaped}$`);
    const callers = await CodeChunk.find({
      repoId: ctx.repoId,
      calls: { $regex: pattern },
    })
      .select(LIST_SELECT)
      .limit(50)
      .lean();
    return {
      target: args.functionName,
      count: callers.length,
      callers: callers.map((c) => ({
        filepath: c.filepath,
        name: c.name,
        type: c.type,
        lines: `${c.startLine}-${c.endLine}`,
      })),
    };
  },
};

// ---------------------------------------------------------------------
// find_callees — for a function, find chunks for the things it calls
// ---------------------------------------------------------------------
const FIND_CALLEES = {
  name: 'find_callees',
  description:
    'For a given function name, look up its chunk and return chunks for ' +
    'each function it calls (when those functions are themselves defined ' +
    'in this repo). Inverse of find_callers.',
  inputSchema: {
    type: 'object',
    properties: {
      functionName: {
        type: 'string',
        description: 'The function whose callees you want.',
      },
    },
    required: ['functionName'],
  },
  async handler(args, ctx) {
    const source = await CodeChunk.findOne({
      repoId: ctx.repoId,
      name: args.functionName,
    })
      .select('-embedding')
      .lean();
    if (!source) {
      return { found: false, name: args.functionName };
    }
    // Strip dotted prefixes — `this.foo` and `obj.foo` both resolve to `foo`.
    const targetNames = [...new Set((source.calls ?? []).map((c) => c.split('.').pop()))];
    const callees = targetNames.length
      ? await CodeChunk.find({
          repoId: ctx.repoId,
          name: { $in: targetNames },
        })
          .select(LIST_SELECT)
          .limit(30)
          .lean()
      : [];
    const resolvedNames = new Set(callees.map((c) => c.name));
    return {
      source: args.functionName,
      sourceFile: source.filepath,
      sourceLines: `${source.startLine}-${source.endLine}`,
      totalCalls: source.calls?.length ?? 0,
      callees: callees.map((c) => ({
        filepath: c.filepath,
        name: c.name,
        type: c.type,
        lines: `${c.startLine}-${c.endLine}`,
      })),
      unresolved: (source.calls ?? []).filter(
        (c) => !resolvedNames.has(c.split('.').pop())
      ),
    };
  },
};

// ---------------------------------------------------------------------
// find_pattern — regex against chunk content
// ---------------------------------------------------------------------
const FIND_PATTERN = {
  name: 'find_pattern',
  description:
    'Find chunks whose source code matches a JavaScript-flavored regular ' +
    'expression (case-insensitive). Use for security-pattern hunts that ' +
    "semantic search can't pinpoint — e.g. `eval\\(`, " +
    "`exec\\s*\\(.*\\$\\{`, `password\\s*=\\s*['\"]`.",
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'JS regex source (no leading or trailing slashes).',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 20, cap 50).',
      },
    },
    required: ['pattern'],
  },
  async handler(args, ctx) {
    let regex;
    try {
      regex = new RegExp(args.pattern, 'i');
    } catch (err) {
      return { error: `Invalid regex: ${err.message}` };
    }
    const limit = Math.min(args.limit ?? 20, 50);
    const chunks = await CodeChunk.find({
      repoId: ctx.repoId,
      content: { $regex: regex },
    })
      .select('-embedding')
      .limit(limit)
      .lean();
    return {
      pattern: args.pattern,
      count: chunks.length,
      matches: chunks.map((c) => {
        const m = c.content.match(regex);
        return {
          filepath: c.filepath,
          name: c.name,
          type: c.type,
          lines: `${c.startLine}-${c.endLine}`,
          matchPreview: m?.[0]?.slice(0, 200),
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------
// get_diff_context — chunks overlapping a line range in a file
// ---------------------------------------------------------------------
const GET_DIFF_CONTEXT = {
  name: 'get_diff_context',
  description:
    'For a file and a line range (e.g. from a PR diff hunk), return every ' +
    'chunk that overlaps that range. This is how the agent fetches the ' +
    'surrounding functions when reasoning about what a diff changes.',
  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Repo-relative file path.',
      },
      startLine: {
        type: 'number',
        description: 'Start of the range (1-indexed, inclusive).',
      },
      endLine: {
        type: 'number',
        description: 'End of the range (1-indexed, inclusive).',
      },
    },
    required: ['filepath', 'startLine', 'endLine'],
  },
  async handler(args, ctx) {
    // Overlap test: chunk.startLine <= range.end AND chunk.endLine >= range.start
    const chunks = await CodeChunk.find({
      repoId: ctx.repoId,
      filepath: args.filepath,
      startLine: { $lte: args.endLine },
      endLine: { $gte: args.startLine },
    })
      .select('-embedding')
      .sort({ startLine: 1 })
      .lean();
    return {
      filepath: args.filepath,
      range: `${args.startLine}-${args.endLine}`,
      chunks: chunks.map((c) => ({
        type: c.type,
        name: c.name,
        lines: `${c.startLine}-${c.endLine}`,
        content: c.content,
        calls: c.calls,
      })),
    };
  },
};

export const codebaseTools = [
  SEARCH_CODE,
  GET_FILE,
  GET_FUNCTION,
  FIND_CALLERS,
  FIND_CALLEES,
  FIND_PATTERN,
  GET_DIFF_CONTEXT,
];

export const codebaseServerInfo = {
  name: 'codebase',
  description:
    'MCP server exposing tools to search and navigate the indexed codebase ' +
    'of the repository currently under review.',
};

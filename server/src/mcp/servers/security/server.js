// Security MCP server — exposes security knowledge & CVE lookups to the agent.
//
// IMPORTANT: until Phase 8 seeds the SecurityKB collection, the KB-backed
// tools (search_owasp, lookup_cwe, search_best_practices) gracefully return
// empty results. The check_dependency tool already works because it hits
// OSV.dev (a free public CVE database) and needs no seeded data.

import SecurityKB from '../../../models/SecurityKB.js';
import { embedQuery } from '../../../services/embedding.service.js';

const KB_VECTOR_INDEX = 'security_kb_vector_index'; // created in Phase 8

// ---------------------------------------------------------------------
// search_owasp — semantic search over OWASP Top 10 entries in SecurityKB
// ---------------------------------------------------------------------
const SEARCH_OWASP = {
  name: 'search_owasp',
  description:
    'Search the OWASP Top 10 knowledge base by natural-language query. ' +
    'Returns the most relevant OWASP entries with their identifier, title, ' +
    'description, and a vulnerable/safe code example pair when available. ' +
    'Call this when you suspect a finding belongs to a known OWASP category.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      language: {
        type: 'string',
        description: 'Optional language filter (e.g. javascript).',
      },
      limit: { type: 'number', description: 'Max results (default 3).' },
    },
    required: ['query'],
  },
  async handler(args, _ctx) {
    return kbVectorSearch({
      query: args.query,
      sources: ['owasp'],
      language: args.language,
      limit: args.limit ?? 3,
    });
  },
};

// ---------------------------------------------------------------------
// lookup_cwe — fetch a CWE entry by identifier (e.g. CWE-89 for SQLi)
// ---------------------------------------------------------------------
const LOOKUP_CWE = {
  name: 'lookup_cwe',
  description:
    'Fetch a specific CWE (Common Weakness Enumeration) entry by its ' +
    'identifier, e.g. "CWE-89" for SQL injection, "CWE-79" for XSS. Use ' +
    'this when you have a strong guess at the weakness category and want ' +
    'to ground your finding in the canonical definition.',
  inputSchema: {
    type: 'object',
    properties: {
      cweId: {
        type: 'string',
        description: 'CWE identifier in the form "CWE-89".',
      },
    },
    required: ['cweId'],
  },
  async handler(args, _ctx) {
    const normalized = String(args.cweId).toUpperCase().trim();
    const doc = await SecurityKB.findOne({
      source: 'cwe',
      identifier: normalized,
    })
      .select('-embedding')
      .lean();
    if (!doc) {
      return { found: false, cweId: normalized };
    }
    return formatKbDoc(doc);
  },
};

// ---------------------------------------------------------------------
// lookup_cve — look up a CVE by id (via OSV.dev)
// ---------------------------------------------------------------------
const LOOKUP_CVE = {
  name: 'lookup_cve',
  description:
    'Look up a specific CVE by its identifier via OSV.dev (free public ' +
    'vulnerability database). Returns affected packages, severity, and ' +
    'summary. Use when a finding references a known CVE.',
  inputSchema: {
    type: 'object',
    properties: {
      cveId: {
        type: 'string',
        description: 'CVE identifier, e.g. "CVE-2021-44228".',
      },
    },
    required: ['cveId'],
  },
  async handler(args, _ctx) {
    const id = String(args.cveId).toUpperCase().trim();
    try {
      const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
      if (res.status === 404) return { found: false, cveId: id };
      if (!res.ok) {
        return { error: `OSV ${res.status}: ${await res.text()}`.slice(0, 300) };
      }
      const data = await res.json();
      return {
        found: true,
        id: data.id,
        summary: data.summary,
        details: data.details?.slice(0, 1500),
        severity: data.severity?.[0]?.score ?? null,
        affected: (data.affected ?? []).slice(0, 5).map((a) => ({
          package: a.package?.name,
          ecosystem: a.package?.ecosystem,
          ranges: a.ranges,
        })),
        references: (data.references ?? []).slice(0, 6).map((r) => r.url),
      };
    } catch (err) {
      return { error: `network: ${err.message}` };
    }
  },
};

// ---------------------------------------------------------------------
// check_dependency — query OSV.dev for CVEs affecting a (package, version)
// ---------------------------------------------------------------------
const CHECK_DEPENDENCY = {
  name: 'check_dependency',
  description:
    'Query OSV.dev for known vulnerabilities affecting a specific ' +
    'dependency version in a given ecosystem. Use when a PR modifies ' +
    'package.json / requirements.txt / etc. and you want to know if the ' +
    'new dependency or version pulls in any CVEs.',
  inputSchema: {
    type: 'object',
    properties: {
      packageName: {
        type: 'string',
        description: 'Package identifier as it appears in the registry.',
      },
      version: {
        type: 'string',
        description: 'Specific version string (e.g. "4.17.10").',
      },
      ecosystem: {
        type: 'string',
        description: 'OSV ecosystem name: npm | PyPI | Maven | Go | crates.io ...',
      },
    },
    required: ['packageName', 'version', 'ecosystem'],
  },
  async handler(args, _ctx) {
    try {
      const res = await fetch('https://api.osv.dev/v1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: { name: args.packageName, ecosystem: args.ecosystem },
          version: args.version,
        }),
      });
      if (!res.ok) {
        return { error: `OSV ${res.status}: ${await res.text()}`.slice(0, 300) };
      }
      const data = await res.json();
      const vulns = data.vulns ?? [];
      return {
        package: args.packageName,
        version: args.version,
        ecosystem: args.ecosystem,
        vulnerabilityCount: vulns.length,
        vulnerabilities: vulns.slice(0, 5).map((v) => ({
          id: v.id,
          summary: v.summary,
          severity: v.severity?.[0]?.score ?? null,
          aliases: v.aliases?.slice(0, 3),
          references: (v.references ?? []).slice(0, 3).map((r) => r.url),
        })),
      };
    } catch (err) {
      return { error: `network: ${err.message}` };
    }
  },
};

// ---------------------------------------------------------------------
// search_best_practices — semantic lookup of secure-coding guidance
// ---------------------------------------------------------------------
const SEARCH_BEST_PRACTICES = {
  name: 'search_best_practices',
  description:
    'Search the curated secure-coding best practices (e.g. parameterized ' +
    'queries, secure password hashing, CSRF protection, secure headers) by ' +
    'natural-language query. Optional language filter.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      language: {
        type: 'string',
        description: 'Optional language filter (e.g. javascript, python).',
      },
      limit: { type: 'number', description: 'Max results (default 3).' },
    },
    required: ['query'],
  },
  async handler(args, _ctx) {
    return kbVectorSearch({
      query: args.query,
      sources: ['best_practice'],
      language: args.language,
      limit: args.limit ?? 3,
    });
  },
};

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function formatKbDoc(doc) {
  return {
    found: true,
    source: doc.source,
    identifier: doc.identifier,
    title: doc.title,
    description: doc.description,
    severity: doc.severity,
    language: doc.language,
    examples: doc.examples ?? null,
    references: doc.references ?? [],
  };
}

// Shared helper used by search_owasp + search_best_practices. Uses Atlas
// $vectorSearch against the security_kb_vector_index. Returns [] if the
// collection is empty (pre-Phase-8) or if the index isn't yet built.
async function kbVectorSearch({ query, sources, language, limit }) {
  // Quick short-circuit so the LLM gets a sane empty result instead of
  // a misleading error when SecurityKB is still empty.
  const docCount = await SecurityKB.estimatedDocumentCount();
  if (docCount === 0) return { count: 0, note: 'security KB not yet seeded', results: [] };

  let qVec;
  try {
    qVec = await embedQuery(query);
  } catch (err) {
    return { error: `embedding failed: ${err.message}`.slice(0, 200) };
  }

  const filter = { source: { $in: sources } };
  if (language && language !== 'all') {
    filter.$or = [{ language }, { language: 'all' }];
  }

  let hits;
  try {
    hits = await SecurityKB.aggregate([
      {
        $vectorSearch: {
          index: KB_VECTOR_INDEX,
          path: 'embedding',
          queryVector: qVec,
          numCandidates: Math.max(limit * 10, 30),
          limit,
          filter,
        },
      },
      {
        $project: {
          embedding: 0,
        },
      },
    ]);
  } catch (err) {
    return { error: `vectorSearch failed: ${err.message}`.slice(0, 200) };
  }

  return {
    count: hits.length,
    results: hits.map(formatKbDoc),
  };
}

export const securityTools = [
  SEARCH_OWASP,
  LOOKUP_CWE,
  LOOKUP_CVE,
  CHECK_DEPENDENCY,
  SEARCH_BEST_PRACTICES,
];

export const securityServerInfo = {
  name: 'security',
  description:
    'MCP server exposing OWASP, CWE, CVE, and best-practice lookups for the ' +
    'agent to ground its findings in established security knowledge.',
};

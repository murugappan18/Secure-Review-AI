# SecureReview AI

**Agentic, context-aware security code review for GitHub pull requests.** Built on MERN + MCP + Agentic RAG over an AST-aware code index.

Unlike static scanners that work on hard-coded rules, SecureReview AI reasons about a PR using the rest of your codebase — it can say things like _"this new endpoint doesn't follow the auth pattern used elsewhere in your codebase"_ or _"this dependency upgrade introduces a CVE that's reachable from your API surface."_

> **Bring Your Own Keys.** This is a public app — every user signs in with GitHub and configures their own AI provider API keys. Your keys are encrypted at rest and never shared.

---

## How it works

```
PR URL ──► GitHub OAuth user ──► clone + index repo with tree-sitter
                                                │
                                                ▼
                              Embed each function/class chunk (Gemini)
                                                │
                                                ▼
              ┌──────────────  Agentic loop (5 phases)  ──────────────┐
              │ 1. Understand diff   (GitHub MCP tools)               │
              │ 2. Gather context    (codebase MCP tools)             │
              │ 3. Reason exploit    (find_pattern, lookup_cwe)       │
              │ 4. Compare patterns  (search_code across the repo)    │
              │ 5. Generate review   (structured JSON findings)       │
              └────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                  Live-streaming Review Theater UI (Socket.IO)
```

The agent autonomously decides which tools to call within each phase. It grounds every finding in a real CWE / OWASP entry from a seeded knowledge base, with vulnerable / safe code examples and references.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite, Tailwind, TanStack Query, Zustand, Framer Motion, Socket.IO client |
| Backend | Node 20+, Express 5, Mongoose, Passport (GitHub OAuth), Socket.IO |
| AI | Gemini (chat + embeddings), Anthropic Claude (optional), Groq (optional) |
| Code parsing | tree-sitter with JS / TS / Python grammars |
| Storage | MongoDB Atlas — Vector Search for code chunks & security KB |
| Agent tools | Custom MCP-shaped tool layer (codebase / security / GitHub) with a Gemini ↔ MCP adapter |

---

## Key features

- **Agentic, not chat.** Multi-step reasoning loop where the LLM autonomously picks which tools to call.
- **MCP architecture.** Tools follow the Model Context Protocol shape so they're portable to any MCP client (Claude Desktop, Cursor).
- **Tree-sitter chunking.** Functions, classes, and methods are stored as semantic units — not random line slices.
- **Hybrid retrieval.** Combines Atlas Vector Search (semantic) with text search for accurate cross-file context.
- **Seeded security KB.** 49 hand-curated OWASP / CWE / best-practice entries, embedded for semantic lookup, cited in every finding.
- **Live Review Theater.** Phases and tool calls stream in real time via Socket.IO. Watching the agent work is the demo centerpiece.
- **Pure BYOK.** Each user supplies and manages their own API keys, encrypted with AES-256-GCM. No shared admin quota.
- **Graceful degradation.** If a late phase fails (quota, network), the agent synthesizes findings from earlier phase data instead of returning empty.
- **Stoppable.** Click Stop on an in-flight review — the AbortController-backed loop short-circuits within seconds.

---

## Running locally

### Prerequisites

- Node 20 LTS or newer
- MongoDB Atlas account (M0 free tier is enough)
- GitHub OAuth app (homepage `http://localhost:5173`, callback `http://localhost:5000/auth/github/callback`)
- Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey) — used for dev scripts and as your initial BYOK key

### Setup

```bash
git clone https://github.com/<you>/Secure_Review.git
cd Secure_Review

# Backend
cd server
npm install
cp .env.example .env
# fill in MONGO_URI, JWT_SECRET, SESSION_SECRET, GITHUB_CLIENT_ID/SECRET, GEMINI_API_KEY
node --use-system-ca scripts/seedSecurityKB.js   # one-time: seeds CWE/OWASP/best-practices
npm run dev

# Frontend (new terminal)
cd ../client
npm install
cp .env.example .env   # defaults already point at localhost:5000
npm run dev
```

### Atlas vector indexes (one-time)

In your Atlas cluster's **Atlas Search** tab, create two **Vector Search** indexes:

**`code_vector_index`** on `securereview.codechunks`:
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "repoId" },
    { "type": "filter", "path": "language" },
    { "type": "filter", "path": "type" }
  ]
}
```

**`security_kb_vector_index`** on `securereview.securitykbs`:
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "source" },
    { "type": "filter", "path": "language" }
  ]
}
```

### First run

1. Open `http://localhost:5173`.
2. Sign in with GitHub.
3. Go to **Settings** — paste your Gemini API key, click **Test**, hit **Save**.
4. Back on **Dashboard** — pick a repo, click **Index** (one-time per repo).
5. Paste a PR URL, click **Review PR**.
6. Watch the Review Theater stream the agent's phases and tool calls live.

---

## Project layout

```
Secure_Review/
├── client/                      React + Vite frontend
│   └── src/
│       ├── routes/              Landing, Dashboard, Reviews, ReviewTheater, Settings, AuthCallback
│       ├── components/review/   PhaseTimeline, AgentThinkingPanel, DiffViewer, FindingsList, SeverityPill
│       ├── hooks/               useReviewStream (socket.io subscription)
│       ├── lib/                 axios (api.js) + socket.io singleton
│       └── store/               Zustand auth store
└── server/                      Express + Mongoose backend
    ├── src/
    │   ├── agent/               agentLoop + 5 phase modules + prompts + runWithTools helper
    │   ├── chunker/             tree-sitter parser + per-language chunkers
    │   ├── mcp/                 codebase, security, github MCP-shaped tools + registry + adapter
    │   ├── models/              User, Repo, CodeChunk, Review, SecurityKB
    │   ├── routes/              auth, repos, reviews, settings
    │   ├── services/            github, indexer, embedding, vectorSearch, llm/{gemini,claude,groq,router}
    │   ├── sockets/             eventBus, reviewSocket
    │   └── utils/               crypto (AES-256-GCM), env loader, userContext (ALS), abortContext (ALS)
    ├── data/security_kb/        Seed JSON: 10 OWASP + 19 CWE + 20 best-practice entries
    └── scripts/                 seedSecurityKB, testAgentLoop, testToolUse
```

See [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) for the engineering trade-offs that shaped this stack.

---

## License

ISC

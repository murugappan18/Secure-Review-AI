# SecureReview AI

**Agentic, context-aware security code review for GitHub pull requests.** Built on MERN + MCP + Agentic RAG over an AST-aware code index.

Unlike static scanners that work on hard-coded rules, SecureReview AI reasons about a PR using the rest of your codebase — it can say things like _"this new endpoint doesn't follow the auth pattern used elsewhere in your codebase"_ or _"this dependency upgrade introduces a CVE that's reachable from your API surface."_

🚀 **Live demo:** **[securereviewai.vercel.app](https://securereviewai.vercel.app)**

> **Bring Your Own Keys.** This is a public app — every user signs in with GitHub and configures their own AI provider API keys (Gemini / Claude / Groq). Keys are encrypted at rest with AES-256-GCM, never shared between users, never logged.

---

## Try it in 90 seconds

1. Open [**securereviewai.vercel.app**](https://securereviewai.vercel.app) → **Sign in with GitHub**.
2. Get a free Gemini API key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
3. In **Settings**, paste your key → **Test** → **Save**.
4. Back on **Dashboard**, click **Index** on any small JS/TS/Python repo you own.
5. Paste a PR URL from that repo into the review card → **Review PR**.
6. Watch the agent stream its phases and tool calls live in the Review Theater.

> ⏱️ First request after idle may take ~30 s to wake the free-tier backend. Subsequent requests are instant.

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

The agent autonomously decides which tools to call within each phase. Every finding is grounded in a real CWE / OWASP entry from a seeded knowledge base, with vulnerable / safe code examples and reference links.

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
- **Indexing hint at submit.** Pasting a PR URL detects in real-time whether the repo is indexed; offers a one-click Index Now action.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite, Tailwind, TanStack Query, Zustand, Framer Motion, Socket.IO client, react-syntax-highlighter |
| Backend | Node 20+, Express 5, Mongoose, Passport (GitHub OAuth), Socket.IO, AsyncLocalStorage |
| AI | Gemini (chat + embeddings), Anthropic Claude (optional), Groq (optional) |
| Code parsing | tree-sitter with JS / TS / Python grammars (v0.21 line for peer-dep compatibility) |
| Storage | MongoDB Atlas — Vector Search for both code chunks and security KB |
| Agent tools | Custom MCP-shaped tool layer (codebase / security / GitHub) with a Gemini ↔ MCP adapter |
| Deploy | Render (backend), Vercel (frontend), UptimeRobot (keepalive) — all on free tiers |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       USER BROWSER                             │
│                                                                │
│   React App (Vite) ────► Vercel CDN                            │
│        │                                                       │
│        │ HTTP + WebSocket                                      │
└────────┼───────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│                      BACKEND (Render)                          │
│                                                                │
│  ┌─────────────────┐    ┌────────────────────────────────┐     │
│  │   Express API   │    │       Socket.IO Server         │     │
│  └────────┬────────┘    └──────────────┬─────────────────┘     │
│           │                            │                       │
│           ▼                            ▼                       │
│  ┌─────────────────────────────────────────────────────┐       │
│  │           Agent Orchestrator                        │       │
│  │  (5 phases × runWithTools inner loop)               │       │
│  └─────┬───────────────────────────────────────┬───────┘       │
│        │                                       │               │
│        ▼                                       ▼               │
│  ┌────────────┐                       ┌────────────────────┐   │
│  │ LLM Router │                       │  MCP Tool Registry │   │
│  │ (Gemini /  │                       │  + Adapter         │   │
│  │  Claude /  │                       │ ┌─────────────────┐│   │
│  │  Groq)     │                       │ │ codebase MCP    ││   │
│  └────────────┘                       │ │ security MCP    ││   │
│                                       │ │ github MCP      ││   │
│                                       │ └─────────────────┘│   │
│                                       └────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│                  MongoDB Atlas (Free M0)                       │
│                                                                │
│  Collections:                                                  │
│   • users          • repos          • codechunks (vector)      │
│   • reviews        • securitykbs (vector)                      │
└────────────────────────────────────────────────────────────────┘
```

For the engineering trade-offs behind these choices, see [**TECHNICAL_DECISIONS.md**](TECHNICAL_DECISIONS.md).

---

## Running locally

### Prerequisites

- Node 20 LTS or newer
- MongoDB Atlas account (M0 free tier is enough)
- GitHub OAuth app (homepage `http://localhost:5173`, callback `http://localhost:5000/auth/github/callback`)
- Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey) — used for dev scripts and as your initial BYOK key

### Setup

```bash
git clone https://github.com/murugappan18/Secure-Review-AI.git
cd Secure-Review-AI

# Backend
cd server
npm install
cp .env.example .env
# fill in MONGO_URI, JWT_SECRET, SESSION_SECRET, GITHUB_CLIENT_ID/SECRET, GEMINI_API_KEY
node scripts/seedSecurityKB.js   # one-time: seeds CWE/OWASP/best-practices into Atlas
npm run dev

# Frontend (new terminal)
cd ../client
npm install
cp .env.example .env   # defaults point at localhost:5000
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
3. Go to **Settings** — paste your Gemini API key, click **Test**, then **Save**.
4. Back on **Dashboard** — pick a repo, click **Index** (one-time per repo).
5. Paste a PR URL, click **Review PR**.
6. Watch the Review Theater stream the agent's phases and tool calls live.

---

## Project layout

```
Secure_Review/
├── client/                      React + Vite frontend (deployed to Vercel)
│   └── src/
│       ├── routes/              Landing, Dashboard, Reviews, ReviewTheater, Settings, AuthCallback
│       ├── components/review/   PhaseTimeline, AgentThinkingPanel, DiffViewer, FindingsList, SeverityPill
│       ├── hooks/               useReviewStream (socket.io subscription)
│       ├── lib/                 axios (api.js) + socket.io singleton
│       └── store/               Zustand auth store
└── server/                      Express + Mongoose backend (deployed to Render)
    ├── src/
    │   ├── agent/               agentLoop + 5 phase modules + prompts + runWithTools helper
    │   ├── chunker/             tree-sitter parser + per-language chunkers (JS, TS, Python)
    │   ├── mcp/                 codebase, security, github MCP-shaped tools + registry + adapter
    │   ├── models/              User, Repo, CodeChunk, Review, SecurityKB
    │   ├── routes/              auth, repos, reviews, settings
    │   ├── services/            github, indexer, embedding, vectorSearch, llm/{gemini,claude,groq,router}
    │   ├── sockets/             eventBus, reviewSocket
    │   └── utils/               crypto (AES-256-GCM), env loader, userContext (ALS), abortContext (ALS)
    ├── data/security_kb/        Seed JSON: 10 OWASP + 19 CWE + 20 best-practice entries
    └── scripts/                 seedSecurityKB, testAgentLoop, testToolUse
```

---

## Known limitations

A few honest notes on what the current free-tier deployment does and doesn't do well.

### Opensource PRs run in "diff-only" mode

The codebase tools (`search_code`, `find_callers`, `find_pattern`, `get_function`, …) all hit a per-user `CodeChunk` index that's only populated when you click **Index** on a repo from your Dashboard. Indexing requires cloning the repo via your OAuth token — which means **only repos you own / collaborate on can be indexed**.

When you paste a PR URL pointing at a repo that's *not* in your indexed set (a third-party / opensource PR), the agent works in **diff-only mode**:

- **Phase 1 (Understand diff)** — works fully (GitHub API).
- **Phase 2 (Gather context)** — typically returns an empty or minimal response. The codebase tools have nothing to search.
- **Phase 3 (Reason exploitability)** — works on the PR's patch hunks + the seeded security KB. Catches obvious patterns (eval, hardcoded secrets, raw SQL concat, etc.) well.
- **Phase 4 (Compare patterns)** — typically empty. The orchestrator's built-in fallback uses the Phase 3 candidates directly so the review still produces findings.
- **Phase 5 (Generate review)** — always works (pure synthesis).

So findings on opensource PRs lean on **diff + security KB only** — no cross-file reasoning. Simple patterns get caught; subtle bugs that require knowing what surrounding code does are missed.

**Workaround:** fork the repo to your own GitHub account, index the fork, then re-paste the PR URL. The agent matches by `owner/repo` so this works as long as you submit the PR URL against the fork (not the upstream).

### LLM output variability

The default free-tier model is `gemini-3.1-flash-lite` (500 requests/day, no card). It's a small model. Two known soft spots, both now mitigated server-side but worth knowing:

- **`suggestedFix`** sometimes ships empty. The agent's post-processor now substitutes `"Manual review required — no obvious fix"` whenever the field comes back blank, so you'll never see a finding without a fix line.
- **`references[]`** sometimes lands empty even when `lookup_cwe` ran successfully in Phase 3. The post-processor extracts the CWE / OWASP IDs from each finding's text, looks them up in the run's actual tool-call history, and attaches the canonical URLs. As a last resort it falls back to a canonical CWE/OWASP URL for the finding's category. Every finding ships with at least one reference URL.

For higher-quality output, switch to **Claude Sonnet** or **Gemini 3 Pro** in Settings — they follow the strict-JSON instructions much more reliably.

### Free-tier infrastructure

- **Render** spins down after 15 min of inactivity → first request after idle takes ~30 s. UptimeRobot pings every 5 min to keep it warm during demos.
- **MongoDB Atlas M0** is enough for the seeded security KB + your code chunks. Watch the 512 MB cap if you index very large repos.
- **Gemini Flash Lite 500 RPD** is plenty for casual use. A single review consumes ~30 requests (5 phases × ~6 LLM round-trips). Heavy use can exhaust the quota — switch providers in Settings if you hit a 429.

---

## Roadmap

Features I'd add next (any pull requests welcome):

- **Monaco diff viewer** — true side-by-side rendering with finding markers on the changed lines (`DiffViewer` is currently a file-impact summary).
- **Multi-org support** — separate orgs sharing an indexed monorepo.
- **Webhook-driven reviews** — auto-review on PR open instead of manual submit.
- **Per-user usage analytics** — visualize each user's monthly Gemini / Claude usage.

---

## License

ISC

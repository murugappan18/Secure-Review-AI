# Building an Agentic Code Reviewer with MCP, RAG, and the MERN Stack

*~1900 words · MERN, AI, security · published on dev.to*

---

Every team has a pull request that should have failed code review and didn't. A hardcoded API key in a feature branch. An `eval()` slipped past in a custom-formula feature. A `dangerouslySetInnerHTML` that trusts a third-party fetch. Static scanners — Snyk, Semgrep — catch some of these on pattern rules. Human reviewers catch others by knowing the codebase. The gap between them is wide.

I spent six weeks building **[SecureReview AI](https://securereviewai.vercel.app)** to close that gap with agentic reasoning. The app takes a GitHub PR URL, decides for itself which tools to call, searches the indexed codebase for context, looks up CWE definitions, and produces a structured security review — usually with three to four real findings — in about four minutes.

Live demo: **[securereviewai.vercel.app](https://securereviewai.vercel.app)** (bring your own free Gemini key). Code: [github.com/murugappan18/Secure-Review-AI](https://github.com/murugappan18/Secure-Review-AI).

In this post I want to walk through four decisions that shaped the stack — most of them not what I expected going in.

---

## Decision 1: Agentic, not chatbot

The instinct when wiring an LLM to a codebase is to do single-shot retrieval-augmented generation: user asks a question → embed the query → pull the top-k chunks → stuff them into the prompt → LLM answers. It's simple and it works for narrow questions.

It does not work for code review. A meaningful review needs to:

1. Read the diff.
2. Find the surrounding context (callers, callees, related patterns in other files).
3. Reason about whether attacker-controlled input can reach a sensitive sink.
4. Compare the change against how the rest of the codebase handles similar concerns.
5. Generate findings grounded in real CWE/OWASP knowledge.

None of those are single-shot retrievals. They're *exploratory*. The LLM has to decide what to look at next based on what it just saw. That's the difference between RAG and **agentic RAG** — the model autonomously chooses which tools to call, in what order, and how many times.

I built the agent as a **phased pipeline** rather than one giant ReAct loop. Five phases:

```
understand_diff  →  gather_context  →  reason_exploitability  →  compare_patterns  →  generate_review
```

Each phase is its own LLM call with its own prompt and its own tool palette. The agentic part lives *inside* each phase — within `reason_exploitability`, for instance, the model might fire seven tool calls in a single iteration:

```
lookup_cwe(CWE-94)        // confirms eval is the right category
lookup_cwe(CWE-79)        // dangerouslySetInnerHTML
find_pattern(eval\s*\()   // finds the literal eval call
find_pattern(dangerouslySetInnerHTML)
search_owasp("code injection")
search_owasp("XSS")
search_best_practices("avoid eval")
```

The phased structure gives me three things a monolithic ReAct loop wouldn't:

- **Debuggability.** When the agent produces a bad result, I know exactly which phase to inspect.
- **UX clarity.** The Review Theater (more on that below) renders the phases as a vertical timeline that ticks ✅ in real time. Recruiters watching the demo *see* the agent thinking, structured.
- **Bounded context.** Each phase's prompt sees only that phase's instructions plus prior phase outputs. Phase 1 doesn't need to know about CWE schemas; Phase 5 doesn't need to know about diff parsing.

The trade-off: the pipeline is less flexible than a free-form ReAct. If the agent decides mid-Phase-3 that it really needs to revisit Phase 1, it can't. In practice this hasn't cost me much because the phase prompts are scoped tightly enough that they rarely need to backtrack.

---

## Decision 2: MCP-shaped tools, not the official MCP SDK Server class

When Anthropic published the Model Context Protocol, my first instinct was to use their `@modelcontextprotocol/sdk`'s `Server` class — wrap each tool group in a real MCP server, transport over stdio, let the agent talk to them as proper external processes.

I built about a quarter of it that way before backing out.

For a monolithic Node backend, spawning a child process per "server" buys you nothing functional. It adds latency, complicates error handling, and creates a deployment story where you have N+1 processes to keep alive. The *value* of MCP isn't the transport — it's the **contract**:

```
{
  name: 'lookup_cwe',
  description: 'Fetch a CWE entry by identifier (e.g. CWE-89)',
  inputSchema: { type: 'object', properties: { cweId: { type: 'string' } }, required: ['cweId'] },
  handler: async (args, ctx) => { /* ... */ }
}
```

That shape — name + description + JSON Schema input + handler — is what lets the same tool be wrapped for Gemini's `functionDeclarations`, Claude's `input_schema`, OpenAI's `function` envelope. It's also what makes the tools portable if I ever want to expose them to Claude Desktop or Cursor: I add ~30 lines of stdio glue and they're MCP-compliant.

So I built my own thin in-process registry plus a small adapter:

```js
// adapter.js
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
```

The registry boots three in-process "servers" — codebase, security, github — and exposes 16 unified tools to the agent. The LLM router (Gemini, Claude, Groq with a transparent failover chain) calls them. Same source of truth across providers.

The portfolio talking point I take from this: **read the protocol, take the contract, don't pay for the transport unless you need it.**

---

## Decision 3: Tree-sitter chunks, not regex slices

Embeddings are useless if you embed garbage. The naive approach to chunking source code is "every N lines" or "split on `function`" — both of which produce broken fragments. A function body split across two chunks gets embedded as two unrelated halves; the embedding model has no clue they're related.

I used **tree-sitter** to parse files into ASTs and extract whole semantic units: `function_declaration`, `class_declaration`, `method_definition`, `arrow_function`. Each chunk is the entire syntactic unit, line ranges intact, with rich metadata pulled from walking the AST:

```js
{
  type: 'function',
  name: 'handleSubmit',
  filepath: 'src/auth/login.jsx',
  startLine: 24,
  endLine: 41,
  content: '...',
  calls: ['validateCsrfToken', 'fetch', 'navigate'],
  imports: ['react', 'react-router-dom'],
  metadata: { isAsync: true, isExported: true, hasErrorHandling: true },
  contentHash: 'sha256:...',
  embedding: [768-dim Gemini embedding]
}
```

That `calls` array is what makes `find_callers` and `find_callees` tools possible. It's a Mongo-queryable adjacency graph extracted at chunk-time. When the agent asks "where is `validateToken` used?", I do `CodeChunk.find({ calls: { $regex: /(^|\.)validateToken$/ }, repoId })` — no second LLM pass, no graph database, no extra infrastructure.

The peer-dep version dance was the only painful part. `tree-sitter-typescript@0.23.x` lags the other grammars at 0.25, so a strict npm install fails. I pinned everything to the v0.21 line — every grammar happily declares it works with `tree-sitter@^0.21`, and runtime ABI compatibility is intact.

---

## Decision 4: Pure BYOK — no admin key fallback

The earliest design used a single admin Gemini key as a "demo mode" fallback. Visitors who hadn't configured their own key would piggyback on mine, rate-limited per IP.

It survived about three days of testing before I killed it.

The realities:

- A **public app would have its admin key drained in days** by random sign-ups.
- Free-tier Gemini quotas reset **per project, not per user** — one heavy user locks everyone else out.
- I personally hit my own quota every other day during local development. Imagine that scaled to recruiters and curious devs.

So I pivoted to **pure BYOK**: every user configures their own Gemini / Claude / Groq keys in Settings, encrypted with AES-256-GCM keyed off a server-side `SESSION_SECRET`. Routes call `user.hasUsableProvider()` before any action — no key, no review. The Review and Index buttons disable with tooltips pointing at Settings.

Implementation detail worth flagging: I used **`AsyncLocalStorage`** to avoid threading user context through ~12 call sites:

```js
// requireAuth middleware
runWithUserContext(user.toUserContext(), () => next());

// Anywhere downstream:
import { getUserApiKey } from '../utils/userContext.js';
const apiKey = getUserApiKey('gemini');  // reads from ALS automatically
```

This pattern also propagates through `setImmediate` and the agent's background loop — I re-establish the ALS frame inside the background callback because Node sometimes loses it across the boundary.

The result: each user's quota is isolated, my admin key is unused in production, and the entire app is genuinely $0/month to operate.

---

## The Review Theater (a.k.a. why the demo lands)

A lot of agentic apps are invisible. The reasoning happens, findings appear, and the user has no sense of *what the agent actually did*. That's a missed opportunity — the work *is* the product.

I built the **Review Theater** as the visual centerpiece. When you submit a PR for review, you navigate immediately to a live page with:

- **Top bar:** PR title, status pill (`running`), provider used (`via gemini`), risk assessment, a pulsing red `LIVE` dot.
- **Left panel:** Changed-files summary with per-file finding markers (red dots on the lines where the agent flagged something).
- **Right panel:** Phase timeline ticking ✅ as each phase completes, then a scrollable feed of tool calls (`lookup_cwe(CWE-79) → 1 result in 30ms`) that animate in as they fire.
- **Bottom:** Severity-grouped findings with vulnerable code (red, syntax-highlighted), suggested fix (green), exploitability notes, and CWE / OWASP reference links.

The whole thing streams via Socket.IO. The orchestrator publishes events to an in-process EventBus, the socket layer forwards them to clients subscribed to `review:<id>`, and the React app mutates its TanStack Query cache directly so the UI updates without re-fetching. Refresh the page mid-review and the server replays the past events from Mongo before continuing the live stream.

**That's the screen recruiters remember.** Static reports are forgettable; watching an agent think live is not.

---

## What surprised me

A few things I didn't expect when I started:

**1. The LLM client matters more than the LLM.** Gemini, Claude, and Groq all have wildly different function-call envelopes. Gemini's `gemini-3.1-flash-lite` will occasionally send `{id: "94"}` when the schema requires `{cweId: "CWE-94"}`. The fix wasn't a smarter prompt — it was tolerant tool handlers that accept common aliases and normalize values (`94` → `CWE-94`).

**2. Throttle before you get rate-limited, not after.** My first version burst Gemini calls as fast as the SDK could fire them, tripping per-minute 429s. The router would back off 60 seconds — and lose its entire timeout budget. The fix was proactive: enforce a 4.5-second minimum gap between Gemini calls (`60s / 15 RPM = 4s`, plus 500 ms safety). I never see a 429 anymore.

**3. Graceful degradation pays dividends.** If Phase 4 ("compare patterns") fails because the lite model returned empty output or the daily quota ran out, the orchestrator now synthesizes findings *locally* from the Phase 3 candidates. The review completes with `"Phase 4 was skipped because <reason>"` in the summary instead of returning empty. Users see results from a partial run; I don't have to fall back to error states for the common case of "the LLM was a little flaky."

**4. The hardest debugging was network, not code.** I lost two days to corporate-firewall issues: Cognizant's Zscaler blocks `huggingface.co` (killed my plan to use local Xenova embeddings), the MongoDB wire protocol over corp WiFi (had to use phone hotspot for local dev), and the SSL inspection that re-signs every HTTPS connection (Node 25 needed `--use-system-ca` to trust the corp CA). None of these problems would exist on Render. The architecture had to be portable enough that the dev environment's constraints don't bleed into production.

---

## Try it

- **Live:** [securereviewai.vercel.app](https://securereviewai.vercel.app)
- **Source:** [github.com/murugappan18/Secure-Review-AI](https://github.com/murugappan18/Secure-Review-AI)
- **Technical decisions deep-dive:** [TECHNICAL_DECISIONS.md](https://github.com/murugappan18/Secure-Review-AI/blob/main/TECHNICAL_DECISIONS.md) — the 11 trade-offs that shaped the stack

To try it on a real PR, you'll need a free Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey). Pure BYOK — there's no shared quota.

If you find a bug, a missing CWE entry, or have a feature in mind — open an issue or send a PR. The roadmap section in the README has the most-wanted next features (Monaco diff viewer, PR commenting via GitHub API, webhook-driven reviews).

---

*Built solo over two weeks with help of an AI Assistants. Happy to chat about agentic patterns, MCP, or what it takes to ship an agentic app on $0/month — find me on my [Portfolio](https://www.murugappanthedev.me) and [LinkedIn](https://www.linkedin.com/in/murugappan-p).*

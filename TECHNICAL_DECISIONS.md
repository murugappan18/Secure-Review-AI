# Technical Decisions

Notable trade-offs made while building SecureReview AI, in roughly the order they came up.

## Why MongoDB Atlas vector search, not Pinecone / Weaviate / pgvector

Atlas Vector Search is **included on the free M0 tier**, and we were already on Mongoose for OAuth users + reviews. Bundling everything into one database means one connection pool, one replica set, one auth model. The 512 MB free-tier ceiling caps us at roughly 150 indexed repos worth of 768-dim embeddings — well above the scale a portfolio demo needs.

Trade-off: Atlas's `$vectorSearch` aggregation stage is **less mature than dedicated vector DBs**. `numCandidates` tuning is more sensitive, and there's no built-in BM25 hybrid scoring — we run text and vector searches separately and re-rank in app code. Acceptable for our scale.

## Why local Xenova ✗, Gemini embeddings ✓

The original plan was `Xenova/bge-small-en-v1.5` running in-process via ONNX — $0 forever, no API call latency, 384 dimensions. **It downloads weights from huggingface.co on first use, and the dev machine sits behind a Zscaler agent that blocks the entire HuggingFace domain.**

Pivoted to Google's `gemini-embedding-001` (Matryoshka, 768 dims after truncation). Pros: works through the corporate filter, higher-quality embeddings, free generous quota. Cons: network roundtrip per batch (~700 ms), and embeddings now consume the user's BYOK Gemini quota.

Worth noting because it shows up in the architecture: **embeddings and chat share the same Gemini key**, so a user only needs one key to get the whole experience.

## Why our own MCP-shaped layer, not the official MCP SDK Server class

Anthropic's `@modelcontextprotocol/sdk` ships a `Server` class that exposes tools over stdio JSON-RPC. For a monolithic backend, spawning child processes per "server" adds latency and dev complexity for zero functional gain. **The protocol's value is the contract** (tool name + JSON Schema input + handler), not the transport.

We adopted the MCP tool **shape** and built a thin in-process registry plus a small adapter that converts MCP tools into the per-provider native function-call format (Gemini's `functionDeclarations`, Claude's `input_schema`, OpenAI's wrapped `function`). Any of our "servers" (`codebase`, `security`, `github`) can be wrapped in a real MCP `Server` + `StdioServerTransport` later for Claude Desktop / Cursor integration with ~30 lines of glue.

## Why tree-sitter, not regex chunking

Naive chunking (every N lines, or "split on `function`") breaks function bodies in half and embeds incoherent fragments. **Tree-sitter parses files into ASTs**, letting us extract whole `function_declaration` / `class_declaration` / `method_definition` nodes with their line ranges intact. We also walk the AST to extract per-chunk metadata — `calls`, `imports`, `isAsync`, `hasErrorHandling` — which becomes Mongo-queryable metadata for tools like `find_callers`.

Pinned to the **v0.21 ecosystem** because `tree-sitter-typescript@0.23.x` lags the other grammars at 0.25 — a mismatched peer dep meant strict installs failed.

## Why a phased pipeline, not one giant ReAct loop

The doc lays out both options. We chose **explicit phases** (understand → gather → reason → compare → generate) for three reasons:

1. **Debuggability.** When something breaks, the failed phase tells us where. A monolithic ReAct loop produces a single unstructured trace.
2. **UX clarity.** The Review Theater renders phases as a vertical timeline that ticks ✅ in real time. That's the visual we want recruiters to remember.
3. **Bounded context.** Each phase's LLM call sees only that phase's instructions + prior phase outputs — keeps prompts focused and tokens low.

The agentic part lives **inside** each phase — the LLM autonomously decides which tools to call (and how many times) to accomplish that phase's specific goal.

## Why BYOK with no admin fallback

The earliest design used a single admin Gemini key as a "demo mode" fallback. The realities that killed that:

- A public app would have its admin key drained in days by random sign-ups.
- Free-tier daily quotas reset per project, not per user — one heavy user could lock everyone else out.
- Per-user quota is the only sustainable model.

Pivoted to **pure BYOK**: every user configures their own keys in `/settings`, encrypted with AES-256-GCM keyed off `SESSION_SECRET`. Routes check `user.hasUsableProvider()` before any action. Without a key, the **Review** and **Index** buttons disable with a tooltip pointing at Settings.

This also means **each user's quota is isolated** — one user hitting their Gemini limit doesn't affect anyone else.

## Why we run an agent throttle ahead of, not just after, Gemini 429s

Free Gemini Flash is 15 RPM. The first version of the agent burst calls as fast as the SDK could fire them, tripping 429s constantly. The router would back off 60 s on each 429 — but losing 60 s per limit hit ate every timeout budget.

The fix is **proactive throttling**: `throttleGemini()` enforces a 4.5 s minimum gap between Gemini calls. At ~13 RPM effective, we **never** hit the per-minute limit. The throttle sleep is interruptible via `AbortSignal` so the Stop button isn't blocked by it.

## Why AsyncLocalStorage instead of explicit parameter plumbing

The BYOK refactor needed every LLM client, the embedding service, and every MCP tool handler to know "what's the current user's API key?" Threading that through ~12 call sites would have been ugly.

Two `AsyncLocalStorage` instances solve it:

- `userContext.js` — carries decrypted API keys, model preferences, enabled providers, default provider.
- `abortContext.js` — carries the per-request `AbortSignal`.

Both are populated in middleware (or in the background `setImmediate` callback for kicked-off agents). Any async-chained code reads them without parameter passing. We also re-establish ALS frames inside `setImmediate` because Node sometimes loses them across the boundary.

## Why we kept Claude / Groq clients even though we don't use them today

The Anthropic SDK works through the corporate network but billing isn't free. Groq's API endpoint is blocked by Zscaler entirely. Both clients are still in the repo because:

1. **Multi-provider architecture** is a stronger portfolio talking point than "single provider, no story."
2. The router's failover chain is real and tested — if a user adds a Claude key, the agent transparently uses it.
3. On Render (no corp firewall), all three providers work.

## Why no Monaco diff viewer yet

Phase 9's `DiffViewer` is a file-impact summary, not a Monaco-based side-by-side. To do a real diff we'd need to persist PR file patches on the Review document (not just metadata), then wire Monaco's diff editor + decoration API. **Decided that's Phase 12 polish** — the findings list already shows vulnerable code snippets with syntax highlighting, so the cost/benefit didn't pencil out for portfolio MVP.

## Why we pre-validate the PR URL before creating a Review

The first version created the `Review` doc the moment the route received a URL, then kicked off the agent which would 404 internally. Users saw "running" for a few seconds before failure (or a confused "complete" with empty findings).

Now `POST /api/reviews` calls `getPullRequest` synchronously **before** any Review is created. PR doesn't exist → return 404 with a friendly message, no DB write. The agent's later prefetch of file patches still throws-and-fails-the-review if the PR somehow disappears between submission and processing — defense in depth.

## Why we picked `gemini-3.1-flash-lite` as the default model

It has a **500 requests-per-day** free quota — 25× the headroom of `gemini-3.5-flash` (20 RPD) and `gemini-2.5-flash` (20 RPD). For a portfolio app that may see bursty usage from recruiters trying it out, that's the difference between "works all day" and "exhausted by 10am."

`gemini-3.1-flash-lite` is less capable on raw reasoning than 3.5-flash, which is why we added (a) a more permissive JSON parser that recovers from minor LLM output drift, (b) tolerant tool-argument resolution (`{id: '94'}` is accepted as `{cweId: 'CWE-94'}`), and (c) a graceful-degradation fallback that converts Phase 3 candidates into final findings when Phase 4 returns empty.

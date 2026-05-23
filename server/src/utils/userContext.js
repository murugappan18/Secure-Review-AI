import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request user context stored via Node's AsyncLocalStorage. Set once in
// the auth middleware (and in the background runReview kickoff), then any
// code in the async call chain — LLM clients, embedding service, MCP tool
// handlers — can read it via getCurrentUserContext() without explicit
// parameter plumbing.
//
// This is how BYOK works:
//   1. requireAuth resolves the user and writes their decrypted keys here.
//   2. geminiClient/claudeClient/groqClient prefer ctx.apiKeys[provider]
//      over process.env.*_API_KEY.
//   3. llmRouter filters its failover chain to ctx.enabledProviders.
//
// If no context is set (e.g. a one-off script, or a test), every getter
// returns null/false and consumers fall back to env keys — that's the
// "admin demo mode" path.

const als = new AsyncLocalStorage();

export function runWithUserContext(ctx, fn) {
  return als.run(ctx, fn);
}

export function getCurrentUserContext() {
  return als.getStore() ?? null;
}

// True when we're inside an authenticated request (set by requireAuth).
// Dev scripts run WITHOUT a user context — we use this distinction so the
// LLM clients can fall back to env keys for scripts, while still strictly
// requiring user-supplied keys in HTTP requests.
export function hasUserContext() {
  return als.getStore() != null;
}

// ---------- per-call helpers (the LLM clients use these) ----------

export function getUserApiKey(provider) {
  const ctx = als.getStore();
  return ctx?.apiKeys?.[provider] ?? null;
}

export function getUserModel(provider) {
  const ctx = als.getStore();
  return ctx?.models?.[provider] ?? null;
}

export function isProviderEnabledForUser(provider) {
  const ctx = als.getStore();
  // No context = no user filter (admin / demo / script — anything goes).
  if (!ctx) return true;
  return ctx.enabledProviders?.has?.(provider) ?? false;
}

export function getUserDefaultProvider() {
  const ctx = als.getStore();
  return ctx?.defaultProvider ?? null;
}

// Returns true iff the user has at least one provider enabled with a key.
// Routes call this for pre-flight before any LLM-touching action.
export function userHasUsableProvider() {
  const ctx = als.getStore();
  if (!ctx) return true; // scripts — assume yes
  return ctx.hasUsableProvider === true;
}

export function userUsableProviders() {
  const ctx = als.getStore();
  return ctx?.usableProviders ?? [];
}

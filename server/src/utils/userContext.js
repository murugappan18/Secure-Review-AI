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

export function isInDemoMode() {
  const ctx = als.getStore();
  if (!ctx) return false;
  return !ctx.hasAnyOwnKey;
}

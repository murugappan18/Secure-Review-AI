import * as gemini from './geminiClient.js';
import * as groq from './groqClient.js';
import * as claude from './claudeClient.js';
import {
  getCurrentUserContext,
  getUserDefaultProvider,
} from '../../utils/userContext.js';

const CLIENTS = { gemini, groq, claude };

// Default failover order if PRIMARY_LLM doesn't specify and after a primary
// fails. Gemini first (free, fast), Claude second (paid but $5 credit).
// Groq is skipped automatically when its API key is empty — convenient
// because Cognizant's Zscaler blocks api.groq.com locally.
const FAILOVER_ORDER = ['gemini', 'claude', 'groq'];

const RATE_LIMIT_STATUS = new Set([429]);
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

// Process-lifetime cache: once a provider returns a billing/quota error,
// we skip it for the rest of the process rather than burning a fallback
// attempt on every request. Lazy-initialized because LLM_DISABLED_PROVIDERS
// from .env isn't available at module-load time (ESM import hoisting).
let _disabledProviders = null;
function disabledProviders() {
  if (_disabledProviders) return _disabledProviders;
  _disabledProviders = new Map();
  const envList = (process.env.LLM_DISABLED_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of envList) {
    _disabledProviders.set(name, 'env_disabled');
  }
  return _disabledProviders;
}

function isTransient(err) {
  const status = err.status ?? err.response?.status;
  if (status && (RATE_LIMIT_STATUS.has(status) || TRANSIENT_STATUS.has(status))) {
    return true;
  }
  if (!status && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND')) {
    return true;
  }
  return false;
}

function isRetryable(err) {
  if (err.code === 'NO_API_KEY') return true; // try the next provider
  if (isTransient(err)) return true;
  // Zscaler block pages come back as 403 with HTML; treat as retryable to fall over.
  const status = err.status ?? err.response?.status;
  if (status === 403 && err.message?.includes?.('Zscaler')) return true;
  return false;
}

// Detect provider-side "this account/key won't work, period" failures so we
// don't keep retrying. Permanent-disable patterns we know about.
function detectPermanentDisable(providerName, err) {
  const msg = (err.message ?? '').toLowerCase();
  if (providerName === 'claude') {
    if (msg.includes('credit balance is too low')) return 'no_credit';
    if (msg.includes('invalid x-api-key') || msg.includes('authentication_error')) return 'bad_key';
  }
  if (providerName === 'gemini') {
    if (msg.includes('api key not valid') || msg.includes('api_key_invalid')) return 'bad_key';
  }
  if (providerName === 'groq') {
    if (msg.includes('invalid api key')) return 'bad_key';
  }
  return null;
}

// Run one provider with one transient-retry. Returns the response or rethrows.
async function callWithRetry(providerName, args) {
  const client = CLIENTS[providerName];
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await client.chat(args);
    } catch (err) {
      lastErr = err;
      const disable = detectPermanentDisable(providerName, err);
      if (disable) {
        disabledProviders().set(providerName, disable);
        throw err; // surface immediately — no point retrying a permanently disabled provider
      }
      if (!isTransient(err) || attempt === 2) throw err;
      // 429 (rate limit) needs much longer than a 503 (model overloaded).
      // Free Gemini Flash is 15 RPM, so 60s gets us a fresh minute.
      const status = err.status ?? err.response?.status;
      const delayMs = status === 429 ? 60_000 : 1500 * attempt;
      console.warn(
        `[llm] ${providerName} transient ${status ?? err.code}, retrying in ${delayMs}ms`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function providerChain(preferred) {
  const seen = new Set();
  const chain = [];
  for (const p of [preferred, ...FAILOVER_ORDER]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    chain.push(p);
  }
  return chain;
}

// "Is this provider usable for the current caller right now?"
// Pure BYOK: only providers the user has explicitly enabled (and has a key
// for) are eligible. Scripts that run without user context (no ALS) get a
// permissive path so dev tools still work — production calls always run
// inside a user context set by requireAuth.
function isProviderAllowedForUser(providerName) {
  const ctx = getCurrentUserContext();
  if (!ctx) return true; // no user (scripts, tests)
  return ctx.enabledProviders?.has?.(providerName) ?? false;
}

// chat({ messages, tools, preferProvider?, model? })
//
// Tries the preferred provider first, then the failover chain. Returns the
// same normalized shape as the underlying clients, plus a `triedProviders`
// array showing the attempts (useful for the Review Theater UI in Phase 9 to
// say "fell back from gemini → claude after rate limit").
export async function chat({ messages, tools, preferProvider, model }) {
  // Primary precedence: explicit arg > user's default > env default > gemini.
  const primary =
    preferProvider ||
    getUserDefaultProvider() ||
    process.env.PRIMARY_LLM ||
    'gemini';
  const chain = providerChain(primary);
  const tried = [];

  for (const providerName of chain) {
    if (!CLIENTS[providerName]) {
      tried.push({ provider: providerName, status: 'unknown_provider' });
      continue;
    }
    if (disabledProviders().has(providerName)) {
      const reason = disabledProviders().get(providerName);
      console.log(`[llm] skipping ${providerName} (disabled: ${reason})`);
      tried.push({ provider: providerName, status: `disabled:${reason}` });
      continue;
    }
    if (!isProviderAllowedForUser(providerName)) {
      console.log(`[llm] skipping ${providerName} (not enabled for this user)`);
      tried.push({ provider: providerName, status: 'user_disabled' });
      continue;
    }

    try {
      console.log(`[llm] trying ${providerName}`);
      const response = await callWithRetry(providerName, { messages, tools, model });
      tried.push({ provider: providerName, status: 'ok' });
      return { ...response, triedProviders: tried };
    } catch (err) {
      const status = err.status ?? err.response?.status ?? null;
      console.warn(
        `[llm] ${providerName} failed (${err.code ?? status ?? 'no-code'}): ${err.message?.slice(0, 200)}`
      );
      tried.push({
        provider: providerName,
        status: err.code === 'NO_API_KEY' ? 'no_key' : status ?? 'error',
        error: err.message?.slice(0, 200),
      });

      if (!isRetryable(err)) {
        // Non-transient error from a configured provider — surface immediately
        // rather than burning fallback credit on what's probably a code bug.
        err.triedProviders = tried;
        throw err;
      }
      // Otherwise fall through to next provider in the chain.
    }
  }

  const err = new Error('[llm] all providers exhausted');
  err.triedProviders = tried;
  throw err;
}

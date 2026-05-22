import * as gemini from './geminiClient.js';
import * as groq from './groqClient.js';
import * as claude from './claudeClient.js';

const CLIENTS = { gemini, groq, claude };

// Default failover order if PRIMARY_LLM doesn't specify and after a primary
// fails. Gemini first (free, fast), Claude second (paid but $5 credit).
// Groq is skipped automatically when its API key is empty — convenient
// because Cognizant's Zscaler blocks api.groq.com locally.
const FAILOVER_ORDER = ['gemini', 'claude', 'groq'];

const RATE_LIMIT_STATUS = new Set([429]);
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

function isRetryable(err) {
  if (err.code === 'NO_API_KEY') return true; // try the next provider
  const status = err.status ?? err.response?.status;
  if (status && (RATE_LIMIT_STATUS.has(status) || TRANSIENT_STATUS.has(status))) {
    return true;
  }
  // Network errors, DNS, TLS — anything without an HTTP status — also retryable.
  if (!status && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND')) {
    return true;
  }
  // Zscaler block pages come back as 403 with HTML; treat as retryable to fall over.
  if (status === 403 && err.message?.includes?.('Zscaler')) return true;
  return false;
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

// chat({ messages, tools, preferProvider?, model? })
//
// Tries the preferred provider first, then the failover chain. Returns the
// same normalized shape as the underlying clients, plus a `triedProviders`
// array showing the attempts (useful for the Review Theater UI in Phase 9 to
// say "fell back from gemini → claude after rate limit").
export async function chat({ messages, tools, preferProvider, model }) {
  const primary = preferProvider || process.env.PRIMARY_LLM || 'gemini';
  const chain = providerChain(primary);
  const tried = [];

  for (const providerName of chain) {
    const client = CLIENTS[providerName];
    if (!client) {
      tried.push({ provider: providerName, status: 'unknown_provider' });
      continue;
    }

    try {
      console.log(`[llm] trying ${providerName}`);
      const response = await client.chat({ messages, tools, model });
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

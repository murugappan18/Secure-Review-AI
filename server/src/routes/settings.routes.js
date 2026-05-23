import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import User, { PROVIDERS } from '../models/User.js';

const router = Router();

// Models we expose in the Settings dropdown for each provider. These don't
// need to be exhaustive — they're a curated short-list for the UI. Users
// can also click "Test" with any key to confirm it works against the model.
const AVAILABLE_MODELS = {
  gemini: [
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest',
  ],
  claude: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
  ],
};

// Default model per provider (used when the user hasn't picked one). Matches
// User.statics.DEFAULT_MODELS — duplicated here to avoid an extra import dance.
const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-lite',
  claude: 'claude-sonnet-4-5',
  groq: 'llama-3.3-70b-versatile',
};

function serializeSettings(user) {
  const out = {
    apiKeys: {},
    providers: {},
    defaultProvider: user.settings?.defaultProvider ?? null,
    availableModels: AVAILABLE_MODELS,
    // Pure BYOK gate: app actions are blocked until isConfigured = true.
    // A user is configured iff they have at least one enabled provider
    // with a key on file.
    isConfigured: user.hasUsableProvider(),
    usableProviders: user.usableProviders(),
  };
  for (const p of PROVIDERS) {
    const ak = user.settings?.apiKeys?.[p];
    out.apiKeys[p] = {
      configured: !!ak?.encryptedKey,
      redactedKey: user.redactedKey(p),
      valid: ak?.valid ?? null,
      addedAt: ak?.addedAt ?? null,
      lastValidatedAt: ak?.lastValidatedAt ?? null,
    };
    const pc = user.settings?.providers?.[p];
    out.providers[p] = {
      enabled: pc?.enabled ?? false,
      modelName: pc?.modelName ?? DEFAULT_MODELS[p],
    };
  }
  return out;
}

// Pull the user with the encryptedKey select-on-demand fields.
// Used by every write handler that needs to call setApiKey/getApiKey.
async function loadFullUser(userId) {
  return User.findById(userId).select(
    '+accessToken +settings.apiKeys.gemini.encryptedKey +settings.apiKeys.claude.encryptedKey +settings.apiKeys.groq.encryptedKey'
  );
}

// -----------------------------------------------------------------------
// GET /api/settings — return the current user's settings (redacted)
// -----------------------------------------------------------------------
router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({ settings: serializeSettings(req.user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// PUT /api/settings/keys — store (or replace) an API key for a provider
// Body: { provider, key }
// -----------------------------------------------------------------------
router.put('/keys', requireAuth, async (req, res, next) => {
  try {
    const { provider, key } = req.body ?? {};
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'invalid_provider' });
    }
    if (typeof key !== 'string' || key.trim().length < 8) {
      return res.status(400).json({ error: 'invalid_key' });
    }
    const user = await loadFullUser(req.userId);
    user.setApiKey(provider, key.trim());
    // Auto-enable the provider when the user adds a key. They can toggle
    // it off later if they want to keep the key on file but not use it.
    if (!user.settings) user.settings = {};
    if (!user.settings.providers) user.settings.providers = {};
    if (!user.settings.providers[provider]) user.settings.providers[provider] = {};
    user.settings.providers[provider].enabled = true;
    await user.save();
    res.json({ settings: serializeSettings(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// DELETE /api/settings/keys/:provider — clear a stored key
// -----------------------------------------------------------------------
router.delete('/keys/:provider', requireAuth, async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'invalid_provider' });
    }
    const user = await loadFullUser(req.userId);
    user.clearApiKey(provider);
    // Also disable the provider when its key is cleared — confusing UX
    // otherwise (provider stays "enabled" but no key to back it).
    if (user.settings?.providers?.[provider]) {
      user.settings.providers[provider].enabled = false;
    }
    await user.save();
    res.json({ settings: serializeSettings(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// PUT /api/settings/providers — update enabled flag + model for a provider
// Body: { provider, enabled?, modelName? }
// -----------------------------------------------------------------------
router.put('/providers', requireAuth, async (req, res, next) => {
  try {
    const { provider, enabled, modelName } = req.body ?? {};
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'invalid_provider' });
    }
    if (modelName != null && typeof modelName !== 'string') {
      return res.status(400).json({ error: 'invalid_model_name' });
    }
    const user = await loadFullUser(req.userId);
    if (!user.settings) user.settings = {};
    if (!user.settings.providers) user.settings.providers = {};
    if (!user.settings.providers[provider]) user.settings.providers[provider] = {};
    if (enabled != null) user.settings.providers[provider].enabled = !!enabled;
    if (modelName != null) user.settings.providers[provider].modelName = modelName || null;
    await user.save();
    res.json({ settings: serializeSettings(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// PUT /api/settings/default-provider — set the user's preferred primary
// Body: { defaultProvider }   ('gemini' | 'claude' | 'groq' | null)
// -----------------------------------------------------------------------
router.put('/default-provider', requireAuth, async (req, res, next) => {
  try {
    const { defaultProvider } = req.body ?? {};
    if (defaultProvider != null && !PROVIDERS.includes(defaultProvider)) {
      return res.status(400).json({ error: 'invalid_provider' });
    }
    const user = await loadFullUser(req.userId);
    if (!user.settings) user.settings = {};
    user.settings.defaultProvider = defaultProvider ?? null;
    await user.save();
    res.json({ settings: serializeSettings(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/settings/validate — test whether a stored key actually works
// Body: { provider }
// Hits a minimal endpoint on the provider (model listing) — costs ~$0.
// -----------------------------------------------------------------------
router.post('/validate', requireAuth, async (req, res, next) => {
  try {
    const { provider } = req.body ?? {};
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'invalid_provider' });
    }
    const user = await loadFullUser(req.userId);
    const key = user.getApiKey(provider);
    if (!key) {
      return res.status(400).json({ error: 'no_key_stored' });
    }

    const result = await testProviderKey(provider, key);
    // Persist the result so the UI can show "✓ Valid (last checked X)".
    if (!user.settings.apiKeys[provider]) user.settings.apiKeys[provider] = {};
    user.settings.apiKeys[provider].valid = result.ok;
    user.settings.apiKeys[provider].lastValidatedAt = new Date();
    await user.save();

    res.json({ result, settings: serializeSettings(user) });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// Provider key probes — small GET against each provider's "list models"
// endpoint. Returns { ok: bool, status: number, error?: string }.
// -----------------------------------------------------------------------
async function testProviderKey(provider, key) {
  try {
    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      );
      if (res.ok) return { ok: true, status: res.status };
      const body = await res.text();
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.ok) return { ok: true, status: res.status };
      const body = await res.text();
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    if (provider === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return { ok: true, status: res.status };
      const body = await res.text();
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    return { ok: false, status: 0, error: 'unknown_provider' };
  } catch (err) {
    return { ok: false, status: 0, error: err.message?.slice(0, 200) ?? 'network_error' };
  }
}

export default router;

import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto.js';

export const PROVIDERS = ['gemini', 'claude', 'groq'];

// Default models for each provider — used when the user hasn't picked one
// explicitly. Match what's in .env so demo mode and BYOK mode behave the same.
const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-lite',
  claude: 'claude-sonnet-4-5',
  groq: 'llama-3.3-70b-versatile',
};

// Per-provider stored secret. `encryptedKey` is set:false so it never
// accidentally leaks via .find() / .toJSON() — must explicitly .select().
const apiKeySubSchema = new mongoose.Schema(
  {
    encryptedKey: { type: String, default: null, select: false },
    addedAt: { type: Date, default: null },
    lastValidatedAt: { type: Date, default: null },
    valid: { type: Boolean, default: null }, // null = untested, true/false after validate
  },
  { _id: false }
);

const providerConfigSubSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    modelName: { type: String, default: null }, // null = use DEFAULT_MODELS[provider]
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    githubId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    email: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    accessToken: { type: String, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    settings: {
      // Legacy convenience field (Phase 1) — kept for backward compatibility.
      defaultModel: { type: String, default: null },
      severityThreshold: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'low',
      },

      // BYOK: per-user encrypted API keys + provider preferences.
      apiKeys: {
        gemini: { type: apiKeySubSchema, default: () => ({}) },
        claude: { type: apiKeySubSchema, default: () => ({}) },
        groq: { type: apiKeySubSchema, default: () => ({}) },
      },
      providers: {
        gemini: { type: providerConfigSubSchema, default: () => ({}) },
        claude: { type: providerConfigSubSchema, default: () => ({}) },
        groq: { type: providerConfigSubSchema, default: () => ({}) },
      },
      defaultProvider: {
        type: String,
        enum: [...PROVIDERS, null],
        default: null, // null = use server default (demo mode picks gemini)
      },
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    toJSON: {
      transform(_doc, ret) {
        delete ret.accessToken;
        delete ret.__v;
        // Defensive: nothing should ever emit the encryptedKey, but if it
        // ever leaks into `ret`, strip it here too.
        if (ret.settings?.apiKeys) {
          for (const p of PROVIDERS) {
            if (ret.settings.apiKeys[p]) {
              delete ret.settings.apiKeys[p].encryptedKey;
            }
          }
        }
        return ret;
      },
    },
  }
);

// --- GitHub access token (unchanged from Phase 2) -------------------

userSchema.methods.setAccessToken = function setAccessToken(plain) {
  this.accessToken = encrypt(plain);
};

userSchema.methods.getAccessToken = function getAccessToken() {
  return this.accessToken ? decrypt(this.accessToken) : null;
};

// --- BYOK API keys --------------------------------------------------

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`[user] unknown provider: ${provider}`);
  }
}

userSchema.methods.setApiKey = function setApiKey(provider, plainKey) {
  assertProvider(provider);
  if (!this.settings) this.settings = {};
  if (!this.settings.apiKeys) this.settings.apiKeys = {};
  if (!this.settings.apiKeys[provider]) this.settings.apiKeys[provider] = {};
  this.settings.apiKeys[provider].encryptedKey = plainKey ? encrypt(plainKey) : null;
  this.settings.apiKeys[provider].addedAt = plainKey ? new Date() : null;
  this.settings.apiKeys[provider].lastValidatedAt = null;
  this.settings.apiKeys[provider].valid = null;
};

userSchema.methods.getApiKey = function getApiKey(provider) {
  assertProvider(provider);
  const enc = this.settings?.apiKeys?.[provider]?.encryptedKey;
  return enc ? decrypt(enc) : null;
};

userSchema.methods.clearApiKey = function clearApiKey(provider) {
  assertProvider(provider);
  if (this.settings?.apiKeys?.[provider]) {
    this.settings.apiKeys[provider].encryptedKey = null;
    this.settings.apiKeys[provider].addedAt = null;
    this.settings.apiKeys[provider].lastValidatedAt = null;
    this.settings.apiKeys[provider].valid = null;
  }
};

// Return a redacted preview ("AIza...••••5944") for showing in the UI
// without revealing the full key. Returns null if no key is set.
userSchema.methods.redactedKey = function redactedKey(provider) {
  const key = this.getApiKey(provider);
  if (!key) return null;
  if (key.length <= 12) return '••••' + key.slice(-4);
  return `${key.slice(0, 6)}...••••${key.slice(-4)}`;
};

userSchema.methods.modelFor = function modelFor(provider) {
  assertProvider(provider);
  return (
    this.settings?.providers?.[provider]?.modelName ?? DEFAULT_MODELS[provider]
  );
};

// "Is this provider configured AND enabled for the user?"
userSchema.methods.isProviderEnabled = function isProviderEnabled(provider) {
  assertProvider(provider);
  return this.settings?.providers?.[provider]?.enabled === true;
};

// Has the user configured at least one of their own API keys?
// Drives the "demo mode" banner — false means they're piggybacking on
// the admin's env keys.
userSchema.methods.hasAnyOwnKey = function hasAnyOwnKey() {
  return PROVIDERS.some((p) => !!this.settings?.apiKeys?.[p]?.encryptedKey);
};

// Snapshot user's BYOK state in a shape suitable for stashing in
// AsyncLocalStorage. Decrypts the keys once, here, so downstream code
// doesn't repeatedly hit the crypto helper for the same request.
userSchema.methods.toUserContext = function toUserContext() {
  const ctx = {
    userId: String(this._id),
    githubAccessToken: this.getAccessToken(),
    apiKeys: {},
    models: {},
    enabledProviders: new Set(),
    defaultProvider: this.settings?.defaultProvider ?? null,
    hasAnyOwnKey: this.hasAnyOwnKey(),
  };
  for (const p of PROVIDERS) {
    const key = this.getApiKey(p);
    if (key) ctx.apiKeys[p] = key;
    ctx.models[p] = this.modelFor(p);
    if (this.isProviderEnabled(p)) ctx.enabledProviders.add(p);
  }
  return ctx;
};

userSchema.statics.DEFAULT_MODELS = DEFAULT_MODELS;

const User = mongoose.model('User', userSchema);
export default User;

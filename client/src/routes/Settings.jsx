import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  X,
  Loader2,
  Eye,
  EyeOff,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

const PROVIDER_INFO = {
  gemini: {
    name: 'Google Gemini',
    color: 'emerald',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    keyPrefix: 'AIza',
    description:
      'Free tier with generous quotas. Recommended for the agent loop and embeddings.',
  },
  claude: {
    name: 'Anthropic Claude',
    color: 'violet',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    description: 'Strongest reasoning. Requires paid credit on Anthropic.',
  },
  groq: {
    name: 'Groq (Llama)',
    color: 'sky',
    docsUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    description:
      'Fastest inference. Free tier. Note: blocked by some corporate networks.',
  },
};

export default function Settings() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await api.get('/api/settings');
      return res.data.settings;
    },
  });

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">SecureReview AI</h1>
            <nav className="flex gap-4 text-sm">
              <Link to="/dashboard" className="text-slate-400 hover:text-slate-100">
                Dashboard
              </Link>
              <Link to="/reviews" className="text-slate-400 hover:text-slate-100">
                Reviews
              </Link>
              <Link to="/settings" className="text-slate-100 font-medium">
                Settings
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {user?.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt=""
                className="w-8 h-8 rounded-full border border-slate-700"
              />
            )}
            <span className="text-sm text-slate-300">{user?.username}</span>
            <button
              onClick={handleLogout}
              className="text-xs text-slate-400 hover:text-slate-200 ml-2"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h2 className="text-2xl font-medium mb-1">Settings</h2>
          <p className="text-sm text-slate-400">
            Bring your own API keys for unlimited use and full control over which models the agent uses.
          </p>
        </div>

        {isLoading && <p className="text-slate-400 text-sm">Loading settings...</p>}
        {isError && (
          <p className="text-red-400 font-mono text-sm">
            Failed to load: {error.response?.data?.error || error.message}
          </p>
        )}

        {data && (
          <>
            {data.isDemoMode && <DemoModeBanner />}

            <section className="space-y-4">
              <h3 className="text-sm uppercase tracking-wider text-slate-500 font-medium">
                Providers
              </h3>
              {Object.keys(PROVIDER_INFO).map((p) => (
                <ProviderCard
                  key={p}
                  provider={p}
                  apiKey={data.apiKeys[p]}
                  providerConfig={data.providers[p]}
                  availableModels={data.availableModels[p] ?? []}
                />
              ))}
            </section>

            <DefaultProviderSection
              defaultProvider={data.defaultProvider}
              providers={data.providers}
            />
          </>
        )}
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------

function DemoModeBanner() {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
      <Sparkles className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-medium text-amber-200">You&apos;re using Demo Mode</p>
        <p className="text-xs text-amber-200/70 mt-1">
          Reviews currently use the app&apos;s shared free quota. Add your own
          API key below to remove rate limits and pick your own models.
        </p>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------

function ProviderCard({ provider, apiKey, providerConfig, availableModels }) {
  const queryClient = useQueryClient();
  const info = PROVIDER_INFO[provider];

  const [editing, setEditing] = useState(!apiKey.configured);
  const [draft, setDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState(null);

  const saveKey = useMutation({
    mutationFn: async (key) => {
      const res = await api.put('/api/settings/keys', { provider, key });
      return res.data.settings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(['settings'], settings);
      setEditing(false);
      setDraft('');
      setError(null);
    },
    onError: (err) => setError(err.response?.data?.error || err.message),
  });

  const clearKey = useMutation({
    mutationFn: async () => {
      const res = await api.delete(`/api/settings/keys/${provider}`);
      return res.data.settings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(['settings'], settings);
      setEditing(true);
    },
  });

  const validateKey = useMutation({
    mutationFn: async () => {
      const res = await api.post('/api/settings/validate', { provider });
      return res.data;
    },
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['settings'], settings);
    },
  });

  const updateProvider = useMutation({
    mutationFn: async (updates) => {
      const res = await api.put('/api/settings/providers', {
        provider,
        ...updates,
      });
      return res.data.settings;
    },
    onSuccess: (settings) => queryClient.setQueryData(['settings'], settings),
  });

  const colorRing = {
    emerald: 'border-emerald-500/30',
    violet: 'border-violet-500/30',
    sky: 'border-sky-500/30',
  };
  const cardBorder = apiKey.configured
    ? colorRing[info.color]
    : 'border-slate-800';

  return (
    <article className={`rounded-xl border ${cardBorder} bg-slate-900/40 p-5`}>
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h4 className="text-base font-medium">{info.name}</h4>
          <p className="text-xs text-slate-400 mt-0.5">{info.description}</p>
        </div>
        <KeyStatusBadge apiKey={apiKey} />
      </header>

      {/* API key region */}
      <div className="mb-4">
        <label className="text-[11px] uppercase tracking-wider text-slate-500 block mb-1.5">
          API Key
        </label>
        {!editing && apiKey.configured ? (
          <div className="flex items-center gap-2 flex-wrap">
            <code className="font-mono text-sm text-slate-300 bg-slate-950/50 px-2 py-1.5 rounded border border-slate-800">
              {apiKey.redactedKey}
            </code>
            <button
              onClick={() => validateKey.mutate()}
              disabled={validateKey.isPending}
              className="text-xs text-slate-300 px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 disabled:opacity-50"
            >
              {validateKey.isPending ? (
                <Loader2 className="w-3 h-3 inline animate-spin" />
              ) : (
                'Test'
              )}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-slate-300 px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500"
            >
              Replace
            </button>
            <button
              onClick={() => clearKey.mutate()}
              disabled={clearKey.isPending}
              className="text-xs text-red-400 px-3 py-1.5 rounded border border-red-500/30 hover:border-red-500/50 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                placeholder={`${info.keyPrefix}...`}
                className="w-full bg-slate-950/60 border border-slate-700 rounded px-3 py-2 pr-9 text-sm font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
                disabled={saveKey.isPending}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button
              onClick={() => draft.trim() && saveKey.mutate(draft.trim())}
              disabled={saveKey.isPending || draft.trim().length < 8}
              className="px-3 py-2 rounded bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {saveKey.isPending ? 'Saving...' : 'Save'}
            </button>
            {apiKey.configured && (
              <button
                onClick={() => {
                  setEditing(false);
                  setDraft('');
                  setError(null);
                }}
                className="px-3 py-2 rounded text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {error && <p className="text-red-400 font-mono text-xs mt-1.5">{error}</p>}
        {validateKey.data && (
          <p
            className={`text-xs mt-1.5 ${
              validateKey.data.result?.ok ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {validateKey.data.result?.ok
              ? '✓ Key validated successfully'
              : `✗ ${validateKey.data.result?.error ?? 'validation failed'}`}
          </p>
        )}
        <p className="text-[11px] text-slate-500 mt-2">
          Get a key from{' '}
          <a
            href={info.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-slate-300"
          >
            {info.docsUrl.replace(/^https:\/\//, '')}
          </a>
          . Stored encrypted with AES-256-GCM.
        </p>
      </div>

      {/* Model + enabled toggle */}
      <div className="flex items-center justify-between gap-4 pt-3 border-t border-slate-800/80">
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-400">Model</label>
          <select
            value={providerConfig.modelName ?? ''}
            onChange={(e) =>
              updateProvider.mutate({ modelName: e.target.value || null })
            }
            disabled={updateProvider.isPending}
            className="bg-slate-950/60 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-slate-500"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">
            {providerConfig.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={providerConfig.enabled}
            onClick={() =>
              updateProvider.mutate({ enabled: !providerConfig.enabled })
            }
            disabled={updateProvider.isPending}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
              providerConfig.enabled
                ? 'bg-emerald-500/90 hover:bg-emerald-500'
                : 'bg-slate-700 hover:bg-slate-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transform transition-transform ${
                providerConfig.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>
    </article>
  );
}

// -----------------------------------------------------------------------

function KeyStatusBadge({ apiKey }) {
  if (!apiKey.configured) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-slate-700 text-slate-500">
        not configured
      </span>
    );
  }
  if (apiKey.valid === true) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
        <Check className="w-3 h-3" strokeWidth={3} />
        valid
      </span>
    );
  }
  if (apiKey.valid === false) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-red-500/40 bg-red-500/10 text-red-300">
        <X className="w-3 h-3" strokeWidth={3} />
        invalid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/5 text-amber-300">
      <AlertTriangle className="w-3 h-3" />
      untested
    </span>
  );
}

// -----------------------------------------------------------------------

function DefaultProviderSection({ defaultProvider, providers }) {
  const queryClient = useQueryClient();
  const mutate = useMutation({
    mutationFn: async (val) => {
      const res = await api.put('/api/settings/default-provider', {
        defaultProvider: val,
      });
      return res.data.settings;
    },
    onSuccess: (settings) => queryClient.setQueryData(['settings'], settings),
  });

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h3 className="text-sm font-medium mb-1">Default provider</h3>
      <p className="text-xs text-slate-400 mb-3">
        Which provider the agent tries first. Falls back through the others if
        rate-limited or unavailable.
      </p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(PROVIDER_INFO).map(([p, info]) => {
          const enabled = providers[p]?.enabled;
          const selected = defaultProvider === p;
          return (
            <button
              key={p}
              onClick={() => mutate.mutate(p)}
              disabled={!enabled || mutate.isPending}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                selected
                  ? 'bg-slate-100 text-slate-900'
                  : enabled
                    ? 'border border-slate-700 text-slate-300 hover:border-slate-500'
                    : 'border border-slate-800 text-slate-600 cursor-not-allowed'
              }`}
            >
              {info.name}
              {!enabled && ' (disabled)'}
            </button>
          );
        })}
      </div>
    </section>
  );
}

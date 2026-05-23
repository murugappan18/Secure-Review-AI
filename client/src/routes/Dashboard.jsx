import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [prUrl, setPrUrl] = useState('');
  const [prError, setPrError] = useState(null);

  // Repo list with embedded index status. Poll every 2s while ANY repo is
  // currently being indexed, so progress bars update live.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['repos'],
    queryFn: async () => {
      const res = await api.get('/api/repos');
      return res.data.repos;
    },
    refetchInterval: (q) => {
      const repos = q.state.data ?? [];
      const anyIndexing = repos.some(
        (r) => r.indexStatus === 'indexing' || r.indexStatus === 'pending'
      );
      return anyIndexing ? 2000 : false;
    },
  });

  const indexMutation = useMutation({
    mutationFn: async (repo) => {
      const res = await api.post(`/api/repos/${repo.owner}/${repo.name}/index`);
      return res.data.repo;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repos'] }),
  });

  const reviewMutation = useMutation({
    mutationFn: async (url) => {
      const res = await api.post('/api/reviews', { prUrl: url });
      return res.data.review;
    },
    onSuccess: (review) => {
      navigate(`/reviews/${review._id}`);
    },
    onError: (err) => {
      // Server returns { error: 'pr_not_found', message: '<friendly>' }.
      // Prefer the friendly message; fall back to the error code, then the
      // network-level message.
      const data = err.response?.data;
      setPrError(data?.message ?? data?.error ?? err.message);
    },
  });

  function handleSubmitReview(e) {
    e.preventDefault();
    setPrError(null);
    const trimmed = prUrl.trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(trimmed)) {
      setPrError('Please enter a valid GitHub PR URL (https://github.com/owner/repo/pull/N).');
      return;
    }
    reviewMutation.mutate(trimmed);
  }

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
              <Link to="/dashboard" className="text-slate-100 font-medium">
                Dashboard
              </Link>
              <Link to="/reviews" className="text-slate-400 hover:text-slate-100">
                Reviews
              </Link>
              <Link to="/settings" className="text-slate-400 hover:text-slate-100">
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

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <DemoModeBanner />

        {/* --- Submit a PR for review --- */}
        <section className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-6">
          <h2 className="text-lg font-medium mb-1">Review a pull request</h2>
          <p className="text-sm text-slate-400 mb-4">
            Paste a GitHub PR URL. We&apos;ll analyze the diff for security issues with
            agentic reasoning over your codebase.
          </p>
          <form onSubmit={handleSubmitReview} className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              className="flex-1 bg-slate-950/60 border border-slate-700 rounded px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-500"
              disabled={reviewMutation.isPending}
            />
            <button
              type="submit"
              disabled={reviewMutation.isPending}
              className="px-4 py-2 rounded bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-60 disabled:cursor-wait whitespace-nowrap"
            >
              {reviewMutation.isPending ? 'Starting...' : 'Review PR'}
            </button>
          </form>
          {prError && (
            <p className="text-red-400 font-mono text-xs mt-2">{prError}</p>
          )}
          <RepoIndexHint
            prUrl={prUrl}
            repos={data}
            onIndex={(repo) => indexMutation.mutate(repo)}
            isStarting={indexMutation.isPending}
          />
        </section>

        {/* --- Repositories --- */}
        <section>
          <div className="mb-4">
            <h2 className="text-xl font-medium mb-1">Your repositories</h2>
            <p className="text-sm text-slate-400">
              Indexing parses the repo into semantic chunks so the agent can search by meaning.
            </p>
          </div>

          {isLoading && <p className="text-slate-400 text-sm">Loading repos...</p>}

          {isError && (
            <p className="text-red-400 font-mono text-sm">
              Failed to fetch repos: {error.response?.data?.error || error.message}
            </p>
          )}

          {data && (
            <ul className="space-y-2">
              {data.map((repo) => (
                <li
                  key={repo.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm text-slate-200 hover:underline truncate"
                      >
                        {repo.fullName}
                      </a>
                      {repo.private && <Pill tone="neutral">private</Pill>}
                      {repo.language && <Pill tone="lang">{repo.language}</Pill>}
                    </div>
                    {repo.description && (
                      <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                        {repo.description}
                      </p>
                    )}
                  </div>

                  <IndexAction
                    repo={repo}
                    onIndex={() => indexMutation.mutate(repo)}
                    isStarting={
                      indexMutation.isPending &&
                      indexMutation.variables?.id === repo.id
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

// --- presentational pieces ---------------------------------------------

// Parse a GitHub PR URL into { owner, name, number } on the client side
// (same regex used for validation). Returns null if it doesn't match.
function parsePrUrlClient(url) {
  const m = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
  );
  if (!m) return null;
  return { owner: m[1], name: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
}

// Show the user whether the repo behind their PR URL is indexed, indexing,
// or not yet indexed. Offers a one-click Index button for the not-indexed
// case. Reviews still work without indexing, but with weaker cross-file
// context — this hint is informational, not blocking.
function RepoIndexHint({ prUrl, repos, onIndex, isStarting }) {
  const parsed = parsePrUrlClient(prUrl);
  if (!prUrl.trim()) {
    return (
      <p className="text-[11px] text-slate-500 mt-3">
        Tip: indexing the repo first gives the agent cross-file context.
      </p>
    );
  }
  if (!parsed) return null; // Don't add noise while the URL is partial

  const fullName = `${parsed.owner}/${parsed.name}`;
  const repo = repos?.find((r) => r.fullName === fullName);

  if (!repo) {
    // PR for a repo not in this user's GitHub list (third-party, fork, etc.)
    // We can't show its index status; review will run without codebase context.
    return (
      <p className="text-[11px] text-slate-500 mt-3 flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <span>
          <code className="font-mono">{fullName}</code> isn&apos;t in your repo
          list — the review will run against the diff only.
        </span>
      </p>
    );
  }

  const status = repo.indexStatus ?? 'not_indexed';

  if (status === 'ready') {
    return (
      <p className="text-[11px] mt-3 flex items-center gap-1.5 text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>
          <code className="font-mono text-slate-300">{fullName}</code> is indexed
          — {repo.chunkCount} chunks available for cross-file analysis.
        </span>
      </p>
    );
  }
  if (status === 'indexing' || status === 'pending') {
    return (
      <p className="text-[11px] mt-3 flex items-center gap-1.5 text-amber-300">
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span>
          Indexing <code className="font-mono text-slate-300">{fullName}</code>
          {repo.indexProgress != null && ` (${repo.indexProgress}%)`} — submitting
          now will use what&apos;s indexed so far.
        </span>
      </p>
    );
  }
  // 'not_indexed' or 'failed'
  return (
    <div className="text-[11px] mt-3 flex items-center gap-2 flex-wrap">
      <AlertCircle className="w-3.5 h-3.5 text-amber-300 shrink-0" />
      <span className="text-slate-400">
        <code className="font-mono text-slate-300">{fullName}</code> isn&apos;t
        indexed{status === 'failed' && ' (previous attempt failed)'} —
      </span>
      <button
        type="button"
        onClick={() => onIndex(repo)}
        disabled={isStarting}
        className="text-[11px] text-amber-200 hover:text-amber-100 underline disabled:opacity-50"
      >
        {isStarting ? 'starting...' : 'index now'}
      </button>
      <span className="text-slate-500">or submit anyway for a diff-only review.</span>
    </div>
  );
}

function DemoModeBanner() {
  // Cheap settings fetch — TanStack caches across pages so this is a no-op
  // network-wise once the user has visited Settings.
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await api.get('/api/settings');
      return res.data.settings;
    },
    staleTime: 60_000,
  });
  if (!data?.isDemoMode) return null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-center gap-3">
      <Sparkles className="w-4 h-4 text-amber-300 shrink-0" />
      <p className="text-xs text-amber-200/90 flex-1">
        You&apos;re running on the app&apos;s shared free quota.
      </p>
      <Link
        to="/settings"
        className="text-xs text-amber-200 hover:text-amber-100 underline whitespace-nowrap"
      >
        Add your own keys →
      </Link>
    </div>
  );
}

function Pill({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-slate-800 text-slate-400',
    lang: 'bg-emerald-500/15 text-emerald-300',
    ok: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    busy: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    error: 'bg-red-500/15 text-red-400 border border-red-500/30',
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function IndexAction({ repo, onIndex, isStarting }) {
  const status = repo.indexStatus ?? 'not_indexed';

  if (status === 'ready') {
    return (
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Pill tone="ok">indexed</Pill>
        <span className="text-[10px] text-slate-500">
          {repo.chunkCount} chunks
        </span>
        <button
          onClick={onIndex}
          className="text-[10px] text-slate-400 hover:text-slate-200 underline"
        >
          Re-index
        </button>
      </div>
    );
  }

  if (status === 'indexing' || status === 'pending') {
    return (
      <div className="flex flex-col items-end gap-1.5 shrink-0 w-40">
        <Pill tone="busy">{status === 'pending' ? 'starting' : 'indexing'}</Pill>
        <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
          <div
            className="h-full bg-amber-400 transition-all duration-500"
            style={{ width: `${repo.indexProgress ?? 0}%` }}
          />
        </div>
        <span className="text-[10px] text-slate-500 font-mono">
          {repo.indexProgress ?? 0}%
        </span>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Pill tone="error">failed</Pill>
        <button
          onClick={onIndex}
          disabled={isStarting}
          className="text-[10px] text-slate-300 hover:text-white underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onIndex}
      disabled={isStarting}
      className="text-xs text-slate-200 px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 hover:bg-slate-800/50 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-wait"
    >
      {isStarting ? 'Starting...' : 'Index'}
    </button>
  );
}

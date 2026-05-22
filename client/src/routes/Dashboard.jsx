import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

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

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">SecureReview AI</h1>
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

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h2 className="text-xl font-medium mb-1">Your repositories</h2>
          <p className="text-sm text-slate-400">
            Pick one to index — we'll clone it, parse with tree-sitter, and store
            function-level chunks for semantic search.
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
      </main>
    </div>
  );
}

// --- presentational pieces ---------------------------------------------

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

  // not_indexed
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

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

export default function Dashboard() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['repos'],
    queryFn: async () => {
      const res = await api.get('/api/repos');
      return res.data.repos;
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
            Pick one to index for security review. Indexing comes in Phase 3.
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
                className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-sm text-slate-200 hover:underline"
                    >
                      {repo.fullName}
                    </a>
                    {repo.private && (
                      <span className="text-[10px] uppercase tracking-wide bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                        private
                      </span>
                    )}
                    {repo.language && (
                      <span className="text-[10px] uppercase tracking-wide bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 rounded">
                        {repo.language}
                      </span>
                    )}
                  </div>
                  {repo.description && (
                    <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                      {repo.description}
                    </p>
                  )}
                </div>
                <button
                  disabled
                  className="text-xs text-slate-500 px-3 py-1.5 rounded border border-slate-800 cursor-not-allowed"
                  title="Indexing arrives in Phase 3"
                >
                  Index
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';
import SeverityPill, {
  ProviderPill,
  StatusPill,
} from '../components/review/SeverityPill.jsx';
import PhaseTimeline from '../components/review/PhaseTimeline.jsx';
import AgentThinkingPanel from '../components/review/AgentThinkingPanel.jsx';
import DiffViewer from '../components/review/DiffViewer.jsx';
import FindingsList from '../components/review/FindingsList.jsx';
import { useState } from 'react';

export default function ReviewTheater() {
  const navigate = useNavigate();
  const { id } = useParams();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [focusedFinding, setFocusedFinding] = useState(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['review', id],
    queryFn: async () => {
      const res = await api.get(`/api/reviews/${id}`);
      return res.data.review;
    },
    // While running, poll for live updates. Phase 10 will switch to sockets.
    refetchInterval: (q) => {
      const review = q.state.data;
      return review?.status === 'running' || review?.status === 'queued' ? 2000 : false;
    },
  });

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  const findings = data?.findings ?? [];
  const bySeverity = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['critical', 'high', 'medium', 'low', 'info'];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top nav */}
      <header className="border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">SecureReview AI</h1>
            <nav className="flex gap-4 text-sm">
              <Link to="/dashboard" className="text-slate-400 hover:text-slate-100">
                Dashboard
              </Link>
              <Link to="/reviews" className="text-slate-400 hover:text-slate-100">
                Reviews
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

      {isLoading && (
        <p className="text-center text-slate-400 mt-16 text-sm">Loading review...</p>
      )}
      {isError && (
        <p className="text-center text-red-400 mt-16 font-mono text-sm">
          {error.response?.status === 404
            ? 'Review not found.'
            : `Failed to load: ${error.message}`}
        </p>
      )}

      {data && (
        <>
          {/* PR header */}
          <div className="border-b border-slate-800 bg-slate-900/30">
            <div className="max-w-7xl mx-auto px-6 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <a
                    href={data.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-sm text-slate-300 hover:text-slate-100 truncate"
                  >
                    {data.prOwner}/{data.prRepo}#{data.prNumber}
                  </a>
                  <StatusPill status={data.status} />
                  <ProviderPill provider={data.modelUsed} />
                  {data.riskAssessment && (
                    <SeverityPill severity={data.riskAssessment} size="xs" />
                  )}
                </div>
                <h2 className="text-xl font-medium truncate">
                  {data.prTitle ?? '(fetching title...)'}
                </h2>
                {data.summary && (
                  <p className="text-sm text-slate-400 mt-2 max-w-3xl">{data.summary}</p>
                )}
              </div>

              <div className="text-right text-xs text-slate-500 shrink-0 space-y-1">
                <div className="flex justify-end gap-1 flex-wrap">
                  {order
                    .filter((sev) => bySeverity[sev])
                    .map((sev) => (
                      <SeverityPill
                        key={sev}
                        severity={sev}
                        count={bySeverity[sev]}
                        size="xs"
                      />
                    ))}
                </div>
                {data.durationMs && (
                  <p>{Math.round(data.durationMs / 1000)}s</p>
                )}
                {data.tokensUsed > 0 && (
                  <p>{data.tokensUsed.toLocaleString()} tokens</p>
                )}
              </div>
            </div>
          </div>

          {/* Two-column main: diff (left) + agent thinking (right) */}
          <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3 min-w-0">
              <DiffViewer
                review={data}
                focusedFinding={focusedFinding}
                onMarkerClick={(finding) => setFocusedFinding(finding)}
              />
            </div>
            <div className="lg:col-span-2 min-w-0">
              <PhaseTimeline phases={data.phases ?? []} />
              <div className="mt-6">
                <AgentThinkingPanel toolCalls={data.toolCalls ?? []} />
              </div>
            </div>
          </div>

          {/* Findings */}
          <div className="max-w-7xl mx-auto px-6 pb-12">
            <FindingsList
              findings={findings}
              focusedFinding={focusedFinding}
              onFocus={setFocusedFinding}
            />
          </div>
        </>
      )}
    </div>
  );
}

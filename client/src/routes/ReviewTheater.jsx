import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { StopCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';
import { useReviewStream } from '../hooks/useReviewStream.js';
import Footer from '../components/Footer.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
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

  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['review', id],
    queryFn: async () => {
      const res = await api.get(`/api/reviews/${id}`);
      return res.data.review;
    },
  });

  // Subscribe to live events. The hook mutates the TanStack Query cache
  // directly so the UI above re-renders on each event without polling.
  const isLive = data?.status === 'running' || data?.status === 'queued';
  const { connected: streamConnected, lastEventAt } = useReviewStream(id, {
    enabled: isLive,
  });

  // Stop button — only meaningful while the review is queued/running.
  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/api/reviews/${id}/stop`);
      return res.data.review;
    },
    onSuccess: (review) => {
      // Optimistically reflect 'stopped' immediately; the socket event
      // will arrive a moment later and reconcile the rest.
      queryClient.setQueryData(['review', id], (old) => ({ ...old, ...review }));
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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top nav */}
      <header className="border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 sm:gap-6 min-w-0">
            <h1 className="text-base sm:text-lg font-semibold whitespace-nowrap">SecureReview AI</h1>
            <nav className="flex gap-3 sm:gap-4 text-xs sm:text-sm">
              <Link to="/dashboard" className="text-slate-400 hover:text-slate-100">
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
          <div className="flex items-center gap-1 sm:gap-3 shrink-0">
            <ThemeToggle />
            {user?.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt=""
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-full border border-slate-700"
              />
            )}
            <span className="text-sm text-slate-300 hidden md:inline">{user?.username}</span>
            <button
              onClick={handleLogout}
              className="text-xs text-slate-400 hover:text-slate-200 ml-1 sm:ml-2 whitespace-nowrap"
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
                  {isLive && streamConnected && <LivePulse />}
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

              <div className="text-right text-xs text-slate-500 shrink-0 space-y-1.5">
                {isLive && (
                  <button
                    onClick={() => stopMutation.mutate()}
                    disabled={stopMutation.isPending}
                    className="inline-flex items-center gap-1.5 text-xs text-red-300 px-3 py-1.5 rounded border border-red-500/40 hover:border-red-500/60 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                    {stopMutation.isPending ? 'Stopping...' : 'Stop review'}
                  </button>
                )}
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
      <Footer />
    </div>
  );
}

// Pulsing "LIVE" dot — only shown while the socket is connected and the
// review is actively running.
function LivePulse() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-red-500/40 bg-red-500/10 text-red-300 text-[10px] uppercase tracking-wider font-medium">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
      </span>
      live
    </span>
  );
}

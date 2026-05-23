import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import SeverityPill, { ProviderPill, StatusPill } from '../components/review/SeverityPill.jsx';
import Footer from '../components/Footer.jsx';
import AppHeader from '../components/AppHeader.jsx';

export default function Reviews() {
  const navigate = useNavigate();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reviews'],
    queryFn: async () => {
      const res = await api.get('/api/reviews');
      return res.data.reviews;
    },
    // Lightly poll so in-progress reviews update their status pill.
    refetchInterval: (q) => {
      const reviews = q.state.data ?? [];
      return reviews.some((r) => r.status === 'running' || r.status === 'queued')
        ? 3000
        : false;
    },
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <AppHeader active="reviews" />

      <main className="max-w-5xl mx-auto px-6 py-8 flex-1 w-full">
        <div className="mb-6">
          <h2 className="text-xl font-medium mb-1">Reviews</h2>
          <p className="text-sm text-slate-400">
            Past security reviews. Click any one to open the Review Theater.
          </p>
        </div>

        {isLoading && <p className="text-slate-400 text-sm">Loading...</p>}
        {isError && (
          <p className="text-red-400 font-mono text-sm">
            Failed to load reviews: {error.response?.data?.error || error.message}
          </p>
        )}

        {data && data.length === 0 && (
          <div className="text-center py-16 border border-dashed border-slate-800 rounded-lg">
            <p className="text-slate-400 mb-4">No reviews yet.</p>
            <a
              href="/dashboard"
              className="inline-block text-sm text-slate-100 px-4 py-2 rounded border border-slate-700 hover:border-slate-500"
            >
              Submit your first PR for review
            </a>
          </div>
        )}

        {data && data.length > 0 && (
          <ul className="space-y-2">
            {data.map((r) => (
              <li key={r._id}>
                <button
                  onClick={() => navigate(`/reviews/${r._id}`)}
                  className="w-full text-left rounded-lg border border-slate-800 bg-slate-900/50 p-4 hover:bg-slate-900 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-sm text-slate-200 truncate">
                          {r.prOwner}/{r.prRepo}#{r.prNumber}
                        </span>
                        <StatusPill status={r.status} />
                        <ProviderPill provider={r.modelUsed} />
                      </div>
                      <p className="text-sm text-slate-300 truncate mb-2">
                        {r.prTitle ?? '(fetching PR title...)'}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span>{new Date(r.createdAt).toLocaleString()}</span>
                        {r.durationMs && <span>· {Math.round(r.durationMs / 1000)}s</span>}
                        {r.tokensUsed > 0 && <span>· {r.tokensUsed.toLocaleString()} tokens</span>}
                      </div>
                    </div>

                    {r.status === 'complete' && (
                      <FindingsSummary findings={r.findings} risk={r.riskAssessment} />
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
      <Footer />
    </div>
  );
}

function FindingsSummary({ findings, risk }) {
  if (!findings?.length) {
    return (
      <div className="text-right shrink-0">
        <p className="text-xs text-slate-500">no findings</p>
      </div>
    );
  }
  const bySeverity = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  return (
    <div className="text-right shrink-0 space-y-1">
      <div className="flex justify-end gap-1 flex-wrap">
        {order
          .filter((sev) => bySeverity[sev])
          .map((sev) => (
            <SeverityPill key={sev} severity={sev} count={bySeverity[sev]} size="xs" />
          ))}
      </div>
      {risk && (
        <p className="text-[10px] text-slate-500 uppercase tracking-wide">risk: {risk}</p>
      )}
    </div>
  );
}

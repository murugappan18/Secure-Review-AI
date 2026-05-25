import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, Check, X, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import SeverityPill, { ProviderPill, StatusPill } from '../components/review/SeverityPill.jsx';
import Footer from '../components/Footer.jsx';
import AppHeader from '../components/AppHeader.jsx';

export default function Reviews() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const deleteMutation = useMutation({
    mutationFn: async (reviewId) => {
      await api.delete(`/api/reviews/${reviewId}`);
      return reviewId;
    },
    onSuccess: (deletedId) => {
      // Optimistically drop from the cached list so the row disappears
      // immediately, without waiting for the next poll.
      queryClient.setQueryData(['reviews'], (old) =>
        Array.isArray(old) ? old.filter((r) => r._id !== deletedId) : old
      );
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
    },
  });

  const rerunMutation = useMutation({
    mutationFn: async (reviewId) => {
      const res = await api.post(`/api/reviews/${reviewId}/rerun`);
      return res.data.review;
    },
    onSuccess: (newReview) => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
      navigate(`/reviews/${newReview._id}`);
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
              <ReviewRow
                key={r._id}
                review={r}
                onOpen={() => navigate(`/reviews/${r._id}`)}
                onDelete={() => deleteMutation.mutate(r._id)}
                onRerun={() => rerunMutation.mutate(r._id)}
                deleting={
                  deleteMutation.isPending &&
                  deleteMutation.variables === r._id
                }
                rerunning={
                  rerunMutation.isPending &&
                  rerunMutation.variables === r._id
                }
              />
            ))}
          </ul>
        )}

        {(deleteMutation.isError || rerunMutation.isError) && (
          <p className="text-red-400 font-mono text-xs mt-3">
            {(deleteMutation.error ?? rerunMutation.error)?.response?.data
              ?.message ??
              (deleteMutation.error ?? rerunMutation.error)?.message}
          </p>
        )}
      </main>
      <Footer />
    </div>
  );
}

// -----------------------------------------------------------------------

// One row in the reviews list. The whole row is clickable (navigates to
// the Review Theater) but the action icons in the bottom-right corner
// stopPropagation so they don't trigger the navigation.
function ReviewRow({ review: r, onOpen, onDelete, onRerun, deleting, rerunning }) {
  // role=button + onKeyDown for keyboard accessibility — we can't use a
  // real <button> here because we have nested <button>s (action icons),
  // which would be invalid HTML.
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 hover:bg-slate-900 transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-slate-500"
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

        <div className="shrink-0 flex flex-col items-end gap-2">
          {r.status === 'complete' && (
            <FindingsSummary findings={r.findings} risk={r.riskAssessment} />
          )}
          <RowActions
            onRerun={onRerun}
            onDelete={onDelete}
            rerunning={rerunning}
            deleting={deleting}
          />
        </div>
      </div>
    </li>
  );
}

// Rerun + delete icon buttons. Each enters a two-step confirm mode on
// first click — the icon swaps for [✓] [✗] inline so the user has to
// explicitly confirm before the destructive action fires.
function RowActions({ onRerun, onDelete, rerunning, deleting }) {
  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <ConfirmIconButton
        icon={RefreshCw}
        label="Rerun"
        tone="neutral"
        pending={rerunning}
        pendingLabel="Starting..."
        confirmMessage="Rerun this review on the same PR?"
        onConfirm={onRerun}
      />
      <ConfirmIconButton
        icon={Trash2}
        label="Delete"
        tone="danger"
        pending={deleting}
        pendingLabel="Deleting..."
        confirmMessage="Permanently delete this review?"
        onConfirm={onDelete}
      />
    </div>
  );
}

// Small icon button that requires a confirm click before firing. First
// click → swap to inline [✓] [✗] tray with a short label. Second click
// (on ✓) calls onConfirm. Click ✗ to bail.
function ConfirmIconButton({
  icon: Icon,
  label,
  tone = 'neutral',
  pending,
  pendingLabel,
  confirmMessage,
  onConfirm,
}) {
  const [confirming, setConfirming] = useState(false);

  const baseBtn =
    'inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const idleTone =
    tone === 'danger'
      ? 'border-slate-800 text-slate-400 hover:text-red-300 hover:border-red-500/50 hover:bg-red-500/10'
      : 'border-slate-800 text-slate-400 hover:text-slate-100 hover:border-slate-600 hover:bg-slate-800';
  const confirmYesTone =
    tone === 'danger'
      ? 'border-red-500/60 text-red-300 bg-red-500/10 hover:bg-red-500/20'
      : 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20';

  if (pending) {
    return (
      <span className={`${baseBtn} border-slate-700 text-slate-300`}>
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>{pendingLabel ?? 'Working...'}</span>
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="inline-flex items-center gap-1" title={confirmMessage}>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
          aria-label={`Confirm ${label.toLowerCase()}`}
          className={`${baseBtn} ${confirmYesTone}`}
        >
          <Check className="w-3 h-3" />
          <span>Confirm</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          aria-label="Cancel"
          className={`${baseBtn} border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-600`}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label={label}
      title={label}
      className={`${baseBtn} ${idleTone}`}
    >
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </button>
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

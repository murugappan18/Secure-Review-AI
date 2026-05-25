import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  StopCircle,
  MessageSquare,
  GitPullRequest,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useReviewStream } from '../hooks/useReviewStream.js';
import Footer from '../components/Footer.jsx';
import AppHeader from '../components/AppHeader.jsx';
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
  const { id } = useParams();
  const [focusedFinding, setFocusedFinding] = useState(null);
  const [postResult, setPostResult] = useState(null);
  const [postError, setPostError] = useState(null);

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

  // Post-to-PR — two styles: 'issue' (single markdown comment) or
  // 'review' (full GitHub PR review w/ inline line-level comments).
  const postMutation = useMutation({
    mutationFn: async (style) => {
      setPostResult(null);
      setPostError(null);
      const res = await api.post(`/api/reviews/${id}/comment`, { style });
      return res.data;
    },
    onSuccess: (data) => setPostResult(data),
    onError: (err) =>
      setPostError(
        err.response?.data?.message ?? err.response?.data?.error ?? err.message
      ),
  });

  const findings = data?.findings ?? [];
  const bySeverity = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['critical', 'high', 'medium', 'low', 'info'];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <AppHeader active="reviews" maxWidth="7xl" />

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

          {/* Post-to-GitHub bar — shown only on completed reviews. */}
          {data.status === 'complete' && (
            <div className="max-w-7xl mx-auto px-6 pt-4">
              <PostToGitHubBar
                review={data}
                pending={postMutation.isPending}
                pendingStyle={postMutation.variables}
                onPost={(style) => postMutation.mutate(style)}
                result={postResult}
                error={postError}
              />
            </div>
          )}

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

// Bar with the two "post to GitHub" buttons, success preview, and any
// error from the most recent attempt. Only shown for complete reviews.
function PostToGitHubBar({ review, pending, pendingStyle, onPost, result, error }) {
  const findingsCount = review.findings?.length ?? 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-slate-200">
            Post this review to the PR
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {findingsCount === 0
              ? 'No findings — posting will simply confirm a clean review on the PR.'
              : 'Pick how to share the findings with the PR author.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onPost('issue')}
            disabled={pending}
            title="Post as a single markdown comment on the PR conversation tab"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded border border-slate-700 text-slate-200 bg-slate-900/40 hover:bg-slate-800 hover:border-slate-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {pending && pendingStyle === 'issue' ? 'Posting...' : 'Post as comment'}
          </button>
          <button
            onClick={() => onPost('review')}
            disabled={pending}
            title="Post as a GitHub PR Review with inline line-level comments where possible"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-slate-100 text-slate-900 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <GitPullRequest className="w-3.5 h-3.5" />
            {pending && pendingStyle === 'review' ? 'Posting...' : 'Post as PR review'}
          </button>
        </div>
      </div>

      {result && (
        <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
          <div className="flex items-start gap-2 text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-medium">
                Posted as {result.style === 'review' ? 'PR review' : 'comment'}
                {result.fallback ? ' (fell back to comment style)' : ''}.
                {result.inlineCount > 0 && (
                  <> {result.inlineCount} inline finding{result.inlineCount === 1 ? '' : 's'}.</>
                )}
                {result.skippedCount > 0 && (
                  <> {result.skippedCount} summarized in the body (line not in PR diff).</>
                )}
              </p>
              {result.fallbackReason && (
                <p className="text-emerald-400/80 mt-0.5">{result.fallbackReason}</p>
              )}
              {result.comment?.htmlUrl && (
                <a
                  href={result.comment.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-1 underline hover:text-emerald-200"
                >
                  View on GitHub <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">Failed to post: {error}</p>
        </div>
      )}
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

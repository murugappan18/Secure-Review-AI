import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  StopCircle,
  MessageSquare,
  GitPullRequest,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Globe,
  Lock,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';
import { useReviewStream } from '../hooks/useReviewStream.js';
import Footer from '../components/Footer.jsx';
import AppHeader from '../components/AppHeader.jsx';
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
  const { id } = useParams();
  const currentUser = useAuthStore((s) => s.user);
  const authBootstrapped = useAuthStore((s) => s.bootstrapped);
  const [focusedFinding, setFocusedFinding] = useState(null);
  const [postResult, setPostResult] = useState(null);
  const [postError, setPostError] = useState(null);

  const queryClient = useQueryClient();
  // Two-tier fetch:
  //   1. Try the authenticated endpoint — succeeds if the viewer is the
  //      owner. Returns the full review with all detail + isOwner=true.
  //   2. On 401 (no cookie) or 404 (not the owner / private), fall back
  //      to the public endpoint — only returns the review if the owner
  //      has flipped isPublic=true. Returns isOwner=false.
  // This is what lets a non-signed-in viewer follow a link from a GitHub
  // PR comment straight into a read-only Review Theater.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['review', id],
    retry: false,
    queryFn: async () => {
      // The authenticated endpoint is the primary path. We ONLY fall back
      // to the public endpoint if the failure is one of "you're not the
      // owner" (401 no-cookie / 404 different user). Any other failure
      // (502 cold start, network blip, server crash) gets retried up to
      // 2x with a small backoff — falling back too eagerly was making
      // the page render as a non-owner public view when in fact the user
      // owned the review and the API had just hiccupped.
      const MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await api.get(`/api/reviews/${id}`);
          const cached = queryClient.getQueryData(['review', id]);
          return {
            review: mergeWithLiveCache(res.data.review, cached?.review),
            isOwner: true,
          };
        } catch (err) {
          const status = err.response?.status;
          // Definite "not your review" → try the public read.
          if (status === 401 || status === 404) {
            try {
              const pub = await api.get(`/api/public/reviews/${id}`);
              const cached = queryClient.getQueryData(['review', id]);
              return {
                review: mergeWithLiveCache(pub.data.review, cached?.review),
                isOwner: false,
              };
            } catch (pubErr) {
              // Public also failed (private review or doesn't exist).
              throw pubErr;
            }
          }
          // Transient (no response, 5xx). Retry with backoff.
          const isTransient = !err.response || (status >= 500 && status < 600);
          if (isTransient && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    },
    // Polling fallback: while the review is in flight, refetch every 3s.
    // The Socket.IO live stream is still the primary update mechanism — it
    // delivers per-event granularity (tool_call, phase_start, ...). Polling
    // is the belt-and-braces backup for when the socket can't connect or
    // drops (Render free tier WebSocket upgrades are flaky). On terminal
    // status (complete/failed/stopped), polling turns off automatically.
    refetchInterval: (q) => {
      const status = q.state.data?.review?.status;
      return status === 'queued' || status === 'running' ? 3000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const review = data?.review;
  const isOwner = data?.isOwner ?? false;

  // Subscribe to live events. The hook mutates the TanStack Query cache
  // directly so the UI above re-renders on each event without polling.
  // Only enabled for the owner — the socket handshake requires the auth
  // cookie, and public viewers don't have one.
  const isLive = review?.status === 'running' || review?.status === 'queued';
  const { connected: streamConnected } = useReviewStream(id, {
    enabled: isOwner && isLive,
  });

  // Stop button — only meaningful while the review is queued/running, and
  // only the owner can call it.
  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/api/reviews/${id}/stop`);
      return res.data.review;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['review', id], (old) => ({
        ...(old ?? {}),
        review: { ...(old?.review ?? {}), ...updated },
      }));
    },
  });

  // Post-to-PR — two styles: 'issue' (single markdown comment) or
  // 'review' (full GitHub PR review w/ inline line-level comments).
  const postMutation = useMutation({
    mutationFn: async (style) => {
      setPostResult(null);
      setPostError(null);
      const res = await api.post(`/api/reviews/${id}/comment`, { style });
      // Posting auto-flips isPublic=true on the server; reflect locally.
      queryClient.setQueryData(['review', id], (old) =>
        old ? { ...old, review: { ...old.review, isPublic: true } } : old
      );
      return res.data;
    },
    onSuccess: (data) => setPostResult(data),
    onError: (err) =>
      setPostError(
        err.response?.data?.message ?? err.response?.data?.error ?? err.message
      ),
  });

  // Visibility toggle — owner-only. Public reviews are readable via
  // /api/public/reviews/:id without auth (what makes the GitHub PR link
  // actually work for non-users).
  const visibilityMutation = useMutation({
    mutationFn: async (isPublic) => {
      const res = await api.put(`/api/reviews/${id}/visibility`, { isPublic });
      return res.data.review;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['review', id], (old) =>
        old ? { ...old, review: { ...old.review, ...updated } } : old
      );
    },
  });

  const findings = review?.findings ?? [];
  const bySeverity = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const order = ['critical', 'high', 'medium', 'low', 'info'];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header chrome is driven by AUTH STATE, not ownership of this
          particular review. Signed-in users always get the full app
          nav (Dashboard / Reviews / Settings). Anonymous viewers who
          followed a public link from a GitHub PR comment get the lighter
          PublicHeader. The owner-only ACTIONS (post-to-GitHub, visibility
          toggle, Stop button) are still gated by `isOwner`.
          We wait for the app-root auth bootstrap before deciding which
          header to show — otherwise a refreshed /reviews/:id flashes the
          PublicHeader for ~200ms while /auth/me is in flight. */}
      {!authBootstrapped ? (
        <HeaderSkeleton />
      ) : currentUser ? (
        <AppHeader active="reviews" maxWidth="7xl" />
      ) : (
        <PublicHeader signedIn={false} />
      )}

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-slate-400 text-sm">Loading review...</p>
        </div>
      )}
      {isError && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <p className="text-red-400 font-mono text-sm mb-2">
              {error.response?.status === 404
                ? 'Review not found, or it has been set to private by its owner.'
                : `Failed to load: ${error.message}`}
            </p>
            <p className="text-slate-500 text-xs">
              {currentUser
                ? 'Return to the Reviews list to pick another review.'
                : 'If you have an account, sign in to see private reviews.'}
            </p>
          </div>
        </div>
      )}

      {review && (
        <>
          {/* Read-only banner for public viewers — sets expectations
              before they see the agent's findings. */}
          {!isOwner && <PublicViewerBanner />}

          {/* PR header */}
          <div className="border-b border-slate-800 bg-slate-900/30">
            <div className="max-w-7xl mx-auto px-6 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <a
                    href={review.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-sm text-slate-300 hover:text-slate-100 truncate"
                  >
                    {review.prOwner}/{review.prRepo}#{review.prNumber}
                  </a>
                  <StatusPill status={review.status} />
                  {isLive && streamConnected && <LivePulse />}
                  <ProviderPill provider={review.modelUsed} />
                  {review.riskAssessment && (
                    <SeverityPill severity={review.riskAssessment} size="xs" />
                  )}
                  {isOwner && (
                    <VisibilityPill
                      isPublic={review.isPublic}
                      pending={visibilityMutation.isPending}
                      onToggle={() =>
                        visibilityMutation.mutate(!review.isPublic)
                      }
                    />
                  )}
                </div>
                <h2 className="text-xl font-medium truncate">
                  {review.prTitle ?? '(fetching title...)'}
                </h2>
                {review.summary && (
                  <p className="text-sm text-slate-400 mt-2 max-w-3xl">{review.summary}</p>
                )}
              </div>

              <div className="text-right text-xs text-slate-500 shrink-0 space-y-1.5">
                {isOwner && isLive && (
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
                {review.durationMs && (
                  <p>{Math.round(review.durationMs / 1000)}s</p>
                )}
                {review.tokensUsed > 0 && (
                  <p>{review.tokensUsed.toLocaleString()} tokens</p>
                )}
              </div>
            </div>
          </div>

          {/* Post-to-GitHub bar — shown only to the owner on completed reviews. */}
          {isOwner && review.status === 'complete' && (
            <div className="max-w-7xl mx-auto px-6 pt-4">
              <PostToGitHubBar
                review={review}
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
                review={review}
                focusedFinding={focusedFinding}
                onMarkerClick={(finding) => setFocusedFinding(finding)}
              />
            </div>
            <div className="lg:col-span-2 min-w-0">
              <PhaseTimeline phases={review.phases ?? []} />
              <div className="mt-6">
                <AgentThinkingPanel toolCalls={review.toolCalls ?? []} />
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
  const noFindings = findingsCount === 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-slate-200">
            Post this review to the PR
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {noFindings
              ? 'No findings — posting will confirm a clean review on the PR.'
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

      {noFindings && !result && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">
            Heads up: this review reported <strong>0 findings</strong>. Posting
            anyway is still useful — it tells the PR author an automated
            security scan ran. The comment will show a clean-review confirmation
            instead of a vulnerability list.
          </p>
        </div>
      )}

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

// Public/private visibility control in the PR header. Owner-only.
//
// Designed as a labelled toggle switch (same shape as the provider
// enable/disable switch in Settings) so users immediately recognise the
// affordance — the earlier pill version looked like a status badge, not
// a control. The Globe/Lock icon + label sits next to the switch so the
// current state is readable at a glance.
function VisibilityPill({ isPublic, pending, onToggle }) {
  const Icon = isPublic ? Globe : Lock;
  const label = isPublic ? 'Public' : 'Private';
  const labelCls = isPublic ? 'text-sky-300' : 'text-slate-400';
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-700 bg-slate-900/40"
      title={
        isPublic
          ? 'Public — anyone with the link can view this review. Click the switch to make it private.'
          : 'Private — only you can see this review. Click the switch to make it public so the PR-comment link works.'
      }
    >
      <Icon className={`w-3 h-3 ${labelCls}`} />
      <span className={`text-[10px] uppercase tracking-wider font-medium ${labelCls}`}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={isPublic}
        aria-label={isPublic ? 'Make private' : 'Make public'}
        onClick={onToggle}
        disabled={pending}
        className={`relative inline-flex h-3.5 w-7 items-center rounded-full transition-colors disabled:opacity-50 ${
          isPublic
            ? 'bg-sky-500/80 hover:bg-sky-500'
            : 'bg-slate-700 hover:bg-slate-600'
        }`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full bg-white shadow-sm transform transition-transform ${
            isPublic ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </span>
  );
}

// Merge a freshly-polled server snapshot with the cached optimistic state
// from live socket events.
//
// Why this exists: the server only persists `review.phases` on phase
// completion, and `review.toolCalls` only at the very end of the entire
// review. Meanwhile the socket streams `phase_start` and `tool_call`
// events as they happen, which we apply to the cache optimistically. If
// polling then naively replaces the cache with the server snapshot, the
// in-progress phase indicator and the current phase's tool calls vanish
// for ~3s until the next socket event refills them — the UI flickers.
//
// Strategy: for a still-running review, take whichever of (server, cache)
// has the LONGER phases / toolCalls array. Longer means "more advanced
// state" — either more completed phases (server caught up) or one more
// in-progress entry from the socket (cache is ahead). For terminal
// statuses (complete/failed/stopped), the server is authoritative.
function mergeWithLiveCache(serverReview, cachedReview) {
  if (!serverReview) return serverReview;
  if (!cachedReview) return serverReview;

  // Once the review terminates the server has the canonical, complete
  // state — no further socket events should arrive that the server
  // doesn't already know about.
  const isLive =
    serverReview.status === 'queued' || serverReview.status === 'running';
  if (!isLive) return serverReview;

  const phases =
    (cachedReview.phases?.length ?? 0) > (serverReview.phases?.length ?? 0)
      ? cachedReview.phases
      : serverReview.phases;
  const toolCalls =
    (cachedReview.toolCalls?.length ?? 0) >
    (serverReview.toolCalls?.length ?? 0)
      ? cachedReview.toolCalls
      : serverReview.toolCalls;

  return { ...serverReview, phases, toolCalls };
}

// Skeleton header rendered for the brief window between the page
// loading and the app-root auth bootstrap completing. Same height as
// the real headers so the layout doesn't shift when one of them
// actually renders.
function HeaderSkeleton() {
  return (
    <header className="border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
        <span className="text-base sm:text-lg font-semibold whitespace-nowrap">
          SecureReview AI
        </span>
        <span className="text-xs text-slate-500">Loading...</span>
      </div>
    </header>
  );
}

// Header for unauthenticated / non-owner viewers landing on a public
// review (e.g. from a link in a GitHub PR comment). Lighter than the
// full AppHeader — no per-user nav, just a sign-in CTA.
function PublicHeader({ signedIn }) {
  return (
    <header className="border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
        <Link to="/" className="text-base sm:text-lg font-semibold whitespace-nowrap">
          SecureReview AI
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <Link
            to={signedIn ? '/dashboard' : '/'}
            className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded bg-slate-100 text-slate-900 hover:bg-white transition-colors"
          >
            {signedIn ? 'Open dashboard' : 'Sign in'}
          </Link>
        </div>
      </div>
    </header>
  );
}

// Banner shown to public viewers — sets the expectation that this is a
// shared, read-only view of someone else's review.
function PublicViewerBanner() {
  return (
    <div className="bg-sky-500/10 border-b border-sky-500/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-2 text-xs text-sky-300">
        <Globe className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">
          Read-only public view. This review was shared by its owner — sign in
          to run your own security review on a PR.
        </span>
        <Link
          to="/"
          className="font-medium underline hover:text-sky-200 whitespace-nowrap"
        >
          Sign in →
        </Link>
      </div>
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

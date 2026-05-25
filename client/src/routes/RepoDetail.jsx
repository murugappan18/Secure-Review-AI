import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  GitMerge,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';
import { api } from '../lib/api.js';
import Footer from '../components/Footer.jsx';
import AppHeader from '../components/AppHeader.jsx';

const STATE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
];

export default function RepoDetail() {
  const { owner, name } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('all');

  // Repo metadata + index status.
  const { data: repoData, isLoading: repoLoading, isError: repoError, error: repoErr } = useQuery({
    queryKey: ['repo-meta', owner, name],
    queryFn: async () => {
      const res = await api.get(`/api/repos/${owner}/${name}/meta`);
      return res.data.repo;
    },
  });

  // PR list (filtered by state).
  const { data: pullsData, isLoading: pullsLoading, isError: pullsError, error: pullsErr } = useQuery({
    queryKey: ['repo-pulls', owner, name, stateFilter],
    queryFn: async () => {
      const res = await api.get(
        `/api/repos/${owner}/${name}/pulls?state=${stateFilter}`
      );
      return res.data;
    },
  });

  // BYOK gate — same as Dashboard.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await api.get('/api/settings');
      return res.data.settings;
    },
    staleTime: 60_000,
  });
  const canReview = settings?.isConfigured === true;

  const reviewMutation = useMutation({
    mutationFn: async (prUrl) => {
      const res = await api.post('/api/reviews', { prUrl });
      return res.data.review;
    },
    onSuccess: (review) => {
      queryClient.invalidateQueries({ queryKey: ['reviews'] });
      navigate(`/reviews/${review._id}`);
    },
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <AppHeader active="dashboard" />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 flex-1 w-full">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to repositories
        </Link>

        {repoLoading && (
          <p className="text-slate-400 text-sm">Loading repo...</p>
        )}
        {repoError && (
          <p className="text-red-400 font-mono text-sm">
            Failed to load repo: {repoErr.response?.data?.message ?? repoErr.message}
          </p>
        )}

        {repoData && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl sm:text-2xl font-semibold font-mono truncate">
                  {repoData.fullName}
                </h1>
                {repoData.description && (
                  <p className="text-sm text-slate-400 mt-1">{repoData.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
                  {repoData.private && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase tracking-wide text-[10px]">
                      private
                    </span>
                  )}
                  {repoData.language && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 uppercase tracking-wide text-[10px]">
                      {repoData.language}
                    </span>
                  )}
                  <IndexStatusPill repo={repoData} />
                  {repoData.defaultBranch && (
                    <span className="text-slate-500">
                      default branch:{' '}
                      <code className="font-mono text-slate-300">
                        {repoData.defaultBranch}
                      </code>
                    </span>
                  )}
                </div>
              </div>
              <a
                href={repoData.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-slate-300 px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View on GitHub
              </a>
            </div>
          </section>
        )}

        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-medium">Pull requests</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Pick a PR to run a SecureReview AI review. Closed and merged
                PRs are read-only.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900/40 p-0.5">
              {STATE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStateFilter(f.key)}
                  className={`px-3 py-1 text-xs rounded ${
                    stateFilter === f.key
                      ? 'bg-slate-100 text-slate-900 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {pullsLoading && (
            <p className="text-slate-400 text-sm">Loading pull requests...</p>
          )}
          {pullsError && (
            <p className="text-red-400 font-mono text-sm">
              Failed to load PRs: {pullsErr.response?.data?.message ?? pullsErr.message}
            </p>
          )}

          {pullsData && pullsData.pulls.length === 0 && (
            <div className="text-center py-12 border border-dashed border-slate-800 rounded-lg">
              <p className="text-slate-400 text-sm">
                No {stateFilter === 'all' ? '' : stateFilter} pull requests on this repo.
              </p>
            </div>
          )}

          {pullsData && pullsData.pulls.length > 0 && (
            <ul className="space-y-2">
              {pullsData.pulls.map((pr) => (
                <PRRow
                  key={pr.number}
                  pr={pr}
                  owner={owner}
                  name={name}
                  onReview={() =>
                    reviewMutation.mutate(pr.htmlUrl ?? `https://github.com/${owner}/${name}/pull/${pr.number}`)
                  }
                  reviewing={
                    reviewMutation.isPending &&
                    reviewMutation.variables?.includes(`/pull/${pr.number}`)
                  }
                  canReview={canReview}
                />
              ))}
            </ul>
          )}

          {reviewMutation.isError && (
            <p className="text-red-400 font-mono text-xs mt-3">
              Couldn&apos;t start review:{' '}
              {reviewMutation.error.response?.data?.message ?? reviewMutation.error.message}
            </p>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}

// -------------------------------------------------------------------------

function PRRow({ pr, onReview, reviewing, canReview }) {
  const isOpen = pr.state === 'open';
  const stateInfo = pr.merged
    ? { icon: GitMerge, label: 'merged', tone: 'bg-violet-500/15 text-violet-300 border-violet-500/30' }
    : pr.state === 'open'
      ? { icon: GitPullRequest, label: pr.draft ? 'draft' : 'open', tone: pr.draft ? 'bg-slate-700/40 text-slate-300 border-slate-600' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' }
      : { icon: XCircle, label: 'closed', tone: 'bg-red-500/15 text-red-300 border-red-500/30' };
  const StateIcon = stateInfo.icon;

  const disabledTitle = !canReview
    ? 'Add an API key in Settings to enable reviews'
    : !isOpen
      ? 'Reviews can only be started on open PRs'
      : '';

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 flex items-start justify-between gap-4 flex-wrap sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span
            className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${stateInfo.tone}`}
          >
            <StateIcon className="w-3 h-3" />
            {stateInfo.label}
          </span>
          <span className="font-mono text-xs text-slate-500">#{pr.number}</span>
          {pr.headRef && pr.baseRef && (
            <span className="text-[10px] text-slate-500 font-mono truncate">
              {pr.headRef} → {pr.baseRef}
            </span>
          )}
        </div>
        <a
          href={pr.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-slate-200 hover:text-white hover:underline font-medium block truncate"
          title={pr.title}
        >
          {pr.title}
        </a>
        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500">
          {pr.author && (
            <span className="inline-flex items-center gap-1">
              {pr.author.avatarUrl && (
                <img
                  src={pr.author.avatarUrl}
                  alt=""
                  className="w-3.5 h-3.5 rounded-full"
                />
              )}
              {pr.author.login}
            </span>
          )}
          <span>·</span>
          <span>opened {timeAgo(pr.createdAt)}</span>
          {pr.mergedAt && (
            <>
              <span>·</span>
              <span>merged {timeAgo(pr.mergedAt)}</span>
            </>
          )}
          {!pr.mergedAt && pr.closedAt && (
            <>
              <span>·</span>
              <span>closed {timeAgo(pr.closedAt)}</span>
            </>
          )}
        </div>
      </div>

      <div className="shrink-0">
        <button
          onClick={onReview}
          disabled={!isOpen || !canReview || reviewing}
          title={disabledTitle}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded bg-slate-100 text-slate-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {reviewing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" /> Review PR
            </>
          )}
        </button>
      </div>
    </li>
  );
}

function IndexStatusPill({ repo }) {
  const status = repo.indexStatus;
  if (status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] uppercase tracking-wider">
        <CheckCircle2 className="w-3 h-3" />
        indexed · {repo.chunkCount} chunks
      </span>
    );
  }
  if (status === 'indexing' || status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] uppercase tracking-wider">
        <Loader2 className="w-3 h-3 animate-spin" />
        indexing {repo.indexProgress ?? 0}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-slate-700 text-slate-500 text-[10px] uppercase tracking-wider">
      not indexed
    </span>
  );
}

// Cheap relative-time formatter — no need for date-fns.
function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

import { Octokit } from 'octokit';

// Each call constructs a fresh Octokit instance bound to the user's
// access token. Cheap to instantiate; keeps tokens out of any shared state.
function client(accessToken) {
  if (!accessToken) {
    const err = new Error('github access token required');
    err.status = 401;
    throw err;
  }
  return new Octokit({ auth: accessToken });
}

// Repos the authenticated user has access to, with the fields the dashboard
// needs. Sorted by last push, capped at 100 — enough for a portfolio demo,
// pagination can come later if anyone needs it.
export async function listUserRepos(accessToken) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.repos.listForAuthenticatedUser({
    per_page: 100,
    sort: 'pushed',
    direction: 'desc',
    affiliation: 'owner,collaborator,organization_member',
  });
  return data.map((r) => ({
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    description: r.description,
    language: r.language,
    size: r.size, // KB
    pushedAt: r.pushed_at,
    htmlUrl: r.html_url,
    permissions: r.permissions, // { admin, push, pull }
  }));
}

export async function getRepoMetadata(owner, repo, accessToken) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data;
}

export async function getPullRequest(owner, repo, pullNumber, accessToken) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data;
}

// Raw unified diff. Used by the agent loop (Phase 7) when analyzing a PR.
export async function getPullRequestDiff(owner, repo, pullNumber, accessToken) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  });
  return data; // string when mediaType is diff
}

// List pull requests on a repo. Used by the repo detail page. state=all so
// the user can see open, closed, and merged PRs together; closed PRs will
// have the Review button disabled in the UI.
export async function listRepoPullRequests(
  owner,
  repo,
  accessToken,
  { state = 'all', perPage = 50 } = {}
) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state,
    per_page: perPage,
    sort: 'updated',
    direction: 'desc',
  });
  return data.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state, // 'open' | 'closed'
    merged: !!p.merged_at,
    draft: !!p.draft,
    author: p.user
      ? { login: p.user.login, avatarUrl: p.user.avatar_url }
      : null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    closedAt: p.closed_at,
    mergedAt: p.merged_at,
    htmlUrl: p.html_url,
    headRef: p.head?.ref,
    baseRef: p.base?.ref,
  }));
}

// Post an issue-style comment on a PR (PRs are issues under the hood for
// the comments API). Used by the "Post comment to PR" button on the
// Review Theater.
export async function postIssueComment(
  owner,
  repo,
  pullNumber,
  body,
  accessToken
) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
  return { id: data.id, htmlUrl: data.html_url };
}

// Post a full GitHub PR Review, optionally with line-level inline comments
// anchored to specific file paths + line numbers. `comments` items should be
// shaped like { path, line, body, side?='RIGHT' }. event='COMMENT' submits
// the review without approving/requesting changes — most neutral choice for
// an automated agent.
export async function createPullRequestReview(
  owner,
  repo,
  pullNumber,
  { body, comments = [], commitId, event = 'COMMENT' },
  accessToken
) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body,
    event,
    commit_id: commitId, // optional — anchors inline comments to a specific SHA
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      body: c.body,
    })),
  });
  return { id: data.id, htmlUrl: data.html_url, state: data.state };
}

// Structured list of files changed in the PR, with per-file patch chunks.
export async function getPullRequestFiles(owner, repo, pullNumber, accessToken) {
  const octokit = client(accessToken);
  const { data } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return data.map((f) => ({
    filename: f.filename,
    status: f.status, // added | modified | removed | renamed
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch, // may be undefined for binary or very large files
    sha: f.sha,
  }));
}

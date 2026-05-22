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

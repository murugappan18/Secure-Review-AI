// GitHub MCP wrapper — exposes our existing github.service.js calls as MCP
// tools. Auth comes from ctx.accessToken which the registry sources from the
// authenticated user's encrypted token at review-kickoff time.
//
// This is the layer the doc (§6.1 step 4) anticipates we'd later swap for
// the official `github-mcp-server` from Anthropic's MCP catalog. Same shape,
// different backend.

import {
  getRepoMetadata,
  getPullRequest,
  getPullRequestDiff,
  getPullRequestFiles,
} from '../../../services/github.service.js';

function requireToken(ctx) {
  if (!ctx?.accessToken) {
    const err = new Error('GitHub access token missing from MCP context');
    err.code = 'MCP_NO_TOKEN';
    throw err;
  }
  return ctx.accessToken;
}

const GET_REPO_METADATA = {
  name: 'get_repo_metadata',
  description:
    'Fetch GitHub metadata for a repository: default branch, language, ' +
    'topics, star count, license. Use when you need to know what the ' +
    'project is at a high level.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub owner (user or org).' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  async handler(args, ctx) {
    const data = await getRepoMetadata(args.owner, args.repo, requireToken(ctx));
    return {
      owner: data.owner?.login,
      name: data.name,
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch,
      language: data.language,
      topics: data.topics,
      description: data.description,
      stars: data.stargazers_count,
      license: data.license?.spdx_id ?? null,
    };
  },
};

const GET_PR = {
  name: 'get_pr',
  description:
    'Fetch a pull request\'s metadata: title, body, base & head SHAs, ' +
    'state, author. Use as the first call when reviewing a PR to ground ' +
    'yourself in what the change is supposed to do.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      prNumber: { type: 'number', description: 'PR number, e.g. 42.' },
    },
    required: ['owner', 'repo', 'prNumber'],
  },
  async handler(args, ctx) {
    const data = await getPullRequest(
      args.owner,
      args.repo,
      args.prNumber,
      requireToken(ctx)
    );
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      author: data.user?.login,
      body: data.body?.slice(0, 2000) ?? null,
      baseSha: data.base?.sha,
      headSha: data.head?.sha,
      baseRef: data.base?.ref,
      headRef: data.head?.ref,
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
    };
  },
};

const GET_PR_DIFF = {
  name: 'get_pr_diff',
  description:
    'Fetch the full unified diff of a PR as a single string. Use sparingly ' +
    '— prefer get_pr_files for structured per-file access. Diff strings can ' +
    'be large and waste context.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      prNumber: { type: 'number' },
    },
    required: ['owner', 'repo', 'prNumber'],
  },
  async handler(args, ctx) {
    const diff = await getPullRequestDiff(
      args.owner,
      args.repo,
      args.prNumber,
      requireToken(ctx)
    );
    // Cap to ~20k chars so a runaway PR doesn't blow the context budget.
    const capped = diff.length > 20_000 ? diff.slice(0, 20_000) + '\n... [truncated]' : diff;
    return { diff: capped, bytes: diff.length };
  },
};

const GET_PR_FILES = {
  name: 'get_pr_files',
  description:
    'List each file changed by a PR with its status (added | modified | ' +
    'removed | renamed), additions/deletions, and patch hunks. This is the ' +
    'primary way the agent inspects what a PR changes.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      prNumber: { type: 'number' },
    },
    required: ['owner', 'repo', 'prNumber'],
  },
  async handler(args, ctx) {
    const files = await getPullRequestFiles(
      args.owner,
      args.repo,
      args.prNumber,
      requireToken(ctx)
    );
    return {
      fileCount: files.length,
      files: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        // Per-file patch can also be big. Cap at 4k each.
        patch: f.patch?.length > 4000 ? f.patch.slice(0, 4000) + '\n... [truncated]' : f.patch,
      })),
    };
  },
};

export const githubTools = [GET_REPO_METADATA, GET_PR, GET_PR_DIFF, GET_PR_FILES];

export const githubServerInfo = {
  name: 'github',
  description:
    'MCP server wrapping the GitHub REST API — fetches PR metadata, diffs, ' +
    'and file changes for the repo currently under review.',
};

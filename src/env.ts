import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './types';

function parseNumber(input: string, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve runtime config from the release event that triggered the run. Throws early with
 * actionable messages if the run wasn't triggered by a release or mandatory secrets
 * (GITHUB_TOKEN, GEMINI_API_KEY) are missing.
 */
export function getConfig(): Config {
  // Resolve repo context robustly
  let { owner, repo } = github.context.repo as { owner?: string; repo?: string };
  owner = owner || '';
  repo = repo || '';
  const ghRepoEnv = process.env.GITHUB_REPOSITORY || '';
  if ((!owner || !repo) && ghRepoEnv.includes('/')) {
    const [o, r] = ghRepoEnv.split('/', 2);
    if (!owner) owner = o;
    if (!repo) repo = r;
  }
  const payloadRepo: any = (github as any).context?.payload?.repository;
  if (!owner && payloadRepo?.owner?.login) owner = String(payloadRepo.owner.login);
  if (!repo && payloadRepo?.name) repo = String(payloadRepo.name);

  const token = process.env.GITHUB_TOKEN || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing (add it as a repository secret).');

  // The release that triggered the run is the single source of truth for the range: its tag is
  // the head, its target_commitish is the branch, and the previous release (resolved in index.ts)
  // is the base. Nothing to wire in the workflow.
  const release = (github.context.payload as { release?: { tag_name?: unknown; target_commitish?: unknown } }).release;
  const releaseTag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!releaseTag) {
    throw new Error(
      'No release found in the event payload. Nuntia runs when a release is published — trigger it with `on: release: types: [published]`. To regenerate notes for a release, re-run this job from the Actions tab.'
    );
  }
  const branch = typeof release?.target_commitish === 'string' ? release.target_commitish : '';

  if (!owner || !repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  }

  const promptUrl = core.getInput('prompt-url');
  const model = core.getInput('model') || 'gemini-3.5-flash';
  const maxLinkedItems = Math.max(0, Math.floor(parseNumber(core.getInput('max-linked-items') || '5', 5)));
  const maxReferenceDepth = Math.max(0, Math.floor(parseNumber(core.getInput('max-reference-depth') || '2', 2)));
  const maxItemLength = Math.max(0, Math.floor(parseNumber(core.getInput('max-item-length') || '5000', 5000)));

  return {
    owner,
    repo,
    branch,
    releaseTag,
    baseCommit: '',
    headCommit: releaseTag,
    token,
    geminiApiKey,
    promptUrl,
    model,
    maxLinkedItems,
    maxReferenceDepth,
    maxItemLength,
  };
}

import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './types';

// Built-in prompt served from the repo. Used when prompt-url is left blank so the action works
// with zero configuration; keep in sync with the default in action.yml.
const DEFAULT_PROMPT_URL =
  'https://raw.githubusercontent.com/danielchalmers/Nuntia/refs/heads/main/examples/Nuntia.prompt';
const DEFAULT_MODEL = 'gemini-3.5-flash';

function parseNumber(input: string, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function requireInput(name: string): string {
  const value = core.getInput(name);
  if (!value) throw new Error(`Missing required input: ${name}.`);
  return value;
}

type BranchTarget = {
  owner: string;
  repo: string;
  branch: string;
};

function parseBranchInput(input: string, fallbackOwner: string, fallbackRepo: string): BranchTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Missing required input: branch.');
  }

  const match = trimmed.match(/^([^/\s]+)\/([^@\s]+)@(.+)$/);
  if (match && match[1] && match[2] && match[3]) {
    const owner = match[1];
    const repo = match[2];
    const branch = match[3].trim();
    if (!branch) {
      throw new Error('Branch input uses owner/repo@branch format but branch is empty.');
    }
    return { owner, repo, branch };
  }

  return { owner: fallbackOwner, repo: fallbackRepo, branch: trimmed };
}

/**
 * Resolve runtime config. Throws early with actionable messages if mandatory
 * secrets (GITHUB_TOKEN, GEMINI_API_KEY) are missing or repo context is absent.
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

  const releaseTag = core.getInput('release-tag').trim();
  const rawBase = core.getInput('base-commit').trim();
  const rawHead = core.getInput('head-commit').trim();
  const rawBranch = core.getInput('branch').trim();

  // Release mode: derive base/head/branch from a published GitHub Release instead of explicit SHAs.
  // Entered when a release-tag is given, or when nothing was specified at all (resolve the latest release).
  const releaseMode = releaseTag !== '' || (rawBase === '' && rawHead === '');

  let baseCommit = rawBase;
  let headCommit = rawHead;
  let branch = rawBranch;

  if (releaseMode) {
    // base/head/branch are resolved later from the release; only owner/repo are needed up front.
    // An explicit owner/repo@branch still overrides the target repo for cross-repo runs.
    if (rawBranch) {
      const branchTarget = parseBranchInput(rawBranch, owner || '', repo || '');
      owner = branchTarget.owner;
      repo = branchTarget.repo;
      branch = branchTarget.branch;
    }
    if (!owner || !repo) {
      throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
    }
  } else {
    baseCommit = requireInput('base-commit');
    headCommit = requireInput('head-commit');
    const branchTarget = parseBranchInput(requireInput('branch'), owner || '', repo || '');
    owner = branchTarget.owner;
    repo = branchTarget.repo;
    branch = branchTarget.branch;
    if (!owner || !repo) {
      throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context or pass branch as owner/repo@branch.');
    }
  }

  const promptUrl = core.getInput('prompt-url').trim() || DEFAULT_PROMPT_URL;
  const model = core.getInput('model').trim() || DEFAULT_MODEL;
  const maxLinkedItems = Math.max(0, Math.floor(parseNumber(core.getInput('max-linked-items') || '5', 5)));
  const maxReferenceDepth = Math.max(0, Math.floor(parseNumber(core.getInput('max-reference-depth') || '2', 2)));
  const maxItemLength = Math.max(0, Math.floor(parseNumber(core.getInput('max-item-length') || '5000', 5000)));

  return {
    owner,
    repo,
    branch,
    baseCommit,
    headCommit,
    token,
    geminiApiKey,
    promptUrl,
    model,
    maxLinkedItems,
    maxReferenceDepth,
    maxItemLength,
    releaseMode,
    releaseTag,
  };
}

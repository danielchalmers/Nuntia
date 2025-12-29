import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './types';

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

  const baseCommit = requireInput('base-commit');
  const headCommit = requireInput('head-commit');
  const rawBranch = requireInput('branch');
  const branchTarget = parseBranchInput(rawBranch, owner || '', repo || '');
  owner = branchTarget.owner;
  repo = branchTarget.repo;
  const branch = branchTarget.branch;
  if (!owner || !repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context or pass branch as owner/repo@branch.');
  }
  const promptUrl = core.getInput('prompt-url');
  const model = core.getInput('model') || 'gemini-3-flash-preview';
  const temperature = parseNumber(core.getInput('temperature') || '1.0', 1.0);
  const maxLinkedItems = Math.max(0, Math.floor(parseNumber(core.getInput('max-linked-items') || '3', 3)));
  const maxReferenceDepth = Math.max(0, Math.floor(parseNumber(core.getInput('max-reference-depth') || '2', 2)));
  const maxItemLengthInput = core.getInput('max-item-length');
  const legacyMaxItemLengthInput = core.getInput('max-item-body-length');
  const maxItemLength = Math.max(
    0,
    Math.floor(parseNumber(maxItemLengthInput || legacyMaxItemLengthInput || '3000', 3000))
  );

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
    temperature,
    maxLinkedItems,
    maxReferenceDepth,
    maxItemLength,
  };
}

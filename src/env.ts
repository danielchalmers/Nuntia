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
  if (!owner || !repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  }

  const token = process.env.GITHUB_TOKEN || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing (add it as a repository secret).');

  const baseCommit = requireInput('base-commit');
  const headCommit = requireInput('head-commit');
  const branch = requireInput('branch');
  const promptPath = core.getInput('prompt-path') || '.github/Nuntia.prompt';
  const outputPath = core.getInput('output-path') || 'artifacts/nuntia-release-notes.md';
  const model = core.getInput('model') || 'gemini-3-flash-preview';
  const temperature = parseNumber(core.getInput('temperature') || '1.0', 1.0);
  const maxLinkedItems = Math.max(0, Math.floor(parseNumber(core.getInput('max-linked-items') || '100', 100)));
  const maxReferenceDepth = Math.max(0, Math.floor(parseNumber(core.getInput('max-reference-depth') || '2', 2)));

  return {
    owner,
    repo,
    branch,
    baseCommit,
    headCommit,
    token,
    geminiApiKey,
    promptPath,
    outputPath,
    model,
    temperature,
    maxLinkedItems,
    maxReferenceDepth,
  };
}

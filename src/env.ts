import * as core from '@actions/core';
import * as github from '@actions/github';
import { ModelResolutionError, resolveModel, type ModelEnv, type ProviderId, type ResolvedModel } from './llm/resolve';
import type { Config } from './types';

// The model each key gets when the model input is blank. GEMINI_API_KEY keeps the default Nuntia had before other providers were supported.
// They favor quality over cost, because release notes are one call per release and a person reviews them.
const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: 'gemini-flash-latest',
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6.1-sol',
};

// The shared resolution error for a model whose provider key is not set.
const MISSING_KEY_ERROR = /which needs \w+_API_KEY, and it is not set/;

function parseNumber(input: string, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function requireInput(name: string): string {
  const value = core.getInput(name);
  if (!value) throw new Error(`Missing required input: ${name}.`);
  return value;
}

type Repository = {
  owner: string;
  repo: string;
};

type BranchTarget = {
  branch: string;
  // Set only when the input names a repository with owner/repo@branch.
  repository?: Repository;
};

function parseBranchInput(input: string): BranchTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Missing required input: branch.');
  }

  // The branch part may be empty so that a bare `owner/repo@` is rejected below rather than taken as a branch name.
  const match = trimmed.match(/^([^/\s]+)\/([^@\s]+)@(.*)$/);
  if (match && match[1] && match[2] && match[3] !== undefined) {
    const branch = match[3].trim();
    if (!branch) {
      throw new Error('Branch input uses owner/repo@branch format but branch is empty.');
    }
    return { branch, repository: { owner: match[1], repo: match[2] } };
  }

  return { branch: trimmed };
}

/**
 * The repository the workflow runs in.
 * context.repo already falls back from GITHUB_REPOSITORY to the event payload, and throws when neither is available.
 */
function resolveWorkflowRepository(): Repository {
  let repository: { owner?: string; repo?: string } = {};
  try {
    repository = github.context.repo;
  } catch {
    // Reported below with a message that names both ways to fix it.
  }
  if (!repository.owner || !repository.repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context or pass branch as owner/repo@branch.');
  }
  return { owner: repository.owner, repo: repository.repo };
}

/**
 * The model API settings, read only from the variables resolution documents.
 * Keys are masked so a later log line can't print them.
 */
function readModelEnv(): ModelEnv {
  const env: ModelEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
  };
  for (const key of [env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]) {
    if (key?.trim()) core.setSecret(key.trim());
  }
  return env;
}

/**
 * Resolve the model input to the provider that serves it, with the same rules as AutoTriage.
 * A workflow_dispatch input with a Gemini default keeps passing that model after a workflow switches keys, so the missing-key error also says how to fix the input.
 */
function resolveConfiguredModel(): ResolvedModel {
  try {
    return resolveModel({ input: 'model', value: core.getInput('model'), env: readModelEnv(), defaults: DEFAULT_MODELS });
  } catch (err) {
    if (err instanceof ModelResolutionError && MISSING_KEY_ERROR.test(err.message)) {
      throw new ModelResolutionError(`${err.message} If the model comes from a workflow_dispatch input, change that input's default to "" and set required: false, so the default for the key you set is used.`);
    }
    throw err;
  }
}

/**
 * Resolve runtime config.
 * Throws early with actionable messages if GITHUB_TOKEN is missing, the model input can't be resolved to a provider with its key, or repo context is absent.
 */
export function getConfig(): Config {
  const token = process.env.GITHUB_TOKEN || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  const resolvedModel = resolveConfiguredModel();

  const baseCommit = requireInput('base-commit');
  const headCommit = requireInput('head-commit');
  const { branch, repository } = parseBranchInput(requireInput('branch'));
  // Only consult the workflow's repository when the branch input doesn't name one, so owner/repo@branch works without repository context.
  const { owner, repo } = repository ?? resolveWorkflowRepository();
  const promptUrl = core.getInput('prompt-url');
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
    promptUrl,
    model: resolvedModel.model,
    resolvedModel,
    maxLinkedItems,
    maxReferenceDepth,
    maxItemLength,
  };
}

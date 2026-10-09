import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveModel, type ModelEnv, type ProviderId } from './llm/endpoint';
import { toReleaseDetails } from './github';
import type { Config, Trigger } from './types';

// The model each key gets when the model input is blank.
// They favor quality over cost, because release notes are one call per release and a person reviews them.
const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: 'gemini-flash-latest',
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6.1-sol',
};


type Repository = {
  owner: string;
  repo: string;
};

// Blank means the prompt bundled with the action.
function parsePromptUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  let protocol = '';
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`prompt-url must be an http or https URL, or blank to use the bundled prompt: ${trimmed}`);
  }
  return trimmed;
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
    // Reported below.
  }
  if (!repository.owner || !repository.repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  }
  return { owner: repository.owner, repo: repository.repo };
}

/**
 * The event that started the run.
 * A release event must carry its release, because that is what the notes are for.
 */
function readTrigger(): Trigger {
  const { eventName, ref, sha, payload } = github.context;
  const trigger: Trigger = { eventName, ref: ref || '', sha: sha || '', headRef: process.env.GITHUB_HEAD_REF || '' };
  if (eventName === 'release') {
    if (!payload.release) throw new Error('The release event has no release in its payload.');
    trigger.release = toReleaseDetails(payload.release);
  }
  return trigger;
}

function readModelEnv(): ModelEnv {
  const env: ModelEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  for (const key of [env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]) {
    if (key?.trim()) core.setSecret(key.trim());
  }
  return env;
}


/**
 * Resolve runtime config.
 * Throws early with actionable messages if GITHUB_TOKEN is missing, no model API key is set, repo context is absent, prompt-url isn't a URL, or a release event has no release.
 */
export function getConfig(): Config {
  const token = process.env.GITHUB_TOKEN || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  const endpoint = resolveModel('model', core.getInput('model'), readModelEnv(), DEFAULT_MODELS);
  const { owner, repo } = resolveWorkflowRepository();
  const promptUrl = parsePromptUrl(core.getInput('prompt-url'));

  return {
    owner,
    repo,
    token,
    promptUrl,
    model: endpoint.model,
    endpoint,
    trigger: readTrigger(),
  };
}

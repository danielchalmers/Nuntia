import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  setSecret: mocks.setSecret,
}));

// @actions/github is deliberately not mocked: its context.repo reads GITHUB_REPOSITORY on each access (falling back to the event payload), so these tests exercise the real fallback and error behavior.

import * as github from '@actions/github';
import { getConfig } from '../src/env';

const REQUIRED_INPUTS = { 'base-commit': 'base-sha', 'head-commit': 'head-sha', branch: 'main' };

function setInputs(values: Record<string, string>) {
  mocks.getInput.mockImplementation((name: string) => values[name] ?? '');
}

beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  // The runner's own model settings must not leak into resolution.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('GITHUB_REPOSITORY', 'acme/widgets');
  // On GitHub Actions the context loads the triggering event's payload at import; clear it so it can't stand in for GITHUB_REPOSITORY.
  github.context.payload = {};
  setInputs(REQUIRED_INPUTS);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('getConfig', () => {
  it('applies the documented defaults when optional inputs are omitted', () => {
    expect(getConfig()).toEqual({
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      baseCommit: 'base-sha',
      headCommit: 'head-sha',
      token: 'token',
      promptUrl: '',
      model: 'gemini-flash-latest',
      endpoint: {
        provider: 'gemini',
        model: 'gemini-flash-latest',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        host: 'generativelanguage.googleapis.com',
        apiKey: 'gemini-key',
        keyName: 'GEMINI_API_KEY',
        isDefault: true,
      },
      maxLinkedItems: 5,
      maxReferenceDepth: 2,
      maxItemLength: 5000,
    });
  });

  it('fails fast when GITHUB_TOKEN is not set', () => {
    vi.stubEnv('GITHUB_TOKEN', '');

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN missing/);
  });

  it('fails fast, naming every key, when no model API key is set', () => {
    vi.stubEnv('GEMINI_API_KEY', '');

    expect(() => getConfig()).toThrow(/No model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'anthropic', 'claude-sonnet-5-5'],
    ['OPENAI_API_KEY', 'openai', 'gpt-6.1-sol'],
  ])('uses the default model for %s when it is the only key', (name, provider, model) => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv(name, 'other-key');

    expect(getConfig()).toMatchObject({ model, endpoint: { provider, model, apiKey: 'other-key', isDefault: true } });
  });

  it('masks every model API key that is set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ' anthropic-key ');

    getConfig();

    expect(mocks.setSecret.mock.calls).toEqual([['gemini-key'], ['anthropic-key']]);
  });

  it('picks the provider from the model name when several keys are set', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    setInputs({ ...REQUIRED_INPUTS, model: 'claude-opus-5-5' });

    expect(getConfig()).toMatchObject({ model: 'claude-opus-5-5', endpoint: { provider: 'anthropic', apiKey: 'anthropic-key' } });
  });

  it('sends a model to OPENAI_BASE_URL unchanged', () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'router-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1/');
    setInputs({ ...REQUIRED_INPUTS, model: 'anthropic/claude-sonnet-5.5' });

    expect(getConfig()).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      endpoint: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai' },
    });
  });

  it.each(['base-commit', 'head-commit', 'branch'])('requires the %s input', (name) => {
    setInputs({ ...REQUIRED_INPUTS, [name]: '' });

    expect(() => getConfig()).toThrow(`Missing required input: ${name}.`);
  });

  it('rejects a branch input that is only whitespace', () => {
    setInputs({ ...REQUIRED_INPUTS, branch: '   ' });

    expect(() => getConfig()).toThrow('Missing required input: branch.');
  });

  it('targets another repository when branch uses owner/repo@branch', () => {
    setInputs({ ...REQUIRED_INPUTS, branch: 'other-org/other-repo@release/2.x' });

    expect(getConfig()).toMatchObject({ owner: 'other-org', repo: 'other-repo', branch: 'release/2.x' });
  });

  it.each(['other-org/other-repo@', 'other-org/other-repo@   '])('rejects %j instead of treating it as a branch name', (branch) => {
    setInputs({ ...REQUIRED_INPUTS, branch });

    expect(() => getConfig()).toThrow('Branch input uses owner/repo@branch format but branch is empty.');
  });

  it('falls back to the event payload repository when GITHUB_REPOSITORY is unset', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    github.context.payload = { repository: { name: 'payload-repo', owner: { login: 'payload-owner' } } } as any;

    expect(getConfig()).toMatchObject({ owner: 'payload-owner', repo: 'payload-repo' });
  });

  it('accepts owner/repo@branch without any repository context', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    setInputs({ ...REQUIRED_INPUTS, branch: 'other-org/other-repo@main' });

    expect(getConfig()).toMatchObject({ owner: 'other-org', repo: 'other-repo', branch: 'main' });
  });

  it('asks for owner/repo@branch when a plain branch has no repository context', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');

    expect(() => getConfig()).toThrow(/Failed to resolve repository context.*pass branch as owner\/repo@branch/);
  });

  it('treats a branch containing slashes but no @ as a plain branch name', () => {
    setInputs({ ...REQUIRED_INPUTS, branch: 'feature/login' });

    expect(getConfig()).toMatchObject({ owner: 'acme', repo: 'widgets', branch: 'feature/login' });
  });

  it('floors numeric limits and clamps negatives to zero', () => {
    setInputs({
      ...REQUIRED_INPUTS,
      'max-linked-items': '2.9',
      'max-reference-depth': '-3',
      'max-item-length': '0',
    });

    expect(getConfig()).toMatchObject({ maxLinkedItems: 2, maxReferenceDepth: 0, maxItemLength: 0 });
  });

  it('falls back to defaults for non-numeric limits', () => {
    setInputs({
      ...REQUIRED_INPUTS,
      'max-linked-items': 'many',
      'max-reference-depth': 'deep',
      'max-item-length': 'Infinity',
    });

    expect(getConfig()).toMatchObject({ maxLinkedItems: 5, maxReferenceDepth: 2, maxItemLength: 5000 });
  });

  it('passes the model and prompt URL inputs through', () => {
    setInputs({ ...REQUIRED_INPUTS, model: 'gemini-custom', 'prompt-url': ' https://example.com/p.txt\n' });

    expect(getConfig()).toMatchObject({ model: 'gemini-custom', promptUrl: 'https://example.com/p.txt', endpoint: { provider: 'gemini' } });
  });

  it('treats a prompt-url of only whitespace as blank, so the bundled prompt is used', () => {
    setInputs({ ...REQUIRED_INPUTS, 'prompt-url': '  \n' });

    expect(getConfig()).toMatchObject({ promptUrl: '' });
  });

  it.each(['examples/Nuntia.prompt', 'file:///etc/passwd', 'ftp://example.com/p.txt'])('rejects a prompt-url of %j, which is not an http or https URL', (promptUrl) => {
    setInputs({ ...REQUIRED_INPUTS, 'prompt-url': promptUrl });

    expect(() => getConfig()).toThrow(`prompt-url must be an http or https URL, or blank to use the bundled prompt: ${promptUrl}`);
  });
});

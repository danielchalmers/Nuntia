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
  vi.stubEnv('GITHUB_HEAD_REF', '');
  // On GitHub Actions the context loads the triggering event at import; replace it so the runner's own event can't leak in.
  github.context.payload = {};
  github.context.eventName = 'push';
  github.context.ref = 'refs/heads/main';
  github.context.sha = 'run-sha';
  setInputs({});
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
      trigger: { eventName: 'push', ref: 'refs/heads/main', sha: 'run-sha', headRef: '' },
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
    setInputs({ model: 'claude-opus-5-5' });

    expect(getConfig()).toMatchObject({ model: 'claude-opus-5-5', endpoint: { provider: 'anthropic', apiKey: 'anthropic-key' } });
  });

  it('sends a model to OPENAI_BASE_URL unchanged', () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'router-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1/');
    setInputs({ model: 'anthropic/claude-sonnet-5.5' });

    expect(getConfig()).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      endpoint: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai' },
    });
  });

  it('falls back to the event payload repository when GITHUB_REPOSITORY is unset', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    github.context.payload = { repository: { name: 'payload-repo', owner: { login: 'payload-owner' } } } as any;

    expect(getConfig()).toMatchObject({ owner: 'payload-owner', repo: 'payload-repo' });
  });

  it('fails without repository context', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');

    expect(() => getConfig()).toThrow('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  });

  it('ignores the removed range and tuning inputs', () => {
    setInputs({ 'base-commit': 'base-sha', 'head-commit': 'head-sha', branch: 'other-org/other-repo@main', 'max-linked-items': '1' });

    expect(getConfig()).toMatchObject({ owner: 'acme', repo: 'widgets', trigger: { ref: 'refs/heads/main', sha: 'run-sha' } });
    expect(mocks.getInput.mock.calls.map(([name]) => name).sort()).toEqual(['model', 'prompt-url']);
  });

  it('reads the release from a release event', () => {
    github.context.eventName = 'release';
    github.context.ref = 'refs/tags/v1.2.0';
    github.context.payload = {
      release: { tag_name: 'v1.2.0', name: ' Widgets 1.2 ', body: 'Notes', prerelease: true, target_commitish: 'dev' },
    } as any;

    expect(getConfig().trigger).toEqual({
      eventName: 'release',
      ref: 'refs/tags/v1.2.0',
      sha: 'run-sha',
      headRef: '',
      release: { tag: 'v1.2.0', name: 'Widgets 1.2', body: 'Notes', prerelease: true, targetCommitish: 'dev' },
    });
  });

  it('treats a missing release name and body as empty', () => {
    github.context.eventName = 'release';
    github.context.payload = { release: { tag_name: 'v1.2.0', name: null, body: null } } as any;

    expect(getConfig().trigger.release).toEqual({ tag: 'v1.2.0', name: null, body: '', prerelease: false, targetCommitish: '' });
  });

  it('fails when a release event carries no release', () => {
    github.context.eventName = 'release';

    expect(() => getConfig()).toThrow('The release event has no release in its payload.');
  });

  it('fails when the release has no tag', () => {
    github.context.eventName = 'release';
    github.context.payload = { release: { name: 'Untagged' } } as any;

    expect(() => getConfig()).toThrow('The release has no tag name.');
  });

  it('ignores a release in the payload of any other event', () => {
    github.context.payload = { release: { tag_name: 'v1.2.0' } } as any;

    expect(getConfig().trigger.release).toBeUndefined();
  });

  it("reads a pull request's branch from GITHUB_HEAD_REF", () => {
    vi.stubEnv('GITHUB_HEAD_REF', 'feature/login');
    github.context.eventName = 'pull_request';
    github.context.ref = 'refs/pull/7/merge';

    expect(getConfig().trigger).toMatchObject({ eventName: 'pull_request', ref: 'refs/pull/7/merge', headRef: 'feature/login' });
  });

  it('passes the model and prompt URL inputs through', () => {
    setInputs({ model: 'gemini-custom', 'prompt-url': ' https://example.com/p.txt\n' });

    expect(getConfig()).toMatchObject({ model: 'gemini-custom', promptUrl: 'https://example.com/p.txt', endpoint: { provider: 'gemini' } });
  });

  it('treats a prompt-url of only whitespace as blank, so the bundled prompt is used', () => {
    setInputs({ 'prompt-url': '  \n' });

    expect(getConfig()).toMatchObject({ promptUrl: '' });
  });

  it.each(['examples/Nuntia.prompt', 'file:///etc/passwd', 'ftp://example.com/p.txt'])('rejects a prompt-url of %j, which is not an http or https URL', (promptUrl) => {
    setInputs({ 'prompt-url': promptUrl });

    expect(() => getConfig()).toThrow(`prompt-url must be an http or https URL, or blank to use the bundled prompt: ${promptUrl}`);
  });
});

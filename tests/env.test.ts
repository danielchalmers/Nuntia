import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  contextRepo: { owner: 'acme', repo: 'widgets' },
}));

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
}));

vi.mock('@actions/github', () => ({
  context: {
    get repo() {
      return mocks.contextRepo;
    },
    payload: {},
  },
}));

import { getConfig } from '../src/env';

const REQUIRED_INPUTS = { 'base-commit': 'base-sha', 'head-commit': 'head-sha', branch: 'main' };

function setInputs(values: Record<string, string>) {
  mocks.getInput.mockImplementation((name: string) => values[name] ?? '');
}

beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  setInputs(REQUIRED_INPUTS);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      geminiApiKey: 'gemini-key',
      promptUrl: '',
      model: 'gemini-flash-latest',
      maxLinkedItems: 5,
      maxReferenceDepth: 2,
      maxItemLength: 5000,
    });
  });

  it.each([
    ['GITHUB_TOKEN', /GITHUB_TOKEN missing/],
    ['GEMINI_API_KEY', /GEMINI_API_KEY missing/],
  ])('fails fast when %s is not set', (name, expected) => {
    vi.stubEnv(name, '');

    expect(() => getConfig()).toThrow(expected);
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
    setInputs({ ...REQUIRED_INPUTS, model: 'gemini-custom', 'prompt-url': 'https://example.com/p.txt' });

    expect(getConfig()).toMatchObject({ model: 'gemini-custom', promptUrl: 'https://example.com/p.txt' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getInput: vi.fn() }));

vi.mock('@actions/core', () => ({ getInput: mocks.getInput }));
vi.mock('@actions/github', () => ({ context: { repo: { owner: 'acme', repo: 'widgets' }, payload: {} } }));

import { getConfig } from '../src/env';

function setBranch(branch: string) {
  const inputs: Record<string, string> = { 'base-commit': 'base-sha', 'head-commit': 'head-sha', branch };
  mocks.getInput.mockImplementation((name: string) => inputs[name] ?? '');
}

beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getConfig branch input', () => {
  it('uses the workflow repository for a plain branch name', () => {
    setBranch('feature/login');

    expect(getConfig()).toMatchObject({ owner: 'acme', repo: 'widgets', branch: 'feature/login' });
  });

  it('targets another repository with owner/repo@branch', () => {
    setBranch('other-org/other-repo@release/2.x');

    expect(getConfig()).toMatchObject({ owner: 'other-org', repo: 'other-repo', branch: 'release/2.x' });
  });

  it.each(['other-org/other-repo@', 'other-org/other-repo@   '])('rejects %j instead of treating it as a branch name', (branch) => {
    setBranch(branch);

    expect(() => getConfig()).toThrow('Branch input uses owner/repo@branch format but branch is empty.');
  });
});

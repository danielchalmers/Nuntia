import * as github from '@actions/github';
import { describe, expect, it } from 'vitest';

function runnerVariables(): string[] {
  return Object.keys(process.env).filter(name => /^(GITHUB|INPUT|RUNNER)_/.test(name));
}

// tests/setup.ts removes the runner's variables, so these hold on a GitHub Actions runner as well as locally.
describe('test setup', () => {
  it('builds the GitHub context without the runner event', () => {
    expect(github.context.eventName).toBeUndefined();
    expect(github.context.payload).toEqual({});
  });

  it('starts each test without GITHUB_*, INPUT_* or RUNNER_* variables', () => {
    expect(runnerVariables()).toEqual([]);

    // Leave variables behind without vi.stubEnv, as the runner's environment would, for the next test to check.
    process.env.GITHUB_REPOSITORY = 'leaked/repo';
    process.env.INPUT_MODEL = 'leaked-model';
    process.env.RUNNER_DEBUG = '1';
    process.env.NUNTIA_SETUP_TEST = 'kept';
  });

  it('removes the variables a previous test left behind, and keeps the others', () => {
    try {
      expect(runnerVariables()).toEqual([]);
      expect(process.env.NUNTIA_SETUP_TEST).toBe('kept');
    } finally {
      delete process.env.NUNTIA_SETUP_TEST;
    }
  });
});

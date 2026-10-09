import { beforeEach } from 'vitest';

// The GitHub Actions runner sets GITHUB_*, INPUT_* and RUNNER_* variables that the code under test reads, so without this a test could pass locally and fail in CI.
// They are removed before the test files load, because @actions/github builds its context at import, and again before each test, so a test that needs one stubs it with vi.stubEnv.
const RUNNER_VARIABLE = /^(GITHUB|INPUT|RUNNER)_/;

function clearRunnerEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (RUNNER_VARIABLE.test(name)) delete process.env[name];
  }
}

clearRunnerEnv();
beforeEach(clearRunnerEnv);

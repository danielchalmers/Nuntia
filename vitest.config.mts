import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // The build bundles .prompt files with esbuild's text loader, so tests import them as their text too.
      name: 'prompt-text',
      load(id) {
        return id.endsWith('.prompt') ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))};` : null;
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Only a failing test prints its logs, and tests that check a log line spy on it.
    silent: 'passed-only',
    // The proxy test in tests/llm/chat.test.ts uses undici's EnvHttpProxyAgent on purpose, so its experimental warning is expected.
    execArgv: ['--disable-warning=UNDICI-EHPA'],
  }
});

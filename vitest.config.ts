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
    include: ['tests/**/*.test.ts']
  }
});

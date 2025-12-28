import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildPrompt } from '../src/prompt';
import type { ReleaseContext } from '../src/types';

describe('buildPrompt', () => {
  it('injects the custom prompt and release context JSON', () => {
    const promptPath = path.join(__dirname, 'temp.prompt');
    fs.writeFileSync(promptPath, 'Test prompt content');

    try {
      const context: ReleaseContext = {
        repository: { owner: 'acme', repo: 'widgets', branch: 'main' },
        range: { base: 'a1b2c3d', head: 'd4e5f6g', totalCommits: 1 },
        commits: [],
        linkedItems: [],
      };

      const { systemPrompt, userPrompt } = buildPrompt(context, promptPath);
      expect(systemPrompt).toContain('Test prompt content');
      expect(userPrompt).toContain('"base": "a1b2c3d"');
      expect(userPrompt).toContain('"head": "d4e5f6g"');
    } finally {
      fs.unlinkSync(promptPath);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { loadPrompt } from '../src/storage';
import * as fs from 'fs';
import * as path from 'path';

describe('prompt loading', () => {
  it('loads custom prompt when file exists', async () => {
    const customPromptPath = path.join(__dirname, 'test-prompt.txt');
    fs.writeFileSync(customPromptPath, 'Custom test prompt');

    try {
      const result = await loadPrompt(customPromptPath);
      expect(result).toBe('Custom test prompt');
    } finally {
      fs.unlinkSync(customPromptPath);
    }
  });

  it('falls back to bundled prompt when custom file does not exist', async () => {
    const bundledPath = path.join(__dirname, '..', 'src', 'Nuntia.prompt');
    const testContent = '# Test bundled prompt content';
    fs.writeFileSync(bundledPath, testContent);

    try {
      const nonExistentPath = path.join(__dirname, 'does-not-exist.txt');
      const result = await loadPrompt(nonExistentPath);
      expect(result).toBe(testContent);
    } finally {
      fs.unlinkSync(bundledPath);
    }
  });

  it('loads bundled prompt when no path provided', async () => {
    const bundledPath = path.join(__dirname, '..', 'src', 'Nuntia.prompt');
    const testContent = '# Test bundled prompt content for empty path';
    fs.writeFileSync(bundledPath, testContent);

    try {
      const result = await loadPrompt('');
      expect(result).toBe(testContent);
    } finally {
      fs.unlinkSync(bundledPath);
    }
  });
});

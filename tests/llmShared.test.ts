import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// src/llm/ and tests/llm/ are copied verbatim from AutoTriage, so they must stand alone and must not be edited here.
const LLM_DIR = path.join(__dirname, '..', 'src', 'llm');

// The PINNED_HASH in AutoTriage's tests/llmShared.test.ts for the copied commit. Update it only when copying the folder over again.
const PINNED_HASH = 'sha256:b3fa340608609285099fdb328d15596296974c601596e7d8bf0846cfa1572ddf';

function llmFiles(dir: string): Array<{ name: string; text: string }> {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .sort()
    // Line endings are normalized so a Windows checkout hashes the same as CI.
    .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n') }));
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(match => match[1]!);
}

describe('src/llm', () => {
  it('imports only its own files and undici', () => {
    for (const { name, text } of llmFiles(LLM_DIR)) {
      for (const specifier of importSpecifiers(text)) {
        expect(specifier, name).toMatch(/^(\.\/[\w-]+|undici)$/);
      }
    }
  });

  it('matches the copy in AutoTriage', () => {
    const hash = createHash('sha256');
    for (const { name, text } of llmFiles(LLM_DIR)) {
      hash.update(`${name}\n${text}\n`);
    }

    expect(`sha256:${hash.digest('hex')}`, 'src/llm/ changed: make the change in AutoTriage and copy the folder over in a paired PR').toBe(PINNED_HASH);
  });
});

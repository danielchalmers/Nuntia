import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// src/llm/ and tests/llm/ are copied verbatim from AutoTriage, so they must stand alone and must not be edited here.
const LLM_DIR = path.join(__dirname, '..', 'src', 'llm');
const LLM_TESTS_DIR = path.join(__dirname, 'llm');
const HEADER = '// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.';
const TESTS_HEADER = '// Source: AutoTriage (danielchalmers/AutoTriage, tests/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.';

// The PINNED_HASH in AutoTriage's tests/llmShared.test.ts for the copied commit. Update it only when copying the folder over again.
const PINNED_HASH = 'sha256:8e50182406a83281830d72971adc29db1617e1818a69db50e510d2e9b6ae78a0';

function llmFiles(dir: string): Array<{ name: string; text: string }> {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .sort()
    // Line endings are normalized so a Windows checkout hashes the same as CI, as in AutoTriage.
    .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n') }));
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(match => match[1]!);
}

describe('src/llm', () => {
  it('names AutoTriage as the source at the top of every file', () => {
    for (const { name, text } of llmFiles(LLM_DIR)) {
      expect(text.split('\n')[0], name).toBe(HEADER);
    }
    for (const { name, text } of llmFiles(LLM_TESTS_DIR)) {
      expect(text.split('\n')[0], name).toBe(TESTS_HEADER);
    }
  });

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

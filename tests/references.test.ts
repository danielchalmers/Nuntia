import { describe, it, expect } from 'vitest';
import { extractReferences, summarizeReferences } from '../src/references';

function toKeys(refs: ReturnType<typeof extractReferences>) {
  return refs
    .map(ref => `${ref.type}:${ref.owner}/${ref.repo}#${ref.id}`)
    .sort();
}

describe('extractReferences', () => {
  it('parses issue, pull, and commit references', () => {
    const text = `
Fixes #12 and closes acme/widgets#78.
See https://github.com/acme/widgets/issues/34 and https://github.com/acme/widgets/pull/56.
Commit: https://github.com/acme/widgets/commit/abcdef1234567890abcdef1234567890abcdef12
Also mentioned: deadbeef1
`;

    const refs = extractReferences(text, 'acme', 'widgets');
    expect(toKeys(refs)).toEqual([
      'commit:acme/widgets#abcdef1234567890abcdef1234567890abcdef12',
      'commit:acme/widgets#deadbeef1',
      'issue:acme/widgets#12',
      'issue:acme/widgets#34',
      'issue:acme/widgets#78',
      'pull:acme/widgets#56',
    ]);
  });

  it('summarizes references into categories', () => {
    const refs = extractReferences('Fixes #1 and #2, see https://github.com/acme/widgets/pull/9', 'acme', 'widgets');
    const summary = summarizeReferences(refs);
    expect(summary.issues.sort()).toEqual([1, 2]);
    expect(summary.pulls).toEqual([9]);
  });
});

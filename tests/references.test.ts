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

    const knownCommits = new Set(['deadbeef1234567890deadbeef1234567890dead']);
    const refs = extractReferences(text, 'acme', 'widgets', knownCommits);
    expect(toKeys(refs)).toEqual([
      'commit:acme/widgets#abcdef1234567890abcdef1234567890abcdef12',
      'commit:acme/widgets#deadbeef1234567890deadbeef1234567890dead',
      'issue:acme/widgets#12',
      'issue:acme/widgets#34',
      'issue:acme/widgets#78',
      'pull:acme/widgets#56',
    ]);
  });

  it('drops bare short SHAs that do not match a known commit', () => {
    const text = 'Bump lockfile hash abc123def456, mention deadbeef and keep 0123456789abcdef0123456789abcdef01234567';
    const refs = extractReferences(text, 'acme', 'widgets', new Set(['fedcba9876543210fedcba9876543210fedcba98']));
    expect(toKeys(refs)).toEqual([
      'commit:acme/widgets#0123456789abcdef0123456789abcdef01234567',
    ]);
  });

  it('keeps explicit commit URLs even when the SHA is short and unknown', () => {
    const refs = extractReferences(
      'See https://github.com/acme/widgets/commit/deadbee for details',
      'acme',
      'widgets',
      new Set()
    );
    expect(toKeys(refs)).toEqual(['commit:acme/widgets#deadbee']);
  });

  it('summarizes references into categories', () => {
    const refs = extractReferences('Fixes #1 and #2, see https://github.com/acme/widgets/pull/9', 'acme', 'widgets');
    const summary = summarizeReferences(refs);
    expect(summary.issues.sort()).toEqual([1, 2]);
    expect(summary.pulls).toEqual([9]);
  });

  it('treats squash-merge subject suffix as a pull request reference', () => {
    const refs = extractReferences(
      'Rename and consolidate action inputs; simplify model temperature behavior (#57)\n\nBody text.',
      'acme',
      'widgets'
    );
    expect(toKeys(refs)).toEqual(['pull:acme/widgets#57']);
  });

  it('prefers pull classification over issue for ambiguous short references', () => {
    const refs = extractReferences('Merge pull request #57 from acme/widgets\n\nFixes #57', 'acme', 'widgets');
    expect(toKeys(refs)).toEqual(['pull:acme/widgets#57']);
  });
});

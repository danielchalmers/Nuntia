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

  it('returns nothing for empty text', () => {
    expect(extractReferences('', 'acme', 'widgets')).toEqual([]);
  });

  it('recognizes "PR #n" and "pull request #n" as pull requests', () => {
    const refs = extractReferences('Follow-up to PR #12 and pull request #13', 'acme', 'widgets');
    expect(toKeys(refs)).toEqual(['pull:acme/widgets#12', 'pull:acme/widgets#13']);
  });

  it('upgrades an issue reference to a pull when the same number is later called a pull request', () => {
    const refs = extractReferences('Closes acme/widgets#57 via PR #57', 'acme', 'widgets');
    expect(toKeys(refs)).toEqual(['pull:acme/widgets#57']);
  });

  it('does not read a cross-repo or word-attached #n as a local issue', () => {
    const refs = extractReferences('Ported from other/lib#5; see also build#6', 'acme', 'widgets');
    expect(toKeys(refs)).toEqual(['issue:other/lib#5']);
  });

  it('only treats a trailing (#n) on the subject line as a pull request', () => {
    const refs = extractReferences('Tidy up\n\nMentioned in the thread (#8)', 'acme', 'widgets');
    expect(toKeys(refs)).toEqual(['issue:acme/widgets#8']);
  });

  it('does not re-match the SHA inside a commit URL as a local commit', () => {
    const knownCommits = new Set(['deadbee1234567890deadbee1234567890deadbe']);
    const refs = extractReferences('Cherry-picked https://github.com/other/repo/commit/deadbee', 'acme', 'widgets', knownCommits);
    expect(toKeys(refs)).toEqual(['commit:other/repo#deadbee']);
  });

  it('lowercases SHAs and ignores digit-only runs even when they prefix a known commit', () => {
    const knownCommits = new Set(['1234567abcdef1234567abcdef1234567abcdef1']);
    const refs = extractReferences(
      'Built 1234567 from ABCDEF1234567890ABCDEF1234567890ABCDEF12',
      'acme',
      'widgets',
      knownCommits
    );
    expect(toKeys(refs)).toEqual(['commit:acme/widgets#abcdef1234567890abcdef1234567890abcdef12']);
  });

  it('summarizes references into categories', () => {
    const refs = extractReferences('Fixes #1 and #2, see https://github.com/acme/widgets/pull/9', 'acme', 'widgets');
    const summary = summarizeReferences(refs, 'acme', 'widgets');
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

describe('summarizeReferences', () => {
  it('de-duplicates numbers and SHAs within each category', () => {
    expect(
      summarizeReferences([
        { type: 'issue', owner: 'acme', repo: 'widgets', id: '1' },
        { type: 'issue', owner: 'acme', repo: 'widgets', id: '1' },
        { type: 'pull', owner: 'acme', repo: 'widgets', id: '2' },
        { type: 'commit', owner: 'acme', repo: 'widgets', id: 'abc1234' },
        { type: 'commit', owner: 'acme', repo: 'widgets', id: 'abc1234' },
      ], 'acme', 'widgets')
    ).toEqual({ issues: [1], pulls: [2], commits: ['abc1234'] });
  });

  it('qualifies references to other repositories so they are not mistaken for local ones', () => {
    const refs = extractReferences(
      'Fixes #1 and other/lib#1, ports https://github.com/other/lib/pull/2 and https://github.com/other/lib/commit/abcdef1234567890abcdef1234567890abcdef12',
      'acme',
      'widgets'
    );

    expect(summarizeReferences(refs, 'acme', 'widgets')).toEqual({
      issues: ['other/lib#1', 1],
      pulls: ['other/lib#2'],
      commits: ['other/lib@abcdef1234567890abcdef1234567890abcdef12'],
    });
  });

  it('treats the release repository case-insensitively', () => {
    const refs = extractReferences('See Acme/Widgets#7', 'acme', 'widgets');

    expect(summarizeReferences(refs, 'acme', 'widgets').issues).toEqual([7]);
  });
});

import type { GitHubClient } from './github';

// Matches the compare/first-release link GitHub appends to generated notes:
//   **Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.1.0
//   **Full Changelog**: https://github.com/o/r/commits/v1.0.0   (first release, no previous tag)
// Tag names contain single dots; the base/head separator is a literal "..." so the non-greedy
// base capture stops at the first three-dot run.
const COMPARE_LINK = /\/compare\/(.+?)\.\.\.([^\s)]+)/;
const COMMITS_LINK = /\/commits\/([^\s)]+)/;

/**
 * Recover the previous release tag from GitHub's generated-notes body.
 * Returns an empty base and isFirstRelease when there is no previous release to diff against.
 */
export function parseRangeFromNotes(body: string): { base: string; isFirstRelease: boolean } {
  const compare = body.match(COMPARE_LINK);
  if (compare && compare[1]) {
    return { base: compare[1], isFirstRelease: false };
  }
  if (COMMITS_LINK.test(body)) {
    return { base: '', isFirstRelease: true };
  }
  // No recognizable changelog link: treat as first release rather than guess a wrong base.
  return { base: '', isFirstRelease: true };
}

/**
 * Ask GitHub which release came before `tag`, using its own previous-tag logic (the same one that
 * fills the auto-generated release body). Returns the previous tag as the base, or a first-release flag.
 */
export async function resolvePreviousTag(gh: GitHubClient, tag: string): Promise<{ base: string; isFirstRelease: boolean }> {
  const notes = await gh.generateReleaseNotes(tag);
  return parseRangeFromNotes(notes);
}

import type { GitHubClient } from './github';

export type ResolvedRelease = {
  base: string; // previous release tag; '' when this is the first release (whole-history mode)
  head: string; // the release tag
  branch: string; // the release's target branch/commitish
  releaseId: number;
  isFirstRelease: boolean;
};

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
  // No recognizable changelog link. Treat as first release rather than guessing a wrong base;
  // the whole-history walk (or an explicit base-commit) is the safe fallback.
  return { base: '', isFirstRelease: true };
}

/**
 * Resolve the base/head/branch for a release from its tag, using GitHub's own previous-tag logic.
 * When releaseTag is empty, resolves the repository's latest published release.
 */
export async function resolveReleaseRange(gh: GitHubClient, releaseTag: string): Promise<ResolvedRelease> {
  const release = releaseTag ? await gh.getReleaseByTag(releaseTag) : await gh.getLatestRelease();
  const tag = release.tagName;
  const notes = await gh.generateReleaseNotes(tag);
  const { base, isFirstRelease } = parseRangeFromNotes(notes);
  return {
    base,
    head: tag,
    branch: release.targetCommitish,
    releaseId: release.id,
    isFirstRelease,
  };
}

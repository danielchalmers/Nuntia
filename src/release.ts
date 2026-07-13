import type { GitHubClient, ReleaseSummary } from './github';

export type CurrentRelease = {
  tagName: string;
  publishedAt: string;
  prerelease: boolean;
};

/**
 * Pick the release that came before `current`: the latest non-draft release published strictly
 * before it. Stable releases compare against stable releases (prereleases are skipped, matching
 * GitHub's own previous-tag behavior), falling back to prereleases when no stable release exists.
 * The list order is irrelevant — GitHub does not guarantee it — because publish dates are compared
 * explicitly. Returns an empty string when there is no previous release.
 */
export function pickPreviousTag(current: CurrentRelease, releases: ReleaseSummary[]): string {
  const currentTime = Date.parse(current.publishedAt);
  const candidates = releases.filter(release => {
    if (release.draft || release.tagName === current.tagName) return false;
    const time = Date.parse(release.publishedAt);
    if (!Number.isFinite(time)) return false;
    // Compare against what existed when the release was published, so re-running the job for an
    // older release reproduces its original range instead of diffing against a newer release.
    return Number.isFinite(currentTime) ? time < currentTime : true;
  });

  const stable = candidates.filter(release => !release.prerelease);
  const pool = current.prerelease ? candidates : (stable.length > 0 ? stable : candidates);

  let previous: ReleaseSummary | undefined;
  for (const release of pool) {
    if (!previous || Date.parse(release.publishedAt) > Date.parse(previous.publishedAt)) {
      previous = release;
    }
  }
  return previous?.tagName ?? '';
}

/**
 * Resolve the previous release tag (the base of the commit range) from the repository's release
 * list — a read-only lookup. Returns a first-release flag when nothing came before.
 */
export async function resolvePreviousTag(
  gh: GitHubClient,
  current: CurrentRelease
): Promise<{ base: string; isFirstRelease: boolean }> {
  const releases = await gh.listReleases();
  const base = pickPreviousTag(current, releases);
  return base ? { base, isFirstRelease: false } : { base: '', isFirstRelease: true };
}

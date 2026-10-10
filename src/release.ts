import { httpStatus, type GitHubClient, type ReleaseDetails } from './github';
import { hasGeneratedNotes } from './publish';
import type { ReleaseRange, Trigger } from './types';

// A reason to stop without writing notes that isn't a failure, such as a first release.
export type Skip = { skip: string };

// What a Full Changelog link says about the release before this one.
export type ChangelogLink = { base: string } | { firstRelease: true };

const FULL_CHANGELOG = /\*\*Full Changelog\*\*:\s*(\S+)/g;

function decodeRef(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function parseLink(url: string, owner: string, repo: string, tag: string): ChangelogLink | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/(compare|commits)\/(.+)$/.exec(path);
  if (!match?.[1] || !match[2] || !match[4]) return undefined;
  if (match[1].toLowerCase() !== owner.toLowerCase() || match[2].toLowerCase() !== repo.toLowerCase()) return undefined;

  const refs = decodeRef(match[4]);
  if (!refs) return undefined;
  if (match[3] === 'commits') return refs === tag ? { firstRelease: true } : undefined;
  // Git forbids ".." in ref names, so the first "..." separates the two refs.
  const separator = refs.indexOf('...');
  if (separator <= 0 || refs.slice(separator + 3) !== tag) return undefined;
  return { base: refs.slice(0, separator) };
}

/**
 * Read the `**Full Changelog**: https://github.com/OWNER/REPO/compare/BASE...TAG` line that GitHub adds to generated release notes.
 * A first release links to `/commits/TAG` instead.
 * Lines that point at another repository or another tag say nothing about this release, so they are skipped, and the last line that fits wins.
 */
export function parseFullChangelog(body: string, owner: string, repo: string, tag: string): ChangelogLink | undefined {
  let link: ChangelogLink | undefined;
  for (const [, url] of body.matchAll(FULL_CHANGELOG)) {
    link = (url ? parseLink(url, owner, repo, tag) : undefined) ?? link;
  }
  return link;
}

async function generateReleaseNotes(gh: GitHubClient, owner: string, repo: string, tag: string): Promise<string> {
  try {
    return await gh.generateReleaseNotes(tag);
  } catch (error) {
    if (httpStatus(error) !== 403) throw error;
    throw new Error(
      `Release ${tag} has no Full Changelog link, and asking GitHub to generate one needs permissions: contents: write. ` +
        `Grant that permission, or add a "**Full Changelog**: https://github.com/${owner}/${repo}/compare/PREVIOUS...${tag}" line to the release.`
    );
  }
}

async function releaseRange(gh: GitHubClient, release: ReleaseDetails, owner: string, repo: string): Promise<ReleaseRange | Skip> {
  let link = parseFullChangelog(release.body, owner, repo, release.tag);
  let source = "the release's Full Changelog link";
  if (!link) {
    console.log(`Release ${release.tag} has no Full Changelog link to ${owner}/${repo}, so asking GitHub to generate release notes for it.`);
    link = parseFullChangelog(await generateReleaseNotes(gh, owner, repo, release.tag), owner, repo, release.tag);
    source = "GitHub's generated release notes";
  }

  if (!link || 'firstRelease' in link) {
    const reason = link
      ? `${release.tag} is the first release, so there is no earlier release to compare it with.`
      : `GitHub's generated release notes for ${release.tag} have no Full Changelog link, so there is no earlier release to compare it with.`;
    return {
      skip: `${reason} To write notes for it anyway, add a "**Full Changelog**: https://github.com/${owner}/${repo}/compare/EARLIER...${release.tag}" line to the release, then run the workflow from the ${release.tag} tag.`,
    };
  }

  console.log(`Release ${release.tag}: the commits after ${link.base}, from ${source}.`);
  return {
    base: link.base,
    head: release.tag,
    // On a release event the run's ref is the tag, so the release names its branch.
    branch: release.targetCommitish,
    release: {
      tag: release.tag,
      previousTag: link.base,
      name: release.name,
      prerelease: release.prerelease,
      hasChangeList: hasGeneratedNotes(release.body),
    },
  };
}

// Preview never calls generate-notes, because that needs contents: write.
async function previewRange(gh: GitHubClient, trigger: Trigger): Promise<ReleaseRange | Skip> {
  if (!trigger.sha) throw new Error('GITHUB_SHA is not set, so there is no commit to preview the next release up to.');

  const debugBase = process.env.NUNTIA_PREVIEW_BASE?.trim();
  let base = debugBase || (await gh.findLatestRelease())?.tag;
  let source = debugBase ? 'the CI debug range limit' : 'the latest release';
  if (!base) {
    base = await gh.findNewestTag();
    source = 'the newest tag, because there is no published release';
  }
  if (!base) return { skip: 'The repository has no releases or tags yet, so there is no earlier release to preview the next one against.' };

  const branch = trigger.headRef || trigger.ref.replace(/^refs\/(heads|tags)\//, '');
  console.log(`Preview of the next release: the commits after ${base} (${source}) up to ${trigger.sha.slice(0, 7)} on ${branch}.`);
  return { base, head: trigger.sha, branch, release: null };
}

/**
 * Decide which commits the notes cover.
 * A release event uses its release, and a dispatch from a tag uses that tag's release, with the base from the release's Full Changelog link.
 * Any other run previews the next release: the commits after the latest release, up to the run's commit.
 */
export async function resolveRange(gh: GitHubClient, trigger: Trigger, owner: string, repo: string): Promise<ReleaseRange | Skip> {
  if (trigger.release) return releaseRange(gh, trigger.release, owner, repo);

  const tag = trigger.ref.startsWith('refs/tags/') ? trigger.ref.slice('refs/tags/'.length) : '';
  if (trigger.eventName === 'workflow_dispatch' && tag) {
    const release = await gh.findReleaseByTag(tag);
    if (!release) {
      throw new Error(`Tag ${tag} has no published release. Publish the release first, or run the workflow from a branch to preview the next release's notes.`);
    }
    return releaseRange(gh, release, owner, repo);
  }

  return previewRange(gh, trigger);
}

import * as core from '@actions/core';
import { httpStatus, type GitHubClient } from './github';
import { errorMessage } from './llm/chat';

export const NOTES_START = '<!-- nuntia:start -->';
export const NOTES_END = '<!-- nuntia:end -->';
// GitHub refuses a release body longer than about this many characters, so a longer one isn't sent.
export const MAX_RELEASE_BODY_LENGTH = 125_000;

const GENERATED_NOTES_COMMENT = '<!-- Release notes generated';
const GENERATED_NOTES_HEADING = /^## What's Changed/m;

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * The release body with Nuntia's section set to section.
 * The text between the markers is replaced, and a body without markers gets the section just before GitHub's generated notes, or at the top when it has none.
 * Returns undefined unless the body has either no markers or one start followed by one end, because otherwise there is no telling which text is Nuntia's.
 */
export function spliceNotes(body: string, section: string): string | undefined {
  const block = `${NOTES_START}\n\n${section.trim()}\n\n${NOTES_END}`;
  const starts = count(body, NOTES_START);
  const ends = count(body, NOTES_END);

  if (starts === 1 && ends === 1) {
    const start = body.indexOf(NOTES_START);
    const end = body.indexOf(NOTES_END);
    if (end < start) return undefined;
    return body.slice(0, start) + block + body.slice(end + NOTES_END.length);
  }
  if (starts || ends) return undefined;

  let at = body.indexOf(GENERATED_NOTES_COMMENT);
  if (at < 0) at = body.search(GENERATED_NOTES_HEADING);
  if (at < 0) at = 0;
  return [body.slice(0, at).trimEnd(), block, body.slice(at).trimStart()].filter(Boolean).join('\n\n');
}

/**
 * Write section into the published release for tag, changing only Nuntia's part of its body.
 * The release is read again first, because generating the notes takes minutes and people edit releases in the meantime.
 * A missing permission fails the run.
 * GitHub being unavailable, or a body Nuntia can't safely change, only warns, because the notes are already in the job summary.
 */
export async function writeToRelease(gh: GitHubClient, tag: string, section: string): Promise<void> {
  try {
    const release = await gh.readReleaseBody(tag);
    if (!release) {
      core.warning(`Release ${tag} no longer exists, so the notes are only in the job summary.`);
      return;
    }

    const body = spliceNotes(release.body, section);
    if (body === undefined) {
      core.warning(
        `Release ${tag} doesn't have exactly one ${NOTES_START} followed by one ${NOTES_END}, so Nuntia can't tell which text is its own, and the notes are only in the job summary. ` +
          'Fix the markers in the release, or remove both, then re-run the job.'
      );
      return;
    }
    if (body.length > MAX_RELEASE_BODY_LENGTH) {
      core.warning(
        `With the notes, release ${tag} would be ${body.length.toLocaleString('en-US')} characters, over GitHub's limit of about ${MAX_RELEASE_BODY_LENGTH.toLocaleString('en-US')}, so the notes are only in the job summary.`
      );
      return;
    }
    if (body === release.body) {
      console.log(`Release ${tag} already has these notes.`);
      return;
    }

    await gh.updateReleaseBody(release.id, body);
    console.log(`Wrote the notes into release ${tag}.`);
  } catch (error) {
    const status = httpStatus(error);
    if (status === 401 || status === 403) {
      throw new Error(
        `Writing the notes into release ${tag} needs permissions: contents: write in the workflow. The notes are in the job summary. GitHub said: ${errorMessage(error)}`
      );
    }
    if (status === 404 || status === 408 || status === 429 || (status !== undefined && status >= 500)) {
      core.warning(`GitHub couldn't save the notes into release ${tag}, so they are only in the job summary. Re-run the job to try again. GitHub said: ${errorMessage(error)}`);
      return;
    }
    throw error;
  }
}

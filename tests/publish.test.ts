import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import type { GitHubClient } from '../src/github';
import { MAX_RELEASE_BODY_LENGTH, NOTES_END, NOTES_START, hasGeneratedNotes, spliceNotes, writeToRelease } from '../src/publish';

vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  warning: vi.fn(),
}));

// Shaped like a body from Generate release notes, which GitHub returns with CRLF line endings.
const GENERATED =
  "<!-- Release notes generated using configuration in .github/release.yml at main -->\r\n\r\n## What's Changed\r\n" +
  '### Bug fixes\r\n* Fix the cache by @dev in https://github.com/acme/widgets/pull/7\r\n\r\n\r\n' +
  '**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0';
const NOTE = '> [!NOTE]\r\n> Hand-written by a maintainer.';
const SECTION = '## Highlights\n\n- **Faster.** Pages load sooner.\n';

function block(section: string): string {
  return `${NOTES_START}\n\n${section.trim()}\n\n${NOTES_END}`;
}

describe('hasGeneratedNotes', () => {
  it("finds GitHub's generated notes by their comment or by the What's Changed heading", () => {
    expect(hasGeneratedNotes(GENERATED)).toBe(true);
    expect(hasGeneratedNotes(`${NOTE}\r\n\r\n${GENERATED.slice(GENERATED.indexOf("## What's Changed"))}`)).toBe(true);
    expect(hasGeneratedNotes(`${block(SECTION)}\n\n${GENERATED}`)).toBe(true);
  });

  it('finds none in a hand-written or empty body', () => {
    expect(hasGeneratedNotes('Hand-written notes.\n\n**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0')).toBe(false);
    expect(hasGeneratedNotes("Mentions What's Changed in passing.")).toBe(false);
    expect(hasGeneratedNotes('')).toBe(false);
  });

  it("ignores a What's Changed heading inside Nuntia's own section", () => {
    expect(hasGeneratedNotes(`Hand-written notes.\n\n${block("## What's Changed\n\n- Faster.")}`)).toBe(false);
  });
});

describe('spliceNotes', () => {
  it("inserts the section just before GitHub's generated notes, below text written above them", () => {
    expect(spliceNotes(`${NOTE}\r\n\r\n${GENERATED}`, SECTION)).toBe(`${NOTE}\n\n${block(SECTION)}\n\n${GENERATED}`);
  });

  it("inserts the section before the What's Changed heading when the generated comment is gone", () => {
    const body = GENERATED.slice(GENERATED.indexOf("## What's Changed"));

    expect(spliceNotes(`Intro\n${body}`, SECTION)).toBe(`Intro\n\n${block(SECTION)}\n\n${body}`);
  });

  it('inserts the section at the top of a body without generated notes, and makes it the whole of an empty body', () => {
    expect(spliceNotes('Hand-written notes.', SECTION)).toBe(`${block(SECTION)}\n\nHand-written notes.`);
    expect(spliceNotes('', SECTION)).toBe(block(SECTION));
  });

  it('replaces only the text between the markers', () => {
    const body = `${NOTE}\r\n\r\n${NOTES_START}\nOld notes, edited by hand.\n${NOTES_END}\r\nText after.\r\n\r\n${GENERATED}`;

    expect(spliceNotes(body, SECTION)).toBe(`${NOTE}\r\n\r\n${block(SECTION)}\r\nText after.\r\n\r\n${GENERATED}`);
  });

  it('gives the same body when run again, with the same notes or with new ones', () => {
    const first = spliceNotes(`${NOTE}\r\n\r\n${GENERATED}`, SECTION)!;

    expect(spliceNotes(first, SECTION)).toBe(first);
    expect(spliceNotes(spliceNotes(first, 'Other notes.')!, SECTION)).toBe(first);
  });

  it.each([
    ['a start without an end', `${NOTES_START}\nNotes`],
    ['an end without a start', `Notes\n${NOTES_END}`],
    ['an end before the start', `${NOTES_END}\nNotes\n${NOTES_START}`],
    ['two sections', `${block('One')}\n${block('Two')}`],
  ])("refuses a body with %s, because it can't tell which text is Nuntia's", (_name, body) => {
    expect(spliceNotes(body, SECTION)).toBeUndefined();
  });
});

describe('writeToRelease', () => {
  function makeClient(release: { id: number; body: string } | undefined | Error, update: unknown = undefined) {
    return {
      readReleaseBody: release instanceof Error ? vi.fn().mockRejectedValue(release) : vi.fn().mockResolvedValue(release),
      updateReleaseBody: update instanceof Error ? vi.fn().mockRejectedValue(update) : vi.fn().mockResolvedValue(update),
    };
  }

  function write(client: ReturnType<typeof makeClient>, section = SECTION) {
    return writeToRelease(client as unknown as GitHubClient, 'v1.1.0', section);
  }

  function httpError(status: number) {
    return Object.assign(new Error(`HTTP ${status}`), { status });
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(core.warning).mockClear();
  });

  it('reads the release again by its tag and saves the body with the section in it', async () => {
    const client = makeClient({ id: 42, body: GENERATED });

    await write(client);

    expect(client.readReleaseBody).toHaveBeenCalledWith('v1.1.0');
    expect(client.updateReleaseBody).toHaveBeenCalledWith(42, `${block(SECTION)}\n\n${GENERATED}`);
    expect(console.log).toHaveBeenCalledWith('Wrote the notes into release v1.1.0.');
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('saves nothing when the release already has these notes', async () => {
    const client = makeClient({ id: 42, body: spliceNotes(GENERATED, SECTION)! });

    await write(client);

    expect(client.updateReleaseBody).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Release v1.1.0 already has these notes.');
  });

  it('skips the write with a warning when the body would pass the size limit, and writes one at the limit', async () => {
    const room = MAX_RELEASE_BODY_LENGTH - block('').length - 2;
    const fits = makeClient({ id: 42, body: '' });
    const tooLong = makeClient({ id: 42, body: 'x'.repeat(room) });

    await write(fits, 'y'.repeat(MAX_RELEASE_BODY_LENGTH - block('').length));
    await write(tooLong, 'y');

    expect(fits.updateReleaseBody).toHaveBeenCalledOnce();
    expect(vi.mocked(fits.updateReleaseBody).mock.calls[0]![1]).toHaveLength(MAX_RELEASE_BODY_LENGTH);
    expect(tooLong.updateReleaseBody).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      "With the notes, release v1.1.0 would be 125,001 characters, over GitHub's limit of about 125,000, so the notes are only in the job summary."
    );
  });

  it('warns without writing when the markers are broken', async () => {
    const client = makeClient({ id: 42, body: `${NOTES_START}\nNotes` });

    await write(client);

    expect(client.updateReleaseBody).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("so Nuntia can't tell which text is its own"));
  });

  it('warns without writing when the release has been deleted', async () => {
    const client = makeClient(undefined);

    await write(client);

    expect(client.updateReleaseBody).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith('Release v1.1.0 no longer exists, so the notes are only in the job summary.');
  });

  it.each([401, 403])('fails the run on HTTP %i, naming the permission the workflow needs', async (status) => {
    const client = makeClient({ id: 42, body: GENERATED }, httpError(status));

    await expect(write(client)).rejects.toThrow(
      `Writing the notes into release v1.1.0 needs permissions: contents: write in the workflow. The notes are in the job summary. GitHub said: HTTP ${status}`
    );
  });

  it.each([404, 408, 429, 500, 502, 503])('only warns on HTTP %i, which is GitHub having trouble rather than a mistake in the workflow', async (status) => {
    const client = makeClient({ id: 42, body: GENERATED }, httpError(status));

    await expect(write(client)).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(
      `GitHub couldn't save the notes into release v1.1.0, so they are only in the job summary. Re-run the job to try again. GitHub said: HTTP ${status}`
    );
  });

  it('only warns when reading the release fails on a server error', async () => {
    const client = makeClient(httpError(502));

    await expect(write(client)).resolves.toBeUndefined();
    expect(client.updateReleaseBody).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('GitHub said: HTTP 502'));
  });

  it('passes on any other failure, which points at a bug', async () => {
    const unexpected = makeClient({ id: 42, body: GENERATED }, httpError(422));
    const thrown = makeClient(new TypeError('boom'));

    await expect(write(unexpected)).rejects.toThrow('HTTP 422');
    await expect(write(thrown)).rejects.toThrow('boom');
    expect(core.warning).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubClient, ReleaseDetails } from '../src/github';
import { parseFullChangelog, resolveRange } from '../src/release';
import type { Trigger } from '../src/types';

const COMPARE_LINE = '**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0';

function makeRelease(overrides: Partial<ReleaseDetails> = {}): ReleaseDetails {
  return {
    tag: 'v1.1.0',
    name: 'Widgets 1.1',
    // Shaped like a body from Generate release notes, which GitHub returns with CRLF line endings.
    body: `## What's Changed\r\n* Add export by @dev in https://github.com/acme/widgets/pull/7\r\n\r\n\r\n${COMPARE_LINE}`,
    prerelease: false,
    targetCommitish: 'main',
    ...overrides,
  };
}

function makeClient(opts: { byTag?: ReleaseDetails; latest?: ReleaseDetails; newestTag?: string; generated?: string | Error } = {}) {
  return {
    findReleaseByTag: vi.fn().mockResolvedValue(opts.byTag),
    findLatestRelease: vi.fn().mockResolvedValue(opts.latest),
    findNewestTag: vi.fn().mockResolvedValue(opts.newestTag),
    generateReleaseNotes:
      opts.generated instanceof Error ? vi.fn().mockRejectedValue(opts.generated) : vi.fn().mockResolvedValue(opts.generated ?? ''),
  };
}

function resolve(client: ReturnType<typeof makeClient>, trigger: Partial<Trigger>) {
  const full: Trigger = { eventName: 'push', ref: 'refs/heads/main', sha: 'f00dfeed1234567890', headRef: '', ...trigger };
  return resolveRange(client as unknown as GitHubClient, full, 'acme', 'widgets');
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseFullChangelog', () => {
  it("reads the previous tag from GitHub's Full Changelog line", () => {
    expect(parseFullChangelog(makeRelease().body, 'acme', 'widgets', 'v1.1.0')).toEqual({ base: 'v1.0.0' });
  });

  it('matches the owner and repository without regard to case', () => {
    const body = '**Full Changelog**: https://github.com/Acme/Widgets/compare/v1.0.0...v1.1.0';

    expect(parseFullChangelog(body, 'acme', 'widgets', 'v1.1.0')).toEqual({ base: 'v1.0.0' });
  });

  it('marks a /commits/ link as a first release', () => {
    const body = '**Full Changelog**: https://github.com/acme/widgets/commits/v1.1.0';

    expect(parseFullChangelog(body, 'acme', 'widgets', 'v1.1.0')).toEqual({ firstRelease: true });
  });

  it.each([
    ['another repository', 'https://github.com/other/widgets/compare/v1.0.0...v1.1.0'],
    ['a fork with the same name', 'https://github.com/someone/widgets/compare/v1.0.0...v1.1.0'],
    ['another tag', 'https://github.com/acme/widgets/compare/v0.9.0...v1.0.0'],
    ['the first release of another tag', 'https://github.com/acme/widgets/commits/v1.0.0'],
    ['the first release of another repository', 'https://github.com/other/widgets/commits/v1.1.0'],
    ['a compare link with no base', 'https://github.com/acme/widgets/compare/...v1.1.0'],
    ['a compare link with two dots', 'https://github.com/acme/widgets/compare/v1.0.0..v1.1.0'],
    ['a pull request link', 'https://github.com/acme/widgets/pull/7'],
    ['text that is not a URL', 'see-below'],
  ])('ignores a link to %s', (_label, url) => {
    expect(parseFullChangelog(`**Full Changelog**: ${url}`, 'acme', 'widgets', 'v1.1.0')).toBeUndefined();
  });

  it('returns nothing when there is no Full Changelog line', () => {
    expect(parseFullChangelog("## What's Changed\n* Add export", 'acme', 'widgets', 'v1.1.0')).toBeUndefined();
  });

  it('reads tags that contain slashes or encoded characters', () => {
    const slashes = '**Full Changelog**: https://github.com/acme/widgets/compare/release/1.0...release/1.1';
    const encoded = '**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0%2Bbuild...v1.1.0%2Bbuild';

    expect(parseFullChangelog(slashes, 'acme', 'widgets', 'release/1.1')).toEqual({ base: 'release/1.0' });
    expect(parseFullChangelog(encoded, 'acme', 'widgets', 'v1.1.0+build')).toEqual({ base: 'v1.0.0+build' });
  });

  it('skips a cross-repository line and uses the last line for this release', () => {
    const body = [
      '**Full Changelog**: https://github.com/acme/widgets/compare/v0.9.0...v1.1.0',
      COMPARE_LINE,
      '**Full Changelog**: https://github.com/upstream/engine/compare/v3.0.0...v1.1.0',
    ].join('\n');

    expect(parseFullChangelog(body, 'acme', 'widgets', 'v1.1.0')).toEqual({ base: 'v1.0.0' });
  });
});

describe('resolveRange', () => {
  describe('on a release event', () => {
    it("takes the range from the release's Full Changelog link without calling GitHub", async () => {
      const client = makeClient();

      const range = await resolve(client, { eventName: 'release', ref: 'refs/tags/v1.1.0', release: makeRelease({ prerelease: true, targetCommitish: 'dev' }) });

      expect(range).toEqual({
        base: 'v1.0.0',
        head: 'v1.1.0',
        branch: 'dev',
        release: { tag: 'v1.1.0', previousTag: 'v1.0.0', name: 'Widgets 1.1', prerelease: true },
      });
      expect(client.findReleaseByTag).not.toHaveBeenCalled();
      expect(client.generateReleaseNotes).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith("Release v1.1.0: the commits after v1.0.0, from the release's Full Changelog link.");
    });

    it('asks GitHub to generate release notes when the release has no Full Changelog line', async () => {
      const client = makeClient({ generated: `## What's Changed\n\n**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.1...v1.1.0` });

      const range = await resolve(client, { eventName: 'release', release: makeRelease({ body: 'Hand-written notes.' }) });

      expect(client.generateReleaseNotes).toHaveBeenCalledWith('v1.1.0');
      expect(range).toMatchObject({ base: 'v1.0.1', head: 'v1.1.0', release: { previousTag: 'v1.0.1' } });
      expect(console.log).toHaveBeenCalledWith("Release v1.1.0: the commits after v1.0.1, from GitHub's generated release notes.");
    });

    it("asks GitHub to generate release notes when the release's link is for another repository", async () => {
      const client = makeClient({ generated: COMPARE_LINE });

      const range = await resolve(client, {
        eventName: 'release',
        release: makeRelease({ body: '**Full Changelog**: https://github.com/upstream/widgets/compare/v0.1.0...v1.1.0' }),
      });

      expect(client.generateReleaseNotes).toHaveBeenCalledWith('v1.1.0');
      expect(range).toMatchObject({ base: 'v1.0.0' });
    });

    it('explains the missing permission when GitHub refuses to generate release notes', async () => {
      const client = makeClient({ generated: httpError(403, 'Resource not accessible by integration') });

      await expect(resolve(client, { eventName: 'release', release: makeRelease({ body: '' }) })).rejects.toThrow(
        'Release v1.1.0 has no Full Changelog link, and asking GitHub to generate one needs permissions: contents: write. ' +
          'Grant that permission, or add a "**Full Changelog**: https://github.com/acme/widgets/compare/PREVIOUS...v1.1.0" line to the release.'
      );
    });

    it('passes on any other generate-notes failure', async () => {
      const client = makeClient({ generated: httpError(502, 'Bad Gateway') });

      await expect(resolve(client, { eventName: 'release', release: makeRelease({ body: '' }) })).rejects.toThrow('Bad Gateway');
    });

    it('skips a first release without asking GitHub for anything', async () => {
      const client = makeClient();

      const result = await resolve(client, {
        eventName: 'release',
        release: makeRelease({ body: '**Full Changelog**: https://github.com/acme/widgets/commits/v1.1.0' }),
      });

      expect(result).toEqual({
        skip:
          'v1.1.0 is the first release, so there is no earlier release to compare it with. ' +
          'To write notes for it anyway, add a "**Full Changelog**: https://github.com/acme/widgets/compare/EARLIER...v1.1.0" line to the release, then run the workflow from the v1.1.0 tag.',
      });
      expect(client.generateReleaseNotes).not.toHaveBeenCalled();
    });

    it("skips a first release found through GitHub's generated release notes", async () => {
      const client = makeClient({ generated: '**Full Changelog**: https://github.com/acme/widgets/commits/v1.1.0' });

      const result = await resolve(client, { eventName: 'release', release: makeRelease({ body: '' }) });

      expect(result).toEqual({ skip: expect.stringContaining('v1.1.0 is the first release') });
    });

    it('skips when even the generated release notes have no Full Changelog line', async () => {
      const client = makeClient({ generated: "## What's Changed" });

      const result = await resolve(client, { eventName: 'release', release: makeRelease({ body: '' }) });

      expect(result).toEqual({ skip: expect.stringContaining("GitHub's generated release notes for v1.1.0 have no Full Changelog link") });
    });
  });

  describe('on a dispatch from a tag', () => {
    it("reads that tag's release and takes the range from it", async () => {
      const client = makeClient({ byTag: makeRelease() });

      const range = await resolve(client, { eventName: 'workflow_dispatch', ref: 'refs/tags/v1.1.0' });

      expect(client.findReleaseByTag).toHaveBeenCalledWith('v1.1.0');
      expect(range).toMatchObject({ base: 'v1.0.0', head: 'v1.1.0', branch: 'main', release: { tag: 'v1.1.0' } });
    });

    it('fails when the tag has no published release', async () => {
      const client = makeClient();

      await expect(resolve(client, { eventName: 'workflow_dispatch', ref: 'refs/tags/v1.1.0' })).rejects.toThrow(
        "Tag v1.1.0 has no published release. Publish the release first, or run the workflow from a branch to preview the next release's notes."
      );
    });
  });

  describe('anywhere else', () => {
    it('previews the commits after the latest release up to the run commit', async () => {
      const client = makeClient({ latest: makeRelease() });

      const range = await resolve(client, { eventName: 'workflow_dispatch', ref: 'refs/heads/dev' });

      expect(range).toEqual({ base: 'v1.1.0', head: 'f00dfeed1234567890', branch: 'dev', release: null });
      expect(client.generateReleaseNotes).not.toHaveBeenCalled();
      expect(client.findNewestTag).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Preview of the next release: the commits after v1.1.0 (the latest release) up to f00dfee on dev.');
    });

    it("labels a pull request's preview with its branch", async () => {
      const client = makeClient({ latest: makeRelease() });

      const range = await resolve(client, { eventName: 'pull_request', ref: 'refs/pull/7/merge', headRef: 'feature/export' });

      expect(range).toMatchObject({ branch: 'feature/export', release: null });
    });

    it('previews a push to a tag instead of reading its release', async () => {
      const client = makeClient({ latest: makeRelease({ tag: 'v1.0.0' }) });

      const range = await resolve(client, { eventName: 'push', ref: 'refs/tags/v1.1.0' });

      expect(client.findReleaseByTag).not.toHaveBeenCalled();
      expect(range).toMatchObject({ base: 'v1.0.0', branch: 'v1.1.0', release: null });
    });

    it('starts from the newest tag when there is no published release', async () => {
      const client = makeClient({ newestTag: 'v0.3.0' });

      const range = await resolve(client, {});

      expect(range).toMatchObject({ base: 'v0.3.0', head: 'f00dfeed1234567890', branch: 'main', release: null });
      expect(console.log).toHaveBeenCalledWith(
        'Preview of the next release: the commits after v0.3.0 (the newest tag, because there is no published release) up to f00dfee on main.'
      );
    });

    it('skips when the repository has no releases or tags', async () => {
      const client = makeClient();

      const result = await resolve(client, {});

      expect(result).toEqual({ skip: 'The repository has no releases or tags yet, so there is no earlier release to preview the next one against.' });
      expect(client.generateReleaseNotes).not.toHaveBeenCalled();
    });

    it('fails without a run commit to preview up to', async () => {
      const client = makeClient({ latest: makeRelease() });

      await expect(resolve(client, { sha: '' })).rejects.toThrow('GITHUB_SHA is not set');
    });
  });
});

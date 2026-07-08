import { describe, it, expect, vi } from 'vitest';
import { parseRangeFromNotes, resolveReleaseRange } from '../src/release';
import type { GitHubClient } from '../src/github';

describe('parseRangeFromNotes', () => {
  it('recovers the previous tag from a compare link', () => {
    const body = 'stuff\n\n**Full Changelog**: https://github.com/acme/widgets/compare/v9.5.0...v9.6.0';
    expect(parseRangeFromNotes(body)).toEqual({ base: 'v9.5.0', isFirstRelease: false });
  });

  it('handles non-semver and prefixed/monorepo tags with dots', () => {
    expect(parseRangeFromNotes('x /compare/2024.10.1...2024.11.0 y')).toEqual({
      base: '2024.10.1',
      isFirstRelease: false,
    });
    expect(parseRangeFromNotes('/compare/pkg-a@1.2.0...pkg-a@1.3.0')).toEqual({
      base: 'pkg-a@1.2.0',
      isFirstRelease: false,
    });
  });

  it('reports a first release when there is only a commits link', () => {
    const body = '**Full Changelog**: https://github.com/acme/widgets/commits/v1.0.0';
    expect(parseRangeFromNotes(body)).toEqual({ base: '', isFirstRelease: true });
  });

  it('falls back to first-release rather than guessing when no link is present', () => {
    expect(parseRangeFromNotes('no changelog link here')).toEqual({ base: '', isFirstRelease: true });
  });
});

describe('resolveReleaseRange', () => {
  it('resolves base/head/branch from a tag via generate-notes', async () => {
    const gh = {
      getReleaseByTag: vi.fn().mockResolvedValue({ id: 42, tagName: 'v9.6.0', targetCommitish: 'dev' }),
      getLatestRelease: vi.fn(),
      generateReleaseNotes: vi
        .fn()
        .mockResolvedValue('**Full Changelog**: https://github.com/acme/widgets/compare/v9.5.0...v9.6.0'),
    } as unknown as GitHubClient;

    const resolved = await resolveReleaseRange(gh, 'v9.6.0');

    expect(resolved).toEqual({
      base: 'v9.5.0',
      head: 'v9.6.0',
      branch: 'dev',
      releaseId: 42,
      isFirstRelease: false,
    });
    expect((gh.getLatestRelease as any)).not.toHaveBeenCalled();
    expect((gh.generateReleaseNotes as any)).toHaveBeenCalledWith('v9.6.0');
  });

  it('resolves the latest release when the tag is blank', async () => {
    const gh = {
      getReleaseByTag: vi.fn(),
      getLatestRelease: vi.fn().mockResolvedValue({ id: 7, tagName: 'v2.0.0', targetCommitish: 'main' }),
      generateReleaseNotes: vi
        .fn()
        .mockResolvedValue('**Full Changelog**: https://github.com/acme/widgets/compare/v1.9.0...v2.0.0'),
    } as unknown as GitHubClient;

    const resolved = await resolveReleaseRange(gh, '');

    expect((gh.getReleaseByTag as any)).not.toHaveBeenCalled();
    expect(resolved.base).toBe('v1.9.0');
    expect(resolved.head).toBe('v2.0.0');
    expect(resolved.branch).toBe('main');
  });

  it('flags a first release with an empty base', async () => {
    const gh = {
      getReleaseByTag: vi.fn().mockResolvedValue({ id: 1, tagName: 'v1.0.0', targetCommitish: 'main' }),
      getLatestRelease: vi.fn(),
      generateReleaseNotes: vi
        .fn()
        .mockResolvedValue('**Full Changelog**: https://github.com/acme/widgets/commits/v1.0.0'),
    } as unknown as GitHubClient;

    const resolved = await resolveReleaseRange(gh, 'v1.0.0');

    expect(resolved.isFirstRelease).toBe(true);
    expect(resolved.base).toBe('');
    expect(resolved.head).toBe('v1.0.0');
  });
});

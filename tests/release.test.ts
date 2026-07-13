import { describe, it, expect, vi } from 'vitest';
import { parseRangeFromNotes, resolvePreviousTag } from '../src/release';
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

describe('resolvePreviousTag', () => {
  it('asks GitHub for the notes and returns the previous tag as the base', async () => {
    const gh = {
      generateReleaseNotes: vi
        .fn()
        .mockResolvedValue('**Full Changelog**: https://github.com/acme/widgets/compare/v9.5.0...v9.6.0'),
    } as unknown as GitHubClient;

    const resolved = await resolvePreviousTag(gh, 'v9.6.0');

    expect((gh.generateReleaseNotes as any)).toHaveBeenCalledWith('v9.6.0');
    expect(resolved).toEqual({ base: 'v9.5.0', isFirstRelease: false });
  });

  it('flags a first release with an empty base', async () => {
    const gh = {
      generateReleaseNotes: vi
        .fn()
        .mockResolvedValue('**Full Changelog**: https://github.com/acme/widgets/commits/v1.0.0'),
    } as unknown as GitHubClient;

    const resolved = await resolvePreviousTag(gh, 'v1.0.0');

    expect(resolved.isFirstRelease).toBe(true);
    expect(resolved.base).toBe('');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { pickPreviousTag, resolvePreviousTag } from '../src/release';
import type { GitHubClient, ReleaseSummary } from '../src/github';

function release(tagName: string, publishedAt: string, overrides: Partial<ReleaseSummary> = {}): ReleaseSummary {
  return { tagName, publishedAt, prerelease: false, draft: false, ...overrides };
}

const current = { tagName: 'v9.6.0', publishedAt: '2026-06-01T00:00:00Z', prerelease: false };

describe('pickPreviousTag', () => {
  it('picks the latest release published before the current one', () => {
    const releases = [
      release('v9.4.0', '2026-03-01T00:00:00Z'),
      release('v9.5.0', '2026-04-01T00:00:00Z'),
      release('v9.6.0', '2026-06-01T00:00:00Z'),
    ];
    expect(pickPreviousTag(current, releases)).toBe('v9.5.0');
  });

  it('does not depend on list order (GitHub does not guarantee it)', () => {
    const releases = [
      release('v9.5.0', '2026-04-01T00:00:00Z'),
      release('v9.6.0', '2026-06-01T00:00:00Z'),
      release('v9.4.0', '2026-03-01T00:00:00Z'),
    ];
    expect(pickPreviousTag(current, releases)).toBe('v9.5.0');
  });

  it('skips prereleases for a stable release', () => {
    const releases = [
      release('v9.5.0', '2026-04-01T00:00:00Z'),
      release('v9.6.0-rc.1', '2026-05-01T00:00:00Z', { prerelease: true }),
      release('v9.6.0', '2026-06-01T00:00:00Z'),
    ];
    expect(pickPreviousTag(current, releases)).toBe('v9.5.0');
  });

  it('compares a prerelease against the latest release of any kind', () => {
    const releases = [
      release('v9.5.0', '2026-04-01T00:00:00Z'),
      release('v9.6.0-rc.1', '2026-05-01T00:00:00Z', { prerelease: true }),
    ];
    const rc2 = { tagName: 'v9.6.0-rc.2', publishedAt: '2026-05-15T00:00:00Z', prerelease: true };
    expect(pickPreviousTag(rc2, releases)).toBe('v9.6.0-rc.1');
  });

  it('falls back to prereleases when no stable release exists yet', () => {
    const releases = [release('v1.0.0-beta.1', '2026-01-01T00:00:00Z', { prerelease: true })];
    const v1 = { tagName: 'v1.0.0', publishedAt: '2026-02-01T00:00:00Z', prerelease: false };
    expect(pickPreviousTag(v1, releases)).toBe('v1.0.0-beta.1');
  });

  it('ignores drafts and the current release itself', () => {
    const releases = [
      release('v9.7.0', '2026-05-20T00:00:00Z', { draft: true }),
      release('v9.6.0', '2026-06-01T00:00:00Z'),
      release('v9.5.0', '2026-04-01T00:00:00Z'),
    ];
    expect(pickPreviousTag(current, releases)).toBe('v9.5.0');
  });

  it('ignores releases published after the current one, so re-runs reproduce the original range', () => {
    const releases = [
      release('v9.5.0', '2026-04-01T00:00:00Z'),
      release('v9.6.0', '2026-06-01T00:00:00Z'),
      release('v9.7.0', '2026-07-01T00:00:00Z'),
    ];
    expect(pickPreviousTag(current, releases)).toBe('v9.5.0');
  });

  it('reports a first release with an empty tag', () => {
    expect(pickPreviousTag(current, [])).toBe('');
    expect(pickPreviousTag(current, [release('v9.6.0', '2026-06-01T00:00:00Z')])).toBe('');
  });
});

describe('resolvePreviousTag', () => {
  it('lists the releases and returns the previous tag as the base', async () => {
    const gh = {
      listReleases: vi.fn().mockResolvedValue([
        release('v9.5.0', '2026-04-01T00:00:00Z'),
        release('v9.6.0', '2026-06-01T00:00:00Z'),
      ]),
    } as unknown as GitHubClient;

    const resolved = await resolvePreviousTag(gh, current);

    expect(resolved).toEqual({ base: 'v9.5.0', isFirstRelease: false });
  });

  it('flags a first release with an empty base', async () => {
    const gh = {
      listReleases: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    const resolved = await resolvePreviousTag(gh, current);

    expect(resolved).toEqual({ base: '', isFirstRelease: true });
  });
});

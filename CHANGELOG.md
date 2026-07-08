# Changelog

All notable changes to Nuntia are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Release mode.** Trigger on published releases and let Nuntia infer the commit range. A new
  `release-tag` input resolves base = previous release, head = the tag, and branch = the release's
  target using GitHub's own previous-tag logic. Leave `release-tag` (and base/head) blank to use the
  latest published release.
- First-release support: when there is no previous tag, notes cover the whole history up to the tag.

### Changed

- **Breaking:** `base-commit`, `head-commit`, and `branch` are now optional. Provide them for an
  arbitrary range, or use `release-tag` (or nothing) for release mode.
- `prompt-url` is now optional and documented as such; blank uses the built-in prompt.
- The example workflow is now [`examples/nuntia.yml`](./examples/nuntia.yml) (renamed from
  `examples/workflows/nuntia-release-notes.yml`) and runs automatically on `release: published`.

### Fixed

- Refuse to generate notes over a reversed or empty commit range (compare status `behind`, or a
  non-identical pair with zero commits) instead of silently emitting base-only notes.
- A bad `prompt-url` now fails fast, before the commit walk, rather than after it.

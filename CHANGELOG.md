# Changelog

All notable changes to Nuntia are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Runs on published releases.** Trigger on `release: published` and Nuntia reads the release from
  the event — its tag and branch — then diffs against the previous release (via GitHub's own
  generate-notes logic). No inputs to configure; the notes go to the run summary and an artifact.

### Changed

- **Breaking:** `base-commit`, `head-commit`, and `branch` are now optional — they're only for
  running over an explicit range outside a release.
- `prompt-url` is now optional and documented as such; blank uses the built-in prompt.
- The example workflow is now [`examples/nuntia.yml`](./examples/nuntia.yml) (renamed from
  `examples/workflows/nuntia-release-notes.yml`) and triggers on `release: published` with no inputs.

### Fixed

- Refuse to generate notes over a reversed or empty commit range (compare status `behind`, or a
  non-identical pair with zero commits) instead of silently emitting base-only notes.
- A bad `prompt-url` now fails fast, before the commit walk, rather than after it.

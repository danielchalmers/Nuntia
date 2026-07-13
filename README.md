# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides whenever you publish a release. It figures out what changed since your previous release, follows the issues, pull requests, and commits referenced in each commit message to recover the *why* behind every change, and feeds the full context to Gemini with a prompt you control. It runs in your workflow with your own API key — no service to host, nothing to configure.

GitHub's auto-generated notes tell readers *what* merged; Nuntia complements them with prose that explains what the release means for users: a highlights section, an upgrading section with breaking changes and before/after diffs, and net changes grouped by feature area. The prompt is fetched from a URL, so you can swap in your own format without forking the action.

## Quick start

1. Add a `GEMINI_API_KEY` secret to your repository or organization ([get a key](https://aistudio.google.com/apikey)).
2. Copy the ready-to-use [`examples/workflows/nuntia.yml`](./examples/workflows/nuntia.yml) into `.github/workflows/`:

```yaml
name: Nuntia (Release Notes)

on:
  release:
    types: [published]

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: danielchalmers/Nuntia@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

      - uses: actions/upload-artifact@v7
        with:
          name: nuntia-release-notes-${{ github.run_number }}
          path: artifacts
          if-no-files-found: error
```

3. Publish a release. The notes appear in the workflow run's summary and as a downloadable artifact — Nuntia never edits your release, so you decide what to do with them.

Don't like the result? Re-run the job from the Actions tab and it regenerates the notes for the same release.

## How it works

- When a release is published, Nuntia looks at your repository's releases to find the one published before it (skipping prereleases for stable releases) and resolves the commit range between the two. Everything is read-only — it never writes to your repository or edits your release.
- It scrapes the commit messages in that range and follows linked issues, PRs, and commits, with configurable depth and caps.
- It sends the aggregated context to Gemini using the prompt fetched from `prompt-url`.
- It writes the release notes markdown (plus payload/context debug files) to the `artifacts/` directory and the workflow run summary.
- On a repository's very first release there is nothing to compare against, so it writes a short notice instead.

## Customizing the prompt

The default prompt produces a themed changelog rather than a per-commit log. To change the tone, structure, or language, start from the [example prompt](./examples/Nuntia.prompt), host your copy anywhere with a raw URL (a Gist works well), and point `prompt-url` at it:

```yaml
      - uses: danielchalmers/Nuntia@main
        with:
          prompt-url: https://gist.githubusercontent.com/you/…/raw/MyPrompt.prompt
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Because the prompt is fetched at run time, you can iterate on it and simply re-run the job — no commits or new releases needed.

## Inputs

All inputs are optional — the happy path sets nothing.

| Input | Purpose | Default |
| --- | --- | --- |
| `prompt-url` | URL to raw prompt template content. | [example prompt](./examples/Nuntia.prompt) |
| `model` | Gemini model identifier. | `gemini-3.5-flash` |
| `max-linked-items` | Maximum linked issues/PRs/commits to fetch per commit. | `5` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |
| `max-item-length` | Maximum length for each commit message and linked item title/body field. | `5000` |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

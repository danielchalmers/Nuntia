# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides from a commit range: it gathers commit messages, follows the issues, pull requests, and commits they reference, and feeds the full context to Gemini with a prompt you control. It runs on demand in your workflow with your own API key — no service to host.

The default prompt produces a themed changelog rather than a per-commit log: a highlights section, an upgrading section with breaking changes and before/after diffs, and net changes grouped by feature area with trailing reference links. The prompt is fetched from a URL, so you can swap in your own format without forking the action.

## Quick start

1. Add a `GEMINI_API_KEY` secret to your repository or organization ([get a key](https://aistudio.google.com/apikey)).
2. Add a manually-triggered workflow, like the ready-to-use [`examples/workflows/nuntia.yml`](./examples/workflows/nuntia.yml):

```yaml
name: Nuntia (Release Notes)

on:
  workflow_dispatch:
    inputs:
      base-commit:
        description: "Start commit SHA"
        required: true
      head-commit:
        description: "End commit SHA"
        required: true

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v7

      - uses: danielchalmers/Nuntia@main
        with:
          base-commit: ${{ inputs.base-commit }}
          head-commit: ${{ inputs.head-commit }}
          branch: main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

      - uses: actions/upload-artifact@v7
        with:
          name: nuntia-release-notes-${{ github.run_number }}
          path: artifacts
          if-no-files-found: error
```

3. Run it from the Actions tab with the first and last commit of the release, then download the release notes from the run's artifacts.
4. Optionally write your own prompt — start from the [example prompt](./examples/Nuntia.prompt), host it anywhere with a raw URL (a Gist works well), and point `prompt-url` at it.

## How it works

- Resolves the inclusive commit range from the base commit, head commit, and branch.
- Scrapes commit messages and follows linked issues, PRs, and commits, with configurable depth and caps.
- Sends the aggregated context to Gemini using the prompt fetched from `prompt-url`.
- Writes the release notes markdown (plus payload/context debug files) to the `artifacts/` directory for your workflow to upload.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `base-commit` | Start commit SHA (inclusive). | Required |
| `head-commit` | End commit SHA (inclusive). | Required |
| `branch` | Branch name (`branch` or `owner/repo@branch`). | Required |
| `prompt-url` | URL to raw prompt template content. | [example prompt](./examples/Nuntia.prompt) |
| `model` | Gemini model identifier. | `gemini-3.5-flash` |
| `max-linked-items` | Maximum linked issues/PRs/commits to fetch. | `5` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |
| `max-item-length` | Maximum length for each commit message and linked item title/body field. | `5000` |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides with an AI model. When you publish a release, it reads the commits since the previous one and the issues and pull requests they reference, then writes highlights and upgrade steps into the release, above GitHub's own change list. It runs in your own workflow with your own model key, so there's no service to host.

## Quick start

1. Add a model API key as a repository or organization secret: `GEMINI_API_KEY` ([get a free key](https://aistudio.google.com/apikey)), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
2. Add [`.github/workflows/nuntia.yml`](./examples/workflows/nuntia.yml):

```yaml
name: Nuntia (Release Notes)

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      prompt-url:
        description: "Raw prompt URL to try (blank uses the bundled prompt)"
        required: false
        default: ""

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Writes the notes into the release.
      issues: read
      pull-requests: read
    steps:
      - uses: danielchalmers/Nuntia@v2
        with:
          prompt-url: ${{ inputs.prompt-url }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

3. Publish a release with **Generate release notes**. A few minutes later, Nuntia's section appears in the release and in the run's job summary.

To preview the next release's notes at any time, run the workflow from a branch in the Actions tab. That writes only to the job summary.

## Which commits

- **A published release** covers the commits after the previous release, up to its tag. Nuntia reads the previous release from the `**Full Changelog**: …/compare/PREVIOUS...TAG` line that **Generate release notes** adds, and asks GitHub to generate one when the line is missing. A first release has nothing to compare with, so Nuntia logs a notice and stops.
- **Any other run**, such as one started from a branch, previews the commits since the latest release (or the newest tag) up to the run's commit.
- **Releases created with `GITHUB_TOKEN`**, for example by release-please or `gh release create` in another workflow, don't trigger `release: published`. Run the workflow on the release's tag afterwards instead.
- **The workflow file has to exist at the release's tag**, because GitHub runs the workflows from that commit.

## Writing into the release

- Nuntia writes its notes between `<!-- nuntia:start -->` and `<!-- nuntia:end -->`, just above GitHub's generated list, or at the top if there isn't one. Re-running the job replaces only that section, so edits outside the markers are kept.
- Before writing, it removes raw HTML and images, turns @mentions into code so nobody is notified, and keeps only the text of links that point outside the repository.
- If the release would pass GitHub's size limit, its markers are broken, or it was deleted, the notes stay in the job summary with a warning.
- A release page that was open before Nuntia wrote, and is saved afterwards, drops Nuntia's section. Reload the page before editing.

## How it works

- Nuntia follows up to 5 references from each commit, 2 levels deep, and reads everything through the GitHub API, so the job needs no checkout.
- A very large release gets less context: Nuntia stops following references after 300 GitHub API calls, and trims the linked issues and pull requests until the context fits in 360,000 characters. Commit messages are never cut, so a release whose commits alone are larger is sent anyway, with a warning.
- A GitHub rate limit or outage doesn't fail a release's run. Nuntia writes notes from what it could read, or leaves a warning if it couldn't read the release at all.

## Prompt

The bundled prompt, [`examples/Nuntia.prompt`](./examples/Nuntia.prompt), is a short brief with two worked examples from MudBlazor: a major release with migration steps and a minor release with a few highlights. The model sizes up each release from its version change and its changes, then follows the closer example. To change the style, replace the examples with notes written the way you want.

To try your own prompt without committing it, host it at a raw URL, such as a gist, and set `prompt-url`. Leave it blank to use the bundled prompt, which is pinned along with the action's version.

## Models

| API key | Default model |
| --- | --- |
| `GEMINI_API_KEY` | `gemini-flash-latest` |
| `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| `OPENAI_API_KEY` | `gpt-6.1-sol` |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model` |

- The defaults favor quality over cost, because a release takes one call and a person reads the result.
- Set `model` to use another model. With several keys mapped, `gemini-*` and `claude-*` models go to their own provider and anything else goes to OpenAI or `OPENAI_BASE_URL`. A blank `model` with several keys mapped fails the run.
- Any OpenAI-compatible service, such as OpenRouter, Azure OpenAI, Groq or Ollama, works by setting `OPENAI_BASE_URL` to its API base.
- Commit messages and linked issue and pull request text go to the provider you pick. The rules match [AutoTriage](https://github.com/danielchalmers/AutoTriage#models), so one set of secrets works for both actions.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `model` | Model to use. Blank uses your key's default. | `""` |
| `prompt-url` | Raw URL of a prompt to try instead of the bundled one. | `""` |

## Results

The notes go into the release and the job summary. The `artifacts/` directory holds them, along with the payload and context Nuntia sent. Upload it with `actions/upload-artifact` to keep it.

A run fails only when something needs fixing: invalid configuration, a rejected key or unknown model, missing permissions, a prompt URL that can't be fetched, or a Full Changelog line naming a tag that no longer exists. A slow or overloaded provider, a refusal, or notes cut off at the output limit only leave a warning, so re-run the job to try again.

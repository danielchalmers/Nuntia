# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides for each release: it gathers the commits since the previous release, follows the issues, pull requests, and commits they reference, and feeds the full context to the model you pick (Gemini, Claude, OpenAI, or any OpenAI-compatible service) with a prompt you control. It runs in your workflow when you publish a release, with your own API key — no service to host.

The default prompt produces a themed changelog rather than a per-commit log: a highlights section, an upgrading section with breaking changes and before/after diffs, and net changes grouped by feature area with trailing reference links. The prompt ships with the action, so pinning a version of Nuntia pins the prompt too, and you can try your own format through `prompt-url` without forking the action.

## Quick start

1. Add a model API key as a secret in your repository or organization: `GEMINI_API_KEY` ([get a key](https://aistudio.google.com/apikey)), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Map it in the step's `env` (see [Models](#models)).
2. Add a workflow that runs when you publish a release, like the ready-to-use [`examples/workflows/nuntia.yml`](./examples/workflows/nuntia.yml):

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
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: danielchalmers/Nuntia@main
        with:
          prompt-url: ${{ inputs.prompt-url }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

3. Publish a release with **Generate release notes**, then read Nuntia's notes in the summary of the workflow run it starts.
4. To preview the next release's notes at any time, run the workflow from a branch in the Actions tab. Optionally try your own prompt there with `prompt-url` (see [Prompt](#prompt)).

## Which commits

- **A published release**, from the `release` event or from running the workflow on the release's tag, covers the commits after the previous release up to the release's tag. The previous release comes from the `**Full Changelog**: …/compare/PREVIOUS...TAG` line that **Generate release notes** adds to the release body. The previous release's own commit is left out, because it shipped in that release.
  - **No Full Changelog line.** Nuntia asks GitHub to generate release notes for the tag and reads the line from those. GitHub requires `contents: write` for that call, so either keep the line in the release or grant that permission.
  - **A first release** links to `/commits/TAG` instead, so there is nothing to compare it with. Nuntia logs a notice and stops without failing. To cover it anyway, add a Full Changelog line that compares it with an earlier tag, then run the workflow on the tag.
- **Any other run**, such as running the workflow from a branch, previews the next release: the commits after the latest release, up to the run's commit. Without a published release it starts from the newest tag by commit date, and with no tags at all it logs a notice and stops. A preview never asks GitHub to generate release notes.
- **The context** names the release's tag, previous tag, name and whether it's a prerelease, so the notes can use the version. The branch is the one the release was created from.
- **Re-running a release's job** reads the release as it was when it was published. To pick up edits, run the workflow on the release's tag instead, which reads the release again. Either way, the workflow file has to exist at the tag's commit.
- **Releases published from another workflow** with `GITHUB_TOKEN`, such as by release-please or `gh release create`, don't start other workflows. Run Nuntia on the tag afterwards, or publish with a different token.

## How it works

- Picks the release and the commits it covers (see [Which commits](#which-commits)).
- Reads the commit messages and follows the issues, pull requests and commits they reference: up to 5 for each commit and 2 levels deep, with each message, title and body cut at 5,000 characters.
- Keeps a very large release within bounds, so it gets less context:
  - It stops following references once the run has made 300 GitHub API calls, and the references found inside linked items are the first left out.
  - If the context is still over about 150k tokens (at 4 characters a token), it drops the items found through other linked items, then the changed-file list, and then cuts linked issue and pull request bodies shorter until the context fits. The log names each step.
- Sends the aggregated context to the model with the bundled prompt, or the one at `prompt-url` when it's set.
- Writes the notes to the job summary. It also writes them, with payload and context debug files, to the `artifacts/` directory, which an `actions/upload-artifact` step with `path: artifacts` can keep.
- Reads everything through the GitHub API, so the job needs no checkout step.

## Prompt

The default prompt is [`examples/Nuntia.prompt`](./examples/Nuntia.prompt), bundled into the action, so a pinned version of Nuntia always uses the same prompt.

`prompt-url` is for trying a prompt without committing it. Copy the default prompt, change it, host it at a raw URL such as a gist or a raw file in any repository, and set `prompt-url` to that URL. Leave it blank to go back to the bundled prompt.

- **The log names the prompt**, as `Prompt: built-in` or `Prompt: <url>`.
- **The fetch** times out after 30 seconds and is retried twice when it times out, the connection fails, or the host returns 408, 429 or a 5xx status. If the prompt still can't be fetched, or the URL returns another error status or an empty file, the run fails without calling the model.

## Models

Set one model API key as a secret and map it in the step's `env`. Nuntia talks to every provider through its OpenAI-compatible Chat Completions API, with the same rules as [AutoTriage](https://github.com/danielchalmers/AutoTriage#models), so one set of secrets works for both actions.

| API key | Default model |
| --- | --- |
| `GEMINI_API_KEY` | `gemini-flash-latest` |
| `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| `OPENAI_API_KEY` | `gpt-6.1-sol` |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model` |

These defaults favor quality over cost, because the notes come from one call per release and a person reviews them.

- **With one key set**, `model` goes to it. With several, a `gemini-*` or `claude-*` model goes to Gemini or Claude when that key is set, and any other model goes to OpenAI or `OPENAI_BASE_URL`.
- **Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base and `model` to a model it serves, such as `anthropic/claude-sonnet-5.5` on OpenRouter.
- **A `model` input passed through from `workflow_dispatch`** keeps sending its default after you switch keys. Give that input a default of `""` and set `required: false`, so the default for the key you set is used.
- **The log names the model and host**, such as `Model: claude-sonnet-5-5 at api.anthropic.com (default for ANTHROPIC_API_KEY)`.
- **Each provider runs at its default reasoning level.** Reasoning that a provider returns separately, or in a `<think>` block at the start of the reply, is left out of the notes.
- **Failures.** A bad key, an unknown model, or a billing problem fails at once and says what to check. An overloaded or rate-limited provider is retried for a few minutes. Notes cut off at the output limit, or a refusal, fail the run without writing a notes file.
- **Your data.** Commit messages and linked issue and pull request text go to the provider you pick. Gateways such as OpenRouter forward the text to further providers.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `prompt-url` | Raw URL of a prompt to try instead of the bundled one, such as a gist (see [Prompt](#prompt)). | Blank, which uses the [bundled prompt](./examples/Nuntia.prompt) |
| `model` | Model that writes the notes. | The default for the API key you set (see [Models](#models)) |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Prompt tokens, cached tokens included. |
| `output-tokens` | Generated tokens, reasoning excluded. |

Token counts follow each provider's own counting, so they aren't comparable across providers. The outputs are unset when there are no notes to write, such as for a first release.

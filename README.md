# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides for each release: it gathers the commits since the previous release, follows the issues, pull requests, and commits they reference, and feeds the full context to the model you pick (Gemini, Claude, OpenAI, or any OpenAI-compatible service) with a prompt you control. It runs in your workflow when you publish a release, with your own API key — no service to host — and writes its section into that release, above GitHub's own change list.

The default prompt writes what GitHub's generated list can't: an optional headline, a few highlights, and the steps to upgrade, with before/after diffs where the pull requests show the code. When the release has no generated list, as in a preview, it adds a short list of changes grouped by area. The prompt ships with the action, so pinning a version of Nuntia pins the prompt too, and you can try your own format through `prompt-url` without forking the action.

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
      contents: write # Writes the notes into the release.
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

3. Publish a release with **Generate release notes**. A few minutes later, Nuntia's section appears in the release, and in the summary of the workflow run it starts (see [Writing into the release](#writing-into-the-release)).
4. To preview the next release's notes at any time, run the workflow from a branch in the Actions tab. Optionally try your own prompt there with `prompt-url` (see [Prompt](#prompt)).

## Which commits

- **A published release**, from the `release` event or from running the workflow on the release's tag, covers the commits after the previous release up to the release's tag. The previous release comes from the `**Full Changelog**: …/compare/PREVIOUS...TAG` line that **Generate release notes** adds to the release body. The previous release's own commit is left out, because it shipped in that release.
  - **No Full Changelog line.** Nuntia asks GitHub to generate release notes for the tag and reads the line from those. GitHub requires `contents: write` for that call, which the workflow already has for writing the notes.
  - **A first release** links to `/commits/TAG` instead, so there is nothing to compare it with. Nuntia logs a notice and stops without failing. To cover it anyway, add a Full Changelog line that compares it with an earlier tag, then run the workflow on the tag.
- **Any other run**, such as running the workflow from a branch, previews the next release: the commits after the latest release, up to the run's commit. Without a published release it starts from the newest tag by commit date, and with no tags at all it logs a notice and stops. A preview never asks GitHub to generate release notes.
- **The context** names the release's tag, previous tag, name and whether it's a prerelease, so the notes can use the version. It also says whether the release body already has GitHub's generated list (its `<!-- Release notes generated` comment or `## What's Changed` heading), so the notes don't repeat it. The branch is the one the release was created from.
- **Re-running a release's job** takes the commits from the release as it was when it was published. To pick up an edited Full Changelog line, run the workflow on the release's tag instead, which reads the release again.
- **The workflow file has to exist at the tag's commit**, because GitHub runs a release's workflows as they were at its tag.
- **Releases created with `GITHUB_TOKEN`**, such as by release-please, semantic-release or `gh release create` in another workflow, never fire `release: published`. Run Nuntia on the tag afterwards, or publish with a different token.

## Writing into the release

- **Where.** For a published release, Nuntia writes its notes into the release between `<!-- nuntia:start -->` and `<!-- nuntia:end -->`. The first time, the section goes just above GitHub's generated notes (the `<!-- Release notes generated` comment or the `## What's Changed` heading), or at the top when the release has neither. A preview writes only to the job summary.
- **Permissions.** The job needs `contents: write`. Without it, the run fails after copying the notes to the job summary.
- **Re-running replaces only Nuntia's section.** The release is read again just before writing, so anything outside the markers stays as it is, while edits between them are replaced. Move an edit you want to keep outside the markers.
- **Editing the release page.** A release page opened before Nuntia wrote and saved afterwards drops Nuntia's section. Reload the page before editing, and re-run the job if the section is gone.
- **Cleaning.** The notes are written from public issue and pull request text, so before writing, Nuntia removes raw HTML, images and its own markers, turns @mentions into code so nobody is notified, keeps only the text of links that point outside the repository, and turns bare URLs outside it into code. Fenced code and code spans are left as they are. The job summary and the notes file get the same text.
- **When it doesn't write.** The notes stay only in the job summary, with a warning, when the release would pass GitHub's limit of about 125,000 characters, when its markers are broken (a start without an end, or more than one pair), when it has been deleted, or when GitHub fails to save it. None of these fail the run.

## How it works

- Picks the release and the commits it covers (see [Which commits](#which-commits)).
- Reads the commit messages and follows the issues, pull requests and commits they reference: up to 5 for each commit and 2 levels deep, with each message, title and body cut at 5,000 characters.
- Keeps a very large release within bounds, so it gets less context:
  - It stops following references once the run has made 300 GitHub API calls, and the references found inside linked items are the first left out.
  - If the context is still over about 150k tokens (at 4 characters a token), it drops the items found through other linked items, then the changed-file list, and then cuts linked issue and pull request bodies shorter until the context fits. The log names each step.
- Sends the aggregated context to the model with the bundled prompt, or the one at `prompt-url` when it's set.
- Cleans the notes and writes them into the release and the job summary (see [Writing into the release](#writing-into-the-release)). It also writes them, with payload and context debug files, to the `artifacts/` directory, which an `actions/upload-artifact` step with `path: artifacts` can keep.
- Reads everything through the GitHub API, so the job needs no checkout step.

## Prompt

The default prompt is [`examples/Nuntia.prompt`](./examples/Nuntia.prompt), bundled into the action, so a pinned version of Nuntia always uses the same prompt.

It is a short brief followed by two worked examples from MudBlazor: v9.0.0, a major release with a headline, highlights and numbered migration steps with before/after diffs, and v9.10.0, a minor release with a few highlights and two upgrading notes. The model first sizes up the release from its version change and what the changes do, then follows the shape of the closer example, so a patch gets a few lines and a major release gets a migration guide. The quickest way to change the style is to replace the examples with notes written the way you want.

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
- **The log names the model and host**, such as `Model: claude-sonnet-5-5 at api.anthropic.com (default for ANTHROPIC_API_KEY)`, and after the call, how long it took and the tokens it used.
- **Each provider runs at its default reasoning level.** Reasoning that a provider returns separately, or in a `<think>` block at the start of the reply, is left out of the notes.
- **Failures.** A bad key, an unknown model, or a billing problem fails the run at once and says what to check. An overloaded or rate-limited provider is retried for a few minutes. Each request to the model gets up to 10 minutes, and the whole call gets 15 minutes counting its retries and waits. While a request is waiting, the log notes each minute that passes. A call that runs out of time, an overload that outlasts the retries, notes cut off at the output limit, or a refusal leave a warning in the log and the job summary and no notes, without failing the run. Re-run the job to try again.
- **Your data.** Commit messages and linked issue and pull request text go to the provider you pick. Gateways such as OpenRouter forward the text to further providers.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `prompt-url` | Raw URL of a prompt to try instead of the bundled one, such as a gist (see [Prompt](#prompt)). | Blank, which uses the [bundled prompt](./examples/Nuntia.prompt) |
| `model` | Model that writes the notes. | The default for the API key you set (see [Models](#models)) |

# Nuntia

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)

**AI-authored release notes and migration guides for your GitHub releases.**

GitHub's built-in notes tell your users *what* merged — a categorized list of pull requests. Nuntia explains what those changes *mean* and how to adopt them. It reads the issues, pull requests, and commits **linked from each commit message** to recover the intent behind a change, then writes polished, outcome-first notes with impact summaries and — when users must take action — step-by-step migration guidance.

## Quickstart

1. Copy [`examples/nuntia.yml`](./examples/nuntia.yml) to `.github/workflows/nuntia.yml`.
2. Add a `GEMINI_API_KEY` repository secret ([get a key](https://aistudio.google.com/apikey)). `GITHUB_TOKEN` is provided automatically — you don't add it.
3. Publish a GitHub release.

That's it. When you publish a release, Nuntia works out what changed since your previous release, writes the notes to the workflow **run summary**, and uploads them as a downloadable **artifact**.

> No commit SHAs, no prompt URL, and no Gist required — the defaults just work.

**Don't like the result?** Open the workflow run and choose **Re-run jobs** to regenerate (output varies run-to-run by design). To try a different model or prompt for one run, use **Run workflow** and fill in the inputs.

## How it works

- On a published release, Nuntia asks GitHub for the release's previous tag and resolves the commit range for you (`previous release → this tag`). For a repository's first release it covers the whole history.
- It scrapes commit messages and follows linked issues/PRs/commits (with configurable depth).
- It sends the aggregated context to Gemini using a prompt served from a URL (its built-in prompt by default).
- It writes the notes (plus payload/context debug files) to the `artifacts/` directory and the run summary. Your workflow uploads them.

## Inputs

The example workflow only needs `release-tag` (which it fills from the release automatically). Everything else is optional.

| Input | Purpose | Default |
| --- | --- | --- |
| `release-tag` | Release tag to summarize. Resolves base = previous release, head = this tag, branch = the release target. Blank (with no base/head) = latest published release. | - |
| `model` | Gemini model identifier. | `gemini-3.5-flash` |
| `prompt-url` | URL to a raw prompt template. Blank uses the built-in prompt. | built-in prompt |

<details>
<summary>Advanced inputs (arbitrary commit range &amp; tuning)</summary>

For projects that don't publish GitHub Releases, drive Nuntia from an explicit range instead of `release-tag`:

| Input | Purpose | Default |
| --- | --- | --- |
| `base-commit` | Start commit SHA/ref (inclusive). | - |
| `head-commit` | End commit SHA/ref (inclusive). | - |
| `branch` | Branch name (`branch` or `owner/repo@branch`); metadata only. | - |
| `max-linked-items` | Max linked issues/PRs/commits fetched **per commit**. | `5` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |
| `max-item-length` | Max length for each commit message and linked item title/body field. | `5000` |

Provide `base-commit` **and** `head-commit` to use this mode. If you provide neither those nor a `release-tag`, Nuntia falls back to the latest published release.

</details>

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

## Customizing the prompt (advanced)

Nuntia serves its prompt from a URL so you can change how notes are written **without changing this action**. To customize:

- **Fork the prompt:** copy [`examples/Nuntia.prompt`](./examples/Nuntia.prompt), host it anywhere raw (a file in your repo, a Gist, etc.), and pass its raw URL as `prompt-url`.
- Pin `prompt-url` to a tag or commit if you want the wording to stay stable across runs.

The prompt is outcome-first: it groups related work into themes, merges duplicates, and adds migration steps when users must act. Nuntia adds the `# Release Notes` title, the release metadata header, and the attribution footer itself, so a custom prompt should start at its first `##` section.

## Versioning

Pin to the major tag for reproducible, opt-in upgrades:

```yaml
uses: danielchalmers/Nuntia@v1
```

## License

[MIT](./LICENSE)

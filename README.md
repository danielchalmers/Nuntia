# Nuntia

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)

**AI-authored release notes and migration guides for your GitHub releases.**

GitHub's built-in notes tell your users *what* merged — a categorized list of pull requests. Nuntia explains what those changes *mean* and how to adopt them. It reads the issues, pull requests, and commits **linked from each commit message** to recover the intent behind a change, then writes polished, outcome-first notes with impact summaries and — when users must take action — step-by-step migration guidance.

## Setup

1. Copy [`examples/nuntia.yml`](./examples/nuntia.yml) to `.github/workflows/nuntia.yml`.
2. Add a `GEMINI_API_KEY` repository secret ([get a key](https://aistudio.google.com/apikey)). `GITHUB_TOKEN` is provided automatically — you don't add it.

That's the whole setup — no commit SHAs, no prompt URL, no Gist. When you **publish a release**, Nuntia reads it, works out what changed since your previous release, and writes the notes to the workflow **run summary** and a downloadable **artifact**.

**Don't like the result?** Open the workflow run and choose **Re-run jobs** to regenerate (output varies run-to-run by design).

## How it works

- On a published release, Nuntia reads the release's tag and branch from the event, and asks GitHub which release came before it — then resolves the commit range `previous release → this release`.
- It scrapes commit messages and follows linked issues/PRs/commits (with configurable depth).
- It sends the aggregated context to Gemini using its built-in prompt.
- It writes the notes (plus payload/context debug files) to the `artifacts/` directory and the run summary. The example workflow uploads the artifact.

It never edits your release — the notes are yours to review and place.

## Configuration

You don't need to configure anything. If you want to, every input is optional:

| Input | Purpose | Default |
| --- | --- | --- |
| `model` | Gemini model identifier. | `gemini-3.5-flash` |
| `prompt-url` | URL to a raw prompt template. Blank uses the built-in prompt. | built-in prompt |

To use a different model or prompt, add a `with:` block to the action step:

```yaml
      - uses: danielchalmers/Nuntia@v1
        with:
          model: gemini-3-pro-preview
          prompt-url: https://raw.githubusercontent.com/you/your-repo/main/your.prompt
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

<details>
<summary>Running over an explicit commit range (without a release)</summary>

Nuntia is built around GitHub Releases, but you can also drive it from an explicit range — for example from a `workflow_dispatch` — by providing `base-commit` and `head-commit` (and optionally `branch`, or `owner/repo@branch`). This is the mode the CI smoke test uses. It also accepts the `max-linked-items` (per commit, default `5`), `max-reference-depth` (`2`), and `max-item-length` (`5000`) tuning inputs.

</details>

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

## Customizing the prompt

Nuntia serves its prompt from a URL so you can change how notes are written **without changing this action** — point `prompt-url` at your own copy of [`examples/Nuntia.prompt`](./examples/Nuntia.prompt) (a file in your repo, a Gist, anything raw). Pin it to a tag or commit if you want the wording to stay stable across runs.

The default prompt is outcome-first: it writes a title and summary, `Highlights`, an `Upgrading` section with migration steps when users must act, and themed `Changes by area` — grouping related work and merging duplicates rather than logging every commit. Nuntia appends its attribution footer to whatever the prompt produces.

## Versioning

Pin to the major tag for reproducible, opt-in upgrades:

```yaml
uses: danielchalmers/Nuntia@v1
```

## License

[MIT](./LICENSE)

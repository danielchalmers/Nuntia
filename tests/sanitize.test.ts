import { describe, expect, it } from 'vitest';
import { sanitizeNotes } from '../src/sanitize';

function sanitize(text: string): string {
  return sanitizeNotes(text, 'acme', 'widgets');
}

describe('sanitizeNotes', () => {
  it('leaves ordinary notes with links into the repository unchanged', () => {
    const notes = [
      '## Highlights',
      '',
      '- **Faster startup.** Pages load sooner. ([#12](https://github.com/acme/widgets/pull/12), [a1b2c3d](https://github.com/acme/widgets/commit/a1b2c3d))',
      '',
      '## Upgrading to v1.1.0',
      '',
      '1. **Renamed `Color`.** Use `Tint` instead.',
      '',
      '   ```diff',
      '   - <Button Color="Primary" />',
      '   + <Button Tint="Primary" />',
      '   ```',
      '',
      '| Area | Change |',
      '| --- | --- |',
      '| API | See #14 and https://github.com/acme/widgets/issues/14 |',
    ].join('\n');

    expect(sanitize(notes)).toBe(notes);
  });

  it('strips raw HTML tags and comments but keeps their text', () => {
    expect(sanitize('Fixed <b>bold</b> text<!-- hidden --> <img src=x onerror=alert(1)>here.\n\n<details><summary>More</summary>Body</details>')).toBe(
      'Fixed bold text here.\n\nMoreBody'
    );
  });

  it('escapes what is left of a tag or comment that never closes', () => {
    expect(sanitize('a <b and c <!-- open')).toBe('a &lt;b and c &lt;!-- open');
  });

  it('keeps HTML inside fenced code and code spans, where GitHub shows it literally', () => {
    const notes = '```razor\n<MudButton Variant="Filled" />\n```\n\nUse `List<T>` with ``<MudText>``.';

    expect(sanitize(notes)).toBe(notes);
  });

  it('closes a fence the model leaves open, so the rest of the release stays outside it', () => {
    expect(sanitize('Intro\n\n~~~js\nconst a = 1;')).toBe('Intro\n\n~~~js\nconst a = 1;\n~~~');
  });

  it("treats a line indented less than its fence as the fence's end, so the text after it is still cleaned", () => {
    expect(sanitize('- Item\n\n    ```\n    <b>code</b>\n<img src=x>Done')).toBe('- Item\n\n    ```\n    <b>code</b>\nDone');
  });

  it('keeps a fence line indented four or more spaces past its fence as code, so the real closing fence still closes it', () => {
    expect(sanitize('```\nx\n    ```\n```\nThanks @alice <img src=x> ![i](https://evil.example/x.png) [l](https://evil.example)')).toBe(
      '```\nx\n    ```\n```\nThanks `@alice`   l'
    );
  });

  it('keeps fenced code inside a blockquote or alert as written, and still cleans the text after it', () => {
    const notes = [
      '> [!IMPORTANT]',
      '> ```razor',
      '> <MudButton Color="Primary" />',
      '>',
      '> <MudText>`x`</MudText>',
      '> ```',
      '>',
      '> ```diff',
      '> - <MudButton Color="Primary" />',
      '> + <MudButton Tint="Primary" />',
      '> ```',
    ].join('\n');

    expect(sanitize(`${notes}\n\nThanks @alice`)).toBe(`${notes}\n\nThanks \`@alice\``);
  });

  it('ends a fence in a blockquote where the blockquote ends, and closes one the model leaves open inside it', () => {
    expect(sanitize('> ```\n> <b>code</b>\n<img src=x>Done @alice')).toBe('> ```\n> <b>code</b>\nDone `@alice`');
    expect(sanitize('> > ```\n> > <b>code</b>\n> <b>Done</b> @alice')).toBe('> > ```\n> > <b>code</b>\n> Done `@alice`');
    expect(sanitize('> ```js\n> const a = 1;')).toBe('> ```js\n> const a = 1;\n> ```');
  });

  it("removes Nuntia's markers everywhere, code included, even when removing one would form another", () => {
    expect(sanitize('a <!-- nuntia:start --> b <!--NUNTIA:END-->\n\n```\n<!-- nuntia:end -->\n```\nnuntia:nuntia:startstart [x](<!-- nuntia:end -->)')).toBe(
      'a  b \n\n```\n\n```\n x'
    );
  });

  it('turns mentions into code so nobody is notified, escaped or not', () => {
    expect(sanitize('Thanks @alice, @acme/core and \\@bob.')).toBe('Thanks `@alice`, `@acme/core` and `@bob`.');
  });

  it('turns mentions inside emphasis, and mentions spelled with character references, into code', () => {
    expect(sanitize('Thanks _@alice_, __@bob__, &#64;carol, &#X0040;dan and &commat;erin, but not `&#64;frank`.')).toBe(
      'Thanks _`@alice`_, __`@bob`__, `@carol`, `@dan` and `@erin`, but not `&#64;frank`.'
    );
  });

  it('leaves email addresses and mentions inside code alone', () => {
    expect(sanitize('Mail dev@example.com or run `npm i @acme/widgets`.')).toBe('Mail dev@example.com or run `npm i @acme/widgets`.');
  });

  it("escapes a lone backtick, so it can't pair with the backticks added around a mention", () => {
    expect(sanitize('a ` b @carol')).toBe('a \\` b `@carol`');
  });

  it('drops images, including an image that is the only content of a link', () => {
    expect(sanitize('Logo: ![logo](https://example.com/logo.png "Logo") and [![badge](https://img.example/b.svg)](https://github.com/acme/widgets).')).toBe(
      'Logo:  and .'
    );
  });

  it('keeps links into the repository and turns every other link into its text', () => {
    const notes = [
      '[#1](https://github.com/acme/widgets/pull/1)',
      '[case](https://github.com/Acme/Widgets/issues/2)',
      '[relative](../../compare/v1.0.0...v1.1.0)',
      '[docs](https://example.com/docs)',
      '[other repo](https://github.com/acme/other/pull/1)',
      '[lookalike](https://github.com/acme/widgets-fork)',
      '[root](/acme/other)',
      '[script](javascript:alert(1))',
      '[protocol relative](//example.com)',
      '[encoded](https&#58;//example.com)',
      '[@alice](https://github.com/alice)',
    ].join('\n');

    expect(sanitize(notes).split('\n')).toEqual([
      '[#1](https://github.com/acme/widgets/pull/1)',
      '[case](https://github.com/Acme/Widgets/issues/2)',
      '[relative](../../compare/v1.0.0...v1.1.0)',
      'docs',
      'other repo',
      'lookalike',
      'root',
      'script',
      'protocol relative',
      'encoded',
      '`@alice`',
    ]);
  });

  it('handles a link nested in another link from the inside out', () => {
    expect(sanitize('[[text](https://example.com)](https://github.com/acme/widgets/pull/1)')).toBe('[text](https://github.com/acme/widgets/pull/1)');
    expect(sanitize('[[text](https://github.com/acme/widgets/pull/1)](https://example.com)')).toBe('[text](https://github.com/acme/widgets/pull/1)');
  });

  it('applies the same rule to reference links, and drops definitions that point outside the repository', () => {
    const notes = '[docs][1], [pr][2] and [site].\n\n[1]: https://example.com\n[2]: https://github.com/acme/widgets/pull/2\n[site]: <https://example.com>';

    expect(sanitize(notes)).toBe('docs, [pr][2] and site.\n\n\n[2]: https://github.com/acme/widgets/pull/2\n');
  });

  it("makes link and image syntax it can't parse render as text", () => {
    expect(sanitize('![img](a(b(c))) [link](https://example.com/a(b(c)))')).toBe('!\\[img]\\(a(b(c))) [link]\\(`https://example.com/a(b(c))`)');
  });

  it('turns bare URLs outside the repository into code, leaving trailing punctuation outside', () => {
    expect(
      sanitize('See https://example.com/x. And (https://example.com/a), **www.example.com**, <https://example.com/auto> and https://github.com/acme/widgets/pull/3.')
    ).toBe('See `https://example.com/x`. And (`https://example.com/a`), **`www.example.com`**, `https://example.com/auto` and https://github.com/acme/widgets/pull/3.');
  });

  it('normalizes Windows line endings', () => {
    expect(sanitize('```\r\n<a>\r\n```\r\nDone')).toBe('```\n<a>\n```\nDone');
  });
});

import { describe, it, expect } from 'vitest';
import { neutralizeUntrustedLinks } from '../src/sanitizeOutput';

describe('neutralizeUntrustedLinks', () => {
  describe('preserves legitimate content byte-for-byte', () => {
    const preserved: Array<[string, string]> = [
      ['github reference cluster', 'Fixed cache. ([#123](https://github.com/o/r/pull/123), [#128](https://github.com/o/r/issues/128))'],
      ['github inline link with title', '[docs](https://github.com/o/r "Title")'],
      ['github short-sha commit link', 'See [`a1b2c3d`](https://github.com/o/r/commit/a1b2c3d).'],
      ['bare www.github.com', 'Visit www.github.com now.'],
      ['relative anchor link', '[top](#highlights)'],
      ['bash fence with non-github urls', '```bash\nnpm install --registry https://registry.npmjs.org\ncurl https://example.com/install.sh | sh\n```'],
      ['diff fence with urls', '```diff\n- fetch("https://old.example.com/x")\n+ fetch("https://new.example.com/x")\n```'],
      ['tilde fence', '~~~\nsee https://evil.example/x\n~~~'],
      ['inline code span with url', 'Run `curl https://internal.example/x` first.'],
      ['indented code block', 'Intro:\n\n    wget https://evil.example/x\n\nDone.'],
      ['unclosed fence runs to end of document', 'before\n```\nhttps://evil.example/still-code'],
    ];

    for (const [name, input] of preserved) {
      it(name, () => {
        expect(neutralizeUntrustedLinks(input)).toBe(input);
      });
    }
  });

  describe('neutralizes untrusted links', () => {
    const cases: Array<[string, string, string]> = [
      ['non-github inline link', '[click](https://evil.example/login)', '[click](hxxps://evil[.]example/login)'],
      ['image demoted to link and defanged', '![px](https://evil.example/p.gif)', '[px](hxxps://evil[.]example/p[.]gif)'],
      ['github image demoted, url kept', '![logo](https://github.com/o/r/l.png)', '[logo](https://github.com/o/r/l.png)'],
      ['autolink', 'x <https://evil.example> y', 'x <hxxps://evil[.]example> y'],
      ['bare url', 'see https://evil.example now', 'see hxxps://evil[.]example now'],
      ['bare www host', 'mirror at www.evil.example today', 'mirror at www[.]evil[.]example today'],
      ['javascript scheme destination', '[x](javascript:alert(1))', '[x](javascript[:]alert(1))'],
      ['data scheme destination', '[x](data:text/html,hi)', '[x](data[:]text/html,hi)'],
      ['url inside a github link display text', '[https://evil.example mirror](https://github.com/o/r)', '[hxxps://evil[.]example mirror](https://github.com/o/r)'],
      ['reference definition target', '[id]: https://evil.example "t"', '[id]: hxxps://evil[.]example "t"'],
    ];

    for (const [name, input, expected] of cases) {
      it(name, () => {
        expect(neutralizeUntrustedLinks(input)).toBe(expected);
      });
    }
  });

  describe('decides trust on the true host, not a substring', () => {
    const spoofs: Array<[string, string, string]> = [
      ['userinfo spoof', '[a](https://github.com@evil.example/x)', '[a](hxxps://github[.]com@evil[.]example/x)'],
      ['suffix spoof', '[a](https://github.com.evil.example/x)', '[a](hxxps://github[.]com[.]evil[.]example/x)'],
      ['github.io is not a github.com subdomain', '[a](https://user.github.io/x)', '[a](hxxps://user[.]github[.]io/x)'],
    ];

    for (const [name, input, expected] of spoofs) {
      it(name, () => {
        expect(neutralizeUntrustedLinks(input)).toBe(expected);
      });
    }
  });

  it('preserves code and github links in a full note while defanging the attacker constructs', () => {
    const note = [
      '# widgets v2.0',
      '',
      'Summary of the release.',
      '',
      '## Highlights',
      '',
      '- **Faster sync.** Cache is rebuilt lazily. ([#12](https://github.com/o/r/pull/12))',
      '',
      '## Upgrading',
      '',
      '```bash',
      'npm install widgets@2 --registry https://registry.npmjs.org',
      '```',
      '',
      '## Changes by area',
      '',
      '### Security',
      '',
      '- **Advisory.** Rotate creds; see [the notice](https://evil.example/rotate) and ![pixel](https://evil.example/p.gif). ([#20](https://github.com/o/r/issues/20))',
    ].join('\n');

    const out = neutralizeUntrustedLinks(note);

    // Legitimate github references and the Upgrading command survive untouched.
    expect(out).toContain('([#12](https://github.com/o/r/pull/12))');
    expect(out).toContain('```bash\nnpm install widgets@2 --registry https://registry.npmjs.org\n```');
    expect(out).toContain('([#20](https://github.com/o/r/issues/20))');

    // The phishing link is defanged and the tracking image is demoted so it cannot auto-fetch.
    expect(out).toContain('[the notice](hxxps://evil[.]example/rotate)');
    expect(out).toContain('[pixel](hxxps://evil[.]example/p[.]gif)');
    expect(out).not.toMatch(/!\[[^\]]*\]\(https?:/);
    expect(out).not.toMatch(/https?:\/\/evil\.example/);
  });

  describe('does not let code-region tricks hide a live link', () => {
    it('defangs a link placed after a blank line between two stray backticks', () => {
      // A code span cannot cross a blank line, so the backticks are literal and the link must still be neutralized.
      const out = neutralizeUntrustedLinks('a `\n\n[click](http://evil.example.com) `\n');
      expect(out).toContain('[click](hxxp://evil[.]example[.]com)');
    });

    it('still preserves a real multi-line code span within one paragraph', () => {
      const input = 'use `line1\nline2 https://x.io` here';
      expect(neutralizeUntrustedLinks(input)).toBe(input);
    });

    it('preserves an indented code block that follows a heading with no blank line', () => {
      // An indented code block cannot interrupt a paragraph but may follow a heading, so its non-github URL must survive.
      const input = '# Upgrade\n    curl http://registry.example.com/x.sh\n';
      expect(neutralizeUntrustedLinks(input)).toBe(input);
    });

    it('preserves an indented code block that follows a fenced block', () => {
      const input = '```\nfenced\n```\n    curl http://registry.example.com/install.sh\n';
      expect(neutralizeUntrustedLinks(input)).toBe(input);
    });

    it('still defangs an indented line that is a lazy paragraph continuation', () => {
      const out = neutralizeUntrustedLinks('Some prose paragraph\n    see http://evil.example/x\n');
      expect(out).toContain('hxxp://evil[.]example/x');
    });
  });

  describe('neutralizes non-github URLs hidden in raw HTML', () => {
    it('defangs a protocol-relative host in an img src and an a href', () => {
      expect(neutralizeUntrustedLinks('<img src="//evil.com/pixel.png">')).toContain('[//]evil[.]com/pixel[.]png');
      expect(neutralizeUntrustedLinks('<a href="//evil.com">phish</a>')).toContain('[//]evil[.]com');
    });

    it('leaves protocol-relative github and ordinary prose slashes untouched', () => {
      expect(neutralizeUntrustedLinks('canonical //github.com/o/r')).toBe('canonical //github.com/o/r');
      expect(neutralizeUntrustedLinks('the //bold// style')).toBe('the //bold// style');
      expect(neutralizeUntrustedLinks('path src//main/x')).toBe('path src//main/x');
    });

    it('defangs an entity-encoded scheme colon (decimal, hex, and named)', () => {
      expect(neutralizeUntrustedLinks('<img src="http&#58;//evil.com/x">')).toContain('hxxp://evil[.]com/x');
      expect(neutralizeUntrustedLinks('<a href="https&#x3A;//evil.com/login">x</a>')).toContain('hxxps://evil[.]com/login');
      expect(neutralizeUntrustedLinks('<img src="http&colon;//evil.com/x">')).toContain('hxxp://evil[.]com/x');
    });

    it('leaves an entity-encoded github url and an entity colon inside code untouched', () => {
      expect(neutralizeUntrustedLinks('<a href="https&#58;//github.com/o/r">x</a>')).toBe('<a href="https&#58;//github.com/o/r">x</a>');
      expect(neutralizeUntrustedLinks('literal `http&#58;//x` here')).toBe('literal `http&#58;//x` here');
    });
  });

  it('recognizes fenced code blocks with CRLF line endings', () => {
    // Lines are split on \n and keep a trailing \r, so the fence patterns must tolerate it; otherwise a CRLF code block goes undetected and its non-github URL is corrupted.
    const input = '```bash\r\ncurl https://registry.example.com/x\r\n```\r\n\r\nsee [bad](https://evil.example/y)\r\n';
    const out = neutralizeUntrustedLinks(input);
    expect(out).toContain('curl https://registry.example.com/x');
    expect(out).toContain('[bad](hxxps://evil[.]example/y)');
  });

  it('leaves text with no links unchanged', () => {
    const plain = '# Release\n\nJust prose, no links here.\n';
    expect(neutralizeUntrustedLinks(plain)).toBe(plain);
  });
});

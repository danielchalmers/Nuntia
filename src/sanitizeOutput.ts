// Neutralizes links to non-github.com hosts in the model's markdown output before it is published.
// The model summarizes attacker-writable commit/PR/issue text, so a faithful summary can carry an attacker's phishing URL or a remote image (a tracking pixel that auto-fetches when the notes render in the Actions UI). This pass defangs those without depending on the model obeying the prompt.
//
// It is deliberately conservative: everything inside code regions is preserved verbatim, because the Upgrading section legitimately puts non-github URLs (package registries, install scripts) in bash/diff blocks, and code neither auto-links nor renders images on any mainstream renderer.
// Run it exactly once — defanging is not idempotent, since a second pass would re-bracket the dots.

const TRUSTED_HOST = 'github.com';

// A destination is trusted (left byte-for-byte) when it is an http(s) URL on github.com or a subdomain, or a host-less relative/anchor ref.
// Parsing against a github.com base folds three cases into one: a relative ref resolves on github.com and stays trusted; a protocol-relative //host resolves to its real authority; an absolute URL keeps its own.
// The host is read from `hostname`, never by substring, so userinfo ("github.com@evil.com"), suffix ("github.com.evil.com"), case, trailing-dot, and IDNA spoofs are all decided on the true host.
function isTrustedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim(), 'https://github.com/');
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  return host === TRUSTED_HOST || host.endsWith('.' + TRUSTED_HOST);
}

// Rewrites a hostile URL into an inert form: an unregistered scheme plus bracketed dots.
// No renderer navigates to or auto-fetches it, and GitHub's bare-URL/www auto-linker no longer fires because the dots are broken.
function defangUrl(raw: string): string {
  return raw
    .replace(/^http/i, 'hxxp')
    .replace(/^(javascript|data|vbscript|file):/i, '$1[:]')
    .replace(/^\/\//, '[//]')
    .replace(/\./g, '[.]');
}

function neutralizeUrl(raw: string): string {
  return isTrustedUrl(raw) ? raw : defangUrl(raw);
}

// An inline link or image: [label](dest "title"). The `!` is captured so an image can be demoted to a link.
// The label allows escaped characters but not a raw closing bracket; the destination stops at whitespace, angle brackets, or the closing paren.
const INLINE_LINK = /(!?)\[((?:[^\]\\]|\\.)*)\]\((\s*)(<?)([^\s<>)]*)(>?)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*)\)/g;

// A reference definition line: [id]: dest "title". Defanging the target neutralizes every [text][id] use site that resolves through it.
// The trailing \r? tolerates CRLF line endings, since lines are split on \n and may keep a carriage return.
const REF_DEF = /^([ ]{0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*)(<?)([^\s<>]+)(>?)([ \t]*(?:"[^"]*"|'[^']*'|\([^)]*\))?[ \t]*)\r?$/gm;

// An autolink: <scheme:rest>.
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.\-]*:[^<>\s]+)>/g;

// A bare URL GitHub would auto-link, either scheme-prefixed, protocol-relative, or starting with www. The leading group keeps the match from starting mid-token.
// The protocol-relative branch requires a dotted authority before the next delimiter so it fires on //host.tld (which resolves live against the page scheme, e.g. inside a raw HTML src) but not on prose like "//TODO", "a // b", or a "src//main" path.
const BARE_URL = /(^|[^/A-Za-z0-9._%-])((?:https?:\/\/|\/\/(?=[^\s<>()[\]"'/?#]*\.)|www\.)[^\s<>()[\]"']+)/gi;

// A scheme whose colon is written as an HTML character reference (&#58;, &#x3A;, &colon;). The prompt forbids raw HTML, but if the model emits it anyway an HTML parser decodes the reference to ':' at render time, so a bare-URL scan on the literal text would miss it. Defanging URLs inside raw HTML this way is best-effort; the primary defenses are the prompt's no-raw-HTML rule and GitHub's own sanitizer.
const ENTITY_SCHEME = /(https?)(?:&#0*58;|&#x0*3a;|&colon;)(\/\/[^\s<>()[\]"']+)/gi;

// Defangs one code-free fragment. Structural passes run first (rewrite destinations, drop the image `!`), then the lexical passes catch any URL sitting in display text, a reference target, an autolink, or bare prose.
function defangProse(text: string): string {
  let out = text.replace(INLINE_LINK, (match, bang, label, lead, open, dest, close, title) => {
    const neutral = neutralizeUrl(dest);
    // A trusted, non-image link is returned untouched so github references stay byte-for-byte; dropping `bang` demotes an image so it can never be an <img src>.
    if (!bang && neutral === dest) return match;
    return `[${label}](${lead}${open}${neutral}${close}${title})`;
  });
  out = out.replace(REF_DEF, (match, head, open, dest, close, tail) => {
    const neutral = neutralizeUrl(dest);
    return neutral === dest ? match : `${head}${open}${neutral}${close}${tail}`;
  });
  out = out.replace(AUTOLINK, (match, url) => {
    const neutral = neutralizeUrl(url);
    return neutral === url ? match : `<${neutral}>`;
  });
  // Runs before BARE_URL so an entity-encoded scheme is neutralized as one unit; otherwise BARE_URL's protocol-relative branch would rewrite only the // part and leave an ambiguous "http&#58;[//]..." behind.
  out = out.replace(ENTITY_SCHEME, (match, scheme, rest) => {
    const url = `${scheme}:${rest}`;
    return isTrustedUrl(url) ? match : defangUrl(url);
  });
  out = out.replace(BARE_URL, (match, pre, url) => {
    const probe = /^www\./i.test(url) ? 'http://' + url : url;
    return isTrustedUrl(probe) ? match : pre + defangUrl(url);
  });
  return out;
}

// The trailing \r? in these fence patterns tolerates CRLF line endings, since lines are split on \n and may keep a carriage return.
function matchFenceOpen(line: string): { char: string; len: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line);
  if (!m) return null;
  const marker = m[1] ?? '';
  const info = m[2] ?? '';
  // A backtick fence's info string cannot contain a backtick; if it does, this is inline code, not a fence.
  if (marker.charAt(0) === '`' && info.includes('`')) return null;
  return { char: marker.charAt(0), len: marker.length };
}

function matchFenceClose(line: string, fence: { char: string; len: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!m) return false;
  const marker = m[1] ?? '';
  return marker.charAt(0) === fence.char && marker.length >= fence.len;
}

// An indented code block needs four spaces or a tab. It cannot interrupt a paragraph, but may begin right after any non-paragraph block; opensParagraph decides which case applies.
function isIndentedCode(line: string): boolean {
  return line.trim() !== '' && /^(?: {4}|\t)/.test(line);
}

// True when this prose line leaves an open paragraph, so a following indented line is a lazy paragraph continuation (to defang), not an indented code block. A blank line, an ATX heading, or a thematic break is its own block and leaves no open paragraph, so an indented code block may start on the next line even without a blank one between. The trailing \r? tolerates CRLF endings.
function opensParagraph(line: string): boolean {
  if (line.trim() === '') return false;
  if (/^ {0,3}#{1,6}(?:[ \t]|\r?$)/.test(line)) return false;
  if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})\r?$/.test(line)) return false;
  return true;
}

// Finds the next run of exactly `runLen` backticks, which is where a code span of that length closes.
function findClosingBacktickRun(text: string, from: number, runLen: number): number {
  const n = text.length;
  for (let i = from; i < n; ) {
    if (text[i] === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      if (j - i === runLen) return j;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

// Walks a prose region, defanging the text between inline code spans while preserving each span verbatim.
function processInline(text: string): string {
  let out = '';
  let plain = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      // An escaped character cannot open a code span or a link construct.
      i += 2;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const close = findClosingBacktickRun(text, j, j - i);
      // A code span is inline and cannot cross a blank line; if the only closing run sits past a paragraph break, the opening backticks are literal, not a span, and text after the blank line stays prose to be defanged.
      if (close !== -1 && !/\n[ \t]*\n/.test(text.slice(i, close))) {
        out += defangProse(text.slice(plain, i)) + text.slice(i, close);
        i = plain = close;
        continue;
      }
      // An unterminated run is literal; keep scanning so a later URL is still defanged.
      i = j;
      continue;
    }
    i++;
  }
  return out + defangProse(text.slice(plain));
}

// Defangs links to non-github hosts in `markdown`, preserving all code regions and every github.com link byte-for-byte.
// Splitting and rejoining on '\n' keeps bytes and line endings exact.
export function neutralizeUntrustedLinks(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  // Tracks whether an indented code block may start on the current line, which is true at the start of the document and after any non-paragraph block, but not while a paragraph is open.
  let canStartIndentedCode = true;
  let i = 0;

  const flush = () => {
    if (prose.length) {
      out.push(processInline(prose.join('\n')));
      prose = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = matchFenceOpen(line);
    if (fence) {
      flush();
      const block = [line];
      i++;
      while (i < lines.length) {
        const inner = lines[i] as string;
        block.push(inner);
        const closed = matchFenceClose(inner, fence);
        i++;
        if (closed) break;
      }
      out.push(block.join('\n'));
      // A closed fenced block leaves no open paragraph, so an indented code block may follow immediately.
      canStartIndentedCode = true;
      continue;
    }
    if (canStartIndentedCode && isIndentedCode(line)) {
      flush();
      const block = [line];
      i++;
      while (i < lines.length) {
        const inner = lines[i] as string;
        if (!isIndentedCode(inner) && inner.trim() !== '') break;
        block.push(inner);
        i++;
      }
      out.push(block.join('\n'));
      canStartIndentedCode = true;
      continue;
    }
    prose.push(line);
    canStartIndentedCode = !opensParagraph(line);
    i++;
  }
  flush();
  return out.join('\n');
}

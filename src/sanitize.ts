// The notes are published in the release, and the model writes them from public issue and pull request text.
// So before they are written, anything that could render HTML, notify someone, show an image or link outside the repository is made inert, and Nuntia's own markers are removed so its section can always be found again.
// Fenced code and code spans are left as written, because GitHub shows them literally.

type Segment = { code: boolean; text: string };
// A fence's prefix is the blockquote markers before it, and depth is how many there are. Its indent is in columns.
type Fence = { depth: number; prefix: string; indent: number; marker: string };

// A fence, alone on its line or right after a list marker, which indents the code to the marker's width.
const FENCE = /^([ \t]*|[ \t]*(?:[-+*]|\d{1,9}[.)]) +)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?: |$)/;
// A blockquote marker, with the one space after it that belongs to it.
const QUOTE = /^[ \t]*> ?/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// An autolink such as <https://example.com> becomes the bare URL, which the URL rule below then handles.
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g;
// An HTML tag, which can span lines but not a blank line.
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s(?:[^<>\n]|\n(?![ \t]*\n))*)?\/?>/g;
// A `<` that could still open a tag, a comment, a declaration or an autolink, including one into text set aside for now.
const TAG_OPENER = /<(?=[A-Za-z\/!?\u0000])/g;
const MARKER = /<!--\s*nuntia:(?:start|end)\s*-->|nuntia:(?:start|end)/gi;

const CHAR = String.raw`(?:[^\[\]\\]|\\[\s\S])`;
// Link text without brackets is matched before link text with one level of brackets, so a link inside another link is handled first.
const LINK_TEXTS = [String.raw`(${CHAR}*)`, String.raw`((?:${CHAR}|\[${CHAR}*\])*)`];
const URL_CHAR = String.raw`(?:[^\s()<>\\]|\\[\s\S])`;
// A destination with an optional title, such as (https://example.com "Title").
const DESTINATION = String.raw`\(\s*(<[^<>\n]*>|(?:${URL_CHAR}|\(${URL_CHAR}*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)`;
const INLINE_LINKS = LINK_TEXTS.map(text => new RegExp(String.raw`(!?)\[${text}\]${DESTINATION}`, 'g'));
const REFERENCE_LINKS = LINK_TEXTS.map(text => new RegExp(String.raw`(!?)\[${text}\](?:\[(${CHAR}*)\])?`, 'g'));
// A blockquote or list item can hold a definition too, and GitHub applies it to the whole document.
const CONTAINER = String.raw`(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*`;
// A link reference definition is a label, a destination and an optional title, with nothing else on its line, or GitHub shows the line as text.
// A label starting with ^ is a footnote, whose text GitHub shows, and a label with an @ could be shown as text, so neither counts.
const DEFINITION = new RegExp(String.raw`^(${CONTAINER}) {0,3}\[(?!\^)((?:(?!@)${CHAR})+)\]:[ \t]*(?:<([^<>\n]*)>|([^\s<]\S*))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$`, 'gm');

// GitHub links bare http, https, ftp and www addresses.
const BARE_URL = /(?<![A-Za-z0-9])(?:(?:https?|ftp):\/\/|www\.)[^\s<>`\u0000]*/gi;
// A user or team mention, with any backslashes before it, since an escaped @ still renders as one.
// Only a letter or digit before the @ rules out a mention, because underscores can be emphasis, and _@alice_ still mentions alice.
const MENTION = /(?:(?<![\\A-Za-z0-9])|(?<=[A-Za-z0-9])(?=\\))\\*@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][\w.-]*)?)/g;
// A character reference that GitHub shows as @, so it can start a mention too.
const AT_REFERENCE = /&(?:#0*64|#x0*40|commat);/gi;
// A numeric character reference, which shows as the character it names.
const NUMERIC_REFERENCE = /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g;
// GitHub shows a backslash-escaped colon as a colon, so https\:// is still a link.
const ESCAPED_SCHEME = /(?<![A-Za-z0-9])(https?|ftp)\\:/gi;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;

/**
 * Whether a link goes to the release's own repository on GitHub.
 * A relative link resolves against the release page, as it does on GitHub.
 */
function pointsIntoRepository(url: string, owner: string, repo: string): boolean {
  // A character reference could spell out another scheme or host once GitHub decodes it.
  if (!url.trim() || /&[#A-Za-z0-9]+;/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'), `https://github.com/${owner}/${repo}/releases/tag/`);
  } catch {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  const prefix = `/${owner}/${repo}`.toLowerCase();
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') &&
    !parsed.username &&
    !parsed.password &&
    (path === prefix || path.startsWith(`${prefix}/`))
  );
}

/** The line without its first depth blockquote markers, or undefined when it has fewer. */
function unquote(line: string, depth: number): string | undefined {
  let rest = line;
  for (let i = 0; i < depth; i++) {
    const quote = QUOTE.exec(rest);
    if (!quote) return undefined;
    rest = rest.slice(quote[0].length);
  }
  return rest;
}

// The columns of leading whitespace, with a tab reaching the next multiple of 4, as CommonMark counts them.
function indentWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/**
 * The fence a line opens, inside any blockquotes it starts with, such as a GitHub alert.
 * A line indented 4 or more columns right after a line of text continues that text's paragraph, unless the text is a list item, so it opens nothing.
 */
function openFence(line: string, previous: string | undefined): Fence | undefined {
  if (indentWidth(line) >= 4 && previous?.trim() && !LIST_ITEM.test(previous)) return undefined;
  let rest = line;
  let depth = 0;
  for (let quote = QUOTE.exec(rest); quote; quote = QUOTE.exec(rest)) {
    rest = rest.slice(quote[0].length);
    depth++;
  }
  const open = FENCE.exec(rest);
  if (!open || (open[2]!.startsWith('`') && open[3]!.includes('`'))) return undefined;
  const lead = open[1]!;
  return { depth, prefix: line.slice(0, line.length - rest.length), indent: LIST_ITEM.test(lead) ? lead.length : indentWidth(lead), marker: open[2]! };
}

/** Split the text into fenced code blocks and the Markdown around them, closing a fence the text leaves open. */
function splitFences(text: string): Segment[] {
  const segments: Segment[] = [];
  let lines: string[] = [];
  let fence: Fence | undefined;
  const flush = (code: boolean) => {
    if (lines.length) segments.push({ code, text: lines.join('\n') });
    lines = [];
  };

  let previous: string | undefined;
  for (const line of text.split('\n')) {
    if (fence) {
      const { depth, indent, marker } = fence;
      // A line with fewer blockquote markers than its fence ends the blockquote, and the fence with it.
      const content = unquote(line, depth);
      if (content !== undefined) {
        const trimmed = content.trim();
        const lineIndent = indentWidth(content);
        // A closing fence can be indented at most three spaces more than its fence, so a line indented further is still code.
        if (trimmed.length >= marker.length && [...trimmed].every(char => char === marker[0]) && lineIndent <= indent + 3) {
          lines.push(line);
          flush(true);
          fence = undefined;
          previous = line;
          continue;
        }
        // A line indented less than its fence ends the list item the fence is in, and the fence with it.
        if (!trimmed || lineIndent >= indent) {
          lines.push(line);
          previous = line;
          continue;
        }
      }
      flush(true);
      fence = undefined;
    }
    const open = openFence(line, previous);
    if (open) {
      flush(false);
      fence = open;
    }
    lines.push(line);
    previous = line;
  }
  if (fence) lines.push(fence.prefix + ' '.repeat(fence.indent) + fence.marker);
  flush(fence !== undefined);
  return segments;
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === '`') end++;
  return end;
}

/**
 * Set aside each code span with keep.
 * A span here can't continue onto another line, so text GitHub may render as Markdown is never mistaken for code, at the cost of showing a rare multi-line span as plain text.
 */
function protectCodeSpans(text: string, keep: (value: string) => string): string {
  let out = '';
  let from = 0;
  for (let start = 0; start < text.length; ) {
    let slashes = 0;
    if (text[start] === '`') while (text[start - 1 - slashes] === '\\') slashes++;
    if (text[start] !== '`' || slashes % 2 === 1) {
      start++;
      continue;
    }
    const openEnd = backtickRunEnd(text, start);
    let close = -1;
    for (let i = openEnd; i < text.length && text[i] !== '\n'; ) {
      if (text[i] !== '`') {
        i++;
        continue;
      }
      const end = backtickRunEnd(text, i);
      if (end - i === openEnd - start) {
        close = end;
        break;
      }
      i = end;
    }
    if (close < 0) {
      start = openEnd;
      continue;
    }
    out += text.slice(from, start) + keep(text.slice(start, close));
    from = start = close;
  }
  return out + text.slice(from);
}

/** Make whatever syntax is left unparsed render as plain text: tag openers, images, links and lone backticks. */
function escapeLeftovers(text: string): string {
  return (
    text
      .replace(TAG_OPENER, '&lt;')
      .replace(/!\[/g, '!\\[')
      .replace(/\]\(/g, ']\\(')
      // Every code span is already set aside, so a backtick left here could pair with one added for a mention or URL.
      .replace(/(\\*)`/g, (match, slashes: string) => (slashes.length % 2 === 1 ? match : `${slashes}\\\``))
  );
}

// Removing one marker can join the text around it into another, so this repeats until none is left.
function removeMarkers(text: string): string {
  let out = text;
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(MARKER, '');
  }
  return out;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function trimUrl(url: string): string {
  const count = (char: string) => url.split(char).length - 1;
  while (/[?!.,:*_~'"]$/.test(url) || (url.endsWith(')') && count('(') < count(')'))) url = url.slice(0, -1);
  return url;
}

// A letter, digit or hyphen spelled as a character reference, which GitHub shows as itself, so it could spell a mention or a URL that the rules here would miss.
function decodeWordCharacter(reference: string, hex: string | undefined, decimal: string | undefined): string {
  const code = hex ? parseInt(hex, 16) : Number(decimal);
  const char = code <= 0x10ffff ? String.fromCodePoint(code) : '';
  return /^[A-Za-z0-9-]$/.test(char) ? char : reference;
}

function sanitizeMarkdown(text: string, inRepository: (url: string) => boolean, definitions: Map<string, boolean>): string {
  const kept: string[] = [];
  const keep = (value: string) => `\u0000${kept.push(value) - 1}\u0000`;
  const keepLink = (label: string, rest: string) => (label.trim() ? keep(`[${escapeLeftovers(label)}]${rest}`) : '');

  let out = protectCodeSpans(text, keep).replace(NUMERIC_REFERENCE, decodeWordCharacter).replace(HTML_COMMENT, '').replace(AUTOLINK, '$1').replace(HTML_TAG, '');
  // A kept definition loses its title, the one part of it GitHub could show.
  out = out.replace(DEFINITION, (_line, container: string, label: string, angled: string | undefined, plain: string | undefined) =>
    definitions.get(normalizeLabel(label)) ? keep(`${container}[${label}]: ${angled === undefined ? plain : `<${angled}>`}`) : container.trimEnd()
  );

  // Images go, and links keep only their text unless they point into the repository, until nothing more changes.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    for (let i = 0; i < LINK_TEXTS.length; i++) {
      out = out.replace(INLINE_LINKS[i]!, (_match, image: string, label: string, destination: string) => {
        if (image) return '';
        const url = destination.startsWith('<') ? destination.slice(1, -1) : destination;
        // A code span set aside inside the destination would come back as part of the URL, where GitHub doesn't read it as code.
        return inRepository(url) && !url.includes('\u0000') ? keepLink(label, `(${destination})`) : label;
      });
      out = out.replace(REFERENCE_LINKS[i]!, (match, image: string, label: string, reference: string | undefined) => {
        const allowed = definitions.get(normalizeLabel(reference || label));
        if (allowed === undefined) return match;
        if (image) return '';
        return allowed ? keepLink(label, reference === undefined ? '' : `[${reference}]`) : label;
      });
    }
  }

  out = out.replace(ESCAPED_SCHEME, '$1:').replace(BARE_URL, (match: string, offset: number, whole: string) => {
    const url = trimUrl(match);
    const inside = inRepository(/^www\./i.test(url) ? `http://${url}` : url);
    // GitHub reads a URL on into text set aside right after it, such as a code span, so a space keeps them apart.
    const gap = whole[offset + match.length] === '\u0000' ? ' ' : '';
    return keep(inside ? url : `\`${url}\``) + match.slice(url.length) + gap;
  });
  out = escapeLeftovers(out.replace(AT_REFERENCE, '@').replace(MENTION, (_match, name: string) => keep(`\`@${name}\``)));

  // A kept value can hold placeholders of its own, such as a code span inside a link.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(PLACEHOLDER, (_match, index: string) => kept[Number(index)] ?? '');
  }
  return out;
}

/**
 * Make the model's notes safe to publish in the release of owner/repo.
 * Raw HTML, images and Nuntia's markers are removed.
 * Mentions and bare URLs outside the repository become code, and links outside the repository become their text.
 */
export function sanitizeNotes(text: string, owner: string, repo: string): string {
  // Removing something, such as a marker or a comment, can join the text around it into new syntax, so the pass repeats until nothing changes.
  let out = text;
  for (let previous = '', passes = 0; previous !== out && passes < 10; passes++) {
    previous = out;
    out = sanitizeOnce(out, owner, repo);
  }
  return out;
}

function sanitizeOnce(text: string, owner: string, repo: string): string {
  const inRepository = (url: string) => pointsIntoRepository(url, owner, repo);
  const segments = splitFences(removeMarkers(text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')));

  // A reference definition applies to the whole document, and the first one for a label wins.
  const definitions = new Map<string, boolean>();
  for (const segment of segments) {
    if (segment.code) continue;
    for (const [, , label, angled, plain] of segment.text.matchAll(DEFINITION)) {
      const key = normalizeLabel(label!);
      if (!definitions.has(key)) definitions.set(key, inRepository(angled ?? plain ?? ''));
    }
  }

  // Markers go before parsing, so none hides in a link that is kept, and again after, in case removing other text joined one together.
  return removeMarkers(segments.map(segment => (segment.code ? segment.text : sanitizeMarkdown(segment.text, inRepository, definitions))).join('\n'));
}

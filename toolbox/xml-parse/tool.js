#!/usr/bin/env node
// Inspired by fast-xml-parser (MIT); reimplemented from the XML grammar/spec
// — no vendored code. A hand-written char-scanner recursive-descent parser
// (no regex over tag structure) that builds a plain-object tree: attributes
// under "@attr", text under "#text" for elements that mix text and child
// elements, repeated same-named siblings collapsed into arrays, CDATA
// sections unwrapped to literal text, comments and the XML declaration
// skipped.
//
// Security note (read this before trusting it with untrusted input): a
// DOCTYPE block is SKIPPED verbatim — its internal subset (bracketed
// <!ENTITY ...> declarations etc.) is scanned only far enough to find the
// declaration's true end (tracking '[' / ']' nesting so an embedded '>'
// doesn't end the skip early), and is never interpreted. No external
// entity is ever fetched and no custom entity is ever expanded — only the
// five built-in XML entities (&amp; &lt; &gt; &quot; &apos;) and numeric
// character references (&#N; / &#xN;) are decoded. That makes the classic
// "billion laughs" (entity-expansion) and XXE (external-entity-fetch)
// attack classes structurally impossible here, not just mitigated: the
// code path that would be needed to exploit either simply does not exist.
//
// stdin: { xml: string, preserveAttributes?: boolean }
// stdout: { root: { <rootTag>: <value> } }
//
// Element nesting is capped at MAX_DEPTH (mirroring html-extract's
// MAX_DEPTH pattern): a document with thousands of unclosed/nested tags
// gets a clean "nesting too deep" parse error instead of overflowing the
// call stack.
'use strict';

const MAX_DEPTH = 500;

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

class XmlParseError extends Error {}

function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}
// XML names may use letters from any script (<café>, <名前>), not just
// ASCII. Checked one UTF-16 unit at a time; a surrogate (half of an astral
// character) is accepted as a name character too.
const NAME_START_RE = /[\p{L}_:\uD800-\uDFFF]/u;
const NAME_CHAR_RE = /[\p{L}\p{M}\p{N}_:.\-\u00B7\uD800-\uDFFF]/u;
function isNameStartChar(c) {
  return c !== undefined && (isAlpha(c) || c === '_' || c === ':' || (c > '\x7f' && NAME_START_RE.test(c)));
}
function isNameChar(c) {
  return c !== undefined && (isAlpha(c) || isDigit(c) || c === '_' || c === ':' || c === '-' || c === '.' || (c > '\x7f' && NAME_CHAR_RE.test(c)));
}
function isXmlSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

const BUILTIN_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Manual (non-regex) entity decode, so an unknown-entity error can point
 * at the exact document offset. `basePos` is where `str` starts in the
 * original document, for position-accurate error messages. */
function decodeXmlEntities(str, basePos) {
  if (str.indexOf('&') === -1) return str;
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] !== '&') { out += str[i]; i += 1; continue; }
    const semi = str.indexOf(';', i);
    if (semi === -1) throw new XmlParseError(`unterminated entity reference at position ${basePos + i}`);
    const body = str.slice(i + 1, semi);
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      // Strict digits: parseInt alone would read "&#12abc;" as &#12; and
      // silently drop the rest.
      const wellFormed = isHex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits);
      const code = wellFormed ? parseInt(digits, isHex ? 16 : 10) : NaN;
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlParseError(`invalid numeric character reference '&${body};' at position ${basePos + i}`);
      }
      out += String.fromCodePoint(code);
    } else if (Object.prototype.hasOwnProperty.call(BUILTIN_ENTITIES, body)) {
      out += BUILTIN_ENTITIES[body];
    } else {
      throw new XmlParseError(
        `unknown entity '&${body};' at position ${basePos + i} (only the 5 built-in XML entities and numeric ` +
        'character references are supported here — DTD-declared entities are deliberately not resolved)',
      );
    }
    i = semi + 1;
  }
  return out;
}

class XmlParser {
  constructor(src) {
    this.src = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
    this.n = this.src.length;
    this.pos = 0;
    this.depth = 0;
  }

  error(msg) {
    throw new XmlParseError(`${msg} at position ${this.pos}`);
  }

  skipWhitespace() {
    while (this.pos < this.n && isXmlSpace(this.src[this.pos])) this.pos += 1;
  }

  /** Skips whitespace, comments, and processing instructions (XML
   * declaration included). Returns true if it consumed a DOCTYPE. */
  skipProlog() {
    let sawDoctype = false;
    for (;;) {
      this.skipWhitespace();
      if (this.src.startsWith('<!--', this.pos)) {
        const end = this.src.indexOf('-->', this.pos + 4);
        if (end === -1) this.error('unterminated comment');
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith('<?', this.pos)) {
        const end = this.src.indexOf('?>', this.pos + 2);
        if (end === -1) this.error('unterminated processing instruction');
        this.pos = end + 2;
        continue;
      }
      if (this.src.slice(this.pos, this.pos + 9).toUpperCase() === '<!DOCTYPE') {
        if (sawDoctype) this.error('a document may have only one DOCTYPE declaration');
        sawDoctype = true;
        let depth = 0;
        let i = this.pos + 9;
        for (;;) {
          if (i >= this.n) this.error('unterminated DOCTYPE declaration');
          const c = this.src[i];
          if (c === '[') depth += 1;
          else if (c === ']') depth -= 1;
          else if (c === '>' && depth <= 0) { i += 1; break; }
          i += 1;
        }
        this.pos = i;
        continue;
      }
      break;
    }
    return sawDoctype;
  }

  parseName() {
    if (!isNameStartChar(this.src[this.pos])) this.error('expected an element or attribute name');
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.n && isNameChar(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  expectChar(ch) {
    if (this.src[this.pos] !== ch) this.error(`expected '${ch}' but found '${this.src[this.pos] ?? '<end of input>'}'`);
    this.pos += 1;
  }

  parseAttrValue() {
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") this.error('expected a quoted attribute value');
    this.pos += 1;
    const valStart = this.pos;
    const endQuote = this.src.indexOf(quote, this.pos);
    if (endQuote === -1) this.error('unterminated attribute value');
    const raw = this.src.slice(valStart, endQuote);
    this.pos = endQuote + 1;
    return decodeXmlEntities(raw, valStart);
  }

  parseElement() {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) this.error(`nesting too deep (over ${MAX_DEPTH} levels)`);
    try {
      return this.parseElementInner();
    } finally {
      this.depth -= 1;
    }
  }

  parseElementInner() {
    this.expectChar('<');
    const name = this.parseName();
    // Null prototype (here and in toValue): an attribute or element named
    // "__proto__" must be stored as an ordinary key, not swallowed as an
    // assignment to the object's prototype.
    const attrs = Object.create(null);
    let selfClosing = false;
    for (;;) {
      this.skipWhitespace();
      if (this.src[this.pos] === '/' && this.src[this.pos + 1] === '>') { this.pos += 2; selfClosing = true; break; }
      if (this.src[this.pos] === '>') { this.pos += 1; break; }
      if (this.pos >= this.n) this.error(`unexpected end of input while parsing the start tag of <${name}>`);
      const attrName = this.parseName();
      this.skipWhitespace();
      this.expectChar('=');
      this.skipWhitespace();
      const value = this.parseAttrValue();
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) this.error(`duplicate attribute '${attrName}' on <${name}>`);
      attrs[attrName] = value;
    }

    if (selfClosing) return { tagName: name, attrs, text: '', children: [] };

    const textParts = [];
    const children = [];
    for (;;) {
      if (this.pos >= this.n) this.error(`unexpected end of input: <${name}> was never closed`);
      if (this.src[this.pos] === '<') {
        if (this.src.startsWith('</', this.pos)) {
          this.pos += 2;
          const closeName = this.parseName();
          this.skipWhitespace();
          this.expectChar('>');
          if (closeName !== name) this.error(`mismatched closing tag: expected </${name}> but found </${closeName}>`);
          break;
        }
        if (this.src.startsWith('<!--', this.pos)) {
          const end = this.src.indexOf('-->', this.pos + 4);
          if (end === -1) this.error('unterminated comment');
          this.pos = end + 3;
          continue;
        }
        if (this.src.startsWith('<![CDATA[', this.pos)) {
          const end = this.src.indexOf(']]>', this.pos + 9);
          if (end === -1) this.error('unterminated CDATA section');
          textParts.push(this.src.slice(this.pos + 9, end)); // raw, not entity-decoded
          this.pos = end + 3;
          continue;
        }
        if (this.src.startsWith('<?', this.pos)) {
          const end = this.src.indexOf('?>', this.pos + 2);
          if (end === -1) this.error('unterminated processing instruction');
          this.pos = end + 2;
          continue;
        }
        children.push(this.parseElement());
        continue;
      }
      const start = this.pos;
      while (this.pos < this.n && this.src[this.pos] !== '<') this.pos += 1;
      textParts.push(decodeXmlEntities(this.src.slice(start, this.pos), start));
    }

    return { tagName: name, attrs, text: textParts.join(''), children };
  }

  parseDocument() {
    this.skipProlog();
    if (this.pos >= this.n) this.error('empty document: no root element found');
    if (this.src[this.pos] !== '<') this.error("expected '<' to start the root element");
    const root = this.parseElement();
    this.skipProlog();
    this.skipWhitespace();
    if (this.pos < this.n) this.error('trailing content found after the root element');
    return root;
  }
}

function toValue(node, preserveAttributes) {
  const hasAttrs = preserveAttributes && Object.keys(node.attrs).length > 0;
  const trimmedText = node.text.trim();

  if (node.children.length === 0) {
    if (!hasAttrs) return trimmedText;
    const obj = Object.create(null);
    obj['@attr'] = node.attrs;
    if (trimmedText.length) obj['#text'] = trimmedText;
    return obj;
  }

  const obj = Object.create(null);
  if (hasAttrs) obj['@attr'] = node.attrs;
  if (trimmedText.length) obj['#text'] = trimmedText;
  for (const child of node.children) {
    const childValue = toValue(child, preserveAttributes);
    if (Object.prototype.hasOwnProperty.call(obj, child.tagName)) {
      if (!Array.isArray(obj[child.tagName])) obj[child.tagName] = [obj[child.tagName]];
      obj[child.tagName].push(childValue);
    } else {
      obj[child.tagName] = childValue;
    }
  }
  return obj;
}

function parseXml(xml, preserveAttributes) {
  const parser = new XmlParser(xml);
  const root = parser.parseDocument();
  return { [root.tagName]: toValue(root, preserveAttributes) };
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const { xml } = args;
  if (typeof xml !== 'string') return fail('xml must be a string');
  const preserveAttributes = args.preserveAttributes === undefined ? true : args.preserveAttributes;
  if (typeof preserveAttributes !== 'boolean') return fail('preserveAttributes must be a boolean');

  let root;
  try {
    root = parseXml(xml, preserveAttributes);
  } catch (err) {
    return fail(err instanceof XmlParseError ? `xml parse error: ${err.message}` : `unexpected error: ${err.message}`);
  }
  process.stdout.write(JSON.stringify({ root }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

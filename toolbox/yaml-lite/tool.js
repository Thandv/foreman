#!/usr/bin/env node
// Inspired by js-yaml (MIT); reimplemented from the YAML spec — no vendored
// code. This is DELIBERATELY a subset of YAML, not a full implementation:
// full YAML (anchors/aliases, tags, multi-document streams, merge keys,
// complex mapping keys, flow scalars spanning multiple lines, and a long
// tail of scalar-resolution edge cases) is a large, genuinely ambiguous
// spec, and reimplementing all of it correctly is out of scope here. What
// IS supported: nested block maps/lists by indentation, a list at the same
// indentation as its parent key (the common `key:\n- a\n- b` form), inline
// flow collections (`[a, b]`, `{k: v}`), quoted strings with backslash
// (double-quote) or `''`-escaped (single-quote) content, comments, and
// multi-line block scalars (`|` literal, `>` folded, with `-`/`+` chomping
// and an optional explicit indent digit).
//
// Anchors (&x), aliases (*x), tags (!!type), multi-document markers (---),
// and merge keys (<<) are REFUSED with a clear error rather than silently
// mis-parsed or approximated. Because anchors/aliases are refused outright
// — there is no code path that ever expands one node's content into
// another's — the "billion laughs" exponential-expansion attack that
// exploits repeated alias expansion is structurally impossible here, not
// just mitigated.
//
// stdin: { text: string }
// stdout: { data: any, warnings: string[] }
//
// Two independent recursion vectors are each capped at MAX_DEPTH (mirroring
// html-extract's MAX_DEPTH pattern): block-level indentation nesting
// (buildNode/buildSequence) and inline flow-collection nesting
// (FlowParser.parseValue, for pathological input like "[[[[...]]]]"). Both
// refuse with a clean "nesting too deep" error instead of overflowing the
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

class YamlError extends Error {}

function coerceScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function checkForbiddenStart(text, lineNo, where) {
  if (!text.length) return;
  const c = text[0];
  if (c === '&' || c === '*') {
    throw new YamlError(`anchors/aliases ('${c}...') are not supported by this YAML subset (${where}, line ${lineNo})`);
  }
  if (c === '!') {
    throw new YamlError(`tags ('!...') are not supported by this YAML subset (${where}, line ${lineNo})`);
  }
}

// --- inline flow parser: quoted strings, [ ... ], { ... }, bare scalars ---
class FlowParser {
  constructor(s, lineNo) {
    this.s = s;
    this.n = s.length;
    this.i = 0;
    this.lineNo = lineNo;
    this.depth = 0;
  }

  error(msg) {
    throw new YamlError(`${msg} (line ${this.lineNo})`);
  }

  skipWs() {
    while (this.i < this.n && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i += 1;
  }

  peek() {
    return this.s[this.i];
  }

  parseValue() {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) this.error(`nesting too deep (over ${MAX_DEPTH} levels)`);
    try {
      this.skipWs();
      const c = this.peek();
      if (c === undefined) this.error('expected a value');
      if (c === '&' || c === '*') this.error(`anchors/aliases ('${c}...') are not supported by this YAML subset`);
      if (c === '!') this.error("tags ('!...') are not supported by this YAML subset");
      if (c === '[') return this.parseArray();
      if (c === '{') return this.parseObject();
      if (c === '"') return this.parseDoubleQuoted();
      if (c === "'") return this.parseSingleQuoted();
      return this.parseBareScalar();
    } finally {
      this.depth -= 1;
    }
  }

  parseArray() {
    this.i += 1;
    const arr = [];
    this.skipWs();
    if (this.peek() === ']') { this.i += 1; return arr; }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const c = this.peek();
      if (c === ',') { this.i += 1; this.skipWs(); if (this.peek() === ']') { this.i += 1; break; } continue; }
      if (c === ']') { this.i += 1; break; }
      this.error("expected ',' or ']' in a flow sequence");
    }
    return arr;
  }

  parseObject() {
    this.i += 1;
    const obj = Object.create(null);
    this.skipWs();
    if (this.peek() === '}') { this.i += 1; return obj; }
    for (;;) {
      this.skipWs();
      let key;
      if (this.peek() === '"') key = this.parseDoubleQuoted();
      else if (this.peek() === "'") key = this.parseSingleQuoted();
      else {
        const start = this.i;
        while (this.i < this.n && this.s[this.i] !== ':' && this.s[this.i] !== ',' && this.s[this.i] !== '}') this.i += 1;
        key = this.s.slice(start, this.i).trim();
        if (!key.length) this.error('expected a key in a flow mapping');
      }
      this.skipWs();
      if (this.peek() !== ':') this.error("expected ':' in a flow mapping");
      this.i += 1;
      const value = this.parseValue();
      obj[key] = value;
      this.skipWs();
      const c = this.peek();
      if (c === ',') { this.i += 1; this.skipWs(); if (this.peek() === '}') { this.i += 1; break; } continue; }
      if (c === '}') { this.i += 1; break; }
      this.error("expected ',' or '}' in a flow mapping");
    }
    return obj;
  }

  parseDoubleQuoted() {
    this.i += 1;
    let out = '';
    const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', b: '\b', f: '\f', '0': '\0' };
    for (;;) {
      if (this.i >= this.n) this.error('unterminated double-quoted string');
      const c = this.s[this.i];
      if (c === '"') { this.i += 1; break; }
      if (c === '\\') {
        this.i += 1;
        if (this.i >= this.n) this.error('unterminated escape sequence in a double-quoted string');
        const e = this.s[this.i];
        if (e === 'u') {
          const hex = this.s.slice(this.i + 1, this.i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("invalid '\\u' escape in a double-quoted string");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 5;
        } else if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
          out += ESCAPES[e];
          this.i += 1;
        } else {
          out += e;
          this.i += 1;
        }
        continue;
      }
      out += c;
      this.i += 1;
    }
    return out;
  }

  parseSingleQuoted() {
    this.i += 1;
    let out = '';
    for (;;) {
      if (this.i >= this.n) this.error('unterminated single-quoted string');
      const c = this.s[this.i];
      if (c === "'") {
        if (this.s[this.i + 1] === "'") { out += "'"; this.i += 2; continue; }
        this.i += 1;
        break;
      }
      out += c;
      this.i += 1;
    }
    return out;
  }

  parseBareScalar() {
    const start = this.i;
    while (this.i < this.n && this.s[this.i] !== ',' && this.s[this.i] !== ']' && this.s[this.i] !== '}' && this.s[this.i] !== ':') {
      this.i += 1;
    }
    const raw = this.s.slice(start, this.i).trim();
    if (!raw.length) this.error('expected a value');
    return coerceScalar(raw);
  }
}

/** A value for a `key:` or `- ` on the block level: either a flow/quoted
 * value (delegated to FlowParser) or, for anything else, the ENTIRE rest
 * of the line taken verbatim as a plain scalar — unlike inside `[...]`/
 * `{...}`, a block-level plain scalar is not stopped early by a comma or
 * colon (`title: a, b: c` is the single string "a, b: c"). */
function parseInlineValue(text, lineNo) {
  const trimmed = text.trim();
  if (!trimmed.length) return null;
  checkForbiddenStart(trimmed, lineNo, 'a value');
  const c = trimmed[0];
  if (c === '[' || c === '{' || c === '"' || c === "'") {
    const fp = new FlowParser(trimmed, lineNo);
    const value = fp.parseValue();
    fp.skipWs();
    if (fp.i !== fp.n) throw new YamlError(`unexpected trailing content after a flow value (line ${lineNo})`);
    return value;
  }
  return coerceScalar(trimmed);
}

/** Does a quote character at `i` open a quoted scalar? Only at the start of
 * one — after the line start, whitespace, or a flow indicator — so the
 * apostrophe in a plain scalar like `it's` (or a key like `don't:`) is just a
 * character, not the start of a string that swallows the rest of the line. */
function opensQuote(s, i) {
  const c = s[i];
  if (c !== '"' && c !== "'") return false;
  if (i === 0) return true;
  const p = s[i - 1];
  return p === ' ' || p === '\t' || p === '[' || p === '{' || p === ',' || p === ':';
}

/** Index just past the quoted scalar opened at `i` (honouring `\\` escapes
 * in double quotes and `''` in single quotes), or s.length if unterminated. */
function skipQuoted(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (q === '"' && s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) {
      if (q === "'" && s[j + 1] === "'") { j += 2; continue; }
      return j + 1;
    }
    j += 1;
  }
  return s.length;
}

// --- comment stripping (quote-aware, so a '#' inside a string is kept) ---
function stripComment(content) {
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (opensQuote(content, i)) { i = skipQuoted(content, i) - 1; continue; }
    if (c === '#' && (i === 0 || content[i - 1] === ' ' || content[i - 1] === '\t')) return content.slice(0, i);
  }
  return content;
}

/** Finds a block-level "key: rest" split, respecting [] {} nesting and
 * quoted strings so a colon inside `{a: b}` or "a: b" doesn't split.
 * Returns null if `body` isn't a mapping-key line at all (a plain scalar
 * or flow value instead). */
function splitMappingKey(body, lineNo) {
  if (body[0] === '"' || body[0] === "'") {
    const fp = new FlowParser(body, lineNo);
    let key;
    try {
      key = body[0] === '"' ? fp.parseDoubleQuoted() : fp.parseSingleQuoted();
    } catch {
      return null;
    }
    if (fp.s[fp.i] === ':' && (fp.i + 1 === fp.n || fp.s[fp.i + 1] === ' ')) {
      return { key, rest: fp.s.slice(fp.i + 1) };
    }
    return null;
  }
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (opensQuote(body, i)) { i = skipQuoted(body, i) - 1; continue; }
    if (c === '[' || c === '{') { depth += 1; continue; }
    if (c === ']' || c === '}') { depth -= 1; continue; }
    if (c === ':' && depth === 0 && (i + 1 === body.length || body[i + 1] === ' ')) {
      return { key: body.slice(0, i).trim(), rest: body.slice(i + 1) };
    }
  }
  return null;
}

/** Consumes raw lines starting at `startIdx` that belong to a `|`/`>`
 * block scalar whose introducing line had `parentIndent`. Returns
 * { text, nextIdx }. Indentation is auto-detected from the first non-blank
 * continuation line unless `explicitIndent` overrides it. */
function consumeBlockScalar(rawLines, startIdx, parentIndent, style, chomp, explicitIndent) {
  let i = startIdx;
  let baseIndent = explicitIndent != null ? parentIndent + explicitIndent : null;
  const collected = [];
  while (i < rawLines.length) {
    const raw = rawLines[i];
    const isBlank = raw.trim() === '';
    if (!isBlank) {
      let w = 0;
      while (w < raw.length && (raw[w] === ' ' || raw[w] === '\t')) w += 1;
      const lineIndent = w;
      if (baseIndent === null) {
        if (lineIndent <= parentIndent) break;
        baseIndent = lineIndent;
      }
      if (lineIndent < baseIndent) break;
    }
    collected.push(isBlank ? '' : raw.slice(baseIndent ?? 0).replace(/[ \t]+$/, ''));
    i += 1;
  }

  let text;
  if (style === '|') {
    text = collected.join('\n');
  } else {
    const parts = [];
    let paragraph = [];
    for (const l of collected) {
      if (l === '') {
        if (paragraph.length) { parts.push(paragraph.join(' ')); paragraph = []; }
        parts.push('');
      } else {
        paragraph.push(l);
      }
    }
    if (paragraph.length) parts.push(paragraph.join(' '));
    text = parts.join('\n');
  }

  if (chomp === 'strip') {
    text = text.replace(/\n+$/, '');
  } else if (chomp === 'keep') {
    if (collected.length) text += '\n';
  } else {
    text = text.replace(/\n+$/, '');
    if (collected.length) text += '\n';
  }
  return { text, nextIdx: i };
}

// --- line tokenizer: raw text -> flat list of logical-line entries -------
function tokenize(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  const entries = [];
  let i = 0;
  while (i < rawLines.length) {
    const lineNo = i + 1;
    const raw = rawLines[i];

    if (raw === '---' || raw.startsWith('--- ') || raw === '...') {
      throw new YamlError(`multi-document markers ('---' / '...') are not supported by this YAML subset (line ${lineNo})`);
    }

    let w = 0;
    while (w < raw.length && (raw[w] === ' ' || raw[w] === '\t')) w += 1;
    if (raw.slice(0, w).indexOf('\t') !== -1) {
      throw new YamlError(`tab character used for indentation (YAML forbids tabs for indentation; line ${lineNo})`);
    }
    let content = raw.slice(w);
    if (content.length === 0) { i += 1; continue; }
    content = stripComment(content);
    if (content.trim() === '') { i += 1; continue; }
    let body = content.replace(/[ \t]+$/, '');
    const indent = w;

    let seq = false;
    let contentIndent = indent;
    if (body === '-' || body.startsWith('- ')) {
      seq = true;
      if (body === '-') {
        contentIndent = indent + 1;
        body = '';
      } else {
        let k = 1;
        while (k < body.length && body[k] === ' ') k += 1;
        contentIndent = indent + k;
        body = body.slice(k);
      }
    }

    const split = splitMappingKey(body, lineNo);
    let key = null;
    let inlineText = body;
    if (split) {
      key = split.key;
      inlineText = split.rest;
      if (key === '<<') throw new YamlError(`merge keys ('<<') are not supported by this YAML subset (line ${lineNo})`);
      checkForbiddenStart(key, lineNo, 'a mapping key');
    }
    inlineText = inlineText.trim();

    let blockScalar = null;
    const bm = /^([|>])([+-]?)(\d*)$/.exec(inlineText);
    if (bm) {
      const style = bm[1];
      const chomp = bm[2] === '-' ? 'strip' : bm[2] === '+' ? 'keep' : 'clip';
      const explicitIndent = bm[3] ? Number(bm[3]) : null;
      const { text: blockText, nextIdx } = consumeBlockScalar(rawLines, i + 1, indent, style, chomp, explicitIndent);
      blockScalar = { style, chomp, text: blockText };
      i = nextIdx;
      inlineText = '';
    } else {
      i += 1;
    }

    entries.push({ lineNo, indent, seq, contentIndent, key, inlineText, blockScalar });
  }
  return entries;
}

// --- indentation tree builder --------------------------------------------
function valueOfEntry(entries, pos, e, ctx) {
  if (e.blockScalar) return e.blockScalar.text;
  if (e.inlineText !== '') return parseInlineValue(e.inlineText, e.lineNo);
  const next = entries[pos.i];
  if (next && next.indent === e.contentIndent && next.seq) return buildSequence(entries, pos, e.contentIndent, ctx);
  if (next && next.indent > e.contentIndent) return buildNode(entries, pos, next.indent, ctx);
  return null;
}

// Mappings are null-prototype objects so a "__proto__" key is stored as an
// ordinary key instead of silently replacing the object's prototype.
function buildMapping(entries, pos, indent, ctx) {
  const obj = Object.create(null);
  while (pos.i < entries.length) {
    const e = entries[pos.i];
    if (e.indent !== indent || e.seq || e.key === null) break;
    pos.i += 1;
    const value = valueOfEntry(entries, pos, e, ctx);
    if (Object.prototype.hasOwnProperty.call(obj, e.key)) {
      ctx.warnings.push(`duplicate key '${e.key}' at line ${e.lineNo}; the later value overwrote the earlier one`);
    }
    obj[e.key] = value;
  }
  return obj;
}

function buildInlineSeqMapping(entries, pos, first, ctx) {
  const obj = Object.create(null);
  const value0 = valueOfEntry(entries, pos, first, ctx);
  obj[first.key] = value0;
  while (pos.i < entries.length) {
    const e = entries[pos.i];
    if (e.indent !== first.contentIndent || e.seq || e.key === null) break;
    pos.i += 1;
    const value = valueOfEntry(entries, pos, e, ctx);
    if (Object.prototype.hasOwnProperty.call(obj, e.key)) {
      ctx.warnings.push(`duplicate key '${e.key}' at line ${e.lineNo}; the later value overwrote the earlier one`);
    }
    obj[e.key] = value;
  }
  return obj;
}

function buildSequence(entries, pos, indent, ctx) {
  ctx.depth += 1;
  if (ctx.depth > MAX_DEPTH) {
    throw new YamlError(`nesting too deep (over ${MAX_DEPTH} levels) near line ${entries[pos.i]?.lineNo ?? '?'}`);
  }
  try {
    const arr = [];
    while (pos.i < entries.length) {
      const e = entries[pos.i];
      if (e.indent !== indent || !e.seq) break;
      pos.i += 1;
      let value;
      if (e.blockScalar) {
        value = e.blockScalar.text;
      } else if (e.key !== null) {
        value = buildInlineSeqMapping(entries, pos, e, ctx);
      } else if (e.inlineText !== '') {
        value = parseInlineValue(e.inlineText, e.lineNo);
      } else {
        const next = entries[pos.i];
        value = next && next.indent >= e.contentIndent ? buildNode(entries, pos, e.contentIndent, ctx) : null;
      }
      arr.push(value);
    }
    return arr;
  } finally {
    ctx.depth -= 1;
  }
}

function buildNode(entries, pos, minIndent, ctx) {
  if (pos.i >= entries.length) return null;
  const e = entries[pos.i];
  if (e.indent < minIndent) return null;
  ctx.depth += 1;
  if (ctx.depth > MAX_DEPTH) throw new YamlError(`nesting too deep (over ${MAX_DEPTH} levels) near line ${e.lineNo}`);
  try {
    if (e.seq) return buildSequence(entries, pos, e.indent, ctx);
    if (e.key !== null) return buildMapping(entries, pos, e.indent, ctx);
    pos.i += 1;
    return e.blockScalar ? e.blockScalar.text : parseInlineValue(e.inlineText, e.lineNo);
  } finally {
    ctx.depth -= 1;
  }
}

function parseYaml(text) {
  const entries = tokenize(text);
  const ctx = { warnings: [], depth: 0 };
  if (entries.length === 0) return { data: null, warnings: ctx.warnings };
  const pos = { i: 0 };
  const data = buildNode(entries, pos, entries[0].indent, ctx);
  // Every builder stops at the first line whose indentation it can't place,
  // and so does every parent up the chain — a line left over here would
  // otherwise be silently dropped from the result.
  if (pos.i < entries.length) {
    const e = entries[pos.i];
    throw new YamlError(
      `unexpected content at line ${e.lineNo} (indent ${e.indent}): it doesn't fit the structure above it — check its indentation; multi-line plain scalars are not supported by this YAML subset (use a quoted string or a '|'/'>' block scalar)`,
    );
  }
  return { data, warnings: ctx.warnings };
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
  if (typeof args.text !== 'string') return fail('text must be a string');

  let result;
  try {
    result = parseYaml(args.text);
  } catch (err) {
    return fail(err instanceof YamlError ? `yaml error: ${err.message}` : `unexpected error: ${err.message}`);
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

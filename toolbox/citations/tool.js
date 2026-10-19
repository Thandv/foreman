#!/usr/bin/env node
// Ported from the author's earlier tools — OFFLINE halves only, as
// two modes of one tool. The original fetched each URL over the network
// (urllib) to get page text; THIS TOOL NEVER FETCHES ANYTHING. Mode
// "extract" finds links and quoted claims in a markdown document. Mode
// "match" checks whether a claimed quote appears in page text the CALLER
// supplies (e.g. fetched separately, or pasted in) — the caller is
// responsible for obtaining that text; this tool only does the string work.
//
// stdin (mode "extract"): { mode: "extract", markdown: string }
// stdout: { links: [{url, line}], claims: [{quote, line, sourceUrl}] }
//
// stdin (mode "match"): { mode: "match", claims: [{quote, sourceUrl}], sources: {url: pageText} }
// stdout: { results: [{quote, sourceUrl, found}] }
'use strict';

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

const MIN_QUOTE_WORDS = 8;
const QUOTE_PROXIMITY_LINES = 2;
const MAX_LINKS = 100;

// The URL may contain one level of balanced parentheses, as Wikipedia URLs
// do ("/wiki/Foo_(bar)"); without that the link was cut at the first ")".
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]>"']+/g;
const QUOTE_RE = /"([^"]{2,})"|“([^”]{2,})”/g;
const TAG_RE = /<[^>]+>/g;
// Anything that is not a letter, digit or space, in any script: an ASCII-only
// \w would strip a CJK or Cyrillic quote down to nothing and never match it.
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE_RE = /\s+/g;

/** Lowercase, strip punctuation, collapse whitespace — for substring comparison. */
function normalize(text) {
  const stripped = text.normalize('NFKC').toLowerCase().replace(PUNCT_RE, ' ');
  return stripped.replace(WHITESPACE_RE, ' ').trim();
}

// Page text is often raw HTML, where "don’t" arrives as "don&#8217;t" and a
// space as "&nbsp;"; decode those before comparing, or the quote never
// matches. Only the handful of entities that matter for prose are named;
// any other named entity becomes a space (it is punctuation-like anyway).
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function decodeEntities(text) {
  return text.replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : ' ';
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(TAG_RE, ' '));
}

/** Markdown inline links and bare URLs, in document order, deduplicated by URL. */
function extractLinks(lines, maxLinks) {
  const seen = new Set();
  const refs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const line = lines[i];
    const urlsOnLine = [];
    const mdSpans = [];

    MARKDOWN_LINK_RE.lastIndex = 0;
    let m;
    while ((m = MARKDOWN_LINK_RE.exec(line))) {
      urlsOnLine.push(m[2]);
      mdSpans.push([m.index, m.index + m[0].length]);
    }

    BARE_URL_RE.lastIndex = 0;
    while ((m = BARE_URL_RE.exec(line))) {
      const start = m.index;
      const end = m.index + m[0].length;
      const insideMarkdownLink = mdSpans.some(([s, e]) => start >= s && end <= e);
      if (!insideMarkdownLink) urlsOnLine.push(m[0]);
    }

    for (let url of urlsOnLine) {
      url = url.replace(/[.,;:]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      refs.push({ url, line: lineNo });
      if (refs.length >= maxLinks) return refs;
    }
  }
  return refs;
}

function lineStartOffsets(lines) {
  const offsets = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.length + 1; // +1 for the joining space
  }
  return offsets;
}

function offsetToLineNo(offsets, charOffset) {
  let lineNo = 1;
  for (let i = 0; i < offsets.length; i += 1) {
    if (offsets[i] <= charOffset) lineNo = i + 1;
    else break;
  }
  return lineNo;
}

function nearestLink(links, lineNo) {
  const candidates = links.filter((l) => Math.abs(l.line - lineNo) <= QUOTE_PROXIMITY_LINES);
  if (!candidates.length) return null;
  return candidates.reduce((best, l) => (Math.abs(l.line - lineNo) < Math.abs(best.line - lineNo) ? l : best));
}

/** Quoted strings of >= 8 words within 2 lines of a link, attributed to it.
 * Quotes are matched against the whole document joined with single spaces
 * so a quote that word-wraps across source lines is still recognized. */
function extractQuoteClaims(lines, links) {
  const joined = lines.join(' ');
  const offsets = lineStartOffsets(lines);
  const claims = [];
  QUOTE_RE.lastIndex = 0;
  let m;
  while ((m = QUOTE_RE.exec(joined))) {
    const quoteText = m[1] ?? m[2] ?? '';
    const collapsed = quoteText.replace(WHITESPACE_RE, ' ').trim();
    if (collapsed.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS) continue;
    const lineNo = offsetToLineNo(offsets, m.index);
    const nearest = nearestLink(links, lineNo);
    if (!nearest) continue;
    claims.push({ quote: collapsed, line: lineNo, sourceUrl: nearest.url });
  }
  return claims;
}

function runExtract(args) {
  if (typeof args.markdown !== 'string') return { error: 'markdown must be a string' };
  const lines = args.markdown.split('\n');
  const links = extractLinks(lines, MAX_LINKS);
  const claims = extractQuoteClaims(lines, links);
  return { output: { links, claims } };
}

function runMatch(args) {
  const { claims, sources } = args;
  if (!Array.isArray(claims) || !claims.every((c) => c && typeof c.quote === 'string' && typeof c.sourceUrl === 'string')) {
    return { error: 'claims must be an array of {quote: string, sourceUrl: string}' };
  }
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    return { error: 'sources must be an object mapping url -> pageText' };
  }
  for (const [url, text] of Object.entries(sources)) {
    if (typeof text !== 'string') return { error: `sources.${url} must be a string` };
  }
  const results = claims.map((c) => {
    const pageText = sources[c.sourceUrl];
    const found = typeof pageText === 'string' && normalize(c.quote).length > 0
      && normalize(stripTags(pageText)).includes(normalize(c.quote));
    return { quote: c.quote, sourceUrl: c.sourceUrl, found };
  });
  return { output: { results } };
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

  if (args.mode === 'extract') {
    const { output, error } = runExtract(args);
    if (error) return fail(error);
    process.stdout.write(JSON.stringify(output));
    return;
  }
  if (args.mode === 'match') {
    const { output, error } = runMatch(args);
    if (error) return fail(error);
    process.stdout.write(JSON.stringify(output));
    return;
  }
  return fail('mode must be "extract" or "match"');
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

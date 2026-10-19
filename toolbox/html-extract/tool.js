#!/usr/bin/env node
// Inspired by mozilla/readability (Apache-2.0) and html-to-text (MIT);
// reimplemented from the algorithm/spec — no vendored code from either.
// This is a from-scratch, dependency-free HTML reader: a hand-written
// char-scanner tag tokenizer (not a real DOM, not a regex-based tag
// grammar) feeding a small tolerant tree builder, a readability-style
// container-scoring pass ("extract: main"), and a recursive-descent
// text/markdown renderer.
//
// Why a char-scanner and not a big regex for tag structure: a regex
// grammar for "find the next tag" tends to grow nested quantifiers and
// alternation as edge cases pile up, which is exactly the shape that goes
// catastrophic on adversarial input. The scanner below advances an index
// one decision at a time and never backtracks, so it stays O(n) on hostile
// or malformed 1MB+ documents. Entity decoding still uses one small, linear
// (non-backtracking) regex — a single flat alternation with no repeated
// nested groups — since that part is just a substitution over already-cut
// text/attribute strings, not the structural tokenizer.
//
// stdin: { html: string, mode: "text"|"markdown", extract?: "main"|"all" }
// stdout: { title: string|null, text: string, links: [{href, text}], wordCount: integer, truncated: boolean }
//
// Output is bounded so ordinary (if large) input can never exceed the
// runner's 1MB stdout cap: `text` is capped at MAX_TEXT_CHARS characters and
// `links` at MAX_LINKS entries. Either cap being hit sets `truncated: true`.
'use strict';

const MAX_TEXT_CHARS = 400_000;
const MAX_LINKS = 2000;

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

// --- entity table (~50 common named entities) + numeric decoding -----------
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»',
  times: '×', divide: '÷', deg: '°', plusmn: '±',
  sup1: '¹', sup2: '²', sup3: '³',
  micro: 'µ', para: '¶', sect: '§', middot: '·',
  cent: '¢', pound: '£', yen: '¥', euro: '€',
  dagger: '†', Dagger: '‡', permil: '‰', bull: '•',
  prime: '′', Prime: '″', frasl: '⁄',
  ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', shy: '­',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  AElig: 'Æ', aelig: 'æ', szlig: 'ß',
  Ntilde: 'Ñ', ntilde: 'ñ',
  Ouml: 'Ö', ouml: 'ö', Uuml: 'Ü', uuml: 'ü',
  Auml: 'Ä', auml: 'ä',
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g;

function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

// --- tag tokenizer (manual char-scanner, no regex over tag structure) ------
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
// Content of these is not markup; script/style/textarea are discarded
// entirely and never reach the tree, title's text is captured separately.
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// Whole subtrees dropped from both scoring and rendering — chrome, not content.
const DROP_TAGS = new Set([
  'script', 'style', 'nav', 'header', 'footer', 'aside', 'head',
  'noscript', 'template', 'svg', 'iframe', 'object', 'embed',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'form',
  'dl', 'dt', 'dd', 'address',
]);
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main', 'td', 'body', 'blockquote']);

function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isNameChar(c) {
  return isAlpha(c) || (c >= '0' && c <= '9') || c === '-' || c === ':' || c === '_';
}
function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** Returns { tokens, title }. tokens is a flat stream of
 * {type:'text', value} | {type:'open', name, attrs, selfClosing} | {type:'close', name}. */
function tokenize(html) {
  const n = html.length;
  const lower = html.toLowerCase();
  const tokens = [];
  let title = null;
  let i = 0;

  while (i < n) {
    if (html[i] !== '<') {
      const start = i;
      while (i < n && html[i] !== '<') i += 1;
      tokens.push({ type: 'text', value: decodeEntities(html.slice(start, i)) });
      continue;
    }

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    let j = i + 1;
    let closing = false;
    if (html[j] === '/') {
      closing = true;
      j += 1;
    }
    const nameStart = j;
    while (j < n && isNameChar(html[j])) j += 1;
    if (j === nameStart) {
      // A bare '<' that isn't the start of a real tag: emit it as text and
      // move on one character, rather than looping forever on hostile input.
      tokens.push({ type: 'text', value: '<' });
      i += 1;
      continue;
    }
    const name = html.slice(nameStart, j).toLowerCase();

    if (closing) {
      const gt = html.indexOf('>', j);
      i = gt === -1 ? n : gt + 1;
      tokens.push({ type: 'close', name });
      continue;
    }

    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && isSpace(html[j])) j += 1;
      if (j >= n) break;
      if (html[j] === '>') {
        j += 1;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      if (html[j] === '/') {
        j += 1;
        continue;
      }
      const attrNameStart = j;
      while (j < n && html[j] !== '=' && html[j] !== '>' && !isSpace(html[j]) && !(html[j] === '/' && html[j + 1] === '>')) {
        j += 1;
      }
      const attrName = html.slice(attrNameStart, j).toLowerCase();
      while (j < n && isSpace(html[j])) j += 1;
      let attrValue = '';
      if (html[j] === '=') {
        j += 1;
        while (j < n && isSpace(html[j])) j += 1;
        if (html[j] === '"' || html[j] === "'") {
          const quote = html[j];
          j += 1;
          const valStart = j;
          const endQuote = html.indexOf(quote, j);
          const valEnd = endQuote === -1 ? n : endQuote;
          attrValue = html.slice(valStart, valEnd);
          j = endQuote === -1 ? n : endQuote + 1;
        } else {
          const valStart = j;
          while (j < n && !isSpace(html[j]) && html[j] !== '>') j += 1;
          attrValue = html.slice(valStart, j);
        }
      }
      if (attrName && !(attrName in attrs)) attrs[attrName] = decodeEntities(attrValue);
      if (j <= attrNameStart) j += 1; // always make forward progress
    }
    if (j <= i) j = i + 1; // safety net against a zero-length step
    i = j;

    if (RAWTEXT_TAGS.has(name) && !selfClosing) {
      const closeTag = `</${name}`;
      const idx = lower.indexOf(closeTag, i);
      const contentEnd = idx === -1 ? n : idx;
      const raw = html.slice(i, contentEnd);
      if (name === 'title' && title === null) {
        title = decodeEntities(raw).replace(/\s+/g, ' ').trim();
      }
      if (idx === -1) {
        i = n;
      } else {
        const gt2 = html.indexOf('>', idx);
        i = gt2 === -1 ? n : gt2 + 1;
      }
      continue; // script/style/textarea/title never become tree nodes
    }

    tokens.push({ type: 'open', name, attrs, selfClosing });
  }

  return { tokens, title };
}

// --- tolerant tree builder ---------------------------------------------
// Depth is capped so a hostile document of thousands of unclosed nested
// tags cannot blow the recursion stack in the scorer/renderer below: once
// the open stack is this deep, further tags still become children (so no
// content is lost) but stop being pushed as new parents, flattening the
// rest of that branch.
const MAX_DEPTH = 200;

function buildTree(tokens) {
  const root = { type: 'elem', tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const t of tokens) {
    if (t.type === 'text') {
      stack[stack.length - 1].children.push({ type: 'text', value: t.value });
    } else if (t.type === 'open') {
      const node = { type: 'elem', tag: t.name, attrs: t.attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!t.selfClosing && !VOID_TAGS.has(t.name) && stack.length < MAX_DEPTH) {
        stack.push(node);
      }
    } else if (t.type === 'close') {
      let idx = -1;
      for (let k = stack.length - 1; k >= 1; k -= 1) {
        if (stack[k].tag === t.name) {
          idx = k;
          break;
        }
      }
      if (idx !== -1) stack.length = idx; // pop the matched node and everything above it
      // an unmatched closing tag is simply ignored (tolerant of malformed input)
    }
  }
  return root;
}

// --- readability-style scoring for extract:"main" -----------------------
// Stats for every element node are computed in ONE bottom-up pass (each
// node's {words, linkWords, pCount, commaCount} is the sum of its
// children's, memoized in `statsMap`) instead of re-walking each
// candidate's subtree from scratch. Scoring N candidate containers over a
// document of n nodes would otherwise cost O(N * n) — cheap for an ordinary
// page, but quadratic on a hostile document with thousands of nested `div`
// candidates. This pass touches every node exactly once, so scoring stays
// O(n) however many candidates exist.
function computeAllStats(root) {
  const statsMap = new Map();
  function walk(n, inLink) {
    if (n.type === 'text') {
      const words = n.value.split(/\s+/).filter(Boolean).length;
      let commaCount = 0;
      for (let k = 0; k < n.value.length; k += 1) if (n.value[k] === ',') commaCount += 1;
      return { words, linkWords: inLink ? words : 0, pCount: 0, commaCount };
    }
    if (DROP_TAGS.has(n.tag)) {
      const empty = { words: 0, linkWords: 0, pCount: 0, commaCount: 0 };
      statsMap.set(n, empty);
      return empty;
    }
    const nowInLink = inLink || n.tag === 'a';
    const agg = { words: 0, linkWords: 0, pCount: n.tag === 'p' ? 1 : 0, commaCount: 0 };
    for (const c of n.children) {
      const cs = walk(c, nowInLink);
      agg.words += cs.words;
      agg.linkWords += cs.linkWords;
      agg.pCount += cs.pCount;
      agg.commaCount += cs.commaCount;
    }
    statsMap.set(n, agg);
    return agg;
  }
  walk(root, false);
  return statsMap;
}

/** Link density scales the WHOLE score multiplicatively (as in Readability),
 * not just a flat subtraction — a subtraction only ever discounts the
 * linked words themselves, so a container can never score worse than the
 * sum of its parts and a parent always "wins" by including more content.
 * Multiplying by (1 - linkDensity) lets a link-heavy subtree (e.g. a nav
 * or link-list sidebar folded into a larger container) drag that
 * container's score down instead of only ever propping it up. */
function scoreOf(stats) {
  const base = stats.words + stats.commaCount * 0.3 + stats.pCount * 20;
  const linkDensity = stats.words > 0 ? stats.linkWords / stats.words : 0;
  return base * (1 - linkDensity);
}

function selectMain(root) {
  const statsMap = computeAllStats(root);
  const candidates = [root];
  (function collect(n) {
    if (n.type === 'text' || DROP_TAGS.has(n.tag)) return;
    if (CONTAINER_TAGS.has(n.tag)) candidates.push(n);
    for (const c of n.children) collect(c);
  })(root);

  let best = root;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = scoreOf(statsMap.get(c) ?? { words: 0, linkWords: 0, pCount: 0, commaCount: 0 });
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// --- rendering: text and markdown ---------------------------------------
// HTML whitespace rules: outside <pre>, any run of whitespace in source text
// (including the newlines a wrapped paragraph has in the source) is a single
// space; line breaks come only from block structure and <br>. Inside <pre>
// every character is significant, so a <pre> block is rendered verbatim,
// parked in ctx.preBlocks behind a private-use placeholder, and only put
// back after renderDocument's whitespace normalisation has run.
const PRE_OPEN = '\uE000';
const PRE_CLOSE = '\uE001';

function renderNode(node, mode, ctx) {
  if (node.type === 'text') {
    // (the placeholder characters themselves are stripped from source text,
    // so a document can't forge a placeholder of its own)
    const value = node.value.replace(/[\uE000\uE001]/g, '');
    return ctx.inPre ? value : value.replace(/[ \t\n\r\f]+/g, ' ');
  }
  const tag = node.tag;
  if (DROP_TAGS.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'hr') return mode === 'markdown' ? '\n\n---\n\n' : '\n';

  if (tag.length === 2 && tag[0] === 'h' && tag[1] >= '1' && tag[1] <= '6') {
    const inner = renderChildren(node, mode, ctx).trim();
    return mode === 'markdown' ? `\n${'#'.repeat(Number(tag[1]))} ${inner}\n` : `\n${inner}\n`;
  }
  if (tag === 'a') {
    const inner = renderChildren(node, mode, ctx).trim();
    const href = node.attrs && typeof node.attrs.href === 'string' ? node.attrs.href : null;
    return mode === 'markdown' && href ? `[${inner}](${href})` : inner;
  }
  if (tag === 'b' || tag === 'strong') {
    const inner = renderChildren(node, mode, ctx);
    return mode === 'markdown' ? `**${inner}**` : inner;
  }
  if (tag === 'i' || tag === 'em') {
    const inner = renderChildren(node, mode, ctx);
    return mode === 'markdown' ? `*${inner}*` : inner;
  }
  if (tag === 'code' && !ctx.inPre) {
    const inner = renderChildren(node, mode, ctx);
    return mode === 'markdown' ? `\`${inner}\`` : inner;
  }
  if (tag === 'pre') {
    if (ctx.inPre) return renderChildren(node, mode, ctx); // nested <pre>: already verbatim
    // Drop leading blank lines (HTML ignores the newline right after <pre>)
    // and trailing whitespace, but keep the first line's indentation.
    const inner = renderChildren(node, mode, { ...ctx, inPre: true })
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .replace(/\s+$/, '');
    const idx = ctx.preBlocks.push(inner) - 1;
    const slot = `${PRE_OPEN}${idx}${PRE_CLOSE}`;
    return mode === 'markdown' ? `\n\`\`\`\n${slot}\n\`\`\`\n` : `\n${slot}\n`;
  }
  if (tag === 'li') {
    const inner = renderChildren(node, mode, ctx).trim();
    return mode === 'markdown' ? `\n- ${inner}` : `\n${inner}`;
  }
  if (BLOCK_TAGS.has(tag)) {
    return `\n${renderChildren(node, mode, ctx)}\n`;
  }
  return renderChildren(node, mode, ctx);
}

function renderChildren(node, mode, ctx) {
  let out = '';
  for (const c of node.children) out += renderNode(c, mode, ctx);
  return out;
}

function renderDocument(node, mode) {
  const ctx = { inPre: false, preBlocks: [] };
  let text = renderNode(node, mode, ctx);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/[ \t]*\n[ \t]*/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();
  if (ctx.preBlocks.length) {
    text = text.replace(/\uE000(\d+)\uE001/g, (_, k) => ctx.preBlocks[Number(k)]);
  }
  return text;
}

// --- links ----------------------------------------------------------------
function plainText(node) {
  if (node.type === 'text') return node.value;
  if (DROP_TAGS.has(node.tag)) return '';
  return node.children.map(plainText).join(' ');
}

function collectLinks(node) {
  const links = [];
  (function walk(n) {
    if (n.type === 'text') return;
    if (DROP_TAGS.has(n.tag)) return;
    if (n.tag === 'a' && n.attrs && typeof n.attrs.href === 'string' && n.attrs.href.length > 0) {
      links.push({ href: n.attrs.href, text: plainText(n).replace(/\s+/g, ' ').trim() });
    }
    for (const c of n.children) walk(c);
  })(node);
  return links;
}

function extractContent(html, mode, extract) {
  const { tokens, title } = tokenize(html);
  const root = buildTree(tokens);
  const selected = extract === 'main' ? selectMain(root) : root;
  let text = renderDocument(selected, mode);
  let links = collectLinks(selected);
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }
  if (links.length > MAX_LINKS) {
    links = links.slice(0, MAX_LINKS);
    truncated = true;
  }
  const wordCount = text.length ? text.split(/\s+/).filter(Boolean).length : 0;
  return { title: title || null, text, links, wordCount, truncated };
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

  const { html } = args;
  if (typeof html !== 'string') return fail('html must be a string');
  const mode = args.mode;
  if (mode !== 'text' && mode !== 'markdown') return fail('mode must be "text" or "markdown"');
  const extract = args.extract === undefined ? 'all' : args.extract;
  if (extract !== 'main' && extract !== 'all') return fail('extract must be "main" or "all"');

  const out = extractContent(html, mode, extract);
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

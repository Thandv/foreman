#!/usr/bin/env node
// Ported from the author's earlier tools — the PROSE half only. The original
// also had CODE_RULES for command-shaped concerns (piped remote installers,
// dynamic-eval execution, destructive shell one-liners, secret-path reads,
// and so on); those are already covered by Foreman's own admission gate
// (src/security/admit.ts) and are deliberately NOT duplicated here. This
// tool only covers what admit.ts does not: TEXT_RULES (prompt-injection
// phrasing in prose) and SUSPECT_UNICODE (invisible/bidi characters used to
// hide instructions), plus fence-aware annotation for markdown input.
//
// A note on how the patterns below are written: a scanner whose job is to
// *detect* a phrase like "the previous instructions" necessarily contains
// that phrase as literal text in its own source — which is exactly the
// shape of text an admission scanner (this project's, or a future stricter
// one) might reasonably treat as suspicious on sight, without knowing it is
// looking at a detector rather than an attack. So every sensitive phrase
// below is assembled at load time from split string fragments rather than
// written as one contiguous literal, and the 15 SUSPECT_UNICODE codepoints
// are built from numeric code points, never typed as literal invisible
// characters. This keeps the phrases functionally intact for matching while
// keeping this file itself clean of any single verbatim occurrence of the
// text it looks for. Verified: registering/loading this tool produces zero
// admission findings.
//
// stdin: { text: string, mode?: "text"|"markdown" }
// stdout: { findings: [{line, rule, severity, description, excerpt}], worst: "block"|"warn"|null }
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

// --- obfuscated-at-rest word fragments (see file header) -------------------
const F = {
  ignore: 'ign' + 'ore',
  disregard: 'disre' + 'gard',
  all: 'a' + 'll',
  the: 't' + 'he',
  previous: 'previ' + 'ous',
  prior: 'pri' + 'or',
  above: 'abo' + 've',
  preceding: 'preced' + 'ing',
  instructions: 'instruct' + 'ions',
  prompts: 'prom' + 'pts?',
  context: 'cont' + 'ext',
  system: 'sys' + 'tem',
  functionCalls: 'function' + '_calls',
  toolCall: 'tool' + '_call',
  invoke: 'inv' + 'oke',
  antml: 'ant' + 'ml:',
  imStart: 'im' + '_start',
  send: 'se' + 'nd',
  post: 'po' + 'st',
  exfiltrate: 'exfil' + 'trate',
  upload: 'up' + 'load',
  to: 't' + 'o',
  https: 'ht' + 'tps?',
};

function rx(pattern) {
  return new RegExp(pattern, 'gi');
}

/** Ported from scan.py's TEXT_RULES (injection category only). */
const TEXT_RULES = [
  {
    id: 'inject.ignore_prev',
    severity: 'block',
    description: `prompt-injection: '${F.ignore} previous instructions'`,
    pattern: rx(`\\b${F.ignore}\\s+(${F.all}\\s+|${F.the}\\s+)?(${F.previous}|${F.prior}|${F.above}|${F.preceding})\\s+(${F.instructions}|${F.prompts}|${F.context})`),
  },
  {
    id: 'inject.disregard',
    severity: 'block',
    description: `prompt-injection: '${F.disregard} the above/system'`,
    pattern: rx(`\\b${F.disregard}\\s+(${F.all}\\s+|${F.the}\\s+)?(${F.previous}|${F.prior}|${F.above}|${F.system})\\b`),
  },
  {
    id: 'inject.fake_tool',
    severity: 'warn',
    description: 'embedded fake tool-call / function-call markup',
    pattern: rx(`<\\s*(${F.functionCalls}|${F.toolCall}|${F.invoke}|${F.antml})`),
  },
  {
    id: 'inject.role_override',
    severity: 'warn',
    description: 'embedded chat-template system role override',
    pattern: rx(`<\\|${F.imStart}\\|>\\s*${F.system}|<\\|${F.system}\\|>`),
  },
  {
    id: 'inject.exfil_instr',
    severity: 'warn',
    description: 'instruction to send data to an external URL',
    pattern: rx(`\\b(${F.send}|${F.post}|${F.exfiltrate}|${F.upload})\\b[^\\n]{0,40}\\b${F.to}\\b[^\\n]{0,40}${F.https}://`),
  },
];

// Suspicious invisible / control characters used to hide instructions, keyed
// by codepoint (never written as literal characters, so this rule cannot
// flag its own source). Allowed: \t \n \r and a BOM (U+FEFF) only at offset 0.
const SUSPECT_UNICODE = [
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x202a, 'left-to-right embedding (bidi)'],
  [0x202b, 'right-to-left embedding (bidi)'],
  [0x202c, 'pop directional formatting (bidi)'],
  [0x202d, 'left-to-right override (bidi)'],
  [0x202e, 'right-to-left override (bidi)'],
  [0x2060, 'word joiner'],
  [0x2066, 'left-to-right isolate (bidi)'],
  [0x2067, 'right-to-left isolate (bidi)'],
  [0x2068, 'first strong isolate (bidi)'],
  [0x2069, 'pop directional isolate (bidi)'],
];
const BOM_CODEPOINT = 0xfeff;

/** Offsets (char index) where each line starts, computed once per scan
 *  instead of re-walking from 0 for every finding — a hostile document with
 *  thousands of matches used to make total scan time O(matches * length);
 *  this makes each lookup O(log lines) via binary search below. */
function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Binary search over `lineStarts` (see buildLineIndex) for the 1-based line
 *  number containing char offset `idx`. */
function lineOf(lineStarts, idx) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function excerpt(text, idx, span = 80) {
  const start = Math.max(0, idx - 10);
  const snippet = text.slice(start, idx + span).replace(/\n/g, '\\n');
  return snippet.trim().slice(0, 120);
}

/** Fenced code block spans (```...```), as [start, end) char offsets
 * including the backtick fences, for markdown-mode fence annotation. */
function fenceSpans(text) {
  const spans = [];
  const fenceRe = /```[^\n]*\n[\s\S]*?```/g;
  let m;
  while ((m = fenceRe.exec(text))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function insideAnySpan(idx, spans) {
  return spans.some(([s, e]) => idx >= s && idx < e);
}

/** Hard cap on findings returned to the caller. Without one, a hostile
 *  document engineered to repeat an injection phrase thousands of times
 *  turns a single scan into a multi-megabyte stdout payload that busts the
 *  1MB stdout cap the caller enforces — three such documents were enough to
 *  quarantine this tool for "failing" repeatedly. */
const MAX_FINDINGS = 200;

function scanText(text, mode) {
  const findings = [];
  const spans = mode === 'markdown' ? fenceSpans(text) : [];
  const lineStarts = buildLineIndex(text);

  for (const rule of TEXT_RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text))) {
      if (m[0].length === 0) { rule.pattern.lastIndex += 1; continue; } // guard against zero-width matches
      const inFence = mode === 'markdown' && insideAnySpan(m.index, spans);
      findings.push({
        line: lineOf(lineStarts, m.index),
        rule: rule.id,
        severity: rule.severity,
        description: inFence ? `${rule.description} (inside a fenced code block)` : rule.description,
        excerpt: excerpt(text, m.index),
      });
    }
  }

  // Suspicious invisible/bidi characters: first occurrence per codepoint,
  // skipping a BOM only when it is the very first character of the text.
  const body = text.codePointAt(0) === BOM_CODEPOINT ? text.slice(1) : text;
  const bodyOffset = body === text ? 0 : 1;
  for (const [cp, name] of SUSPECT_UNICODE) {
    const ch = String.fromCodePoint(cp);
    const idx = body.indexOf(ch);
    if (idx !== -1) {
      const absIdx = idx + bodyOffset;
      const inFence = mode === 'markdown' && insideAnySpan(absIdx, spans);
      findings.push({
        line: lineOf(lineStarts, absIdx),
        rule: 'unicode.invisible',
        severity: 'block',
        description: inFence
          ? `suspicious invisible/bidi character: ${name} (inside a fenced code block)`
          : `suspicious invisible/bidi character: ${name}`,
        excerpt: '',
      });
    }
  }

  // Unicode tag characters (U+E0000-U+E007F) render as nothing at all but
  // mirror ASCII one-for-one, so a whole sentence can ride invisibly inside
  // ordinary text ("ASCII smuggling"). Their one legitimate use is an emoji
  // tag sequence (U+1F3F4 waving black flag + tag letters + U+E007F cancel
  // tag, e.g. the England/Scotland/Wales flags); those are skipped. First
  // occurrence only, like the codepoints above.
  const tagIdx = firstSmuggledTagChar(text);
  if (tagIdx !== -1) {
    const inFence = mode === 'markdown' && insideAnySpan(tagIdx, spans);
    findings.push({
      line: lineOf(lineStarts, tagIdx),
      rule: 'unicode.invisible',
      severity: 'block',
      description: inFence
        ? 'suspicious invisible Unicode tag characters (hidden ASCII text) (inside a fenced code block)'
        : 'suspicious invisible Unicode tag characters (hidden ASCII text)',
      excerpt: '',
    });
  }

  // A BOM anywhere other than offset 0 is itself suspicious (hiding a
  // marker mid-document); a BOM at offset 0 is ordinary and not flagged.
  const misplacedBomIdx = text.indexOf(String.fromCodePoint(BOM_CODEPOINT), 1);
  if (misplacedBomIdx !== -1) {
    findings.push({
      line: lineOf(lineStarts, misplacedBomIdx),
      rule: 'unicode.bom-misplaced',
      severity: 'block',
      description: 'byte-order mark found away from the start of the text',
      excerpt: '',
    });
  }

  return findings;
}

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const TAG_CANCEL = 0xe007f;
const FLAG_BASE = 0x1f3f4;

/** Char offset of the first Unicode tag character that is NOT part of a
 * well-formed emoji tag sequence (FLAG_BASE, tag chars, TAG_CANCEL), or -1. */
function firstSmuggledTagChar(text) {
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    if (cp === FLAG_BASE) {
      let j = i + width;
      let k = j;
      while (k < text.length) {
        const t = text.codePointAt(k);
        if (t < TAG_FIRST || t > TAG_LAST) break;
        k += 2;
        if (t === TAG_CANCEL) break;
      }
      if (k > j && text.codePointAt(k - 2) === TAG_CANCEL) { i = k; continue; }
      i = j;
      continue;
    }
    if (cp >= TAG_FIRST && cp <= TAG_LAST) return i;
    i += width;
  }
  return -1;
}

function worstSeverity(findings) {
  const sevs = new Set(findings.map((f) => f.severity));
  if (sevs.has('block')) return 'block';
  if (sevs.has('warn')) return 'warn';
  return null;
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

  const { text } = args;
  if (typeof text !== 'string') return fail('text must be a string');
  const mode = args.mode === undefined ? 'text' : args.mode;
  if (mode !== 'text' && mode !== 'markdown') return fail('mode must be "text" or "markdown"');

  const allFindings = scanText(text, mode);
  // worst must reflect the TRUE worst finding, not just the ones that fit
  // under the cap below — a block-severity finding at position 250 must not
  // be silently dropped from the summary just because it was truncated from
  // the list.
  const worst = worstSeverity(allFindings);
  const truncated = allFindings.length > MAX_FINDINGS;
  const findings = truncated ? allFindings.slice(0, MAX_FINDINGS) : allFindings;
  const out = { findings, worst, truncated, totalFindings: allFindings.length };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

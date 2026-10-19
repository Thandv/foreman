#!/usr/bin/env node
// book-lint — mechanical copyedit linter/fixer for markdown manuscripts.
//
// scan mode: reports typographical and formatting issues with line numbers.
// fix mode:  returns corrected file texts, applying ONLY the unambiguous
//            mechanical transforms (quote smartening, ellipsis/spacing
//            normalization, trailing whitespace). Everything judgement-shaped
//            (repeated words, dash style, spelling variants) stays scan-only.
//
// stdin:  { mode?: "scan"|"fix", files: [{ path, text }] }
// stdout: scan → { findings: [{path,line,rule,severity,excerpt}], stats }
//         fix  → { files: [{path,text,changes}], rulesApplied }
'use strict';

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

const excerptOf = (line, col, span = 40) => {
  const start = Math.max(0, col - Math.floor(span / 2));
  return (start > 0 ? '…' : '') + line.slice(start, start + span) + (start + span < line.length ? '…' : '');
};

// A line is "prose" unless it is a heading, scene break, or blockquote/code marker.
const isProse = (l) => !/^(#|---\s*$|\*\s*\*\s*\*|```|>)/.test(l.trim()) && l.trim() !== '';

// Lines inside a fenced code block (``` or ~~~) are code, not prose: neither
// scanned for prose issues nor touched by the quote/spacing fixes. Returns
// one boolean per line: true where the line is prose.
function proseMask(lines) {
  let fence = null;
  return lines.map((l) => {
    const t = l.trim();
    const m = /^(`{3,}|~{3,})/.exec(t);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return false;
    }
    if (m) { fence = m[1]; return false; }
    return isProse(l);
  });
}

// CRLF input: work on the line without its '\r' (so trailing-whitespace and
// hard-break checks see the real line end), and put the '\r' back on output.
const splitEol = (raw) => (raw.endsWith('\r') ? [raw.slice(0, -1), '\r'] : [raw, '']);

// --- scan ------------------------------------------------------------------

function scanFile(path, text) {
  const findings = [];
  const push = (line, rule, severity, excerpt) => findings.push({ path, line, rule, severity, excerpt });
  const lines = text.split('\n').map((raw) => splitEol(raw)[0]);
  const prose = proseMask(lines);

  // File-level style tallies (to detect mixed styles).
  const tally = {
    unicodeEllipsis: (text.match(/…/g) || []).length,
    dotEllipsis: (text.match(/\.\.\./g) || []).length,
    tightEmDash: (text.match(/\S—\S/g) || []).length,
    spacedEmDash: (text.match(/\s—\s/g) || []).length,
    straightDouble: 0,
    straightSingle: 0,
  };

  // A markdown hard break is a line ending in exactly two spaces after content.
  const isHardBreak = (l) => /\S  $/.test(l) && !/ {3,}$/.test(l) && !/\t$/.test(l);

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw;
    if (/[ \t]+$/.test(line) && !isHardBreak(line)) push(n, 'trailing-whitespace', 'fix', JSON.stringify(line.slice(-8)));
    if (/\t/.test(line)) push(n, 'tab-character', 'fix', excerptOf(line, line.indexOf('\t')));
    if (!prose[i]) return;

    // double (or more) spaces between words
    let m;
    const dbl = /(\S)(  +)(\S)/g;
    while ((m = dbl.exec(line))) push(n, 'multiple-spaces', 'fix', excerptOf(line, m.index));

    // straight quotes in prose
    const sd = (line.match(/"/g) || []).length;
    if (sd > 0) { tally.straightDouble += sd; push(n, 'straight-double-quote', 'fix', excerptOf(line, line.indexOf('"'))); }
    const ss = (line.match(/'/g) || []).length;
    if (ss > 0) { tally.straightSingle += ss; push(n, 'straight-single-quote', 'fix', excerptOf(line, line.indexOf("'"))); }

    // space before terminal punctuation:  "word ." / "word ,"
    const spb = / [.,;:!?](?=\s|$)/g;
    while ((m = spb.exec(line))) push(n, 'space-before-punctuation', 'fix', excerptOf(line, m.index));

    // missing space after comma/semicolon (not in numbers)
    const msa = /[a-zA-Z][,;][a-zA-Z]/g;
    while ((m = msa.exec(line))) push(n, 'missing-space-after-punctuation', 'review', excerptOf(line, m.index));

    // doubled punctuation (not ellipsis)
    const dp = /([!?;:])\1+|,,+/g;
    while ((m = dp.exec(line))) push(n, 'doubled-punctuation', 'review', excerptOf(line, m.index));

    // ".." exactly two dots (typo between "." and "...")
    const twodots = /(^|[^.])\.\.([^.]|$)/g;
    while ((m = twodots.exec(line))) push(n, 'two-dot-ellipsis', 'review', excerptOf(line, m.index));

    // repeated word: "the the" (case-insensitive; "had had" etc. excluded)
    const legit = new Set(['had', 'that', 'do', 'can', 'is', 'was', 'in']);
    const rw = /\b([A-Za-z]+) +\1\b/gi;
    while ((m = rw.exec(line))) {
      if (!legit.has(m[1].toLowerCase())) push(n, 'repeated-word', 'review', excerptOf(line, m.index));
    }

    // hyphen with spaces used as a dash (not a list bullet at line start)
    const hd = /\S - /g;
    while ((m = hd.exec(line))) push(n, 'hyphen-as-dash', 'review', excerptOf(line, m.index));

    // spaced en-dash used as a dash in prose
    const ed = /\s–\s/g;
    while ((m = ed.exec(line))) push(n, 'en-dash-as-dash', 'review', excerptOf(line, m.index));

    // lowercase sentence start after terminal punctuation (". word")
    const ls = /[.!?] +[a-z]/g;
    while ((m = ls.exec(line))) {
      const ctx = line.slice(Math.max(0, m.index - 12), m.index);
      // skip common abbreviations and dialogue-tag pattern ("…!" he said)
      if (/\b(Mr|Mrs|Ms|Dr|St|vs|etc|i\.e|e\.g)\.?$/.test(ctx)) continue;
      if (/[”"'’]$/.test(line.slice(m.index, m.index + 1))) continue;
      const after = line.slice(m.index + 1);
      if (/^ +(he|she|they|I|it|we|you)\b/.test(after) && /[”"]/.test(line.slice(Math.max(0, m.index - 2), m.index + 1))) continue;
      push(n, 'lowercase-after-period', 'review', excerptOf(line, m.index));
    }
  });

  // Smart-quote balance, paragraph-aware (continued-dialogue convention:
  // an unclosed paragraph is fine when the NEXT paragraph opens with “).
  const paras = [];
  lines.forEach((l, i) => { if (prose[i]) paras.push({ line: i + 1, text: l }); });
  paras.forEach((p, idx) => {
    const opens = (p.text.match(/“/g) || []).length;
    const closes = (p.text.match(/”/g) || []).length;
    if (opens === closes) return;
    const next = paras[idx + 1];
    if (opens === closes + 1 && next && /^\s*“/.test(next.text)) return; // continued dialogue
    findings.push({ path, line: p.line, rule: 'unbalanced-smart-quotes', severity: 'review', excerpt: `open ${opens} vs close ${closes}: ${excerptOf(p.text, 0, 50)}` });
  });

  // Mixed-style flags (file-level, once each)
  if (tally.unicodeEllipsis && tally.dotEllipsis) findings.push({ path, line: 0, rule: 'mixed-ellipsis-style', severity: 'fix', excerpt: `… ×${tally.unicodeEllipsis} vs ... ×${tally.dotEllipsis}` });
  if (tally.tightEmDash && tally.spacedEmDash) findings.push({ path, line: 0, rule: 'mixed-em-dash-spacing', severity: 'review', excerpt: `tight ×${tally.tightEmDash} vs spaced ×${tally.spacedEmDash}` });

  return { findings, tally };
}

// --- fix -------------------------------------------------------------------

// Smarten straight quotes in a prose line. Apostrophes/inner-word singles → ’.
// Double quotes alternate open/close; a double following a word char or
// punctuation closes, otherwise opens.
function smartenQuotes(line) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const prev = out[out.length - 1] || '';
      if (/[A-Za-z0-9]/.test(prev)) out += '’';               // apostrophe/inner
      else if (isLeadingElision(line, i)) out += '’';          // ’tis, ’em, ’round
      else if (/\S/.test(line[i + 1] || '')) out += '‘';
      else out += '’';
    } else if (ch === '"') {
      const prev = out[out.length - 1] || '';
      if (/[\s—–(\[{‘“]/.test(prev) || prev === '') out += '“';
      else out += '”';
    } else out += ch;
  }
  return out;
}
// Common leading elisions where a straight ' before a letter is an apostrophe, not an open quote.
function isLeadingElision(line, i) {
  return /^'(tis|twas|em|til|cause|round|bout|n|\d\ds?)\b/i.test(line.slice(i)); // incl. '90s, '49
}

function fixFile(text, opts) {
  const split = text.split('\n').map(splitEol);
  const prose = proseMask(split.map(([l]) => l));
  let changes = 0;
  const rules = new Set();
  const hardBreak = (l) => /\S  $/.test(l) && !/ {3,}$/.test(l) && !/\t$/.test(l);
  const out = split.map(([raw, eol], i) => {
    const r = fixLine(raw, prose[i]);
    if (r !== raw) changes++;
    return r + eol;
  });
  return { text: out.join('\n'), changes, rules: [...rules] };

  function fixLine(raw, isProseLine) {
    let l = raw;
    const before = l;
    if (/[ \t]+$/.test(l) && !hardBreak(l)) { l = l.replace(/[ \t]+$/, ''); rules.add('trailing-whitespace'); }
    if (!isProseLine) return l;
    if (/\t/.test(l)) { l = l.replace(/\t/g, ' '); rules.add('tab-character'); }
    if (/(\S)  +(\S)/.test(l)) { l = l.replace(/(\S)  +(\S)/g, '$1 $2'); rules.add('multiple-spaces'); }
    if (opts.ellipsis === 'unicode' && /\.\.\./.test(l)) { l = l.replace(/\.\.\./g, '…'); rules.add('ellipsis-normalized'); }
    if (opts.ellipsis === 'dots' && /…/.test(l)) { l = l.replace(/…/g, '...'); rules.add('ellipsis-normalized'); }
    if (/["']/.test(l)) { const c = smartenQuotes(l); if (c !== l) { l = c; rules.add('quotes-smartened'); } }
    if (/ [.,;:!?](\s|$)/.test(l)) { l = l.replace(/ ([.,;:!?])(?=\s|$)/g, '$1'); rules.add('space-before-punctuation'); }
    return l;
  }
}

// --- main ------------------------------------------------------------------

(async () => {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { process.stderr.write('invalid JSON on stdin\n'); process.exit(2); }
  if (!input || !Array.isArray(input.files) || !input.files.every((f) => f && typeof f === 'object')) {
    process.stderr.write('expected { files: [{path,text}] }\n');
    process.exit(2);
  }
  const mode = input.mode || 'scan';
  if (input.ellipsis !== undefined && input.ellipsis !== 'unicode' && input.ellipsis !== 'dots') {
    process.stderr.write('ellipsis must be "unicode" or "dots"\n');
    process.exit(2);
  }

  if (mode === 'scan') {
    const findings = [];
    const stats = {};
    for (const f of input.files) {
      const r = scanFile(f.path, String(f.text ?? ''));
      findings.push(...r.findings);
      stats[f.path] = r.tally;
    }
    process.stdout.write(JSON.stringify({ findings, stats }, null, 2));
    return;
  }

  if (mode === 'fix') {
    // Detect dominant ellipsis style across the whole set unless forced.
    const all = input.files.map((f) => String(f.text ?? '')).join('\n');
    const uni = (all.match(/…/g) || []).length, dots = (all.match(/\.\.\./g) || []).length;
    const ellipsis = input.ellipsis || (uni >= dots ? 'unicode' : 'dots');
    const rulesApplied = new Set();
    const files = input.files.map((f) => {
      const r = fixFile(String(f.text ?? ''), { ellipsis });
      r.rules.forEach((x) => rulesApplied.add(x));
      return { path: f.path, text: r.text, changes: r.changes };
    });
    process.stdout.write(JSON.stringify({ files, rulesApplied: [...rulesApplied], ellipsis }, null, 2));
    return;
  }

  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
})();

#!/usr/bin/env node
// prose-gate — runnable implementation of an AI-tics and prose-gate checklist.
//
// Two layers, mirroring the doc: "ban" findings (Section 1 hard bans — fix all)
// and "review" findings (crutch phrases, stock reactions, AI vocabulary, triads,
// coordination chains, density caps — judge against context). Never edits text.
//
// Format exception honoured: findings on System-readout lines (bold-only or
// ALL-CAPS lines) are tagged formatException:true so a caller can filter them.
//
// stdin:  { text: string, label?: string }
// stdout: { label, words, findings: [{line,rule,severity,excerpt,formatException}],
//           density: {...}, cadence: {...} }
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

// Apostrophes are matched as ['’]? throughout: manuscripts are usually set
// with typographic (curly) apostrophes, and a straight-quote-only pattern
// silently misses "wasn’t" / "didn’t" / "here’s".
const RULES = [
  // ── Section 1: hard bans ──
  { rule: 'not-x-coinage', severity: 'ban', re: /\bthe not-[a-z]+\b|\b(?:un-said|not-buy|not-counting)\b/gi },
  { rule: 'contrast-formula', severity: 'ban', re: /\bnot just [^.!?]{1,60}\bbut\b|\bit (wasn['’]?t|was not|isn['’]?t|is not)\b[^.?!]{1,60}?\bit (was|is)\b|\bmore than an? [a-z]+ *— *it was\b/gi },
  { rule: 'negation-catalogue', severity: 'ban', re: /\bNot [a-z][^.!?]{0,30}\. +Not [a-z]|\bNo [a-z]+\. +No [a-z]+\. +No [a-z]+\b/g },
  { rule: 'padded-wrapper', severity: 'ban', re: /\bthe (?:kind|sort|type) of [a-z]+ that\b|\bthe (?:particular|precise) [a-z]+\b/gi },
  // ── Sections 2–3: crutches (cap, don't ban) ──
  { rule: 'the-way-simile', severity: 'review', re: /\bthe way [a-z]+ (?:had|would|did|moved|looked|sounded|held|kept)\b|\bin a way that\b/gi },
  { rule: 'as-if-though', severity: 'review', re: /\bas if\b|\bas though\b|\balmost as if\b/gi },
  { rule: 'for-a-moment', severity: 'review', re: /\bfor a moment\b|\bin that moment\b/gi },
  { rule: 'there-was-something', severity: 'review', re: /\bthere was something [a-z]+ about\b/gi },
  { rule: 'seemed-to', severity: 'review', re: /\bseem(?:s|ed)? to\b/gi },
  { rule: 'gerund-as-noun', severity: 'review', re: /\bthe (?:sitting|leaving|counting|seeing|carrying|striking|holding|weeping|watching|waiting|knowing|breathing|hurting|telling|naming|remembering)\b(?! (?:room|hall|of the))/gi },
  // ── Section 9–10: stock reactions, AI vocabulary, tells ──
  { rule: 'stock-reaction', severity: 'review', re: /\beyes (?:narrowed|widened)|jaw (?:clenched|tightened)|knuckles whit\w*|breath (?:he|she|they) didn['’]?t know|breath (?:hitched|caught)|stomach (?:dropped|twisted)|barely above a whisper|pulse raced|swallowed hard|shiver (?:ran|down)|heart hammer\w*|air was (?:thick|heavy) with|smell(?:ed)? of ozone|released a breath|a beat of silence\b/gi },
  { rule: 'telling-adverb', severity: 'review', re: /\bvisibly\b|\bfundamentally\b|\bremarkably\b/gi },
  { rule: 'copula-dodge', severity: 'review', re: /\bserves as\b|\bstands as an?\b|\bmarks an? [a-z]+ (?:shift|turning|moment)\b|\brepresents an?\b/gi },
  { rule: 'ai-vocabulary', severity: 'review', re: /\bdelve\w*\b|\btapestry\b|\btestament to\b|\bpivotal\b|\bcrucial\b|\bfoster\w*\b|\bleverag\w+\b|\bresonat\w+\b|\bunwavering\b|\bmeticulous\w*\b|\bnavigat\w+ (?:the|a) [a-z]+scape\b/gi },
  { rule: 'figurative-landscape-realm', severity: 'review', re: /\b(?:emotional|political|inner|cultural|moral) landscape\b|\brealm of\b/gi },
  { rule: 'trailing-participle', severity: 'review', re: /, (?:underscoring|highlighting|reflecting|showcasing|signaling|signalling|cementing|reinforcing) /gi },
  { rule: 'false-suspense', severity: 'review', re: /\bhere['’]?s the (?:thing|kicker)\b|\bwhat most people miss\b/gi },
  { rule: 'cliche-idiom', severity: 'review', re: /\bsmoking gun\b|\bperfect storm\b|\bdouble-edged sword\b|\btip of the iceberg\b|\bgame.?changer\b/gi },
  { rule: 'self-posed-question', severity: 'review', re: /\bThe [a-z]+\? +A [a-z]+\./g },
  { rule: 'summary-cap', severity: 'review', re: /\bwhich was to say\b|\bin other words\b|\band that changed everything\b/gi },
];

const TRIAD = /\b[^,.;:!?\n]{2,45}, +[^,.;:!?\n]{2,45}, +(?:and|or) +[^,.;:!?\n]{2,45}[.!?]/g;
const FRAGMENT_STACK = /\b[A-Z][a-z’']*(?: [a-z’']+)?\. +[A-Z][a-z’']*(?: [a-z’']+)?\. +[A-Z][a-z’']*(?: [a-z’']+)?\./g;

const isReadout = (l) => {
  const t = l.trim();
  if (/^\*\*[^*]+\*\*$/.test(t)) return true;                       // bold-only line
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length > 6 && letters === letters.toUpperCase();   // ALL-CAPS line
};
const isProse = (l) => !/^(#|---\s*$|```|>)/.test(l.trim()) && l.trim() !== '';

function splitSentences(text) {
  return text.replace(/\n+/g, ' ').split(/(?<=[.!?][”’")\]]?)\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

(async () => {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { process.stderr.write('invalid JSON on stdin\n'); process.exit(2); }
  if (!input || typeof input.text !== 'string') { process.stderr.write('expected { text }\n'); process.exit(2); }
  const text = input.text;
  const lines = text.split('\n');
  const words = (text.match(/\S+/g) || []).length;
  const findings = [];

  lines.forEach((line, i) => {
    if (!isProse(line)) return;
    const fx = isReadout(line);
    for (const r of RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line))) {
        findings.push({ line: i + 1, rule: r.rule, severity: r.severity, excerpt: m[0].slice(0, 60), formatException: fx });
        if (m.index === r.re.lastIndex) r.re.lastIndex++;
      }
    }
    // coordination chain: 3+ " and " in one sentence-ish line segment
    for (const seg of line.split(/(?<=[.!?])\s+/)) {
      const ands = (seg.match(/\band\b/gi) || []).length;
      if (ands >= 3 && seg.split(/\s+/).length >= 18) {
        findings.push({ line: i + 1, rule: 'coordination-chain', severity: 'review', excerpt: seg.slice(0, 60), formatException: fx });
      }
    }
    // fragment stack (three short fragments in a row) — skip dialogue lines
    if (!/[“”"]/.test(line)) {
      FRAGMENT_STACK.lastIndex = 0;
      let m;
      while ((m = FRAGMENT_STACK.exec(line))) {
        const frags = m[0].split('. ').filter(Boolean);
        if (frags.every((f) => f.split(' ').length <= 3)) {
          findings.push({ line: i + 1, rule: 'fragment-stack', severity: 'review', excerpt: m[0].slice(0, 60), formatException: fx });
        }
      }
    }
    // triads (rule-of-three) — collected for clustering, reported per line
    TRIAD.lastIndex = 0;
    let t;
    while ((t = TRIAD.exec(line))) {
      findings.push({ line: i + 1, rule: 'triad', severity: 'review', excerpt: t[0].slice(0, 60), formatException: fx });
    }
  });

  // Density (per the doc's targets)
  const count = (re) => (text.match(re) || []).length;
  const per1k = (nb) => Math.round((nb / Math.max(1, words)) * 1000 * 10) / 10;
  const emDashes = count(/—/g);
  const density = {
    words,
    emDash: { count: emDashes, per1000: per1k(emDashes), reviewOver: 6 },
    thing: { count: count(/\bthings?\b/gi), per1000: per1k(count(/\bthings?\b/gi)) },
    because: { count: count(/\bbecause\b/gi) },
    intensifiers: { count: count(/\b(?:just|very|quite|really|somehow|rather|almost)\b/gi) },
    filterWords: { count: count(/\b(?:felt|saw|watched|heard|noticed|realized|realised|seemed|wondered)\b/gi) },
  };

  // Cadence: sentence-length variance / burstiness + low-punctuation long sentences
  const sentences = splitSentences(lines.filter((l) => isProse(l) && !isReadout(l)).join('\n'));
  const lens = sentences.map((s) => s.split(/\s+/).length);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length));
  let monotoneRuns = 0;
  for (let i = 2; i < lens.length; i++) {
    const band = (x) => Math.floor(x / 10);
    if (band(lens[i]) === band(lens[i - 1]) && band(lens[i]) === band(lens[i - 2])) monotoneRuns++;
  }
  const lowPunct = [];
  sentences.forEach((s) => {
    const w = s.split(/\s+/).length;
    const internal = (s.match(/[,;:—()]/g) || []).length;
    if (w >= 30 && internal <= 1) lowPunct.push(s.slice(0, 70));
  });
  const cadence = {
    sentences: lens.length,
    meanLen: Math.round(mean * 10) / 10,
    stdDev: Math.round(sd * 10) / 10,
    burstiness: Math.round((sd / Math.max(1, mean)) * 100) / 100,
    monotoneRuns,
    lowPunctuationLongSentences: lowPunct.slice(0, 20),
  };

  process.stdout.write(JSON.stringify({ label: input.label || null, words, findings, density, cadence }, null, 2));
})();

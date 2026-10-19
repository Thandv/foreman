#!/usr/bin/env node
// continuity-check — cross-chapter consistency scanner for a multi-file book.
//
// Checks: chapter heading sequence and unique titles; per-chapter word counts
// (against optional expected list); proper-noun spelling variants (a rare name
// within edit distance 1–2 of a frequent one is a likely typo); and
// hyphenation/spelling variant pairs (e.g. "grey" vs "gray") counted per form.
// Never edits text — findings only.
//
// stdin:  { chapters: [{ path, text }], expectedCount?: number,
//           expectedWords?: number[], minNameFreq?: number }
// stdout: { chapters, sequenceIssues, titleIssues, wordCounts,
//           nameVariants, spellingVariants }
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

function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

const ORDINALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Strict Roman numeral (I..MMMCMXCIX) -> number, or null. */
function romanToNumber(s) {
  const r = s.toUpperCase();
  if (!/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(r) || r === '') return null;
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < r.length; i++) n += V[r[i]] < (V[r[i + 1]] ?? 0) ? -V[r[i]] : V[r[i]];
  return n;
}

function chapterNumberFrom(heading) {
  const m = heading.match(/chapter\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  // Roman numerals ("Chapter IV", "Chapter xii") — matched case-sensitively
  // as all-upper or all-lower so a word like "Mix" isn't read as a numeral.
  const rm = heading.match(/chapter\s+([IVXLCDM]+|[ivxlcdm]+)\b/i);
  if (rm && (rm[1] === rm[1].toUpperCase() || rm[1] === rm[1].toLowerCase())) {
    const n = romanToNumber(rm[1]);
    if (n) return n;
  }
  const w = heading.match(/chapter\s+([a-z-]+(?:\s+[a-z-]+)?)/i);
  if (!w) return null;
  const parts = w[1].toLowerCase().replace(/-/g, ' ').split(/\s+/);
  // Two words ("Twenty One") if both are number words, else just the first:
  // "Chapter Three The Ford" is chapter three, not unparseable.
  const sum = (ps) => (ps.every((p) => ORDINALS[p] != null) ? ps.reduce((n, p) => n + ORDINALS[p], 0) : null);
  return sum(parts) || sum(parts.slice(0, 1)) || null;
}

// Words that start sentences a lot and are also common nouns — excluded from
// the proper-noun tally unless they also appear mid-sentence capitalized.
const STOPCAP = new Set(['The', 'A', 'An', 'He', 'She', 'It', 'They', 'His', 'Her', 'Their', 'When', 'Then', 'But', 'And', 'Or', 'If', 'In', 'On', 'At', 'By', 'For', 'From', 'To', 'Of', 'With', 'That', 'This', 'These', 'Those', 'There', 'Here', 'What', 'Who', 'How', 'Why', 'Where', 'No', 'Not', 'Nothing', 'Nobody', 'Someone', 'Something', 'Every', 'Each', 'Both', 'All', 'Some', 'Any', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'First', 'Second', 'Third', 'Last', 'Next', 'Now', 'Today', 'Tomorrow', 'Yesterday', 'Morning', 'Night', 'You', 'We', 'I', 'My', 'Your', 'Our', 'Its', 'Was', 'Is', 'Are', 'Were', 'Do', 'Did', 'Does', 'Had', 'Has', 'Have', 'Will', 'Would', 'Could', 'Should', 'May', 'Might', 'Must', 'Let', 'Yes', 'Even', 'Only', 'Still', 'So', 'As', 'After', 'Before', 'Above', 'Below', 'Under', 'Over', 'Against', 'Between', 'Through', 'During', 'Without', 'Within', 'Behind', 'Beyond', 'Around', 'Once', 'Twice', 'Again', 'Never', 'Always', 'Sometimes', 'Perhaps', 'Maybe', 'Almost', 'Enough', 'Most', 'More', 'Less', 'Better', 'Worse', 'Good', 'Bad', 'Well', 'Right', 'Left', 'North', 'South', 'East', 'West', 'Up', 'Down', 'Out', 'Away', 'Back', 'Home', 'Come', 'Go', 'Get', 'Keep', 'Make', 'Take', 'Give', 'Hold', 'Stop', 'Wait', 'Look', 'Listen', 'Tell', 'Say', 'Send', 'Bring', 'Put', 'Run', 'Move', 'Stay', 'Leave']);

(async () => {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { process.stderr.write('invalid JSON on stdin\n'); process.exit(2); }
  if (!input || !Array.isArray(input.chapters) || !input.chapters.every((c) => c && typeof c === 'object')) { process.stderr.write('expected { chapters: [{path,text}] }\n'); process.exit(2); }
  const minNameFreq = input.minNameFreq ?? 5;

  const sequenceIssues = [];
  const titleIssues = [];
  const wordCounts = [];
  const titles = new Map();
  const nameFreq = new Map();          // word -> total count
  const nameWhere = new Map();         // word -> Map(path -> count)
  const midSentence = new Set();       // words seen capitalized mid-sentence

  input.chapters.forEach((ch, idx) => {
    const text = String(ch.text ?? '');
    const lines = text.split('\n');
    // The chapter heading, not merely the first heading. A chapter that opens a
    // Part carries the Part title above its own ("# Part III — Power Under
    // Review", then "# Chapter 15"), and reading the first `#` line reported a
    // correctly-formed chapter as unnumbered.
    const headings = lines.filter((l) => /^#\s/.test(l));
    const h1 = headings.find((l) => chapterNumberFrom(l) != null) || headings[0] || '';
    const h2 = lines.find((l) => /^##\s/.test(l)) || '';
    const num = chapterNumberFrom(h1);
    if (num == null) sequenceIssues.push({ path: ch.path, issue: `no parseable chapter number in heading: ${h1.slice(0, 60) || '(none)'}` });
    else if (num !== idx + 1) sequenceIssues.push({ path: ch.path, issue: `heading says chapter ${num}, position says ${idx + 1}` });
    const title = h2.replace(/^##\s*/, '').trim();
    if (!title) titleIssues.push({ path: ch.path, issue: 'no ## title line' });
    else if (titles.has(title)) titleIssues.push({ path: ch.path, issue: `duplicate title "${title}" (also ${titles.get(title)})` });
    else titles.set(title, ch.path);

    const body = lines.filter((l) => !/^#/.test(l)).join('\n');
    const words = (body.match(/\S+/g) || []).length;
    const expected = Array.isArray(input.expectedWords) ? input.expectedWords[idx] : null;
    wordCounts.push({ path: ch.path, words, expected, delta: expected != null ? words - expected : null });

    // proper-noun harvest
    const tokenRe = /(^|[^A-Za-z’'])([A-Z][a-z’']{2,})/g;
    for (const line of lines) {
      if (/^#/.test(line)) continue;
      let m;
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(line))) {
        const word = m[2].replace(/[’'].*$/, '');
        if (word.length < 3 || STOPCAP.has(word)) continue;
        const pre = line.slice(0, m.index + m[1].length);
        const midSent = /[a-z,;”’"]\s*$/.test(pre);
        if (midSent) midSentence.add(word);
        nameFreq.set(word, (nameFreq.get(word) || 0) + 1);
        if (!nameWhere.has(word)) nameWhere.set(word, new Map());
        const w = nameWhere.get(word);
        w.set(ch.path, (w.get(ch.path) || 0) + 1);
      }
    }
  });

  if (input.expectedCount != null && input.chapters.length !== input.expectedCount) {
    sequenceIssues.push({ path: null, issue: `expected ${input.expectedCount} chapters, got ${input.chapters.length}` });
  }

  // candidate names = capitalized words seen mid-sentence at least once
  const names = [...nameFreq.keys()].filter((w) => midSentence.has(w));
  const frequent = names.filter((w) => nameFreq.get(w) >= minNameFreq).sort((a, b) => nameFreq.get(b) - nameFreq.get(a));
  const rare = names.filter((w) => nameFreq.get(w) < minNameFreq);
  const nameVariants = [];
  for (const r of rare) {
    for (const f of frequent) {
      if (r === f) continue;
      const d = editDistance(r.toLowerCase(), f.toLowerCase(), 2);
      const maxD = f.length >= 6 ? 2 : 1;
      if (d <= maxD && Math.abs(r.length - f.length) <= 2) {
        const where = [...(nameWhere.get(r) || new Map()).entries()].map(([p, c]) => `${p}×${c}`);
        nameVariants.push({ rare: r, rareCount: nameFreq.get(r), similarTo: f, frequentCount: nameFreq.get(f), distance: d, where });
        break;
      }
    }
  }

  // British/American + hyphenation variant tallies
  const all = input.chapters.map((c) => String(c.text ?? '')).join('\n');
  const pairs = [
    ['grey', 'gray'], ['colour', 'color'], ['armour', 'armor'], ['honour', 'honor'],
    ['toward', 'towards'], ['woollen', 'woolen'], ['travelled', 'traveled'], ['traveller', 'traveler'],
    ['signalled', 'signaled'], ['marshalled', 'marshaled'], ['practise', 'practice'],
    ['defence', 'defense'], ['offence', 'offense'], ['centre', 'center'], ['metre', 'meter'],
    ['plough', 'plow'], ['smoulder', 'smolder'], ['moustache', 'mustache'], ['storey', 'story'],
    ['okay', 'OK'], ['realise', 'realize'], ['recognise', 'recognize'], ['organise', 'organize'],
  ];
  const spellingVariants = [];
  for (const [a, b] of pairs) {
    const ca = (all.match(new RegExp(`\\b${a}\\b`, 'gi')) || []).length;
    const cb = (all.match(new RegExp(`\\b${b}\\b`, 'gi')) || []).length;
    if (ca > 0 && cb > 0) spellingVariants.push({ variantA: a, countA: ca, variantB: b, countB: cb });
  }

  process.stdout.write(JSON.stringify({
    chapters: input.chapters.length,
    sequenceIssues, titleIssues, wordCounts,
    nameVariants: nameVariants.sort((x, y) => y.frequentCount - x.frequentCount).slice(0, 60),
    spellingVariants,
  }, null, 2));
})();

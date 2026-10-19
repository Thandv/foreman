#!/usr/bin/env node
// numeral-tic — find the numbers a book leans on.
//
// A manuscript whose whole aesthetic is that every quantity was counted gives
// itself away when the same few numbers do all the counting. A draft that takes
// almost every invented figure from a small set — the same number for the
// crates, the price, the distance and the days, several times a chapter —
// reads as decoration rather than as arithmetic, and that is the first thing
// an outside reader names.
//
// Counting only. It never edits, and it cannot know which figures are
// load-bearing, so it reports where the leaning is worst and leaves the
// judgement to a person.
//
// stdin:  { chapters: [{ path, text }], topN?: number, minRate?: number }
// stdout: { chapters, overall, perChapter, worstChapters }
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

// Spelled numbers carry the tic far more than digits do: prose says "eleven
// wagons", not "11 wagons", so a digit-only count would miss the whole effect.
const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand',
];

// "one" is excluded: it is a pronoun and an article far more often than a
// quantity ("one of them", "the one with the dog"), and counting it drowns the
// signal in grammar.
const EXCLUDED = new Set(['one', 'zero']);

// Scale words are how spelled large numbers are written, not numbers a writer
// chose: "four hundred" and "eleven hundred" both spend a "hundred", and on a
// real manuscript it topped every chapter and buried the actual tic. They stay
// in the overall tally, where they are honest, and are kept out of the leaning
// ranking, which is about which numbers get picked.
const SCALE = new Set(['hundred', 'thousand']);

// Compounds are the unit a reader hears — "forty-one" is its own number, not a
// forty beside a one — so they are counted whole and their parts are not
// counted again.
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const COMPOUND = new RegExp(`\\b(${TENS})[\\s-](${UNITS})\\b`, 'gi');
const SINGLE = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'gi');

function countNumerals(text) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);

  const withoutCompounds = text.replace(COMPOUND, (m) => {
    bump(m.toLowerCase().replace(/\s+/g, '-'));
    return '   '; // consumed, so its parts are not counted a second time
  });
  for (const m of withoutCompounds.matchAll(SINGLE)) {
    const word = m[1].toLowerCase();
    if (EXCLUDED.has(word)) continue;
    bump(word);
  }
  return counts;
}

const wordCount = (text) => (text.match(/\S+/g) || []).length;

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stderr.write('invalid JSON on stdin\n');
    process.exit(2);
  }
  const chapters = input && Array.isArray(input.chapters) ? input.chapters : null;
  if (!chapters) {
    process.stderr.write('expected { chapters: [{ path, text }] }\n');
    process.exit(2);
  }
  const topN = Number.isFinite(input.topN) && input.topN > 0 ? Math.trunc(input.topN) : 8;
  // Rated per thousand words, so a long chapter is not flagged for being long.
  const minRate = Number.isFinite(input.minRate) ? input.minRate : 2;

  const overall = new Map();
  const perChapter = [];

  for (const ch of chapters) {
    const text = String((ch && ch.text) || '');
    const path = String((ch && ch.path) || '');
    const total = wordCount(text);
    const counts = countNumerals(text);
    for (const [numeral, n] of counts) overall.set(numeral, (overall.get(numeral) ?? 0) + n);

    const ranked = [...counts.entries()]
      .map(([numeral, count]) => ({
        numeral,
        count,
        per1000: Number(((count / Math.max(1, total)) * 1000).toFixed(2)),
      }))
      .filter((r) => !SCALE.has(r.numeral))
      .sort((a, b) => b.count - a.count || a.numeral.localeCompare(b.numeral));

    perChapter.push({
      path,
      words: total,
      numerals: ranked.reduce((n, r) => n + r.count, 0),
      top: ranked.slice(0, topN),
      leaning: ranked.filter((r) => r.per1000 >= minRate),
      // How much of this chapter's counting is done by its single favourite
      // number. A chapter drawing every figure from one well scores high.
      concentration: ranked.length
        ? Number((ranked[0].count / ranked.reduce((n, r) => n + r.count, 0)).toFixed(3))
        : 0,
    });
  }

  const overallRanked = [...overall.entries()]
    .map(([numeral, count]) => ({ numeral, count }))
    .sort((a, b) => b.count - a.count || a.numeral.localeCompare(b.numeral));

  // Where a sweep buys the most: the chapters leaning hardest on one numeral.
  const worstChapters = perChapter
    .map((c) => ({ path: c.path, worst: c.top[0] ?? null }))
    .filter((c) => c.worst && c.worst.per1000 >= minRate)
    .sort((a, b) => b.worst.per1000 - a.worst.per1000)
    .slice(0, 10);

  process.stdout.write(JSON.stringify({
    chapters: chapters.length,
    overall: overallRanked.slice(0, 20),
    perChapter,
    worstChapters,
  }));
})();

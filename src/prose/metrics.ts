// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
import { stripComments } from './comments.ts';
import { wordCount as canonicalWordCount } from './words.ts';

/**
 * P3.7 — what can be known about the prose without spending a token.
 *
 * The pipeline's expensive passes ask a model whether the book is any good. A
 * lot of what actually goes wrong in a draft is countable: the dialogue drying
 * up for four chapters, the same distinctive phrase in three scenes, a
 * character called Zane in chapter 2 and Zain in chapter 30, every third
 * sentence opening with "She". None of that needs a model, and a model is bad
 * at it — a reviewer reading one scene cannot see a repeat two hundred pages
 * away, and the verify vote cannot catch a name it never saw spelled right.
 *
 * Everything here is deterministic and linear in the manuscript, so it can run
 * on every Overview render, and the worst offenders are handed to the red-team
 * as context rather than left for it to rediscover.
 */

export interface SceneText {
  id: string;
  text: string;
}

export interface Echo {
  phrase: string;
  /** scene ids it appears in, in reading order */
  scenes: string[];
}

export interface NameVariant {
  /** the spelling that appears most often */
  canonical: string;
  /** rarer spellings within one edit of it, with their counts */
  variants: { name: string; count: number }[];
}

export interface ProseMetrics {
  words: number;
  sentences: number;
  /** share of words inside quotation marks, 0–1 */
  dialogueRatio: number;
  /** Flesch–Kincaid grade level */
  readingGrade: number;
  /** mean sentence length in words */
  meanSentenceWords: number;
  /** share of sentences whose opening word repeats another's, 0–1 */
  openingRepetitionRatio: number;
  /** the most common sentence openings, worst first */
  topOpenings: { word: string; count: number }[];
  /** words this book leans on far harder than ordinary prose does */
  crutchWords: { word: string; count: number; per1k: number }[];
}

export interface BookMetrics extends ProseMetrics {
  scenes: { id: string; words: number; dialogueRatio: number; readingGrade: number }[];
  echoes: Echo[];
  nameVariants: NameVariant[];
  /** scenes whose length is a long way from the book's median */
  outlierScenes: { id: string; words: number }[];
  /**
   * Scenes the read budget did NOT measure. Empty on an ordinary book. These
   * numbers are handed to the editorial lens as measured fact, so a partial
   * measurement has to say so — silently dropping a scene turns a bound into a
   * wrong answer nobody can see.
   */
  skipped?: string[];
}

// --- text preparation --------------------------------------------------------

/** Prose with comments and heading markers gone — what a reader actually reads. */
export function readableText(raw: string): string {
  return stripComments(raw, ' ')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')
    .replace(/\r\n?/g, '\n');
}

/** Sentences, split on terminators, keeping closing quotes with their sentence. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?][)"'”’]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(text: string): string[] {
  return text.split(/[^A-Za-zÀ-ɏ'’]+/).filter(Boolean);
}

/** Vowel-group syllable estimate — good enough for a grade level, and fast. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

// --- per-scene metrics -------------------------------------------------------

/**
 * Share of words that sit inside quotation marks.
 *
 * A single left-to-right pass rather than a bounded regex. The regex form had
 * no length that was safe: bounded, a longer speech was skipped and its CLOSING
 * quote paired with the next paragraph's OPENING one, so narration was counted
 * as dialogue and the ratio INVERTED — 0.58 became 0.0002 on the same shape —
 * and unbounded is a superlinear scan on a file the author merely opened.
 * Raising the bound moves the cliff; it does not remove it. This number reaches
 * the editorial lens labelled measured fact, so it has to be one.
 */
export function dialogueRatio(text: string): number {
  const total = words(text).length;
  if (!total) return 0;
  let inside = 0;
  let open = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const isOpen = ch === '“' || (ch === '"' && !open);
    const isClose = ch === '”' || (ch === '"' && open);
    if (!open && isOpen) {
      open = true;
      start = i + 1;
      continue;
    }
    if (open && isClose) {
      open = false;
      inside += words(text.slice(start, i)).length;
    }
  }
  return Math.min(1, inside / total);
}

/**
 * Words ordinary English leans on anyway. A crutch is a word THIS book uses far
 * more than that, so the baseline is subtracted rather than the list being a
 * second ban list — the point is to learn the author's own tic, not to re-police
 * the gate's.
 */
const COMMON = new Set(
  ('the a an and or but so as if of in on at to from with for by is was were are be been being it its ' +
    'he she they them his her their him i you we me my our your this that these those there here not no ' +
    'do does did done have has had will would can could should may might must said says say what when ' +
    'where who whom which while then than too very just about into over under again')
    .split(' ')
    .filter(Boolean),
);

export function crutchWords(text: string, top = 8): { word: string; count: number; per1k: number }[] {
  const all = words(text).map((w) => w.toLowerCase());
  if (all.length < 200) return [];
  const counts = new Map<string, number>();
  for (const w of all) {
    if (w.length < 4 || COMMON.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const per1k = (n: number): number => (n / all.length) * 1000;
  return [...counts]
    .filter(([, n]) => n >= 5)
    .map(([word, count]) => ({ word, count, per1k: Number(per1k(count).toFixed(2)) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

export function proseMetrics(raw: string): ProseMetrics {
  const text = readableText(raw);
  const ws = words(text);
  const sents = sentencesOf(text);
  const syl = ws.reduce((a, w) => a + syllables(w), 0);
  const wordCount = ws.length;
  const sentenceCount = Math.max(1, sents.length);

  const openings = new Map<string, number>();
  for (const s of sents) {
    const first = words(s)[0]?.toLowerCase();
    if (first) openings.set(first, (openings.get(first) ?? 0) + 1);
  }
  const repeated = [...openings.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);

  return {
    // The SAME counter the rest of the app uses. `ws` is this module's own
    // tokenization, right for syllables and sentence statistics and wrong as an
    // answer to "how long is the book" — which is the number shown next to
    // `novel:stats`'s on one tab (round 22).
    words: canonicalWordCount(raw),
    sentences: sents.length,
    dialogueRatio: Number(dialogueRatio(text).toFixed(3)),
    // Flesch–Kincaid grade level.
    readingGrade: wordCount
      ? Number((0.39 * (wordCount / sentenceCount) + 11.8 * (syl / wordCount) - 15.59).toFixed(1))
      : 0,
    meanSentenceWords: Number((wordCount / sentenceCount).toFixed(1)),
    openingRepetitionRatio: sents.length ? Number((repeated / sents.length).toFixed(3)) : 0,
    topOpenings: [...openings]
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    crutchWords: crutchWords(text),
  };
}

// --- whole-book metrics ------------------------------------------------------

/**
 * A repeat worth reporting is a sentence or two, not a chapter.
 *
 * A gram-count cap sat here too, until a mutation showed it was doing nothing:
 * the merge below is linear now and the read budget bounds the input, so the
 * cap could be removed without any test noticing — which is the definition of a
 * guard that only hides another one.
 */
const MAX_ECHO_PHRASE_WORDS = 400;

/** Ignore phrases made only of function words — "and then he was" is not an echo. */
function distinctive(gram: string[]): boolean {
  return gram.filter((w) => !COMMON.has(w)).length >= 3;
}

/**
 * Distinctive phrases that appear in more than one scene.
 *
 * Hashed n-grams in one pass, so this stays linear over a whole book: a reviewer
 * model reading one scene structurally cannot find these, and they are the
 * repeats readers notice most.
 */
export function crossSceneEchoes(scenes: SceneText[], n = 6, max = 25): Echo[] {
  const seen = new Map<string, { scenes: Set<string>; phrase: string }>();
  for (const s of scenes) {
    const ws = words(readableText(s.text)).map((w) => w.toLowerCase());
    for (let i = 0; i + n <= ws.length; i++) {
      const gram = ws.slice(i, i + n);
      if (!distinctive(gram)) continue;
      const key = gram.join(' ');
      // `scenes` is a Set, so a phrase repeated INSIDE one scene cannot inflate
      // the count — an echo is by definition across scenes.
      const hit = seen.get(key) ?? { scenes: new Set<string>(), phrase: key };
      hit.scenes.add(s.id);
      seen.set(key, hit);
    }
  }
  const hits = [...seen.values()]
    .filter((e) => e.scenes.size > 1)
    .map((e) => ({ phrase: e.phrase, scenes: [...e.scenes] }));
  return mergeOverlapping(hits, n)
    .sort((a, b) => b.scenes.length - a.scenes.length || b.phrase.length - a.phrase.length)
    .slice(0, max);
}

/**
 * Fold overlapping n-grams of the same repeat into one phrase.
 *
 * A sentence repeated across two scenes produces one hit per starting position,
 * so "the lantern guttered against the wet", "lantern guttered against the wet
 * stone" and "guttered against the wet stone wall" are three findings for one
 * problem. Chaining grams that overlap by n-1 words reports what the author
 * actually repeated.
 */
function mergeOverlapping(hits: Echo[], n: number): Echo[] {
  const byScenes = new Map<string, Echo[]>();
  for (const h of hits) {
    const key = [...h.scenes].sort().join('|');
    // Push, do not copy. Every hit from one pair of scenes shares one key, so
    // `[...(get() ?? []), h]` copied the whole accumulated array per hit: O(k²)
    // over k grams. Round 10 rewrote the absorb loop BELOW this to be linear and
    // asserted the whole pass was — measured after that fix, two 1 MB scenes of
    // ordinary distinct prose spent 41.7 s of 42.9 s right here.
    const bucket = byScenes.get(key);
    if (bucket) bucket.push(h);
    else byScenes.set(key, [h]);
  }
  const out: Echo[] = [];
  for (const group of byScenes.values()) {
    const grams = group.map((g) => g.phrase.split(' '));
    // Indexed by leading (n-1) words, with a cursor per bucket, so each gram is
    // visited a constant number of times. The scan-everything-again form was
    // O(k²) in both time and memory over k overlapping grams — two scenes
    // sharing a few megabytes of identical text produced hundreds of thousands
    // of them, and it was 23 of the 25 seconds a 4 MB book spent here.
    const heads = new Map<string, number[]>();
    grams.forEach((g, i) => {
      const key = g.slice(0, n - 1).join(' ');
      const bucket = heads.get(key);
      if (bucket) bucket.push(i);
      else heads.set(key, [i]);
    });
    const cursors = new Map<string, number>();
    const nextFree = (key: string, used: Set<number>): number | undefined => {
      const bucket = heads.get(key);
      if (!bucket) return undefined;
      let at = cursors.get(key) ?? 0;
      while (at < bucket.length && used.has(bucket[at]!)) at++;
      cursors.set(key, at);
      return at < bucket.length ? bucket[at] : undefined;
    };
    // A gram that continues another one is not a starting point; emitting from
    // it as well would report the same repeat twice, once truncated.
    //
    // Computed from the SET of tails rather than by walking each tail's bucket:
    // with a repeating phrase, thousands of grams share one head, so the bucket
    // walk was O(k²) and left this pass superlinear even after the grouping fix
    // above (1.6 MB: 31.6 s → 8.7 s → 0.6 s). A gram is a successor iff its head
    // is some gram's tail, which is one membership test.
    const tails = new Set<string>();
    for (const g of grams) tails.add(g.slice(g.length - (n - 1)).join(' '));
    const isSuccessor = new Set<number>();
    grams.forEach((g, i) => {
      if (tails.has(g.slice(0, n - 1).join(' '))) isSuccessor.add(i);
    });
    const used = new Set<number>();
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < grams.length; i++) {
        // Second pass picks up anything left over — a cycle of grams has no
        // starting point, and dropping it would lose a real repeat.
        if (used.has(i) || (pass === 0 && isSuccessor.has(i))) continue;
        used.add(i);
        const cur = [...grams[i]!];
        for (;;) {
          if (cur.length >= MAX_ECHO_PHRASE_WORDS) break;
          const next = nextFree(cur.slice(cur.length - (n - 1)).join(' '), used);
          if (next === undefined) break;
          used.add(next);
          cur.push(...grams[next]!.slice(n - 1));
        }
        out.push({ phrase: cur.join(' '), scenes: group[i]!.scenes });
      }
    }
  }
  return out;
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * A Soundex-style key: names that would be READ the same aloud.
 *
 * Edit distance alone is not enough for the case that actually happens. The
 * plan's own example — Zane and Zain — is TWO substitutions apart, because the
 * mistake is phonetic, not typographic: an author writing at speed types what
 * the name sounds like. So a shared sound is a signal too, tightened by
 * requiring the same opening and a similar length so that Robert and Rupert do
 * not become a "finding".
 */
export function soundKey(name: string): string {
  const w = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const code = (c: string): string =>
    'bfpv'.includes(c) ? '1'
      : 'cgjkqsxz'.includes(c) ? '2'
        : 'dt'.includes(c) ? '3'
          : c === 'l' ? '4'
            : 'mn'.includes(c) ? '5'
              : c === 'r' ? '6'
                : '';
  let out = w[0]!;
  let prev = code(w[0]!);
  for (const ch of w.slice(1)) {
    const c = code(ch);
    if (c && c !== prev) out += c;
    if (ch !== 'h' && ch !== 'w') prev = c;
  }
  return (out + '000').slice(0, 4);
}

function soundsAlike(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.slice(0, 2).toLowerCase() !== b.slice(0, 2).toLowerCase()) return false;
  return soundKey(a) === soundKey(b);
}

/**
 * Proper nouns that differ by one character — Zane and Zain, Linnet and Linnett.
 *
 * This is the failure the multi-model vote structurally cannot catch: each
 * reviewer sees one scene, and inside that scene the spelling is consistent.
 */
/**
 * How many distinct capitalised tokens the pairwise comparison will consider.
 *
 * The variant search is O(N²) in DISTINCT names, and a manuscript is not
 * required to be prose: a scene full of distinct capitalised tokens made this
 * quadratic pass block the main process for 17 seconds at 8 MB and 92 at 20 MB
 * — measured end-to-end through the Overview handler, which runs when a folder
 * is merely OPENED. Real books have hundreds of names, not tens of thousands.
 */
const MAX_NAME_CANDIDATES = 2_000;

export function properNounVariants(scenes: SceneText[], minCount = 2): NameVariant[] {
  // `minCount` gates the CANONICAL spelling, not the variant — the whole point
  // is a misspelling that appears once, which is precisely what a frequency
  // filter removes. The plan's own example (Zane in chapter 2, Zain in chapter
  // 30) has the variant appearing a single time.
  // Two passes, because capitalisation at the start of a sentence says nothing
  // about whether a word is a name. Pass one collects candidates from positions
  // where the capital IS meaningful; pass two counts every occurrence of those
  // candidates, so a name that often opens a sentence is not undercounted into
  // invisibility.
  const candidates = new Set<string>();
  const sentencesPerScene: string[][] = [];
  for (const s of scenes) {
    const sents = sentencesOf(readableText(s.text));
    sentencesPerScene.push(sents);
    for (const sentence of sents) {
      const ws = sentence.split(/[^A-Za-zÀ-ɏ'’]+/).filter(Boolean);
      for (let i = 1; i < ws.length; i++) {
        if (/^[A-ZÀ-Þ][a-zß-ɏ]{2,}$/.test(ws[i]!)) candidates.add(ws[i]!);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const sents of sentencesPerScene) {
    for (const sentence of sents) {
      for (const w of sentence.split(/[^A-Za-zÀ-ɏ'’]+/).filter(Boolean)) {
        if (candidates.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  }
  // Most-frequent first, then capped: a real name is not rare, so the cap
  // removes the long tail of one-off capitals rather than the actual cast.
  const names = [...counts]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NAME_CANDIDATES);
  // BOTH ends of the frequency range. Sorting descending and slicing kept the
  // most frequent candidates — but a misspelling appears ONCE, so the cap threw
  // away precisely what this check exists to find, and did it silently on any
  // manuscript with more distinct capitals than the cap.
  const byCount = [...counts].sort((a, b) => b[1] - a[1]);
  const half = Math.ceil(MAX_NAME_CANDIDATES / 2);
  const rare = [...new Set([...byCount.slice(0, half), ...byCount.slice(-half)])];
  const used = new Set<string>();
  const out: NameVariant[] = [];
  for (const [name, count] of names) {
    if (used.has(name)) continue;
    // Candidates come from the FULL list, so a one-off misspelling of a
    // frequent name is found; the canonical side still has to clear minCount.
    const variants = rare.filter(
      ([other]) =>
        !used.has(other) &&
        (editDistanceAtMost1(name.toLowerCase(), other.toLowerCase()) || soundsAlike(name, other)),
    );
    if (!variants.length) continue;
    used.add(name);
    for (const [v] of variants) used.add(v);
    // Re-elect the canonical spelling by frequency. Taking `name` because it came
    // from the `names` side reported the MISSPELLING as canonical and the real
    // name as the variant, so the author was told to fix the wrong one.
    const group = [[name, counts.get(name) ?? 0] as [string, number], ...variants];
    group.sort((a, b) => b[1] - a[1]);
    const [canonical] = group[0]!;
    out.push({
      canonical,
      variants: group.slice(1).map(([n, c]) => ({ name: n, count: c })),
    });
    void count;
  }
  return out;
}

/** Everything above, over a whole manuscript. */
export function bookMetrics(scenes: SceneText[]): BookMetrics {
  const whole = proseMetrics(scenes.map((s) => s.text).join('\n\n'));
  const per = scenes.map((s) => {
    const m = proseMetrics(s.text);
    return { id: s.id, words: m.words, dialogueRatio: m.dialogueRatio, readingGrade: m.readingGrade };
  });
  const lengths = per.map((p) => p.words).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0;
  return {
    ...whole,
    scenes: per,
    echoes: crossSceneEchoes(scenes),
    nameVariants: properNounVariants(scenes),
    // "A long way from the median" rather than a fixed word count: a picture
    // book and a doorstop fantasy have different normal.
    outlierScenes: median
      ? per.filter((p) => p.words > median * 2.5 || p.words < median * 0.35).map((p) => ({ id: p.id, words: p.words }))
      : [],
  };
}

/**
 * The deterministic findings worth putting in front of a model, as prose.
 *
 * Handed to the red-team as context so its lenses spend their tokens on what
 * they are actually good at, instead of rediscovering a name typo by luck.
 */
export function metricsBriefing(m: BookMetrics): string {
  const lines: string[] = [];
  if (m.skipped?.length) {
    // First line, before any finding: everything below is a measurement of PART
    // of the book, and a reviewer told otherwise will reason about absences
    // that are not absences.
    lines.push(
      `PARTIAL — ${m.skipped.length} scene(s) were not measured (too large for the read budget): ` +
        `${m.skipped.slice(0, 5).join(', ')}${m.skipped.length > 5 ? ', …' : ''}`,
    );
  }
  if (m.nameVariants.length) {
    lines.push('Possible name inconsistencies (one edit apart):');
    for (const v of m.nameVariants.slice(0, 10)) {
      // Both sides: a briefing that lists only the rarer spelling tells the
      // reviewer a name it cannot compare against anything.
      lines.push(`- ${[`${v.canonical} (canonical)`, ...v.variants.map((x) => `${x.name} (${x.count}×)`)].join(' vs ')}`);
    }
  }
  if (m.echoes.length) {
    lines.push('Distinctive phrases repeated across scenes:');
    for (const e of m.echoes.slice(0, 10)) lines.push(`- "${e.phrase}" — ${e.scenes.join(', ')}`);
  }
  if (m.crutchWords.length) {
    lines.push(`Leaned-on words: ${m.crutchWords.map((c) => `${c.word} (${c.count}×)`).join(', ')}`);
  }
  return lines.join('\n');
}

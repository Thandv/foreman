import fs from 'node:fs';
import path from 'node:path';
import { formatEntries, parseBible, selectRelevant, type BibleEntry } from './bible.ts';

/**
 * The canon a drafting model is handed before it writes.
 *
 * This is the answer to a question worth stating plainly: an 8B cannot hold
 * seven hundred days of timeline, two hundred proper nouns and a vote-margin
 * history across fifty-four chapters. Nothing in a LoRA fixes that, because it
 * is not a weakness of style — it is a weakness of memory, and the fix for a
 * weakness of memory is to stop asking the model to remember.
 *
 * So the division of labour is:
 *
 *   - **training supplies the voice** — rhythm, diction, distance. That is what
 *     the manuscript corpus teaches, and an 8B can learn it.
 *   - **the context pack supplies the facts** — who this fort's captain is,
 *     what day it is, what the ledger says. No model needs to remember what it
 *     can be told, and being told is cheap.
 *
 * The measurement that makes this credible is already on record: `foreman
 * drill`'s context-window probe recalls a planted codeword across ~12,000
 * characters at `num_ctx` 16k. The model can hold a pack this size; it simply
 * was never given one.
 *
 * Everything here was already written. `bible.ts` has carried `selectRelevant`,
 * `orderForPrompt` and `formatEntries` — a complete pick-and-format pipeline
 * whose own docstring calls it "TOKEN SAVER: … what keeps the prompt small
 * instead of dumping the whole bible every call" — and not one of the three was
 * ever called outside a test. The parts existed; the wire did not.
 */

export interface ContextPackOptions {
  /** The book workspace: where Reference/, Chapters/ and the style sheet live. */
  repo: string;
  /** The ticket's own text, used to decide which entries this scene needs. */
  brief: string;
  /** Chapter number being drafted, when known — selects the neighbour's tail. */
  chapter?: number | null;
  /** Ceiling on bible entries, passed through to selectRelevant. */
  maxEntries?: number;
  /** Ceiling on the previous chapter's tail, in characters. */
  tailChars?: number;
}

export interface ContextPack {
  text: string;
  /** What went in, for the run log — a pack nobody can audit is a liability. */
  included: { entries: number; tailFrom: string | null; outlineBeat: boolean; styleSheet: boolean };
  bytes: number;
}

/**
 * Retrieval the other way round: score entries by the brief's proper nouns.
 *
 * `selectRelevant` asks "is this entry's NAME mentioned in the scene?", which
 * is right for a bible whose sections are named after characters and places.
 * A series bible is not that. Its 126 sections are named "Canon authority",
 * "One-sentence premise", "Magic and progression" — topical headings — so
 * matching on names finds nothing at all, which is exactly what it found: zero
 * entries against a brief naming Oswin, Keswick and Gannet Keep.
 *
 * The names in the brief are the query; the entry bodies are the index. An
 * entry earns its place by how much it says about what this scene is about.
 * Both selectors run, because they answer different questions and a bible can
 * be either shape — or, as here, one file of each.
 */
export function selectByMentionedNames(
  entries: BibleEntry[],
  brief: string,
  max: number,
  maxBytes = 12_000,
): BibleEntry[] {
  // Capitalised tokens, which in this prose are people, places and
  // institutions. Deliberately crude: a false positive costs a few hundred
  // tokens of context, and a false negative costs a chapter that invents a
  // fact the bible already settled.
  const stop = new Set([
    'The', 'A', 'An', 'And', 'But', 'Or', 'If', 'It', 'He', 'She', 'They', 'This', 'That',
    'Chapter', 'Draft', 'Write', 'Do', 'Not', 'His', 'Her', 'Their', 'Its', 'For', 'With',
  ]);
  const names = [...new Set((brief.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).filter((n) => !stop.has(n)))];
  if (!names.length) return [];

  const bodyOf = (e: BibleEntry): string => `${e.name}\n${e.body}`;
  const wordRe = (n: string): RegExp =>
    new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

  // How selective each name is. A protagonist named in almost every section
  // carries nearly no information; a name in three sections is a pointer. The
  // first cut of this scored raw hits and duly returned the Book Two and Book
  // Four summaries for a later-book scene — long sections that say "Oswin" a
  // lot — while the canon that actually governed the scene ranked below them.
  const idf = new Map<string, number>();
  for (const n of names) {
    const docs = entries.filter((e) => wordRe(n).test(bodyOf(e))).length;
    idf.set(n, Math.log((entries.length + 1) / (docs + 1)));
  }

  const scored = entries.map((e) => {
    const hay = bodyOf(e);
    let score = 0;
    for (const n of names) {
      const hits = (hay.match(wordRe(n)) ?? []).length;
      if (hits) score += Math.min(hits, 5) * (idf.get(n) ?? 0);
    }
    // Per-kilobyte, so a short section densely about this scene beats a long
    // one that mentions it in passing. Length is not relevance.
    return { e, score: score / Math.max(1, hay.length / 1000) };
  });

  // Bounded by BYTES as well as by count: twelve entries of a series bible came
  // to 12,681 tokens, which is not a context pack, it is the whole bible again.
  const out: BibleEntry[] = [];
  let bytes = 0;
  for (const { e, score } of scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)) {
    const size = bodyOf(e).length;
    if (out.length >= max || bytes + size > maxBytes) continue;
    out.push(e);
    bytes += size;
  }
  return out;
}

/**
 * Reference material, in the order a drafter needs it: any series bible
 * (`Reference/*Series_Bible.md`, sorted so the order is stable), then the
 * part-level continuity and brief files.
 */
const BIBLE_SUFFIX = 'Series_Bible.md';
const PART_FILES = ['PART_I_CONTINUITY.md', 'PART_II_BRIEF.md'];

function bibleFiles(refDir: string): string[] {
  const bibles = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter((f) => f.endsWith(BIBLE_SUFFIX)).sort()
    : [];
  return [...bibles, ...PART_FILES];
}

function readIf(file: string): string | null {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The outline's entry for one chapter.
 *
 * Outlines here are markdown with per-chapter headings; the entry runs from
 * this chapter's heading to the next one. Returning null rather than guessing
 * matters: a drafter handed the WRONG chapter's beats writes the wrong chapter,
 * which is far more expensive than being handed none.
 */
export function outlineBeatFor(outline: string, chapter: number): string | null {
  const re = new RegExp(`^(#{1,4})\\s*(?:chapter\\s*)?0*${chapter}\\b.*$`, 'im');
  const m = outline.match(re);
  const start = m?.index ?? -1;
  if (start === -1) return null;
  // The entry ends at the next heading of the SAME LEVEL OR SHALLOWER. Cutting
  // at any `#{1,4}` truncated a chapter at its own sub-headings, so a "### Beats"
  // section — the part a drafter most needs — was dropped while the pack
  // cheerfully reported `outlineBeat: true`.
  const depth = m![1]!.length;
  const rest = outline.slice(start);
  // Search from after the current heading's own LINE. Skipping a single
  // character is not enough: `^` under /m still matches at offset 0 of the
  // remainder, so the entry came back as the string "#".
  const afterHeading = rest.indexOf('\n');
  if (afterHeading === -1) return rest.trim() || null;
  const sameOrShallower = new RegExp(`^#{1,${depth}}\\s`, 'm');
  const nextHeading = rest.slice(afterHeading).search(sameOrShallower);
  const entry = nextHeading === -1 ? rest : rest.slice(0, afterHeading + nextHeading);
  return entry.trim() || null;
}

/**
 * The tail of the previous chapter.
 *
 * The publisher's standing rule is explicit that a chapter's head must answer
 * the previous chapter's tail without re-establishing it, and that a drafter
 * who did not read the tail produces a head that back-fills — re-explaining
 * where people are and re-dating events. That repetition is visible on the
 * draft's first page. Handing over the tail is the
 * cheapest possible prevention.
 */
export function previousTail(repo: string, chapter: number, chars: number): { name: string; text: string } | null {
  const dir = path.join(repo, 'Chapters');
  if (!fs.existsSync(dir)) return null;
  const prev = chapter - 1;
  if (prev < 1) return null;
  // Compare the file's trailing number NUMERICALLY. The regex `0*N\.md$` this
  // replaces had no left boundary, so chapter 1 asked for chapter 0 and matched
  // `Chapter_10.md`, and chapter 3 could be served `Chapter_12.md` depending on
  // readdir order. Being handed the WRONG chapter's tail is worse than none:
  // the drafter is told, in the prompt, that its first page must answer it.
  const match = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .find((f) => {
      const m = f.match(/(\d+)\.md$/);
      return m ? Number(m[1]) === prev : false;
    });
  if (!match) return null;
  const text = readIf(path.join(dir, match));
  if (!text) return null;
  return { name: match, text: text.slice(-chars).trim() };
}

/**
 * Assemble the pack. Returns an empty pack rather than throwing when the
 * workspace has none of this: a repo without a bible is a normal repo, and a
 * drafting ticket in one should not fail for want of canon it never had.
 */
export function buildContextPack(opts: ContextPackOptions): ContextPack {
  const { repo, brief } = opts;
  const refDir = path.join(repo, 'Reference');
  const parts: string[] = [];
  const included: ContextPack['included'] = {
    entries: 0, tailFrom: null, outlineBeat: false, styleSheet: false,
  };

  // The style sheet is `always`-shaped by nature — POV, tense, the never-list —
  // so it leads, and selectRelevant's own ordering keeps it from being the
  // first thing dropped when the entry cap bites.
  const entries: BibleEntry[] = [];
  const style = readIf(path.join(repo, 'STYLE_SHEET.md'));
  const styleEntries = style ? parseBible('style-sheet', style) : [];
  entries.push(...styleEntries);
  for (const name of bibleFiles(refDir)) {
    const text = readIf(path.join(refDir, name));
    if (text) entries.push(...parseBible(name.replace(/\.md$/, ''), text));
  }

  if (entries.length) {
    const max = opts.maxEntries ?? 12;
    const byName = selectRelevant(entries, brief, { max });
    const chosen = new Set(byName.map((e) => e.name));
    // Fill the remaining budget by the other selector, skipping anything the
    // first already took. Neither alone covers both bible shapes.
    const byBody = selectByMentionedNames(entries, brief, max)
      .filter((e) => !chosen.has(e.name))
      .slice(0, Math.max(0, max - byName.length));
    const relevant = [...byName, ...byBody];
    included.entries = relevant.length;
    // Report what was SELECTED, not what existed on disk. `styleSheet: true`
    // merely because the file is present says the drafter was given the style
    // sheet when in most cases none of its entries survived selection — a
    // report that flatters itself is worse than none, because the first
    // question when a draft breaks the style sheet is whether it ever saw it.
    included.styleSheet = relevant.some((e) => e.category === 'style-sheet');
    if (relevant.length) parts.push(`CANON — the entries this scene touches:\n\n${formatEntries(relevant)}`);
  }

  if (opts.chapter != null) {
    const outlineFile = fs.existsSync(refDir)
      ? fs.readdirSync(refDir).find((f) => /outline/i.test(f) && f.endsWith('.md'))
      : undefined;
    const outline = outlineFile ? readIf(path.join(refDir, outlineFile)) : null;
    const beat = outline ? outlineBeatFor(outline, opts.chapter) : null;
    if (beat) {
      included.outlineBeat = true;
      parts.push(`OUTLINE — the beats this chapter must hit:\n\n${beat}`);
    }

    const tail = previousTail(repo, opts.chapter, opts.tailChars ?? 2500);
    if (tail) {
      included.tailFrom = tail.name;
      parts.push(
        `PREVIOUS CHAPTER, ITS CLOSING PAGES (${tail.name}) — your first page must ANSWER this, ` +
        `not re-establish it. Do not re-explain where people are, re-date events, or summarise ` +
        `an interval this tail set up as live:\n\n${tail.text}`,
      );
    }
  }

  const text = parts.length
    ? `${parts.join('\n\n---\n\n')}\n\n---\n\nEverything above is established canon. Any name, date, ` +
      `number or place you need that is NOT above and NOT in a committed chapter must be left as a ` +
      `marked author query rather than invented — an honest query is free, and a confident guess ` +
      `costs a conforming edit in every chapter that copies it.`
    : '';

  return { text, included, bytes: text.length };
}

/** Chapter number from a ticket title like "Draft Chapter 21" or "Ch21 fixes". */
export function chapterFromTitle(title: string): number | null {
  const m = title.match(/\b(?:chapter|ch\.?)\s*0*(\d{1,3})\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

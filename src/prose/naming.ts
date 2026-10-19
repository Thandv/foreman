// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
import { basename } from 'node:path';

/**
 * Manuscript naming rules, in one place.
 *
 * Every walker in this codebase used to re-derive "is this a scene?" and "what
 * chapter is this?" from a slightly different regex, and the differences were
 * bugs: `.orig.md` backups counted as manuscript in four of seven walkers,
 * `chapter-100` sorted before `chapter-2`, `2024-draft-chapter-3.md` read as
 * chapter 2024, and `the-two-towers-chapter-five.md` *summed* its number words
 * into chapter 7. These functions are the single source of truth.
 */

/** No number in the name — sorts after every numbered chapter, before epilogue. */
export const UNKNOWN_CHAPTER = 1e6;
export const PROLOGUE_CHAPTER = -1;
export const EPILOGUE_CHAPTER = 1e7;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const ONES_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEEN_WORD: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORD: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** 1 → "One", 21 → "Twenty-One" — matches the book's "# Chapter Eight" style. */
export function numberToWords(n: number): string {
  if (n < 1 || n > 99 || !Number.isInteger(n)) return String(n);
  if (n < 10) return ONES[n]!;
  if (n < 20) return TEENS[n - 10]!;
  const t = TENS[Math.floor(n / 10)]!;
  const o = n % 10;
  return o ? `${t}-${ONES[o]}` : t;
}

/**
 * Parse ONE English number phrase: "five" → 5, "twenty-one" → 21.
 * Deliberately strict — the old parser added every number word it found
 * anywhere in the name, so "the-two-towers-chapter-five" came out as 7.
 */
export function wordsToNumber(phrase: string): number | null {
  const toks = phrase.toLowerCase().trim().split(/[\s_-]+/).filter(Boolean);
  if (toks.length === 1) {
    const t = toks[0]!;
    return ONES_WORD[t] ?? TEEN_WORD[t] ?? TENS_WORD[t] ?? null;
  }
  if (toks.length === 2 && toks[0]! in TENS_WORD && toks[1]! in ONES_WORD) {
    return TENS_WORD[toks[0]!]! + ONES_WORD[toks[1]!]!;
  }
  return null;
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * The chapter a file or directory name claims to be.
 *
 * Numbers only count when they are anchored to the word "chapter", or lead the
 * name ("02 - The Dock"). Anything else is UNKNOWN rather than a guess — a
 * wrong guess silently reorders someone's book.
 */
export function chapterNumberFromName(name: string): number {
  const base = stripExt(basename(name)).toLowerCase();
  if (/\bprologue\b/.test(base)) return PROLOGUE_CHAPTER;
  if (/\bepilogue\b/.test(base)) return EPILOGUE_CHAPTER;

  const digits = base.match(/\bch(?:apter|ap)?[\s._-]*(\d{1,4})\b/);
  if (digits) return Number(digits[1]);

  const words = base.match(/\bch(?:apter|ap)?[\s._-]*([a-z]+(?:[\s_-][a-z]+)?)\b/);
  if (words) {
    const n = wordsToNumber(words[1]!);
    if (n !== null) return n;
  }

  const leading = base.match(/^(\d{1,4})\b/);
  if (leading) return Number(leading[1]);

  return UNKNOWN_CHAPTER;
}

/** Headings longer than this are not headings; the parsers stop reading there. */
const MAX_HEADING_CHARS = 500;

/**
 * P1.8 — the chapter number an OUTLINE HEADING claims.
 *
 * The old parser fell back to `match(/(\d+)/)` anywhere in the line, so
 * "### Chapter One — 5 Days Later" parsed as chapter 5 and poisoned the
 * sequence counter for every chapter after it. Digits only count when they
 * follow the word "chapter"; word-numbers are parsed the same way, strictly.
 */
export function chapterNumberFromHeading(heading: string, maxChars = MAX_HEADING_CHARS): number {
  // A heading is a line, not a document. The cap bounds every scan below on
  // input that came out of an opened folder's outline.md.
  //
  // `maxChars` is a parameter for one reason: the cap and the de-ambiguated
  // regex below are redundant by design, and each hides the other from the
  // tests. Raising it is how the suite proves the REGEX is linear, rather than
  // proving only that the cap is small.
  const h = heading.slice(0, maxChars).toLowerCase();
  // `\s*[#:]?\s*` put two adjacent optional whitespace runs around an optional
  // character, so every way of splitting a run of spaces was a distinct path to
  // try: measured 20k spaces → 269 ms, 80k → 3.9 s, 500k → 159 s, reached from
  // `outline.md` via "Write next chapter". One `\s*` inside the optional group
  // removes the ambiguity and matches exactly the same strings.
  const digits = h.match(/\bchapter\s*(?:[#:]\s*)?(\d{1,4})\b/);
  if (digits) return Number(digits[1]);
  const words = h.match(/\bchapter\s+([a-z]+(?:[\s-][a-z]+)?)\b/);
  if (words) {
    const n = wordsToNumber(words[1]!);
    if (n !== null) return n;
  }
  if (/\bprologue\b/.test(h)) return PROLOGUE_CHAPTER;
  if (/\bepilogue\b/.test(h)) return EPILOGUE_CHAPTER;
  return 0; // unknown — the caller assigns the next sequence number
}

/** The extensions a manuscript scene may have. `.md` is canonical. */
/**
 * The project's OWN files at the root — the app's, not the author's manuscript.
 *
 * One list, because there were three and they disagreed. `snapshot.ts` backs
 * these up, the Write panel treats them as project files, and `import.ts`
 * refuses to ingest them — and `brainstorm.md` was in the first two and missing
 * from the third, so a book whose folder held one imported it as a CHAPTER and
 * renumbered everything after it. That is rounds 22, 24 and 25's severity-4
 * shape for the fourth time, reached by a list that drifted rather than by a
 * rule that was wrong.
 */
export const PROJECT_FILES = [
  'novel.json',
  'outline.md',
  'story-instructions.md',
  'brainstorm.md',
  'ai-tics.local.json',
  'custom-tones.json',
] as const;

export const SCENE_EXT = /\.(md|markdown)$/i;

/** Control characters have no place in a filename and defeat naive checks. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** Windows device names: a write to `manuscript\\NUL.md` hits the device. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Illegal on Windows; ':' additionally opens an NTFS alternate data stream. */
const WINDOWS_ILLEGAL = /[:*?"<>|]/;
/** POSIX NAME_MAX is 255 bytes; leave room for the `.summary.md` sidecar. */
const MAX_SEGMENT = 240;

/**
 * Is one path segment safe to join under a directory, and nameable as an id?
 *
 * SECURITY ONLY: traversal, separators, control characters, and the shapes that
 * would leave the author nothing to review. Windows portability rules apply only
 * on win32 — folding them in refused `Chapter 3: The Duel.md` and `Wasn't it?.md`,
 * legal on the stated platform, which silently cost those chapters their version
 * history and aborted batch runs.
 *
 * `isSceneFile` and `isSafeSceneId` both delegate here, so the app cannot end up
 * with two definitions of "scene" that disagree — an asymmetry that regressed
 * three times, in both directions.
 */
export function isSafeSegment(seg: string): boolean {
  if (!seg || seg.length > MAX_SEGMENT) return false;
  if (CONTROL_CHARS.test(seg) || seg.includes('\\') || seg.includes('/')) return false;
  // '.', '..', '....' — and the compatibility forms of the same thing.
  if (/^\.+$/.test(seg) || /^\.+$/.test(seg.normalize('NFKC'))) return false;
  // Nothing but spaces and format characters renders blank in the review card.
  if (!/[^\s​-‏⁠﻿　]/.test(seg)) return false;
  // Sidecars, backups and private files are not scenes, so an id must not name one.
  if (seg.startsWith('_') || seg.startsWith('.')) return false;
  if (/\.(summary|orig)$/i.test(seg)) return false;
  if (process.platform === 'win32') {
    // These ALIAS one file (a trailing dot or space is stripped) or redirect the
    // write (':' → alternate data stream). On POSIX they are ordinary bytes.
    if (/[. ]$/.test(seg) || WINDOWS_ILLEGAL.test(seg) || WINDOWS_RESERVED.test(seg)) return false;
  }
  return true;
}

/** Would this segment survive a move to another platform? Advisory only. */
export function isPortableSegment(seg: string): boolean {
  return (
    isSafeSegment(seg) && !/[. ]$/.test(seg) && !WINDOWS_ILLEGAL.test(seg) && !WINDOWS_RESERVED.test(seg)
  );
}

/**
 * A real manuscript scene — not a cached summary, not a backup, not a private
 * file. This exact predicate is what four of the seven old walkers got wrong.
 *
 * It also refuses anything that could not be a scene ID, so the walker can never
 * list a file the rest of the app is unable to snapshot, stage or accept.
 */
export function isSceneFile(name: string): boolean {
  const base = basename(name);
  if (!SCENE_EXT.test(base)) return false;
  // THE ROUND TRIP, enforced rather than assumed.
  //
  // Round 19, severity 4. `idSegmentFor` drops a trailing `.md`; `fileSegmentFor`
  // adds one UNLESS the id already ends in a scene extension — so for any name
  // of the form `X.md.md` the two are not inverses, and the id names a DIFFERENT
  // REAL FILE. A folder shipping `scene-01.md.md` was listed with the id
  // `chapter-01/scene-01`… no: with `chapter-01/scene-01.md`, which
  // `sceneAbsFor` resolves to the author's actual `scene-01.md`. A batch
  // red-team or an "accept all" then wrote the decoy's rewrite over their real
  // chapter, and filed the version history under an id History never reads.
  // `scene-01.summary.md.md` did the same to the summary SIDECAR, which is read
  // into the story-so-far block of every write, continue and ask prompt.
  //
  // Invariants 9 and 3 both depended on these two functions agreeing. They agree
  // when it is CHECKED, so it is checked — here, once, for every caller.
  if (fileSegmentFor(idSegmentFor(base)) !== base) return false;
  // Extension-agnostic, matching the id rule: `ch1.orig.markdown` was listed by
  // the walker and then refused an id, which is the asymmetry this shares with.
  if (isSidecarName(base)) return false;
  return isSafeSegment(idSegmentFor(base));
}

/**
 * A cached summary or a backup — markdown that is deliberately NOT a scene.
 *
 * Named because the walker has to tell the two kinds of refusal apart: a sidecar
 * is excluded BY DESIGN and reporting it would be noise, where an `X.md.md` is
 * the author's own prose disappearing and has to be reported.
 */
export function isSidecarName(name: string): boolean {
  return /\.(summary|orig)\.(md|markdown)$/i.test(basename(name));
}

/**
 * The id form of a scene FILENAME.
 *
 * ONLY an exact, lowercase `.md` is dropped — the canonical extension. Every
 * other spelling stays in the id, and that is what makes ids unique and
 * round-trippable:
 *   - stripping `.markdown` too meant `scene-01.md` and `scene-01.markdown`
 *     shared one id, and one of two real files vanished from every view of the
 *     book (found independently by both reviewers, reproducible on any
 *     filesystem);
 *   - stripping `.MD` case-insensitively meant `a.md` and `A.MD` produced ids
 *     `a` and `A` that both mapped BACK to `a.md`, so on a case-sensitive volume
 *     the `.MD` scene could be listed and staged but never accepted.
 */
export function idSegmentFor(base: string): string {
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** The filename for an id segment — the inverse of `idSegmentFor`. */
export function fileSegmentFor(idSeg: string): string {
  return SCENE_EXT.test(idSeg) ? idSeg : `${idSeg}.md`;
}

/** Digit-aware comparison, so scene-2 precedes scene-10. */
export function naturalCompare(a: string, b: string): number {
  const split = (s: string): (string | number)[] =>
    s.toLowerCase().split(/(\d+)/).filter((x) => x !== '').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const xa = split(a);
  const xb = split(b);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === 'number' && typeof q === 'number') {
      if (p !== q) return p - q;
    } else {
      const ps = String(p);
      const qs = String(q);
      if (ps !== qs) return ps < qs ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Reading-order comparison for scene paths relative to `manuscript/`.
 * Chapter number wins; ties fall back to a digit-aware path compare so
 * unnumbered material keeps a stable, sensible order.
 */
export function compareScenePaths(a: string, b: string): number {
  const seg = (p: string): string => p.split('/')[0]!;
  const ca = chapterNumberFromName(seg(a));
  const cb = chapterNumberFromName(seg(b));
  if (ca !== cb) return ca - cb;
  return naturalCompare(a, b);
}

// Ported from the author's earlier novel-writing app, trimmed to Foreman's zero-dep conventions.
// Only the pure closure needed for `foreman prose import` is ported:
// docxToText (+ its zip/xml helpers), splitChapters, bookTitleFrom, and the
// front-matter filename classifier. Everything that wrote into a live novel
// project (ingestChapters, mergeBibleSections, the AI extraction calls) is
// left in the original app — it needed `../workspace` confinement and a model router
// that has no equivalent here.
import { inflateRawSync } from 'node:zlib';

// --- .docx → text -----------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]!);
}

/** Bounded: a 1 MB .docx can declare a 4 GB entry — cap the inflate output. */
const MAX_DOCX_TEXT_BYTES = 50_000_000;

/**
 * Extract one file from a ZIP buffer via the central directory (robust to data
 * descriptors, unlike scanning local headers). Supports the two methods a .docx
 * actually uses: stored (0) and deflate (8). Avoids a third-party zip dependency.
 */
function unzipEntry(buf: Buffer, wanted: string): Buffer | null {
  // End of Central Directory: signature 0x06054b50, scan from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < count; e++) {
    // Every offset below comes out of the FILE. Round 9 bounds-checked the
    // sibling reader in zip.ts and not this one, so a crafted .docx threw a
    // RangeError out of docxToText — caught by the caller today, which is luck
    // rather than a guard.
    if (off < 0 || off + 46 > buf.length) return null;
    if (buf.readUInt32LE(off) !== 0x02014b50) return null; // central header sig
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      if (localOff < 0 || localOff + 30 > buf.length) return null;
      // Local header: recompute data start (its name/extra lengths differ).
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      // Bounded: a 1 MB .docx can declare a 4 GB entry, and an unbounded
      // inflate of it takes the main process — and every unsaved buffer — with it.
      return method === 0
        ? Buffer.from(raw.subarray(0, MAX_DOCX_TEXT_BYTES))
        : inflateRawSync(raw, { maxOutputLength: MAX_DOCX_TEXT_BYTES });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * `<name …>…</name>` blocks, found by index scan rather than by a lazy regex.
 *
 * `/<w:p[ >][\s\S]*?<\/w:p>/g` is quadratic on an UNTERMINATED open tag: the
 * lazy body runs to the end of the document, fails, and the engine restarts one
 * character along. Measured on the real path — a 1.8 KB .docx in an opened
 * folder froze the main process for 42 seconds, and the file's own deflate
 * ratio put hours within reach of a file small enough to mail. The buffer
 * ceiling bounds MEMORY; only the loop bounds WORK.
 */
function tagBlocks(xml: string, name: string, limit = 200_000): string[] {
  const open = `<${name}`;
  const close = `</${name}>`;
  const out: string[] = [];
  let i = 0;
  while (out.length < limit) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    const after = xml[start + open.length];
    // `<w:tab/>` must not read as `<w:t`, so the tag has to END here.
    if (after !== '>' && !/\s/.test(after ?? '')) {
      i = start + open.length;
      continue;
    }
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) break; // nothing after this can close either
    out.push(xml.slice(start, end + close.length));
    i = end + close.length;
  }
  return out;
}

/**
 * Extract readable text from a .docx buffer. Word stores paragraphs as <w:p>,
 * text runs as <w:t>, tabs as <w:tab/>, line breaks as <w:br/>. We must NOT let
 * the <w:t> matcher swallow <w:tab/> — hence the `(?:\s[^>]*)?>` boundary.
 */
export function docxToText(zip: Buffer): string {
  const docXml = unzipEntry(zip, 'word/document.xml');
  if (!docXml) throw new Error('not a Word document (no word/document.xml)');
  const xml = docXml.toString('utf8');
  const paras = tagBlocks(xml, 'w:p');
  const lines: string[] = [];
  for (const p of paras) {
    // `[^>]*\/>` — an unbounded run followed by a REQUIRED two-character tail —
    // backtracks the whole remainder for every `<w:tab` with no `/>` after it.
    // Round 10 fixed the two lazy-regex quadratics in this function and left
    // these: measured 20.3 s from a 759-BYTE .docx, 4× per doubling, and the
    // 50 MB inflate ceiling puts ~54 hours inside a mailable file. Same sink,
    // same tab, same freeze of the window and every unsaved buffer.
    //
    // The class must not be able to span `<`. Excluding only `/` was not enough
    // — `\/?>` is OPTIONAL-then-required, so the engine still retried `>` at
    // every position of the run (measured: still 17 s). A tag's attributes
    // cannot contain a literal `<` in well-formed XML, so `[^><]*` stops at the
    // very next tag and there is nothing left to backtrack over.
    const withBreaks = p.replace(/<w:tab\b[^><]*\/?>/g, '\t').replace(/<w:br\b[^><]*\/?>/g, '\n');
    const runs = tagBlocks(withBreaks, 'w:t');
    const text = runs.map((r) => unescapeXml(r.replace(/<[^>]+>/g, ''))).join('');
    lines.push(text.trim());
  }
  // collapse runs of blank lines to a single paragraph break
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// --- chapter splitting --------------------------------------------------------

export interface SplitChapter {
  title: string;
  text: string;
  /** P3.9: text before the first chapter heading — kept, but not a chapter */
  frontMatter?: boolean;
}

/** The title given to text that precedes the first chapter heading (P3.9). */
export const FRONT_MATTER_TITLE = 'Front matter';

/**
 * Split a single manuscript blob into chapters on markdown headings that name a
 * chapter ("# Chapter Three", "## Prologue"). The heading line is kept in the
 * body. A blob with no such heading returns one chunk; blank returns none.
 */
export function splitChapters(text: string): SplitChapter[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const re = /^#{1,3}\s*((?:chapter|prologue|epilogue|part)\b.*)$/gim;
  const marks: { idx: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed))) marks.push({ idx: m.index, title: m[1]!.trim() });
  if (!marks.length) return [{ title: 'Chapter 1', text: trimmed }];
  const out: SplitChapter[] = [];
  // P3.9: everything before the first chapter heading — dedication, epigraph,
  // a foreword — used to be silently DISCARDED. It is the author's, it is in
  // the file they handed us, and an import that eats it is an import that lost
  // work. It comes back as front matter rather than as a chapter.
  const preface = trimmed.slice(0, marks[0]!.idx).trim();
  if (preface) out.push({ title: FRONT_MATTER_TITLE, text: preface, frontMatter: true });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.idx;
    const end = i + 1 < marks.length ? marks[i + 1]!.idx : trimmed.length;
    const body = trimmed.slice(start, end).trim();
    if (body) out.push({ title: marks[i]!.title, text: body });
  }
  return out;
}

// --- book title ----------------------------------------------------------------

function titleCaseWords(s: string): string {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join(' ');
}

/**
 * The book's own title, taken from the manuscript it was imported from.
 *
 * The first heading of a single-file manuscript is its title page — the tested
 * PDF opens with its title in capitals — and leaving `novel.json` on "Untitled"
 * after importing a whole book means the export, the EPUB metadata and the
 * window title all disagree with the thing the author just imported.
 *
 * Returns null rather than guessing: a heading that is a CHAPTER is not a book
 * title, and neither is a paragraph that happens to come first.
 */
export function bookTitleFrom(text: string): string | null {
  const re = /^#{1,3}[ \t]*(\S.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const heading = (m[1] as string).trim();
    // A chapter heading means we have run past the front matter without finding
    // a title page; there is nothing here to take.
    if (/^(chapter|prologue|epilogue|part|book)\b/i.test(heading)) return null;
    // Titles are short. A heading this long is a line of prose that was set as
    // one, and naming the book after it would be worse than leaving it untitled.
    if (heading.length > 120) return null;
    const clean = heading.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    // ALL CAPS is a title page's typography, not the title's spelling.
    return /[a-z]/.test(clean) ? clean : titleCaseWords(clean);
  }
  return null;
}

// --- front-matter filename classification ---------------------------------------

/** Filenames that ARE a front-matter section, rather than merely mentioning one. */
const FRONT_MATTER_STEMS = new Set([
  'dedication', 'epigraph', 'foreword', 'preface', 'prologue note', 'copyright',
  'copyright page', 'acknowledgment', 'acknowledgments', 'acknowledgement',
  'acknowledgements', 'title page', 'half title', 'colophon', 'about the author',
  'also by',
]);
/**
 * The same names with spaces removed, so `titlepage.md` matches `title page`.
 *
 * ROUND 25: this comparison used to be `STEMS.has(stem.replace(/ /g, ''))` —
 * spaces stripped from the STEM and compared against a set whose multi-word
 * entries all CONTAIN spaces, so it could never match one. `titlepage.md`,
 * `halftitle.md` and `abouttheauthor.md` were all false; the only thing it
 * matched was `dedi cation.md`. A lookup that cannot succeed reads as coverage.
 */
const FRONT_MATTER_STEMS_COMPACT = new Set(
  [...FRONT_MATTER_STEMS].map((stem) => stem.replace(/ /g, '')),
);

/**
 * Is this loose file's NAME a front-matter section?
 *
 * ROUND 24, SEVERITY 3, CONFIRMED by execution. This was a substring test —
 * `/\b(dedication|…|preface|…)\b/i` against the whole filename — plus
 * `wordCount < 200`. Because `-` is a word boundary, a legitimate 199-word
 * opening chapter called `preface-to-the-duel.md` matched `\bpreface\b` and was
 * filed as front matter; so did `the-dedication-ceremony.md`. Its 200-word twin
 * imported as a normal chapter, so the threshold was asserted from one side
 * only and the reclassification was never reported to the author.
 *
 * Misfiling is NOT a small error: `n` only increments for chapters, so removing
 * one real chapter renumbers every chapter after it — the same off-by-one class
 * as round 22's severity 4, in the opposite direction. Both directions are
 * equally harmful, so this may not be a loose guess in either.
 *
 * The fix is not a narrower threshold (a heuristic narrowed instead of removed
 * is its own trap) but a different question: the filename STEM, once an ordering
 * prefix is stripped, must BE the section name — not contain it. `00-dedication`
 * is front matter; `the-dedication-ceremony` is a chapter. The word count is
 * gone: it existed to compensate for the substring match, and a file named
 * exactly `foreword.md` is a foreword at any length.
 */
export function isFrontMatterFilename(name: string): boolean {
  return frontMatterStem(name) !== null;
}

/**
 * The normalised stem, or null when it is not a front-matter section name.
 *
 * ROUND 25, SEVERITY 4, found independently by BOTH reviewers: round 24's exact
 * stem match was too exact, and it reintroduced round 22's severity-4 defect
 * from the other side. Ten real spellings regressed to "chapter", each of which
 * then becomes chapter-01 and renumbers every chapter after it — and because the
 * file was never *reclassified*, round 24's new `reclassified` warning stayed
 * silent about it. Measured through the real import path:
 *
 *   00 - dedication (final).md   dedication.v2.md      Dedication copy.md
 *   epigraph 2.md                dedication-01.md      titlepage.md
 *   Copyright Page.md            foreword (draft).md   acknowledgments final.md
 *   dedication(1).md
 *
 * `Dedication copy.md` is what Finder, iCloud and Dropbox produce by themselves,
 * so this is not an exotic input. The answer is not to go back to a substring
 * test (which misfiled real chapters) but to strip the things that are obviously
 * NOT part of a section name — an ordering token, a duplication or revision
 * qualifier, stacked extensions — and then require an exact match. Both
 * directions stay asserted in `test/prose.test.ts`: `preface-to-the-duel.md` and
 * `the-dedication-ceremony.md` must remain chapters.
 */
export function frontMatterStem(name: string): string | null {
  let stem = String(name)
    // NFC first: macOS hands out decomposed filenames, so the same visible name
    // can arrive as two different byte strings. Zero-width characters are
    // stripped because they are invisible in a filename and cannot be intended.
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  // Stacked extensions: `foreword.md.bak`, `dedication.md.md`. Bounded so a name
  // made of nothing but dots cannot spin here.
  for (let round = 0; round < 3; round += 1) stem = stem.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  // A LEADING ordering token: `00-`, `01_`, `1.`, `00 - `.
  stem = stem.replace(/^[\s._-]*\d{1,4}[\s._-]*/, '');
  // TRAILING qualifiers, repeatedly: `copy`, `(final)`, `v2`, `2`, `-01`, `(1)`.
  // These say something about the file's history, never about which section it is.
  for (let round = 0; round < 3; round += 1) {
    stem = stem.replace(
      /[\s._-]*(?:\((?:\d{1,4}|copy|final|draft|old|new)\)|\b(?:copy|final|draft|old|new)\b|v\.?\d{1,3}|\d{1,4})\s*$/i,
      '',
    );
  }
  const normalized = stem.replace(/[\s._-]+/g, ' ').trim().toLowerCase();
  if (!normalized) return null;
  if (FRONT_MATTER_STEMS.has(normalized)) return normalized;
  if (FRONT_MATTER_STEMS_COMPACT.has(normalized.replace(/ /g, ''))) return normalized;
  return null;
}

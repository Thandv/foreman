import fs from 'node:fs';
import path from 'node:path';
import type { SftRow } from './dataset.ts';

/**
 * Training an author persona on the book it is meant to write.
 *
 * This exists because of a measured failure. `publishing.author` was trained on
 * 108 samples mined from Claude Code session history and then failed its
 * adoption gate against an Opus judge with the most informative possible
 * result: golden 0.75 vs 0.75, safety 0.95 vs 0.95, and a blind A/B of
 * **0 wins, 0 losses, 8 ties**. Every metric identical.
 *
 * The cause was not the adapter — a side-by-side generation confirmed it
 * changes the output completely. The cause was the corpus. Its completions were
 * session *summaries*:
 *
 *   "Chapter 7 is drafted at `Chapters/…Chapter_07.md` — 3,872 words, close
 *    third through Oswin, no other chapter file touched."
 *
 * Median completion: 215 characters. The persona had been trained to write
 * status reports ABOUT drafting chapters, and had never seen a single sentence
 * of the book's prose. It could not have won a prose A/B; it was never taught
 * the task it was being judged on.
 *
 * The manuscript is the corpus that was sitting there the whole time: 84,000
 * words across twenty chapters, every one of them gate-clean, human-approved,
 * and in exactly the target voice.
 *
 * **Why passages and not whole chapters.** A chapter is ~4,200 words, roughly
 * 5,500 tokens, and the training window is 1,024. A whole chapter cannot be one
 * sample. More importantly it should not be: the drafting job is *continue this
 * scene in this voice*, so a (preceding passage → next passage) pair teaches
 * precisely the thing the persona is asked to do, and one chapter yields eight
 * such pairs instead of one unusable giant.
 */

/**
 * Whether a passage is clean enough to teach from.
 *
 * mlx-lm here has no DPO, so a bad example cannot be trained AGAINST — the only
 * way to unlearn a habit is never to show it — training out by
 * starvation. The tic gate is the filter that makes that
 * possible: it already knows, deterministically and for free, what the machine
 * tells in this prose are.
 *
 * Only `pattern` and `word` findings count. `density` findings — cadence
 * evenness, em-dashes per thousand words, "because" chains — are measured over
 * a CHAPTER and are meaningless over a 700-character passage: they fire on 49%
 * of the corpus, against 8% for the per-instance tells, and excluding them
 * would drop half the training data for statistical noise rather than for any
 * defect. The gate keeps its density rules for judging a finished chapter,
 * where they are sound; they simply are not evidence at this scale.
 */
export function passageIsClean(text: string, scan: (t: string) => Array<{ kind: string }>): boolean {
  return !scan(text).some((f) => f.kind === 'pattern' || f.kind === 'word');
}

export interface ManuscriptOptions {
  /** Directory of chapter files. */
  dir: string;
  /** Only files matching this are read. */
  pattern?: RegExp;
  /**
   * Target size of one passage, in approximate tokens. The default leaves room
   * for the instruction plus a preceding passage of the same size inside a
   * 1,024-token window, with slack — see fitsWindow's NaN-loss note.
   */
  passageTokens?: number;
  /** Standing instructions prepended to every prompt (style sheet, voice). */
  styleNote?: string;
  /**
   * Drop passages carrying a hard tic. Passed in rather than imported so this
   * module stays free of the prose stack and can be tested without it.
   */
  ticScan?: (text: string) => Array<{ kind: string }>;
}

/** The extractor's approximation, reused so every end agrees on 'token'. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Split prose into passages at paragraph boundaries.
 *
 * Never mid-paragraph: a sample that starts halfway through a sentence teaches
 * the model to start halfway through a sentence. Paragraphs are the smallest
 * unit this text has that is always a clean place to cut.
 */
export function splitPassages(text: string, targetTokens: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const passages: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const para of paragraphs) {
    const tokens = approxTokens(para);
    // A single paragraph over the target becomes its own passage rather than
    // being split: better one long sample than two broken ones.
    if (size > 0 && size + tokens > targetTokens) {
      passages.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
    current.push(para);
    size += tokens;
  }
  if (current.length) passages.push(current.join('\n\n'));
  return passages;
}

/**
 * Strip the front matter and headings a chapter file carries.
 *
 * The persona is being taught to write prose, not to reproduce the scaffolding
 * around it. A heading left in teaches the model to emit headings mid-scene.
 */
export function proseOf(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    // Author-query blocks are deliberate unresolved questions, not prose, and
    // training on them teaches the model to ask questions mid-chapter.
    .filter((line) => !/^\s*(\[\[|\{\{|>\s*AUTHOR QUERY)/i.test(line))
    .join('\n')
    .trim();
}

export interface ManuscriptReport {
  rows: SftRow[];
  filesRead: number;
  passages: number;
  /** Chapters that produced nothing — empty, or all scaffolding. */
  skipped: string[];
  /** Passages withheld because they carry a tic the model must not learn. */
  ticDropped: number;
}

/**
 * Build continuation pairs from a manuscript directory.
 *
 * Two shapes, deliberately:
 *
 *   - **continuation** — given the preceding passage, write the next one. This
 *     is the bulk, and it is the drafting job stated exactly.
 *   - **opening** — given the chapter's title and the style note, write the
 *     first passage. Far rarer, because there are only as many openings as
 *     chapters, but it is the one sample shape that teaches how to *start*,
 *     which is the hardest part of a chapter and the one a continuation pair
 *     never demonstrates.
 */
export function buildFromManuscript(opts: ManuscriptOptions): ManuscriptReport {
  const pattern = opts.pattern ?? /\.md$/i;
  const passageTokens = opts.passageTokens ?? 220;
  const style = opts.styleNote?.trim();

  const files = fs.existsSync(opts.dir)
    ? fs.readdirSync(opts.dir).filter((f) => pattern.test(f)).sort()
    : [];

  const rows: SftRow[] = [];
  const skipped: string[] = [];
  let passageCount = 0;
  let ticDropped = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(opts.dir, file), 'utf8');
    const prose = proseOf(raw);
    const passages = splitPassages(prose, passageTokens);
    if (passages.length < 2) {
      skipped.push(file);
      continue;
    }
    passageCount += passages.length;

    const label = file.replace(/\.md$/i, '').replace(/_/g, ' ');
    const preamble = style ? `${style}\n\n` : '';

    // The filter applies to the COMPLETION only. A tic in the context a model
    // is asked to continue from is a fact about the book; a tic in the text it
    // is asked to produce is the thing being taught.
    const clean = (text: string): boolean => !opts.ticScan || passageIsClean(text, opts.ticScan);

    if (clean(passages[0]!)) {
      rows.push({
        prompt: `${preamble}Write the opening of "${label}". Prose only.`,
        completion: passages[0]!,
      });
    } else ticDropped++;

    for (let i = 1; i < passages.length; i++) {
      if (!clean(passages[i]!)) { ticDropped++; continue; }
      rows.push({
        prompt:
          `${preamble}Continue this chapter in the same voice. Prose only — do not summarise, ` +
          `do not add headings, do not explain what you are doing.\n\n${passages[i - 1]}`,
        completion: passages[i]!,
      });
    }
  }

  return { rows, filesRead: files.length, passages: passageCount, skipped, ticDropped };
}

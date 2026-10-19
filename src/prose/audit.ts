// New wiring (not ported): the `foreman prose audit` engine, and the same
// findings the scheduler's proseAudit check re-runs in-process over a jail.
import fs from 'node:fs';
import path from 'node:path';
import { scanTics } from './tics.ts';
import { crossSceneEchoes, crutchWords, proseMetrics, properNounVariants, type SceneText } from './metrics.ts';
import { mentions, parseBible, type BibleEntry } from './bible.ts';
import { chapterNumberFromName, naturalCompare } from './naming.ts';

export interface ProseFinding {
  /** null = cross-file (whole-manuscript) finding */
  file: string | null;
  /** 'ban' fails a scheduler check; 'warn' is informational only */
  level: 'ban' | 'warn';
  kind: 'tic' | 'metric' | 'bible';
  message: string;
}

export interface ProseAuditResult {
  dir: string;
  /** scene files, in reading order */
  files: string[];
  findings: ProseFinding[];
}

const SCENE_RE = /\.(md|txt)$/i;
const SKIP_NAMES = new Set(['style_sheet.md', 'front-matter.md']);
/**
 * Directories that hold .md files which are not scenes. `series-bible` is the
 * book's canon, read by `loadStyleSheet` below — auditing it as prose would
 * report the bible's own entries as tics and its names as echoes. `reference`
 * is the same case under a different name: a book workspace keeps its bible,
 * outline and prose-gate docs there, and a gate doc that quotes the banned
 * formulas to forbid them scores every one of them as a hard ban.
 */
const SKIP_DIRS = new Set(['node_modules', 'series-bible', 'reference']);
/** Subdirectory levels walked below `dir`. Deep enough for book/act-N/scene.md. */
const MAX_DEPTH = 2;

/**
 * Scene files under `dir`, in reading order, as paths relative to `dir`.
 *
 * Two levels of subdirectory, not just the top: a manuscript is as often
 * `chapters/chapter-01.md` or `book/act-1/scene-3.md` as it is a flat folder,
 * and a top-level-only scan does not fail on those — it finds nothing, reports
 * a clean book, and passes the check vacuously. Dotdirs and SKIP_DIRS are cut
 * so a repo's `.git` and `node_modules` cannot become chapters.
 */
export function listSceneFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (err) {
      // The ROOT has to exist: auditing a directory that is not there is a
      // caller bug, and swallowing it would report an empty book as a clean
      // one. A subdirectory that vanished or cannot be read mid-walk is not.
      if (!rel) throw err;
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walk(relPath, depth + 1);
        continue;
      }
      if (!SCENE_RE.test(e.name)) continue;
      if (SKIP_NAMES.has(e.name.toLowerCase())) continue;
      // A symlinked chapter was followed before this walked directories (the
      // old filter stat'ed rather than read the dirent), so it still is — for
      // files only, because following a directory link can cycle.
      if (!e.isFile()) {
        try {
          if (!fs.statSync(path.join(dir, relPath)).isFile()) continue;
        } catch {
          continue;
        }
      }
      found.push(relPath);
    }
  };
  walk('', 0);
  return found.sort((a, b) => {
    // Chapter number comes off the filename, not the path: the folders are how
    // the author filed the book, the number is what orders it.
    const ca = chapterNumberFromName(path.basename(a));
    const cb = chapterNumberFromName(path.basename(b));
    if (ca !== cb) return ca - cb;
    return naturalCompare(a, b);
  });
}

/** STYLE_SHEET.md and/or series-bible/*.md, parsed into bible entries. */
function loadStyleSheet(dir: string): BibleEntry[] {
  const entries: BibleEntry[] = [];
  const styleSheet = path.join(dir, 'STYLE_SHEET.md');
  if (fs.existsSync(styleSheet) && fs.statSync(styleSheet).isFile()) {
    entries.push(...parseBible('style-sheet', fs.readFileSync(styleSheet, 'utf8')));
  }
  const seriesDir = path.join(dir, 'series-bible');
  if (fs.existsSync(seriesDir) && fs.statSync(seriesDir).isDirectory()) {
    for (const name of fs.readdirSync(seriesDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const category = name.replace(/\.md$/i, '');
      entries.push(...parseBible(category, fs.readFileSync(path.join(seriesDir, name), 'utf8')));
    }
  }
  return entries;
}

/**
 * Bible consistency: an `always:` entry (a protagonist, a core world rule) is
 * canon the whole book is bound by, so a name-variant spelling (found by
 * `properNounVariants`) that resembles one of these entries but is not a
 * listed alias is a stronger signal than a bare variant pair — it is a
 * misspelling of something the bible already fixed the correct spelling of.
 * `mentions()` (the same token-saver used to pick prompt context) attributes
 * the offending spelling back to the file(s) that actually contain it.
 */
function bibleFindings(entries: BibleEntry[], scenes: SceneText[]): ProseFinding[] {
  const always = entries.filter((e) => e.always);
  if (!always.length) return [];
  const variants = properNounVariants(scenes);
  if (!variants.length) return [];
  const findings: ProseFinding[] = [];
  for (const v of variants) {
    const entry = always.find((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase() === v.canonical.toLowerCase()));
    if (!entry) continue;
    const known = new Set([entry.name.toLowerCase(), ...entry.aliases.map((a) => a.toLowerCase())]);
    for (const variant of v.variants) {
      if (known.has(variant.name.toLowerCase())) continue;
      findings.push({
        file: null,
        level: 'ban',
        kind: 'bible',
        message: `"${variant.name}" (${variant.count}×) looks like a misspelling of always-on bible entry "${entry.name}" [${entry.category}] — not a listed alias`,
      });
      for (const s of scenes) {
        if (mentions(s.text, [variant.name])) {
          findings.push({
            file: s.id,
            level: 'ban',
            kind: 'bible',
            message: `uses "${variant.name}" — always-on bible entry "${entry.name}" [${entry.category}] does not list it as an alias`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Run the full manuscript audit over a directory: naming order, scanTics per
 * file, cross-file metrics (crutch words, echoes, name variants, length
 * outliers), and — when a style sheet exists — bible always-rule consistency.
 */
export function auditDir(dir: string): ProseAuditResult {
  const files = listSceneFiles(dir);
  const scenes: SceneText[] = files.map((f) => ({ id: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const findings: ProseFinding[] = [];

  for (const s of scenes) {
    for (const t of scanTics(s.text)) {
      findings.push({
        file: s.id,
        level: t.note.startsWith('HARD BAN:') ? 'ban' : 'warn',
        kind: 'tic',
        message: `${t.note} — "${t.match}"`,
      });
    }
  }

  if (scenes.length) {
    for (const c of crutchWords(scenes.map((s) => s.text).join('\n\n'))) {
      findings.push({ file: null, level: 'warn', kind: 'metric', message: `crutch word: "${c.word}" (${c.count}×, ${c.per1k}/1k)` });
    }
    for (const e of crossSceneEchoes(scenes)) {
      findings.push({ file: null, level: 'warn', kind: 'metric', message: `repeated phrase across ${e.scenes.length} scenes: "${e.phrase}" — ${e.scenes.join(', ')}` });
    }
    for (const v of properNounVariants(scenes)) {
      findings.push({
        file: null, level: 'warn', kind: 'metric',
        message: `possible name inconsistency: ${v.canonical} vs ${v.variants.map((x) => `${x.name} (${x.count}×)`).join(', ')}`,
      });
    }

    const lengths = scenes.map((s) => ({ id: s.id, words: proseMetrics(s.text).words }));
    const sorted = [...lengths].sort((a, b) => a.words - b.words);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]!.words : 0;
    if (median) {
      for (const l of lengths) {
        if (l.words > median * 2.5 || l.words < median * 0.35) {
          findings.push({ file: l.id, level: 'warn', kind: 'metric', message: `length outlier: ${l.words} words (book median ${median})` });
        }
      }
    }

    findings.push(...bibleFindings(loadStyleSheet(dir), scenes));
  }

  return { dir, files, findings };
}

export function auditHasBans(result: ProseAuditResult): boolean {
  return result.findings.some((f) => f.level === 'ban');
}

/** Grouped report: per-file findings first (in reading order), then cross-file. */
export function formatAuditReport(result: ProseAuditResult): string {
  if (!result.findings.length) return `prose audit: ${result.files.length} file(s), clean`;

  const perFile = new Map<string, ProseFinding[]>();
  const crossFile: ProseFinding[] = [];
  for (const f of result.findings) {
    if (f.file) {
      const arr = perFile.get(f.file) ?? [];
      arr.push(f);
      perFile.set(f.file, arr);
    } else crossFile.push(f);
  }

  const lines: string[] = [];
  for (const file of result.files) {
    const fFindings = perFile.get(file);
    if (!fFindings?.length) continue;
    lines.push(`${file}:`);
    for (const f of fFindings) lines.push(`  [${f.level}] ${f.kind}: ${f.message}`);
  }
  if (crossFile.length) {
    lines.push('cross-file:');
    for (const f of crossFile) lines.push(`  [${f.level}] ${f.kind}: ${f.message}`);
  }
  const bans = result.findings.filter((f) => f.level === 'ban').length;
  const warns = result.findings.length - bans;
  lines.push('');
  lines.push(`${result.findings.length} finding(s): ${bans} ban, ${warns} warn, across ${result.files.length} file(s)`);
  return lines.join('\n');
}

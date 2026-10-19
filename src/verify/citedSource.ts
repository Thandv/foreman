import { execFileSync } from 'node:child_process';
import { config } from '../config.ts';
import { readJailFile } from './jailRead.ts';
import { isDocPath } from './revertCheck.ts';

/**
 * The source a changed document cites, for a reviewer that sees only the diff.
 *
 * A design note or a README section makes claims about code that is not in
 * its diff. On the Kiln trial the reviewer passed an ADR "checked for internal
 * consistency only" ("I could not open src/server.ts") and a README security
 * section with "no README claim was spot-checked against code". So when a diff
 * adds or changes prose, the repo files its ADDED lines cite are read from the
 * work tree and attached: numbered by the file's own lines, the cited lines
 * with their surroundings when a line is cited, the lines that hold a name the
 * document gives beside the file (`src/trust.ts` `INCLUDE_DEPTH`) when one is,
 * else the head of the file — under one budget, with everything left out
 * named. The worker's report is read for citations too: a README's claims are
 * mapped to files there, not in the README.
 *
 * The tree is the worker's. Each file is read through readJailFile (a regular
 * file, inside the jail, capped), and only when git lists it in that tree — an
 * ignored file a document happens to name is not sent to a hosted reviewer.
 */

export const CITED_SOURCE_HEADING =
  "SOURCE THE DOCUMENT CITES (read by Foreman from the work tree; line numbers are the file's own)";

/** Lines shown on each side of a cited line or range. */
const CONTEXT_LINES = 40;
/** Lines shown on each side of a line that holds a name the document gives beside the file. */
const SYMBOL_CONTEXT_LINES = 12;
/** Places shown per such name: its first uses in the file, which is where it is defined. */
const SYMBOL_HITS = 2;
/** Lines shown from the top of a file cited with no line and no name that is found in it. */
const HEAD_LINES = 80;
/** The largest file read; a larger one is named as not shown. */
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
/** Cited paths considered, in order of first mention. */
const MAX_CITED = 40;
/** A source line longer than this is shown cut (a minified file is one line). */
const MAX_LINE = 400;
/** The longest line of a document or report that is scanned for citations. */
const MAX_PROSE_LINE = 4_000;
/** The least a file is offered before it is left out whole instead. */
const MIN_FILE_ROOM = 600;

export interface Citation {
  path: string;
  /** Cited lines or ranges, as written; empty when only the file is named. */
  ranges: Array<[number, number]>;
  /** Backticked identifiers on the lines that cite the file: `serveStatic`, `LOG_CAP_BYTES`. */
  symbols: string[];
  /** Written with no directory, in backticks: a root file, or a file named by its base name. */
  bare: boolean;
}

const LINE_REF = String.raw`(?::(\d+)(?:\s*[-–]\s*(\d+))?|#L(\d+)(?:-L?(\d+))?|,?\s+lines?\s+(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?)?`;
/** `src/x.ts`, `src/x.ts:123`, `test/y.test.ts:10-20`, `src/x.ts#L5`, `src/x.ts line 7`: a path with a directory in it. */
const SLASHED = new RegExp(String.raw`(?<![\w./@~-])((?:\.\/)?(?:[\w@.-]+\/)+[\w@.-]*\.[A-Za-z]\w{0,9})\`?` + LINE_REF, 'g');
/** A name with no directory counts only inside backticks: `package.json`, `README.md:12`, `server.ts`. */
const BACKTICKED = new RegExp(String.raw`\`([\w@.-]+\.[A-Za-z]\w{0,9})` + LINE_REF + String.raw`\``, 'g');
/** A backticked identifier, with or without call parentheses. */
const SYMBOL = /`([A-Za-z_$][\w$]{2,63})(?:\(\))?`/g;

/** The repo paths a text cites, in order of first mention, each with the lines and names cited with it; at most `max`. */
export function citedPaths(text: string, max: number = MAX_CITED): Citation[] {
  const found = new Map<string, Citation>();
  for (const line of text.split(/\r?\n/)) {
    // Prose has no line this long; one that is (a pasted blob, or a line built to make the scan slow) cites nothing.
    if (line.length > MAX_PROSE_LINE) continue;
    const hits: Array<{ at: number; m: RegExpMatchArray; bare: boolean }> = [];
    for (const m of line.matchAll(SLASHED)) hits.push({ at: m.index ?? 0, m, bare: false });
    for (const m of line.matchAll(BACKTICKED)) hits.push({ at: m.index ?? 0, m, bare: true });
    if (!hits.length) continue;
    hits.sort((a, b) => a.at - b.at);
    const symbols = [...line.matchAll(SYMBOL)].map((m) => m[1]!);
    for (const { m, bare } of hits) {
      const rel = m[1]!.replace(/^\.\//, '');
      if (rel.split('/').includes('..')) continue;
      let c = found.get(rel);
      if (!c) {
        if (found.size >= max) continue;
        c = { path: rel, ranges: [], symbols: [], bare };
        found.set(rel, c);
      }
      const from = Number(m[2] ?? m[4] ?? m[6] ?? 0);
      const to = Number(m[3] ?? m[5] ?? m[7] ?? 0) || from;
      if (from > 0 && c.ranges.length < 50) c.ranges.push([Math.min(from, to), Math.max(from, to)]);
      for (const sym of symbols) if (c.symbols.length < 12 && !c.symbols.includes(sym)) c.symbols.push(sym);
    }
  }
  return [...found.values()];
}

/** The prose files a diff adds or changes, each with the text of its added lines. */
export function changedProse(diff: string): Array<{ path: string; added: string }> {
  const out: Array<{ path: string; added: string }> = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!block.startsWith('diff --git ')) continue;
    const plus = /^\+\+\+ (?:b\/)?(.+?)\s*$/m.exec(block);
    const file = plus && plus[1] !== '/dev/null' ? plus[1]! : null;
    if (!file || !isDocPath(file)) continue;
    const added = block.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++ ')).map((l) => l.slice(1));
    if (added.length) out.push({ path: file, added: added.join('\n') });
  }
  return out;
}

/**
 * The pins of every git call made on a tree a worker could write (isolate.ts, verify/gateOutcome.ts): the tree's
 * repo config is the worker's too, and a plain `git ls-files` runs whatever program `core.fsmonitor` names.
 */
const PINNED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false'];
const NOT_INHERITED = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(_.*)?)$/;

/** Every file git lists in the tree (tracked, or added by the work); null when git cannot say. */
function listedByGit(dir: string): string[] | null {
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!NOT_INHERITED.test(key)) env[key] = value;
    const raw = execFileSync('git', ['-C', dir, ...PINNED, '--no-optional-locks', 'ls-files', '-z'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    });
    return raw.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Widened and merged line windows, clipped to the file. */
function merge(wide: Array<[number, number]>, total: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const w of wide.map(([a, b]): [number, number] => [Math.max(1, a), Math.min(total, b)]).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else merged.push(w);
  }
  return merged;
}

/** What of a file is shown: around the cited lines, around the cited names, or — with neither — its head. */
function windows(c: Citation, lines: string[]): { spans: Array<[number, number]>; head: boolean } {
  const total = lines.length;
  const wide: Array<[number, number]> = c.ranges
    .filter(([from]) => from <= total)
    .map(([from, to]) => [from - CONTEXT_LINES, to + CONTEXT_LINES]);
  for (const sym of c.symbols) {
    const word = new RegExp(`(?<![\\w$])${sym.replace(/[$]/g, '\\$&')}(?![\\w$])`);
    let hits = 0;
    for (let i = 0; i < total && hits < SYMBOL_HITS; i++) {
      if (!word.test(lines[i]!)) continue;
      wide.push([i + 1 - SYMBOL_CONTEXT_LINES, i + 1 + SYMBOL_CONTEXT_LINES]);
      hits++;
      i += SYMBOL_CONTEXT_LINES; // the next use, not the next line of this one
    }
  }
  return wide.length ? { spans: merge(wide, total), head: false } : { spans: [[1, Math.min(total, HEAD_LINES)]], head: true };
}

/** One file's section in at most `room` characters; null when not even its first lines fit. */
function section(c: Citation, rel: string, text: string, room: number): string | null {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const total = lines.length;
  const width = String(total).length;
  const { spans, head } = windows(c, lines);
  const body: string[] = [];
  const shown: string[] = [];
  let used = 0;
  let cut = false;
  for (const [from, to] of spans) {
    let last = from - 1;
    for (let n = from; n <= to; n++) {
      const raw = lines[n - 1]!;
      const line = `${String(n).padStart(width)}| ${raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}… [line cut]` : raw}`;
      if (used + line.length + 1 > room - 200 - rel.length) {
        cut = true;
        break;
      }
      body.push(line);
      used += line.length + 1;
      last = n;
    }
    if (last >= from) shown.push(from === last ? `${from}` : `${from}-${last}`);
    if (cut) break;
    body.push(`${' '.repeat(width)}| …`);
  }
  if (body.at(-1)?.endsWith('| …')) body.pop();
  if (!shown.length) return null;
  const why = head ? '; no line or name in it was cited, so this is the head of the file' : '';
  return `--- ${rel} (lines ${shown.join(', ')} of ${total}${why}${cut ? '; the rest of what was cited did not fit the budget' : ''}) ---\n${body.join('\n')}`;
}

/**
 * The labelled block for a review prompt, or '' when the diff changes no
 * prose file or nothing cited can be read. `report` is the worker's final
 * message: the files it names are attached after the document's own. At most
 * `budget` characters, the heading and the lists of what was left out included.
 */
export function citedSourceBlock(diff: string, treeDir: string, report: string | null = null, budget: number = config.citedSourceBytes): string {
  const prose = changedProse(diff);
  if (!prose.length) return '';
  // A document does not cite itself, and another changed document is already in the diff.
  const own = new Set(prose.map((p) => p.path));
  const added = prose.map((p) => p.added).join('\n');
  // The document's citations come first and the report's after, and only the first MAX_CITED are looked at: how many
  // were not is said at the end of the block, like everything else that is left out.
  const every = citedPaths(`${added}\n${report ?? ''}`, 10 * MAX_CITED).filter((c) => !own.has(c.path));
  const cited = every.slice(0, MAX_CITED);
  const beyond = every.length - cited.length;
  /** What the document itself cites: its files are given their room before the report's (see below). */
  const documentCites = new Map(citedPaths(added, 10 * MAX_CITED).map((c) => [c.path, c] as const));
  const byDocument = new Set(documentCites.keys());
  if (!cited.length) return '';
  const listed = listedByGit(treeDir);
  if (!listed) return '';
  const tracked = new Set(listed);

  // Each citation as a file of the tree. A name with no directory is the root file, or the one file with that base
  // name; a name that is neither (`fs.promises`, `server.lock`) is not a citation and is dropped without a word.
  const files: Array<{ c: Citation; rel: string; text: string }> = [];
  const unread: string[] = [];
  for (const c of cited) {
    let rel: string | null = tracked.has(c.path) ? c.path : null;
    if (!rel && c.bare) {
      const same = listed.filter((f) => f.endsWith(`/${c.path}`));
      if (same.length !== 1) continue;
      rel = same[0]!;
    }
    if (rel && own.has(rel)) continue;
    const twin = rel ? files.find((f) => f.rel === rel) : undefined;
    if (twin) {
      // `server.ts` and src/server.ts are one file: what was cited with either name is shown.
      twin.c.ranges.push(...c.ranges);
      for (const sym of c.symbols) if (!twin.c.symbols.includes(sym)) twin.c.symbols.push(sym);
      continue;
    }
    const text = rel ? readJailFile(treeDir, rel, MAX_SOURCE_FILE_BYTES) : null;
    if (rel && text !== null) files.push({ c, rel, text });
    else unread.push(c.path);
  }

  const intro =
    `${CITED_SOURCE_HEADING}\n` +
    `The diff adds or changes ${prose.map((p) => p.path).join(', ')}. Below are the repo files that its added lines, or the worker's ` +
    'report, cite, as they are in the work tree now: the cited lines with their surroundings, the lines around a name given ' +
    "beside the file, or the head of the file when neither is cited. Check the document's claims against this text. A claim " +
    'about source that is neither here nor in the diff was not shown to you.';
  // The lists of names at the end are paid for first, at their largest, so the block never passes the budget.
  // (A file both cite can be named twice: once more for the list of files shown by the document's citations only.)
  const tailRoom = Math.min(Math.floor(budget / 4), 600 + cited.reduce((n, c) => n + (c.path.length + 2) * (documentCites.has(c.path) ? 2 : 1), 0));
  let room = budget - intro.length - tailRoom;
  // Every file whole when they all fit. Otherwise the small ones whole and the rest a share of what is left.
  const want = files.map((f) => (section(f.c, f.rel, f.text, Number.MAX_SAFE_INTEGER) ?? '').length + 2);
  const share = new Array<number>(files.length).fill(0);
  const whole = new Array<boolean>(files.length).fill(false);
  // The files the DOCUMENT cites are given their room first, shared among themselves; the files only the worker's
  // report names share what is left. The report is free text, and forty names in it must not shrink the one file the
  // document's claims are about to a sliver (Kiln's lock ADR: src/server.ts lines 858-1125 became 858-901).
  const fromReport = (k: number): boolean => !byDocument.has(files[k]!.c.path);
  /** Files of the document whose lines the report cited too, shown by the document's citations only. */
  const narrowed: string[] = [];
  const order = files.map((_, k) => k).sort((a, b) => Number(fromReport(a)) - Number(fromReport(b)) || want[a]! - want[b]!);
  let left = order.filter((k) => !fromReport(k)).length;
  for (const [n, i] of order.entries()) {
    if (fromReport(i) && (n === 0 || !fromReport(order[n - 1]!))) left = order.length - n;
    let need = want[i]! + 200 + files[i]!.rel.length;
    // An equal share of what is left — but never a sliver each: past that point the first files get a readable
    // piece and the rest are named as left out.
    const fair = Math.max(Math.floor(room / Math.max(1, left--)), Math.min(room, 4 * MIN_FILE_ROOM));
    // One file cited by both: the lines are shown in file order and cut where the room ends, so a report that cites
    // the document's file at earlier lines (src/server.ts:1-800 beside the ADR's 858-1125) would push the document's
    // own lines out of it. When both do not fit, the document's lines and names are what is shown, and the tail says
    // the report's were not.
    const own = documentCites.get(files[i]!.c.path);
    if (need > fair && own && (own.ranges.length || own.symbols.length)
      && (own.ranges.length < files[i]!.c.ranges.length || own.symbols.length < files[i]!.c.symbols.length)) {
      files[i]!.c = own;
      need = (section(own, files[i]!.rel, files[i]!.text, Number.MAX_SAFE_INTEGER) ?? '').length + 2 + 200 + files[i]!.rel.length;
      narrowed.push(files[i]!.rel);
    }
    whole[i] = need <= fair;
    share[i] = Math.min(need, fair);
    room -= share[i]!;
  }
  const sections: string[] = [];
  const overBudget: string[] = [];
  files.forEach((f, i) => {
    const text = whole[i] || share[i]! >= MIN_FILE_ROOM ? section(f.c, f.rel, f.text, share[i]!) : null;
    if (text) sections.push(text);
    else overBudget.push(f.rel);
  });
  if (!sections.length && !overBudget.length) return '';
  // What the three lists of names may take between them, after their labels: each takes what it needs of what is
  // left, and a list that does not fit ends in "and others" — so the tail never passes the room kept for it.
  let nameRoom = Math.max(0, tailRoom - 560);
  const names = (list: string[]): string => {
    const text = list.join(', ');
    const cap = Math.max(0, nameRoom - 12);
    const said = text.length > cap ? `${text.slice(0, Math.max(0, text.lastIndexOf(', ', cap)))}, and others`.replace(/^, /, '') : text;
    nameRoom -= said.length;
    return said;
  };
  const tail = [
    overBudget.length ? `NOT SHOWN, over this block's ${budget}-character budget (FOREMAN_CITED_SOURCE_BYTES): ${names(overBudget)}` : '',
    narrowed.length ? `SHOWN BY THE DOCUMENT'S OWN CITATIONS ONLY (the lines the worker's report cites in them did not fit as well): ${names(narrowed)}` : '',
    unread.length ? `CITED BUT NOT READ (not a regular file of this tree that git lists, over 1 MB, or binary): ${names(unread)}` : '',
    beyond > 0 ? `NOT LOOKED AT: ${beyond} more cited path${beyond > 1 ? 's' : ''}. Only the first ${MAX_CITED} are, the document's before the report's.` : '',
  ].filter(Boolean);
  return [intro, ...sections, ...tail].join('\n\n');
}

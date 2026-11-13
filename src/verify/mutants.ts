import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { provisionDeps } from '../deps.ts';
import { checkoutWorktree } from '../isolate.ts';
import type { Store } from '../queue.ts';
import type { Run } from '../types.ts';
import { isTestPath } from './literals.ts';
import { exists, git, inside, isDocPath, isRunnableTest, messageOf, nodeTestScript, withinScratch } from './revertCheck.ts';
import { blob, fileCommand, listChanges, oneLine, writeFromTree, type RevertRunResult } from './revertTests.ts';
import { allLines, changedLinesOf } from './testNames.ts';
import { removeScratch } from './tests.ts';

/**
 * The mutation check on changed lines: a REVIEWER AID that decides nothing. The revert check (revertTests.ts) asks
 * whether a new test fails with the whole change put back; this asks the finer question independent reviews kept
 * answering by hand — in 12 of 15 reviewed tickets some mutant of the changed code passed every test the ticket
 * wrote. For a code ticket whose tests passed, small line-local mutants of the source lines its diff changes are
 * each run, in a scratch tree of the reviewed tree, against the test files the diff adds or changes, and recorded as
 * `killed` (the tests fail), `survived` (they pass) or `could-not-run`. A survivor means the tests do not check that
 * line, or the mutant is equivalent; which one is the reviewer's call.
 *
 * Operators, deliberately few (mutation at code review keeps to a handful that developers act on): a relational
 * boundary (`<` ↔ `<=`, `>` ↔ `>=`, spaced only), equality (`===` ↔ `!==`, `==` ↔ `!=`), a logical connector
 * (`&&` ↔ `||`), a boolean literal, and deleting an expression statement (a call or an assignment on its own line).
 * Only JavaScript and TypeScript sources, only `node --test` projects, at most `maxMutants` per run.
 */

export type MutantOp = 'relational' | 'equality' | 'logical' | 'boolean' | 'delete-statement';
export type MutantOutcome = 'killed' | 'survived' | 'could-not-run';

export interface Mutant {
  /** 1-based line in the reviewed tree's file. */
  line: number;
  /** 0-based column of `from` in that line (the whole line for delete-statement). */
  col: number;
  op: MutantOp;
  from: string;
  to: string;
}

export interface MutantRow {
  file: string;
  line: number;
  op: MutantOp;
  from: string;
  to: string;
  /** The original line, trimmed. */
  text: string;
  outcome: MutantOutcome;
  /** Why it could not run; '' otherwise. */
  detail: string;
}

export interface MutantsResult {
  version: 1;
  status: 'ran' | 'n/a' | 'could-not-run';
  reason: string;
  mutants: MutantRow[];
  /** Mutants the changed lines offered before the cap. */
  candidates: number;
  /** The test files every mutant was run against. */
  testFiles: string[];
  runMs: number;
  runs: number;
}

export interface MutantsOptions {
  repo: string;
  base: string | null;
  /** The reviewed tree (isolate.ts jailTree); the live jail is never written. */
  tree: string;
  workRoot: string;
  runId: string;
  /** Runs one command in the scratch tree; the caller's goes through the verify slots and the sandbox. */
  run: (dir: string, cmd: string, timeoutMs: number) => Promise<RevertRunResult>;
  signal?: AbortSignal;
  /** At most this many mutants are run. Default 20. */
  maxMutants?: number;
  /** One run's bound. Default 120 s. */
  perRunMs?: number;
  /** Run time for the whole check, slot waits not counted. Default 600 s. */
  budgetMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const MUTANTS_DEFAULTS = { maxMutants: 20, perRunMs: 120_000, budgetMs: 600_000 } as const;

const SOURCE_RE = /\.[cm]?[jt]sx?$/;
/** Longest first, so `===` is never read as `==` and `=>` or a shift is never read as a comparison. */
const TOKENS = ['>>>=', '===', '!==', '>>>', '<<=', '>>=', '==', '!=', '<=', '>=', '&&', '||', '=>', '<<', '>>', '<', '>'];
const FLIP: Record<string, [MutantOp, string]> = {
  '<': ['relational', '<='], '<=': ['relational', '<'], '>': ['relational', '>='], '>=': ['relational', '>'],
  '===': ['equality', '!=='], '!==': ['equality', '==='], '==': ['equality', '!='], '!=': ['equality', '=='],
  '&&': ['logical', '||'], '||': ['logical', '&&'],
};
/** A line starting with one of these is not an expression statement, so deleting it is not offered. */
const NOT_A_STATEMENT = /^(const|let|var|return|if|else|for|while|do|switch|case|default|break|continue|throw|try|catch|finally|import|export|type|interface|declare|function|class|async\s+function|enum|namespace|module)\b/;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/**
 * Where a regex literal starting at `k` ends (its closing `/`), or -1 when the `/` is a division. A regex is a `/`
 * that follows an operator, an opening bracket, `return` or the start of the code (`before` is the code so far);
 * it ends at the first unescaped `/` outside a character class, on the same line.
 */
function regexEnd(line: string, k: number, before: string): number {
  const prev = before.trimEnd();
  if (prev !== '' && !/[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) && !/\b(return|typeof|case)$/.test(prev)) return -1;
  let inClass = false;
  for (let j = k + 1; j < line.length; j++) {
    const c = line[j]!;
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j;
  }
  return -1;
}

/**
 * Each line with string, template and comment text blanked to spaces, so columns are kept and nothing in them
 * matches. A template literal and a block comment carry over to the next line; a regex literal is blanked too.
 */
function codeLines(source: string): string[] {
  let template = false;
  let block = false;
  return source.split('\n').map((line) => {
    let out = '';
    let quote: string | null = template ? '`' : null;
    for (let k = 0; k < line.length; k++) {
      const c = line[k]!;
      if (block) {
        if (c === '*' && line[k + 1] === '/') { block = false; out += '  '; k++; } else out += ' ';
        continue;
      }
      if (quote) {
        if (c === '\\') { out += '  '; k++; continue; }
        if (c === quote) quote = null;
        out += ' ';
        continue;
      }
      if (c === '/' && line[k + 1] === '/') { out += ' '.repeat(line.length - k); break; }
      if (c === '/' && line[k + 1] === '*') { block = true; out += '  '; k++; continue; }
      if (c === '/') {
        const end = regexEnd(line, k, out);
        if (end > k) { out += ' '.repeat(end - k + 1); k = end; continue; }
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; out += ' '; continue; }
      out += c;
    }
    template = quote === '`';
    return out.slice(0, line.length);
  });
}

const count = (s: string, c: string): number => s.split(c).length - 1;

/**
 * A line is a statement of its own only when its brackets balance and the code line before it ended one: deleting
 * a continuation (`  a === b;` after `const ok =`) or the tail of a wrapped call breaks the file, and a file that
 * does not load fails its tests, which would read as a killed mutant.
 */
function standsAlone(code: string[], n: number, stmt: string): boolean {
  if (count(stmt, '(') !== count(stmt, ')') || count(stmt, '[') !== count(stmt, ']')) return false;
  for (let k = n - 2; k >= 0; k--) {
    const prev = code[k]!.trim();
    if (prev === '') continue;
    return /[;{}]$/.test(prev);
  }
  return true;
}

/** Every mutant the fixed operators offer on the given lines of `source`, in line then column order. */
export function mutantsFor(source: string, lines: Iterable<number>): Mutant[] {
  const all = source.split('\n');
  const masked = codeLines(source);
  const out: Mutant[] = [];
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    const raw = all[n - 1];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    const code = masked[n - 1]!;
    if (code.trim() === '' || trimmed.startsWith('*') || /^(import|export)\b.*\bfrom\b/.test(trimmed)) continue;
    for (let k = 0; k < code.length;) {
      const tok = TOKENS.find((t) => code.startsWith(t, k));
      if (tok) {
        const flip = FLIP[tok];
        const relational = flip?.[0] === 'relational';
        // A comparison is spaced (`a < b`); `Array<T>`, `<div>` and the like are not.
        if (flip && (!relational || (code[k - 1] === ' ' && code[k + tok.length] === ' '))) {
          out.push({ line: n, col: k, op: flip[0], from: tok, to: flip[1] });
        }
        k += tok.length;
        continue;
      }
      for (const [from, to] of [['true', 'false'], ['false', 'true']] as const) {
        if (code.startsWith(from, k) && !isWordChar(code[k - 1]) && !isWordChar(code[k + from.length])) {
          out.push({ line: n, col: k, op: 'boolean', from, to });
          k += from.length - 1;
          break;
        }
      }
      k++;
    }
    const stmt = code.trim();
    if (stmt.endsWith(';') && !/[{}]/.test(stmt) && !NOT_A_STATEMENT.test(stmt) && /[(=]/.test(stmt) && standsAlone(masked, n, stmt)) {
      out.push({ line: n, col: raw.indexOf(trimmed), op: 'delete-statement', from: trimmed, to: '' });
    }
  }
  return out;
}

/** All of them under the cap; over it, `max` spread evenly over the list. Deterministic. */
export function pickMutants<M>(ms: M[], max: number): M[] {
  if (ms.length <= max) return ms;
  return Array.from({ length: max }, (_v, i) => ms[Math.floor((i * ms.length) / max)]!);
}

/** The source with one mutant applied. */
function applyMutant(source: string, m: Mutant): string {
  const lines = source.split('\n');
  const line = lines[m.line - 1]!;
  lines[m.line - 1] = m.op === 'delete-statement'
    ? `${line.slice(0, m.col)}/* foreman mutant: statement removed */`
    : `${line.slice(0, m.col)}${m.to}${line.slice(m.col + m.from.length)}`;
  return lines.join('\n');
}

/**
 * Run the check. Null only when `signal` aborted it. Every other failure — a git error, a refused sandbox, tests
 * that do not pass before any mutant, a runner that throws — is `could-not-run`, never a result that reads as clean.
 */
export async function mutantsCheck(opts: MutantsOptions): Promise<MutantsResult | null> {
  if (typeof opts.run !== 'function') throw new TypeError('mutantsCheck needs a runner (opts.run): pass one that runs the command sandboxed');
  const now = opts.now ?? Date.now;
  const maxMutants = opts.maxMutants ?? MUTANTS_DEFAULTS.maxMutants;
  const perRunMs = opts.perRunMs ?? MUTANTS_DEFAULTS.perRunMs;
  const budgetMs = opts.budgetMs ?? MUTANTS_DEFAULTS.budgetMs;
  const log = opts.log ?? ((): void => {});
  const aborted = (): boolean => opts.signal?.aborted === true;

  let picked: Array<Mutant & { file: string; text: string }> = [];
  let candidates = 0;
  let testFiles: string[] = [];
  let runMs = 0;
  let runs = 0;
  const na = (reason: string): MutantsResult => ({ version: 1, status: 'n/a', reason, mutants: [], candidates, testFiles, runMs, runs });
  const row = (m: Mutant & { file: string; text: string }, outcome: MutantOutcome, detail = ''): MutantRow =>
    ({ file: m.file, line: m.line, op: m.op, from: m.from, to: m.to, text: m.text, outcome, detail });
  const failAll = (why: string): MutantsResult => ({
    version: 1, status: 'could-not-run', reason: `the check could not run: ${oneLine(why, 300)}`,
    mutants: picked.map((m) => row(m, 'could-not-run', oneLine(why))), candidates, testFiles, runMs, runs,
  });

  let dir: string | null = null;
  try {
    if (!opts.base) throw new Error('the base commit of the work could not be found');
    const base = opts.base;
    const changes = await listChanges(opts.repo, base, opts.tree);
    const live = changes.filter((c) => c.status !== 'D');
    const sources = live.filter((c) => SOURCE_RE.test(c.path) && !c.path.endsWith('.d.ts') && !isTestPath(c.path) && !isDocPath(c.path));
    testFiles = live.filter((c) => SOURCE_RE.test(c.path) && isTestPath(c.path)).map((c) => c.path);
    if (sources.length === 0) return na('the diff changes no JavaScript or TypeScript source file');
    if (testFiles.length === 0) return na('the diff adds or changes no test file to run its mutants against');

    // --- which mutants: the fixed operators on each source's changed lines ---
    const originals = new Map<string, string>();
    const all: Array<Mutant & { file: string; text: string }> = [];
    for (const c of sources) {
      // A regular file only: a symlink's blob is its target's path, and writing a mutant would follow the link.
      const listed = await git(opts.repo, ['ls-tree', '-z', opts.tree, '--', c.path]);
      if (!/^100(644|755) blob /.test(listed)) continue;
      const after = await blob(opts.repo, opts.tree, c.path);
      if (after === null) continue;
      originals.set(c.path, after);
      const before = await blob(opts.repo, base, c.from ?? c.path);
      const changed = before === null
        ? allLines(after)
        : changedLinesOf(await git(opts.repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', `${base}:${c.from ?? c.path}`, `${opts.tree}:${c.path}`]));
      const lines = after.split('\n');
      for (const m of mutantsFor(after, changed.lines)) all.push({ ...m, file: c.path, text: oneLine(lines[m.line - 1] ?? '', 160) });
    }
    candidates = all.length;
    if (all.length === 0) return na('no changed source line offers a mutant');
    picked = pickMutants(all, maxMutants);

    // --- the scratch tree: the base with the whole reviewed change on it ---
    if (!/^[A-Za-z0-9._-]+$/.test(opts.runId)) return failAll('the run id is not a safe directory name');
    const scratch = path.join(opts.workRoot, `mutants-${opts.runId}`);
    if (exists(scratch)) return failAll(`${scratch} already exists`);
    await fsp.mkdir(opts.workRoot, { recursive: true });
    await checkoutWorktree(opts.repo, scratch, ['--detach'], base);
    dir = scratch;
    for (const c of changes) {
      const gone = c.status === 'D' ? c.path : c.from;
      if (gone) {
        const target = inside(scratch, gone);
        if (target) await fsp.rm(withinScratch(scratch, target, gone), { recursive: true, force: true });
      }
      if (c.status !== 'D') await writeFromTree(opts.repo, opts.tree, scratch, c.path);
    }
    await provisionDeps(scratch, opts.repo, { allowInstall: false });

    const script = nodeTestScript(scratch);
    if (!script) return failAll('the test script is not `node --test`, so the changed test files cannot be run on their own');
    testFiles = testFiles.filter((f) => isRunnableTest(scratch, f));
    if (testFiles.length === 0) return na('no changed test file is one the test command runs');
    const cmd = fileCommand(script.flags, testFiles, perRunMs, null);

    // Every write into the scratch tree, the mutant and the restore after it: the path is checked again each time
    // (the worker's tests ran in between and may have swapped a file or a directory for a link), whatever is there
    // is removed, never followed, and a new regular file is created. Any failure stops the check (could-not-run).
    const writeScratch = async (rel: string, content: string): Promise<void> => {
      const abs = inside(scratch, rel);
      if (!abs) throw new Error(`${rel} is outside the scratch tree`);
      const target = withinScratch(scratch, abs, rel);
      await fsp.rm(target, { force: true });
      await fsp.writeFile(target, content, { flag: 'wx' });
    };

    const runOnce = async (limit: number): Promise<RevertRunResult> => {
      if (aborted()) throw new Error('the run was aborted');
      const started = now();
      runs++;
      const res = await opts.run(scratch, cmd, limit);
      runMs += Math.max(0, now() - started - (res.waitedMs ?? 0));
      if (res.refused) throw new Error(`the sandbox refused the command: ${oneLine(res.output)}`);
      return res;
    };

    // --- before any mutant: the tests must pass, or no survivor means anything ---
    const clean = await runOnce(Math.min(perRunMs, budgetMs));
    if (aborted()) return null;
    if (!clean.passed || clean.timedOut) {
      return failAll(clean.timedOut ? 'the changed tests timed out before any mutant was applied' : 'the changed tests do not pass in the scratch tree before any mutant');
    }
    // A mutant may hang (a loop condition flipped): bounded at three clean runs, within the per-run cap.
    const limit = Math.min(perRunMs, Math.max(30_000, 3 * runMs));

    const rows: MutantRow[] = [];
    for (const m of picked) {
      if (budgetMs - runMs <= 0) {
        rows.push(row(m, 'could-not-run', `not run: the ${Math.round(budgetMs / 1000)} s run-time budget was spent`));
        continue;
      }
      const original = originals.get(m.file)!;
      await writeScratch(m.file, applyMutant(original, m));
      let res: RevertRunResult;
      try {
        res = await runOnce(Math.min(limit, budgetMs - runMs));
      } finally {
        await writeScratch(m.file, original);
      }
      if (aborted()) return null;
      rows.push(res.timedOut ? row(m, 'could-not-run', 'timed out with the mutant in place') : row(m, res.passed ? 'survived' : 'killed'));
    }
    const count = (o: MutantOutcome): number => rows.filter((r) => r.outcome === o).length;
    log(`mutation check: ${rows.length} mutant(s) in ${(runMs / 1000).toFixed(1)}s`);
    return {
      version: 1, status: 'ran',
      reason: `${rows.length} mutant(s) of changed lines (of ${candidates}): ${count('killed')} killed, ${count('survived')} survived, ${count('could-not-run')} could not run`,
      mutants: rows, candidates, testFiles, runMs, runs,
    };
  } catch (err) {
    if (aborted()) return null;
    return failAll(messageOf(err));
  } finally {
    if (dir) {
      await git(opts.repo, ['worktree', 'remove', '--force', dir]).catch(() => '');
      removeScratch(dir);
      await git(opts.repo, ['worktree', 'prune']).catch(() => '');
    }
  }
}

const NOTE_MAX = 6_000;

/** The table for the reviewer and the owner gate, worded so it decides nothing. Null when there is nothing to say. */
export function mutantsNote(r: MutantsResult | null): string | null {
  if (!r || r.status === 'n/a') return null;
  const n = (o: MutantOutcome): number => r.mutants.filter((m) => m.outcome === o).length;
  const head = [
    'FOREMAN MUTATION CHECK (a reviewer aid; it decides nothing): small mutants of the source lines this diff changes',
    `were each run against the test files it adds or changes (${r.testFiles.join(', ') || 'none'}).`,
    r.status === 'could-not-run' ? `- ${r.reason}` : null,
    `- killed: ${n('killed')}`,
    `- survived: ${n('survived')} — the tests pass with that line changed: either they do not check it, or the mutant is equivalent; the reviewer decides which`,
    `- could not run: ${n('could-not-run')}`,
    r.candidates > r.mutants.length ? `- ${r.mutants.length} of ${r.candidates} possible mutants were run` : null,
  ].filter((l): l is string => l !== null);
  const order: MutantOutcome[] = ['survived', 'could-not-run', 'killed'];
  const label: Record<MutantOutcome, string> = { survived: 'SURVIVED', 'could-not-run': 'could not run', killed: 'killed' };
  const rows = order.flatMap((o) => r.mutants.filter((m) => m.outcome === o).map((m) =>
    `  [${label[o]}] ${m.file}:${m.line} ${m.op === 'delete-statement' ? 'statement removed' : `${m.from} → ${m.to}`}: ${oneLine(m.text, 120)}${m.detail ? ` — ${m.detail}` : ''}`));
  const out = [...head, ...rows];
  let text = out.join('\n');
  if (text.length > NOTE_MAX) {
    let kept = head.length;
    while (kept < out.length && out.slice(0, kept + 1).join('\n').length < NOTE_MAX - 120) kept++;
    text = `${out.slice(0, kept).join('\n')}\n  [FOREMAN cut ${out.length - kept} more row(s); the whole table is on the run's mutants artifact]`;
  }
  return text;
}

/** One line for the artifact row and `foreman show`. */
export function mutantsSummary(r: MutantsResult): string {
  if (r.status !== 'ran') return `mutation check ${r.status}: ${oneLine(r.reason, 300)}`;
  const n = (o: MutantOutcome): number => r.mutants.filter((m) => m.outcome === o).length;
  return `mutation check: ${n('killed')} killed, ${n('survived')} survived, ${n('could-not-run')} could not run`;
}

export const mutantsPath = (runId: string, root: string = config.artifactRoot): string => path.join(root, `${runId}.mutants.json`);

/** Store the result: the JSON file and a `mutants` artifact row. Nothing is held on it. */
export function recordMutants(store: Store, runId: string, taskId: string, r: MutantsResult): void {
  const file = mutantsPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(r, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  store.addArtifact({ runId, taskId, type: 'mutants', path: file, summary: mutantsSummary(r) });
}

/** A stored result read back, or null: no file, or one that is not this shape. */
export function readMutants(file: string): MutantsResult | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as MutantsResult;
    return v && v.version === 1 && Array.isArray(v.mutants) && typeof v.status === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The note for a run whose result was recorded earlier (a re-review, the owner gate); null when there is none. */
export function storedMutantsNote(store: Store, run: Run | null): string | null {
  if (!run) return null;
  const row = store.artifactsForTask(run.taskId).filter((a) => a.type === 'mutants' && a.runId === run.id).at(-1);
  return row ? mutantsNote(readMutants(row.path)) : null;
}

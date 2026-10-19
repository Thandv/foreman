import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { provisionDeps } from '../deps.ts';
import { checkoutWorktree } from '../isolate.ts';
import type { Store } from '../queue.ts';
import type { Run } from '../types.ts';
import { isTestPath } from './literals.ts';
import { exists, git, inside, isDocPath, isRunnableTest, messageOf, nodeTestScript, PINNED, pinnedEnv, shq, withinScratch } from './revertCheck.ts';
import { allLines, changedLinesOf, changedTests, findTests, namePatternFor, type ChangedTest, type TestCall } from './testNames.ts';
import { removeScratch } from './tests.ts';

const execBuf = promisify(execFile);

/**
 * The revert check, per test: a REVIEWER AID that decides nothing. For a code
 * ticket whose tests passed, the tests its diff adds or changes (by the call
 * that defines each, testNames.ts) are run in a scratch tree at the base with
 * only the diff's test-side files on it — the change to the code put back —
 * and each is recorded as one of:
 *
 * - `fails-without-change`: it fails there, with its first failure line;
 * - `passes-without-change`: it passes there. Either it does not test the
 *   change, or it pins behaviour that must not change (a refactor's snapshot).
 *   Which one is the reviewer's call; nothing here guesses;
 * - `could-not-run`: it timed out, its file did not load, it was skipped, it
 *   never reported, or the check itself could not run.
 *
 * Nothing here repairs, holds or fails a ticket: the table goes to the
 * reviewer and the owner gate as a note, and onto the run as an artifact.
 *
 * One run per changed test file: `node <the test script's own flags> --test
 * <file>` with the script's reporters replaced by TAP on stdout (its results
 * carry each test's location, which is how a result is matched to its call —
 * names built in a loop or from a variable included), a per-test timeout, and
 * --test-force-exit. Where every name on the way is known, --test-name-pattern
 * runs only the changed tests and the outermost test around each subtest.
 */

export type RevertTestOutcome = 'fails-without-change' | 'passes-without-change' | 'could-not-run';

export interface RevertTestRow {
  file: string;
  /** The full name as the run reported it (describes and parents joined with ' > '), or as the source writes it. */
  name: string;
  /** Line of the call that defines it, in the reviewed tree. */
  line: number;
  change: ChangedTest['change'];
  outcome: RevertTestOutcome;
  /** The first failure line (fails), or why it could not run; '' for a pass. */
  detail: string;
}

export interface RevertTestsResult {
  version: 1;
  /** `ran`: every row is a result of a run. `could-not-run`: the check failed as a whole; every row says so. */
  status: 'ran' | 'n/a' | 'could-not-run';
  reason: string;
  tests: RevertTestRow[];
  /** Changed lines in changed test files that are in no test (imports, helpers, fixtures): counted, not attributed. */
  unattributed: Array<{ file: string; lines: number }>;
  /** Time the test commands ran, not counting any wait for a verify slot. */
  runMs: number;
  /** Test commands started. */
  runs: number;
}

/** What the caller's runner reports for one command. */
export interface RevertRunResult {
  passed: boolean;
  /** Killed at the time limit it was given. */
  timedOut: boolean;
  /** Nothing ran: the sandbox was asked for and could not be used. */
  refused?: boolean;
  /** The whole output, every line (the TAP report is read off it). */
  output: string;
  /** Time spent waiting for a verify slot before the command started; not charged to the check's budget. */
  waitedMs?: number;
}

export interface RevertTestsOptions {
  repo: string;
  /** The base commit of the work; null when it could not be found, which is a could-not-run. */
  base: string | null;
  /** The tree the reviewers are shown (isolate.ts jailTree): test files are read from it, never from the live jail. */
  tree: string;
  workRoot: string;
  runId: string;
  /**
   * Runs one command in the scratch tree. Required, and there is no built-in one: the command is the worker's test
   * code, so the caller passes a runner that goes through the verify slots and the sandbox (runTestsSlotted).
   */
  run: (dir: string, cmd: string, timeoutMs: number) => Promise<RevertRunResult>;
  signal?: AbortSignal;
  /** Each test may run this long at the base (node's --test-timeout). Default 60 s. */
  perTestMs?: number;
  /** One file's run may take this long in all, whatever its tests. Default 300 s. */
  perFileMs?: number;
  /** Added to a file's bound for loading it, on top of perTestMs per changed test. Default 30 s. */
  loadMs?: number;
  /** Run time for the whole check, slot waits not counted. Default 600 s. */
  budgetMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const REVERT_TESTS_DEFAULTS = { perTestMs: 60_000, perFileMs: 300_000, budgetMs: 600_000, loadMs: 30_000 } as const;

interface Change { status: string; path: string; from: string | null }

/** `git diff --name-status -M -z base tree`, read: each changed path with its old name for a rename. */
async function listChanges(repo: string, base: string, tree: string): Promise<Change[]> {
  const out = await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--name-status', '-z', base, tree, '--']);
  const parts = out.split('\0');
  const changes: Change[] = [];
  for (let k = 0; k < parts.length;) {
    const status = parts[k++] ?? '';
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const from = parts[k++] ?? '';
      const to = parts[k++] ?? '';
      changes.push({ status: status[0]!, path: to, from });
    } else {
      changes.push({ status: status[0]!, path: parts[k++] ?? '', from: null });
    }
  }
  return changes;
}

async function blob(repo: string, rev: string, rel: string): Promise<string | null> {
  try {
    return await git(repo, ['cat-file', 'blob', `${rev}:${rel}`]);
  } catch {
    return null;
  }
}

/** A path of the reviewed tree, written into the scratch tree as the tree has it: bytes and mode, a symlink verbatim. */
async function writeFromTree(repo: string, tree: string, root: string, rel: string): Promise<void> {
  const target = inside(root, rel);
  if (!target) throw new Error(`${rel} is outside the scratch tree`);
  withinScratch(root, target, rel);
  const listed = await git(repo, ['ls-tree', '-z', tree, '--', rel]);
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(listed);
  if (!m) return;
  const [, mode, type, oid] = m;
  if (type !== 'blob') return;
  const { stdout } = await execBuf('git', [...PINNED, 'cat-file', 'blob', oid!], { cwd: repo, env: pinnedEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(target, { recursive: true, force: true });
  if (mode === '120000') await fsp.symlink(stdout.toString('utf8'), target);
  else await fsp.writeFile(target, stdout, { mode: mode === '100755' ? 0o755 : 0o644 });
}

/** One TAP result line and what its YAML block says. */
export interface TapResult {
  /** The names from the outermost subtest down to this one. */
  path: string[];
  ok: boolean;
  directive: 'SKIP' | 'TODO' | null;
  type: string | null;
  file: string | null;
  line: number | null;
  col: number | null;
  failureType: string | null;
  error: string | null;
  /** An assertion's `expected` and `actual`, when the block gives them on one line each. */
  expected: string | null;
  actual: string | null;
}

const unescapeTap = (s: string): string => s.replace(/\\([\\#])/g, '$1').replace(/\\n/g, '\n');
const unquote = (s: string): string => {
  const t = s.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
};

/** node's TAP reporter, read: every result, nested by indentation (four spaces a level), with its YAML diagnostics. */
export function parseTap(output: string): { results: TapResult[]; comments: string[] } {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const results: TapResult[] = [];
  const comments: string[] = [];
  const subtests: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = /^( *)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const depth = Math.floor(sub[1]!.length / 4);
      subtests.length = depth;
      subtests[depth] = unescapeTap(sub[2]!);
      continue;
    }
    const res = /^( *)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!res) {
      const comment = /^# (.*)$/.exec(line);
      if (comment) comments.push(comment[1]!);
      continue;
    }
    const depth = Math.floor(res[1]!.length / 4);
    const name = unescapeTap(res[3]!.replace(/\s+$/, ''));
    const r: TapResult = {
      path: [...subtests.slice(0, depth), name], ok: res[2] === 'ok', directive: (res[4] as 'SKIP' | 'TODO' | undefined) ?? null,
      type: null, file: null, line: null, col: null, failureType: null, error: null, expected: null, actual: null,
    };
    // The YAML block: `---` on the next line, `...` at the same indentation ends it.
    const pad = `${res[1]!}  `;
    if ((lines[i + 1] ?? '').trimEnd() === `${pad}---`) {
      let j = i + 2;
      for (; j < lines.length && lines[j]!.trimEnd() !== `${pad}...`; j++) {
        const l = lines[j]!;
        if (!l.startsWith(pad) || l.startsWith(`${pad} `)) continue;
        const kv = /^(\w+): ?(.*)$/.exec(l.slice(pad.length));
        if (!kv) continue;
        const [, key, raw] = kv;
        if (key === 'type') r.type = unquote(raw!);
        else if (key === 'expected' && !/^[|>]-?$/.test(raw!.trim())) r.expected = raw!.trim();
        else if (key === 'actual' && !/^[|>]-?$/.test(raw!.trim())) r.actual = raw!.trim();
        else if (key === 'failureType') r.failureType = unquote(raw!);
        else if (key === 'location') {
          const loc = /^(.*):(\d+):(\d+)$/.exec(unquote(raw!));
          if (loc) [r.file, r.line, r.col] = [loc[1]!, Number(loc[2]), Number(loc[3])];
        } else if (key === 'error') {
          if (/^\|-?$|^>-?$/.test(raw!.trim())) {
            // A block scalar: its first non-empty line.
            const next = lines.slice(j + 1).find((x) => x.startsWith(`${pad} `) && x.trim());
            r.error = next?.trim() ?? '';
          } else r.error = unquote(raw!);
        }
      }
      i = j;
    }
    results.push(r);
  }
  return { results, comments };
}

const oneLine = (s: string, max = 240): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** Is this result the runner's report for a file that did not load (one failure named after the file, at its top)? */
function loadFailure(results: TapResult[], file: string): TapResult | null {
  const top = results.filter((r) => r.path.length === 1);
  const named = top.find((r) => !r.ok && (r.path[0] === file || r.path[0]!.endsWith(`/${file}`) || file.endsWith(`/${r.path[0]}`) || r.path[0] === path.basename(file))
    && ((r.line === 1 && r.col === 1) || r.error === 'test failed'));
  return named ?? null;
}

/** Paths of the scratch tree said relative to it (as given, and as node resolves it): the detail is read by a person. */
function relative(text: string, dir: string): string {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* gone already: the path as given */
  }
  let out = text;
  for (const d of new Set([real, dir])) out = out.split(`file://${d}/`).join('').split(`${d}/`).join('');
  return out;
}

/** The first line a load error printed (node's stderr arrives as TAP comments), else the runner's own words. */
function loadErrorLine(comments: string[], fallback: string | null, dir: string): string {
  const hit = comments.find((c) => /^\w*Error\b/.test(c.trim())) ?? comments.find((c) => /\bERR_\w+/.test(c));
  return oneLine(relative(hit ?? fallback ?? 'the file did not load', dir));
}

/** Does this TAP location name this file of the scratch tree? */
function sameFile(loc: string, dir: string, file: string): boolean {
  const plain = loc.replace(/^file:\/\//, '');
  if (plain === path.join(dir, file)) return true;
  return plain.endsWith(`/${file}`);
}

/** The command for one file: the script's flags without its reporters or filters, then ours. */
function fileCommand(flags: string[], file: string, perTestMs: number, patterns: string[] | null): string {
  const DROP = /^--test-(reporter|reporter-destination|timeout|name-pattern|skip-pattern|only|shard|force-exit|rerun-failures)(=|$)/;
  const kept: string[] = [];
  for (let k = 0; k < flags.length; k++) {
    const f = flags[k]!;
    if (DROP.test(f)) {
      // The value as the next word (`--test-reporter spec`), when it was written that way.
      if (!f.includes('=') && !/^--test-(only|force-exit)$/.test(f) && k + 1 < flags.length && !flags[k + 1]!.startsWith('-')) k++;
      continue;
    }
    kept.push(f);
  }
  return [
    'node', ...kept.map(shq), '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-timeout=${perTestMs}`, '--test-force-exit',
    ...(patterns ?? []).map((p) => `--test-name-pattern=${shq(p)}`),
    shq(file),
  ].join(' ');
}

/** The names from a call's outermost describe or test down to it, each as an anchored regex; null where a name is not known. */
function namePath(calls: TestCall[], index: number): Array<RegExp | null> {
  const out: Array<RegExp | null> = [];
  for (let c: number | null = index; c !== null; c = calls[c]!.parent) {
    const p = calls[c]!.namePattern;
    out.unshift(p === null ? null : new RegExp(`^${p}$`, 's'));
  }
  return out;
}

/**
 * Which call each result of a run belongs to. By name first: the result's path (its describes and parent tests, then
 * its own name) against each test call's names, a name not known from the source matching anything. Where that
 * leaves more than one call, the location node gives a FAILING result (a passing one has none) decides: same line,
 * and the column of one of the callee's identifiers; else the call with the fewest unknown names, the first in the file.
 */
function matchResults(calls: TestCall[], results: TapResult[]): Map<TapResult, number> {
  const paths = calls.map((c, k) => (c.kind === 'test' ? namePath(calls, k) : null));
  const out = new Map<TapResult, number>();
  const taken = new Set<number>();
  for (const r of results) {
    let fits = paths.flatMap((p, k) => (p && p.length === r.path.length && p.every((re, i) => re === null || re.test(r.path[i]!)) ? [k] : []));
    if (fits.length > 1 && r.line !== null) {
      const at = fits.filter((k) => calls[k]!.line === r.line && (r.col === null || calls[k]!.cols.includes(r.col)));
      if (at.length > 0) fits = at;
    }
    // Two calls with one name (a passing result carries no location): node reports them in source order, so a call
    // that already has its result yields to one that has none. Without this a vacuous second test went unreported.
    if (fits.length > 1) {
      const fresh = fits.filter((k) => !taken.has(k));
      if (fresh.length > 0) fits = fresh;
    }
    if (fits.length > 1) {
      const unknown = (k: number): number => paths[k]!.filter((re) => re === null).length;
      const least = Math.min(...fits.map(unknown));
      fits = fits.filter((k) => unknown(k) === least);
    }
    if (fits.length > 0) {
      out.set(r, fits[0]!);
      taken.add(fits[0]!);
    }
  }
  return out;
}


/** The rows of one file's targets, from one run's TAP report. Targets with no result are returned apart. */
function rowsFromRun(
  dir: string, file: string, calls: TestCall[], targets: ChangedTest[], output: string,
): { rows: RevertTestRow[]; missing: ChangedTest[]; loadError: string | null } {
  const { results, comments } = parseTap(output);
  const failed = loadFailure(results, file);
  // A test defined in another module (a shared helper) is located there; one with no location is this file's.
  const own = results.filter((r) => r !== failed && r.type !== 'suite' && (r.file === null || sameFile(r.file, dir, file)));
  if (failed && own.length === 0) {
    return { rows: [], missing: targets, loadError: loadErrorLine(comments, failed.error, dir) };
  }
  const owner = matchResults(calls, own);
  const rows: RevertTestRow[] = [];
  const missing: ChangedTest[] = [];
  for (const target of targets) {
    const mine = own.filter((r) => owner.get(r) === target.index);
    if (mine.length === 0) {
      missing.push(target);
      continue;
    }
    for (const r of mine) {
      const base = { file, name: r.path.join(' > '), line: target.call.line, change: target.change };
      // An assertion's first line is often only its kind ("Expected values to be strictly equal:"): the values say more.
      const values = r.expected !== null || r.actual !== null ? ` (expected ${r.expected ?? '?'}, actual ${r.actual ?? '?'})` : '';
      const said = oneLine(relative(`${(r.error ?? '').replace(/:\s*$/, '')}${values}`, dir));
      if (r.directive === 'SKIP') rows.push({ ...base, outcome: 'could-not-run', detail: 'skipped at the base' });
      else if (r.directive === 'TODO') rows.push({ ...base, outcome: 'could-not-run', detail: 'marked todo: its result does not count' });
      else if (r.ok) rows.push({ ...base, outcome: 'passes-without-change', detail: '' });
      else if (r.failureType === 'testTimeoutFailure') rows.push({ ...base, outcome: 'could-not-run', detail: `timed out at the base: ${said}` });
      else if (r.failureType === 'cancelledByParent') rows.push({ ...base, outcome: 'could-not-run', detail: 'cancelled: the test around it ended first' });
      else if (r.failureType === 'hookFailure') rows.push({ ...base, outcome: 'could-not-run', detail: `a hook failed before it ran: ${said}` });
      else rows.push({ ...base, outcome: 'fails-without-change', detail: said || r.failureType || 'failed' });
    }
  }
  return { rows, missing, loadError: null };
}

const sourceName = (calls: TestCall[], index: number): string => {
  const parts: string[] = [];
  for (let c: number | null = index; c !== null; c = calls[c]!.parent) parts.unshift(calls[c]!.name ?? calls[c]!.nameSrc);
  return parts.join(' > ');
};

/**
 * Run the check. Null only when `signal` aborted it (a cancel, a stop, the run's deadline): a command killed by the
 * abort says nothing about a test, so nothing is concluded. Every other failure — a git error, an unwritable
 * scratch tree, a refused sandbox, a runner that throws — is a `could-not-run` row for every changed test, never a
 * result that reads as clean.
 */
export async function revertTestsCheck(opts: RevertTestsOptions): Promise<RevertTestsResult | null> {
  if (typeof opts.run !== 'function') throw new TypeError('revertTestsCheck needs a runner (opts.run): pass one that runs the command sandboxed');
  const now = opts.now ?? Date.now;
  const perTestMs = opts.perTestMs ?? REVERT_TESTS_DEFAULTS.perTestMs;
  const perFileMs = opts.perFileMs ?? REVERT_TESTS_DEFAULTS.perFileMs;
  const budgetMs = opts.budgetMs ?? REVERT_TESTS_DEFAULTS.budgetMs;
  const loadMs = opts.loadMs ?? REVERT_TESTS_DEFAULTS.loadMs;
  const log = opts.log ?? ((): void => {});
  const na = (reason: string): RevertTestsResult => ({ version: 1, status: 'n/a', reason, tests: [], unattributed: [], runMs: 0, runs: 0 });
  const aborted = (): boolean => opts.signal?.aborted === true;

  // What is known so far, for the could-not-run answer if anything below throws.
  const targets: Array<{ file: string; calls: TestCall[]; tests: ChangedTest[] }> = [];
  const unattributed: RevertTestsResult['unattributed'] = [];
  let runMs = 0;
  let runs = 0;
  const failAll = (why: string): RevertTestsResult => ({
    version: 1,
    status: 'could-not-run',
    reason: `the check could not run: ${oneLine(why, 300)}`,
    tests: targets.flatMap((f) => f.tests.map((t) => ({
      file: f.file, name: sourceName(f.calls, t.index), line: t.call.line, change: t.change, outcome: 'could-not-run' as const, detail: oneLine(why),
    }))),
    unattributed,
    runMs,
    runs,
  });

  let dir: string | null = null;
  try {
    if (!opts.base) throw new Error('the base commit of the work could not be found');
    const base = opts.base;
    const changes = await listChanges(opts.repo, base, opts.tree);
    if (changes.length === 0) return na('the diff is empty');
    const sides = (c: Change): string[] => (c.from ? [c.path, c.from] : [c.path]);
    if (changes.every((c) => sides(c).every(isTestPath))) return na('test-only: the diff has no non-test file to put back');
    if (changes.every((c) => sides(c).every((p) => isTestPath(p) || isDocPath(p)))) {
      return na('besides tests the diff changes documentation only: there is no code change to put back');
    }

    // --- which tests: read off the two versions of each changed test file ---
    for (const c of changes) {
      if (c.status === 'D' || !isTestPath(c.path) || !/\.[cm]?[jt]sx?$/.test(c.path)) continue;
      const after = await blob(opts.repo, opts.tree, c.path);
      if (after === null) continue;
      const before = await blob(opts.repo, base, c.from ?? c.path);
      let changed = allLines(after);
      if (before !== null) {
        const hunks = await git(opts.repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', `${base}:${c.from ?? c.path}`, `${opts.tree}:${c.path}`]);
        changed = changedLinesOf(hunks);
      }
      const found = changedTests(before, after, changed);
      if (found.unattributed > 0) unattributed.push({ file: c.path, lines: found.unattributed });
      if (found.tests.length > 0) targets.push({ file: c.path, calls: findTests(after), tests: found.tests });
    }
    if (targets.length === 0) return na('the diff adds or changes no test (its test-side changes are outside any test)');

    // --- the scratch tree: the base, with the test side of the diff on it ---
    if (!/^[A-Za-z0-9._-]+$/.test(opts.runId)) return failAll('the run id is not a safe directory name');
    const scratch = path.join(opts.workRoot, `revert-tests-${opts.runId}`);
    // Whatever is already there is not ours to reuse, and not ours to remove.
    if (exists(scratch)) return failAll(`${scratch} already exists`);
    await fsp.mkdir(opts.workRoot, { recursive: true });
    // Checked out with every filter and merge driver the repo (or an include only the new worktree matches)
    // names switched off: the worker can write the config and info/attributes, and a smudge program there ran here.
    await checkoutWorktree(opts.repo, scratch, ['--detach'], base);
    dir = scratch;
    for (const c of changes) {
      // A test-side file the diff removed or renamed away is gone from the scratch tree too.
      const gone = c.status === 'D' ? c.path : c.from;
      if (gone && isTestPath(gone)) {
        const target = inside(scratch, gone);
        if (target) await fsp.rm(withinScratch(scratch, target, gone), { recursive: true, force: true });
      }
      if (c.status !== 'D' && isTestPath(c.path)) await writeFromTree(opts.repo, opts.tree, scratch, c.path);
    }
    await provisionDeps(scratch, opts.repo, { allowInstall: false });

    const script = nodeTestScript(scratch);
    if (!script) return failAll('the test script is not `node --test`, so one file cannot be run on its own');
    // A file the test command does not run (outside its patterns) has no tests the project runs.
    for (let k = targets.length - 1; k >= 0; k--) {
      if (!isRunnableTest(scratch, targets[k]!.file)) {
        unattributed.push({ file: targets[k]!.file, lines: 0 });
        targets.splice(k, 1);
      }
    }
    if (targets.length === 0) return na('no changed test is in a file the test command runs');

    // --- one run per file ---
    const rows: RevertTestRow[] = [];
    const runOnce = async (file: string, patterns: string[] | null, count: number): Promise<{ output: string; killed: boolean } | null> => {
      const left = budgetMs - runMs;
      if (left <= 0) return null;
      // A file that hangs at the base costs at most this: its load, a test's bound per changed test, the file cap.
      const limit = Math.min(perFileMs, loadMs + perTestMs * Math.max(1, count), left);
      const cmd = fileCommand(script.flags, file, perTestMs, patterns);
      if (aborted()) throw new Error('the run was aborted');
      const started = now();
      runs++;
      const res = await opts.run(scratch, cmd, limit);
      runMs += Math.max(0, now() - started - (res.waitedMs ?? 0));
      if (res.refused) throw new Error(`the sandbox refused the command: ${oneLine(res.output)}`);
      log(`revert check: ${file} ran in ${((now() - started - (res.waitedMs ?? 0)) / 1000).toFixed(1)}s${res.timedOut ? ` (killed at its ${Math.round(limit / 1000)} s bound)` : ''}`);
      return { output: typeof res.output === 'string' ? res.output : '', killed: res.timedOut };
    };
    for (const f of targets) {
      const sourceRow = (t: ChangedTest, detail: string): RevertTestRow => ({
        file: f.file, name: sourceName(f.calls, t.index), line: t.call.line, change: t.change, outcome: 'could-not-run', detail,
      });
      const pats = f.tests.map((t) => namePatternFor(f.calls, t.index));
      const filter = pats.every((p): p is string => p !== null) ? [...new Set(pats)] : null;
      let first = await runOnce(f.file, filter, f.tests.length);
      if (aborted()) return null;
      if (!first) {
        rows.push(...f.tests.map((t) => sourceRow(t, `not run: the ${Math.round(budgetMs / 1000)} s run-time budget was spent`)));
        continue;
      }
      let got = rowsFromRun(scratch, f.file, f.calls, f.tests, first.output);
      // A filter that matched nothing it should have (a name node builds differently): once more, unfiltered.
      if (filter && got.loadError === null && !first.killed && got.missing.length > 0) {
        const again = await runOnce(f.file, null, f.calls.filter((c) => c.kind === 'test').length);
        if (aborted()) return null;
        if (again) {
          first = again;
          const retry = rowsFromRun(scratch, f.file, f.calls, got.missing, again.output);
          got = { rows: [...got.rows, ...retry.rows], missing: retry.missing, loadError: retry.loadError };
        }
      }
      rows.push(...got.rows);
      for (const t of got.missing) {
        rows.push(sourceRow(t, got.loadError !== null ? `the file did not load at the base: ${got.loadError}`
          : first.killed ? 'the run was killed at its time bound before this test reported'
            : 'it did not report at the base (not reached, or its name was not matched)'));
      }
    }
    if (aborted()) return null;
    const count = (o: RevertTestOutcome): number => rows.filter((r) => r.outcome === o).length;
    return {
      version: 1,
      status: 'ran',
      reason: `${rows.length} changed test(s): ${count('fails-without-change')} fail without the change, ${count('passes-without-change')} pass without it, ${count('could-not-run')} could not run`,
      tests: rows,
      unattributed,
      runMs,
      runs,
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

/**
 * Should the check run for this run at all? Only with FOREMAN_REVERT_TESTS on, for a code ticket in a repo whose
 * worker finished and whose test step ran and passed, with a diff and a recorded reviewed tree, on a run not
 * stopped. Never for writing or research kinds; never on red tests (there is nothing to read a pass against).
 */
export function revertTestsApplies(o: {
  enabled: boolean; kind: string; repo: string | null | undefined; workerOk: boolean; testsRan: boolean; testsPassed: boolean;
  diff: string; tree: string | null | undefined; aborted: boolean;
}): boolean {
  return o.enabled && o.kind === 'code' && Boolean(o.repo) && o.workerOk && o.testsRan && o.testsPassed
    && o.diff.trim() !== '' && Boolean(o.tree) && !o.aborted;
}

const NOTE_MAX = 6_000;

/**
 * The table for the reviewer and the owner gate, worded so it decides nothing. Null when there is nothing to say
 * (n/a). The rows that pass without the change come first: they are the ones a reviewer has to read.
 */
export function revertTestsNote(r: RevertTestsResult | null): string | null {
  if (!r || r.status === 'n/a') return null;
  const n = (o: RevertTestOutcome): number => r.tests.filter((t) => t.outcome === o).length;
  const head = [
    'FOREMAN REVERT CHECK (a reviewer aid; it decides nothing): each test this diff adds or changes was run with the',
    "diff's non-test files put back to the base commit.",
    r.status === 'could-not-run' ? `- ${r.reason}` : null,
    `- fails without the src change: ${n('fails-without-change')}`,
    `- passes without the src change: ${n('passes-without-change')} — either it does not test the change, or it pins behaviour that must not change; the reviewer decides which`,
    `- could not run: ${n('could-not-run')}`,
    ...r.unattributed.filter((u) => u.lines > 0).map((u) => `- ${u.file}: ${u.lines} changed line(s) in no test (helpers, imports, fixtures) — not attributed to a test`),
  ].filter((l): l is string => l !== null);
  const order: RevertTestOutcome[] = ['passes-without-change', 'could-not-run', 'fails-without-change'];
  const label: Record<RevertTestOutcome, string> = {
    'passes-without-change': 'PASSES without the change',
    'could-not-run': 'could not run',
    'fails-without-change': 'fails without the change',
  };
  const rows = order.flatMap((o) => r.tests.filter((t) => t.outcome === o).map((t) =>
    `  [${label[o]}] ${t.file}:${t.line} "${oneLine(t.name, 160)}" (${t.change})${t.detail ? ` — ${t.detail}` : ''}`));
  const out = [...head, ...rows];
  let text = out.join('\n');
  if (text.length > NOTE_MAX) {
    let kept = head.length;
    while (kept < out.length && out.slice(0, kept + 1).join('\n').length < NOTE_MAX - 120) kept++;
    text = `${out.slice(0, kept).join('\n')}\n  [FOREMAN cut ${out.length - kept} more row(s); the whole table is on the run's revert-tests artifact]`;
  }
  return text;
}

/** One line for the artifact row and `foreman show`. */
export function revertTestsSummary(r: RevertTestsResult): string {
  if (r.status !== 'ran') return `revert check ${r.status}: ${oneLine(r.reason, 300)}`;
  const n = (o: RevertTestOutcome): number => r.tests.filter((t) => t.outcome === o).length;
  return `revert check: ${n('fails-without-change')} fail, ${n('passes-without-change')} pass, ${n('could-not-run')} could not run without the src change`;
}

/** The file a run's result is kept in, under the artifact root (like `<run>.assertions.json`). */
export const revertTestsPath = (runId: string, root: string = config.artifactRoot): string => path.join(root, `${runId}.revert-tests.json`);

/**
 * Store the result: the JSON file, and a `revert-tests` artifact row whose summary is one line. The row holds
 * nothing back: gate.ts asks it for no hold.
 */
export function recordRevertTests(store: Store, runId: string, taskId: string, r: RevertTestsResult): void {
  const file = revertTestsPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Whole or not at all: a reader never sees half a file (it would read as no result).
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(r, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  store.addArtifact({ runId, taskId, type: 'revert-tests', path: file, summary: revertTestsSummary(r) });
}

/** A stored result read back, or null: no file, or one that is not this shape. */
export function readRevertTests(file: string): RevertTestsResult | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as RevertTestsResult;
    return v && v.version === 1 && Array.isArray(v.tests) && typeof v.status === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The note for a run whose result was recorded earlier (a re-review, the owner gate); null when there is none. */
export function storedRevertTestsNote(store: Store, run: Run | null): string | null {
  if (!run) return null;
  const row = store.artifactsForTask(run.taskId).filter((a) => a.type === 'revert-tests' && a.runId === run.id).at(-1);
  return row ? revertTestsNote(readRevertTests(row.path)) : null;
}

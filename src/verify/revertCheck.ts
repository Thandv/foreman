import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { provisionDeps } from '../deps.ts';
import { checkoutWorktree, PINNED, pinnedEnv, pinnedGit, type ChangedFile } from '../isolate.ts';
import { isTestPath } from './literals.ts';
import { removeScratch } from './tests.ts';

/**
 * "This test would fail on the old code" is a claim reviewers make without
 * running anything; the operator rejected eight passes that rested on it. This
 * is the claim run mechanically: put a scratch tree at the work's base, carry
 * over only the test-side changes, run each changed test file there, and
 * require a non-zero exit. A test that passes without the change proves nothing
 * about the change.
 *
 * Nothing here writes inside the jail: the jail is only read from. The per-file
 * `revertCheck` below is not wired to a caller: a file with one meaningful new
 * test passes it however vacuous its other new tests are. What the scheduler
 * runs is the per-test check (verify/revertTests.ts), built on the helpers here.
 */

export interface RevertCheckResult {
  status: 'pass' | 'gap' | 'n/a' | 'skipped' | 'inconclusive';
  /** One line for the park note. */
  reason: string;
  files: Array<{ file: string; outcome: 'fails-without-change' | 'passes-without-change' | 'timeout' | 'not-run' }>;
  /**
   * The `fails-without-change` files in which no test ran: the file did not load
   * in the reverted tree, or node refused to start. That is still a failure
   * without the change, and often an honest one (the test imports something the
   * change adds), but no assertion was reached — the caller decides what it is worth.
   */
  loadErrors?: string[];
  /**
   * The `fails-without-change` files for which that question has no answer: the
   * report is in a form that is not read here (a reporter other than spec or tap,
   * or one written to a file), or the run printed nothing at all.
   */
  loadUnknown?: string[];
}

type FileOutcome = RevertCheckResult['files'][number];

/**
 * Every git call here runs in the daemon, in the operator's repo or in the jail, and both read a config and a git
 * directory the worker can write. So they go through isolate.ts's own (`pinnedGit`): no hooks — `worktree add` runs
 * post-checkout — no fsmonitor program, no extra attributes file, no signing, objects read as stored, no GIT_*
 * variable of the daemon's pointing the call at another repository, and every filter and merge driver the config
 * names switched off (`hash-object -- <path>` ran a clean filter, `merge-tree` a merge driver).
 */
export { PINNED, pinnedEnv };

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await pinnedGit(cwd, args)).stdout;
}

const DOC_PATH = /\.(md|txt|rst)$|^docs\//;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** Code, scripts, config and build files: none of them is documentation, wherever it is kept. */
const NOT_PROSE_EXT = new RegExp(`\\.(${[
  '[cm]?[jt]sx?', 'py[iwx]?', 'rb', 'go', 'rs', 'java', 'kts?', 'scala', 'swift', 'php', 'p[lm]', 'lua', 'r', 'jl', 'ex', 'exs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'm', 'mm', 'cs', 'fs', 'vb', 'zig', 'nim', 'dart', 'wasm', 'wat',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'awk', 'sed', 'sql',
  'json', 'jsonc', 'json5', 'ya?ml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'lock', 'xml', 'proto', 'graphql',
  'cmake', 'mk', 'mak', 'gradle', 'bazel', 'bzl', 'ninja', 'nix', 'tf', 'dockerfile',
].join('|')})$`, 'i');
const NOT_PROSE_NAME = /^(CMakeLists\.txt|(requirements|constraints)[^/]*\.txt|(GNU)?[Mm]akefile|Dockerfile|Rakefile|Gemfile|Justfile|BUILD|WORKSPACE)$/;
/** Directories whose files are read at runtime: a .md or .txt there is a prompt or a skill, which is code. */
const RUNTIME_DIR = /(^|\/)(src|lib|bin|scripts|prompts|skills|agents)\//;

/**
 * Is this changed path documentation, with nothing in it for a test to prove?
 * The pattern alone is not enough: `docs/build.js`, `requirements.txt` and
 * `src/prompt.txt` all match it and all change what the code does.
 */
export function isDocPath(rel: string): boolean {
  if (!DOC_PATH.test(rel)) return false;
  if (NOT_PROSE_EXT.test(rel) || NOT_PROSE_NAME.test(path.posix.basename(rel))) return false;
  return !RUNTIME_DIR.test(rel);
}

/** Flags whose value is the NEXT word when written without `=`; that word is not a file pattern. */
const VALUE_FLAGS = new Set([
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-shard',
  '--test-concurrency', '--test-timeout', '--test-coverage-include', '--test-coverage-exclude', '--test-isolation',
  '--import', '--require', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists', '--conditions',
]);

/** Words of a package.json script up to the first shell operator, quotes removed. */
function words(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)) {
    if (/^(&&|\|\||[;|&])$/.test(m[0])) break;
    out.push(m[0].replace(/'([^']*)'|"([^"]*)"/g, (_all, a?: string, b?: string) => a ?? b ?? ''));
  }
  return out;
}

/** The flags and the file patterns of a `node … --test …` script, or null when it is not one. */
export function nodeTestScript(dir: string): { flags: string[]; patterns: string[] } | null {
  let script: string;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const raw = pkg.scripts?.['test'];
    if (typeof raw !== 'string') return null;
    script = raw.trim();
  } catch {
    return null;
  }
  if (!/^node (--\S+ )*--test\b/.test(script)) return null;
  const args = words(script).slice(1);
  // `--test\b` also matches the start of `--test-timeout`; the runner flag itself must be there.
  if (!args.includes('--test')) return null;
  const flags: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--test') continue;
    if (!arg.startsWith('-')) {
      patterns.push(arg);
      continue;
    }
    flags.push(arg);
    if (VALUE_FLAGS.has(arg) && i + 1 < args.length) flags.push(args[++i]!);
  }
  return { flags, patterns };
}

export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that runs ONE test file the way the project's own `test` script
 * would: same node flags, the file in place of the script's patterns. null for
 * any other kind of test script — there is no general way to aim an arbitrary
 * runner at one file, and a guess that exits non-zero would read as "fails
 * without the change".
 */
export function perFileTestCmd(dir: string, file: string): string | null {
  const parsed = nodeTestScript(dir);
  if (!parsed) return null;
  return ['node', ...parsed.flags.map(shq), '--test', shq(file)].join(' ');
}

/**
 * Would the project's test command run this file at all? A changed helper under
 * test/ (Foreman's own test/env.ts) exits 0 under `node --test` with no test in
 * it, which would read as a test that passes without the change. So the script's
 * own patterns decide when it names any; with none, any code file on the test
 * side counts, as in node's default search.
 */
export function isRunnableTest(dir: string, file: string): boolean {
  if (!CODE_FILE.test(file)) return false;
  const patterns = nodeTestScript(dir)?.patterns ?? [];
  if (patterns.length === 0) return true;
  return patterns.some((raw) => {
    const pattern = raw.replace(/^\.\//, '');
    if (file === pattern || file.startsWith(pattern.replace(/\/*$/, '/'))) return true;
    try {
      return path.matchesGlob(file, pattern);
    } catch {
      return false;
    }
  });
}

/** `rel` under `root`, or null when it would land outside it. */
export function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}

export function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * `abs`, which is `rel` under the scratch tree `root`, when no symlink on the
 * way to it leads out of the tree. The base tree can carry a committed symlink
 * (`tests -> /somewhere/else`) that the diff replaced with a real directory:
 * the link's own path is not test-side, so it is still there, and a copy or a
 * delete below it would land on the far side. Refused rather than repaired —
 * what the reverted tree should look like there is not ours to guess.
 */
export function withinScratch(root: string, abs: string, rel: string): string {
  let parent = path.dirname(abs);
  while (!exists(parent)) parent = path.dirname(parent);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(parent);
    realRoot = fs.realpathSync(root);
  } catch {
    throw new Error(`${rel} is behind a symlink that does not resolve; nothing was written through it`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`${rel} resolves outside the scratch worktree; nothing was written through it`);
  }
  return abs;
}

/** A rename that left the content alone: the blob at `base:from` is the file in the jail. Reads only. */
async function unchangedRename(repo: string, jailDir: string, base: string, c: ChangedFile): Promise<boolean> {
  if (c.status !== 'renamed' || !c.from || !inside(jailDir, c.path)) return false;
  try {
    const [was, now] = await Promise.all([
      git(repo, ['rev-parse', '--verify', `${base}:${c.from}`]),
      git(jailDir, ['hash-object', '--', c.path]),
    ]);
    return was.trim() === now.trim();
  } catch {
    return false;
  }
}

/**
 * Why the test report of this script cannot be read by `noTestRan`, or null
 * when it can: only spec and TAP are read, and only when they are printed.
 */
function unreadableReport(flags: string[]): string | null {
  const value = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === flag) out.push(flags[i + 1] ?? '');
      else if (flags[i]!.startsWith(`${flag}=`)) out.push(flags[i]!.slice(flag.length + 1));
    }
    return out;
  };
  const reporters = value('--test-reporter');
  const destinations = value('--test-reporter-destination');
  // Several reporters, each with its own destination (node pairs them in order): the report is readable when the
  // only one that prints is spec or tap, whatever the others write to files. Kiln's test script is this shape — spec
  // to stdout beside a skip list written to a file — and read as a whole it made every Kiln result "unreadable".
  if (reporters.length > 1 && destinations.length === reporters.length) {
    const printed = reporters.filter((_name, i) => destinations[i] === 'stdout' || destinations[i] === 'stderr');
    if (printed.length === 0) return 'the test report is written to a file';
    if (printed.length > 1) return 'more than one test reporter prints its report';
    return printed[0] === 'spec' || printed[0] === 'tap' ? null : 'the test reporter is not spec or tap';
  }
  if (reporters.some((name) => name !== 'spec' && name !== 'tap')) return 'the test reporter is not spec or tap';
  if (destinations.some((to) => to !== 'stdout' && to !== 'stderr')) return 'the test report is written to a file';
  return null;
}

/**
 * Did a failed run of `file` reach no test at all? Read off the runner's own
 * report (spec or TAP). Node prints no `tests N` summary when it refuses to
 * start (a bad option, a command the shell could not parse), and reports a file
 * it could not load — a missing export, a missing module, a syntax error — as
 * ONE failing test named after the file. A test can be given that name too, so
 * the name is not enough: the failure must also carry the runner's own mark for
 * the file as a whole. Where the report locates the failure, that is the top of
 * the file, `<file>:1:1` (a test sits where it was written; and with
 * --test-isolation=none the location is the only mark there is). Where it does
 * not, it is the error `'test failed'`, which is all the runner says of a file
 * whose process exited non-zero.
 */
function noTestRan(dir: string, file: string, output: string): boolean {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const count = (key: string): number | null => {
    let last: number | null = null;
    for (const line of lines) {
      const m = new RegExp(`^\\s*(?:ℹ|#) ${key} (\\d+)\\s*$`).exec(line);
      if (m) last = Number(m[1]);
    }
    return last;
  };
  const tests = count('tests');
  if (tests === null || tests === 0) return true;
  if (tests !== 1 || count('fail') !== 1) return false;

  const want = path.resolve(dir, file);
  const isFile = (name: string): boolean => path.resolve(dir, name) === want;
  const located: boolean[] = [];
  let wholeFileError = false;
  for (let i = 0; i < lines.length; i++) {
    const spec = /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/.exec(lines[i]!);
    if (spec && isFile(spec[1]!)) {
      // In the list of failing tests: `test at <where>` above the name, the error below it.
      const at = /^\s*test at .+:(\d+):(\d+)\s*$/.exec(lines[i - 1] ?? '');
      if (at) located.push(at[1] === '1' && at[2] === '1');
      if ((lines[i + 1] ?? '').trim() === "'test failed'") wholeFileError = true;
      continue;
    }
    // Top-level TAP points only: a suite's own tests are indented under it.
    const tap = /^not ok \d+ - (.+?)\s*$/.exec(lines[i]!);
    if (!tap || !isFile(tap[1]!)) continue;
    for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]!) && lines[j]!.trim() !== '...'; j++) {
      const at = /^\s+location: .*:(\d+):(\d+)['"]?\s*$/.exec(lines[j]!);
      if (at) located.push(at[1] === '1' && at[2] === '1');
      if (/^\s+error: ['"]test failed['"]\s*$/.test(lines[j]!)) wholeFileError = true;
    }
  }
  return located.length > 0 ? located.includes(true) : wholeFileError;
}

/**
 * Is this a test report that lost its `tests N` summary? `noTestRan` reads a
 * missing summary as "node refused to start", which is right for the two or
 * three lines node prints then. But the caller may keep only the end of a long
 * output, and spec prints the summary BEFORE the failing tests: sixteen failing
 * tests, or one long assertion diff, push it out of a 400-line tail. What is
 * left still shows that tests ran — the reporter's own marks, a frame of the
 * runner calling a test function — or is simply too long to be a refusal to
 * start. That is a report that cannot be read, not a file that did not load.
 */
const REFUSAL_MAX_LINES = 60;
function summaryCut(output: string): boolean {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (/^\s*(?:ℹ|#) tests \d+\s*$/m.test(plain)) return false;
  if (/^\s*(?:[✖✔▶﹣] |(?:not )?ok \d+ |# Subtest: |TAP version \d+\s*$|test at .+:\d+:\d+\s*$)/m.test(plain)) return true;
  if (/\(node:internal\/test_runner\/test:\d+:\d+\)/.test(plain)) return true;
  return plain.split(/\r?\n/).length > REFUSAL_MAX_LINES;
}

/** What a rejection carried, whatever it was: `run` is the caller's and may reject with anything. */
export function messageOf(err: unknown): string {
  // An Error's message is a string by convention only; one that is not, or that throws when read, must not throw from a catch.
  try {
    if (err instanceof Error) return String(err.message || err.name || 'Error');
  } catch {
    return 'rejected with an Error whose message could not be read';
  }
  if (typeof err === 'string' && err.trim()) return err;
  return `rejected with ${typeof err === 'object' && err !== null ? 'a non-Error object' : String(err)}`;
}

export async function revertCheck(opts: {
  repo: string;
  jailDir: string;
  base: string;
  changed: ChangedFile[];
  workRoot: string;
  runId: string;
  /**
   * Runs one test file's command in the scratch tree. Required, and there is no built-in one: the command is the
   * worker's test code, so whoever wires this check in passes a runner that goes through the sandbox
   * (verify/tests.ts runTests), never a plain spawn.
   */
  run: (dir: string, cmd: string, timeoutMs: number) => Promise<{ passed: boolean; timedOut: boolean; output: string }>;
  /** default 180_000 */
  perFileTimeoutMs?: number;
  /** default 600_000 */
  totalBudgetMs?: number;
}): Promise<RevertCheckResult> {
  // Before anything else, so a call wired without a runner fails on every diff, not only on one that reaches a test.
  if (typeof opts.run !== 'function') throw new TypeError('revertCheck needs a runner (opts.run): pass one that runs the command sandboxed');
  const started = Date.now();
  const perFile = opts.perFileTimeoutMs ?? 180_000;
  const budget = opts.totalBudgetMs ?? 600_000;
  const na = (reason: string): RevertCheckResult => ({ status: 'n/a', reason, files: [] });

  const { changed } = opts;
  if (changed.length === 0) return na('no test in the diff: the diff is empty');
  // A rename changes two paths. `src/x.js -> docs/x.md` (or `-> test/helpers/x.js`) takes a source file away,
  // which is a change to revert, whatever the name it was given afterwards.
  const each = (c: ChangedFile, is: (rel: string) => boolean): boolean => is(c.path) && (c.status !== 'renamed' || !c.from || is(c.from));
  if (changed.every((c) => each(c, isTestPath))) return na('test-only: the diff has no non-test file to revert');
  if (changed.every((c) => each(c, isDocPath))) return na('docs-only: every changed path is documentation');
  // Tests beside documentation: still nothing to put back, so a test that holds at base is no finding.
  if (changed.every((c) => each(c, (rel) => isTestPath(rel) || isDocPath(rel)))) {
    return na('test-only: besides tests the diff changes documentation only, so there is no non-test file to revert');
  }
  const testSide = changed.filter((c) => c.status !== 'deleted' && isTestPath(c.path));
  // A test that was only moved passes at base exactly as it did before the move: it says nothing about the change.
  const moved = new Set<string>();
  for (const c of testSide) {
    if (await unchangedRename(opts.repo, opts.jailDir, opts.base, c)) moved.add(c.path);
  }
  const candidates = testSide.filter((c) => !moved.has(c.path)).map((c) => c.path);
  if (candidates.length === 0) {
    return na(moved.size > 0
      ? 'no test in the diff: the only test files in it were renamed with their content unchanged'
      : 'no test in the diff: no test file was added or changed');
  }

  const notRun = (list: string[]): FileOutcome[] => list.map((file) => ({ file, outcome: 'not-run' as const }));
  if (!/^[A-Za-z0-9._-]+$/.test(opts.runId)) {
    return { status: 'inconclusive', reason: 'revert check could not run: the run id is not a safe directory name', files: notRun(candidates) };
  }
  const dir = path.join(opts.workRoot, `revert-${opts.runId}`);
  // Whatever is already there is not ours to reuse, and not ours to remove.
  if (exists(dir)) {
    return { status: 'inconclusive', reason: `revert check could not run: ${dir} already exists`, files: notRun(candidates) };
  }

  try {
    await fsp.mkdir(opts.workRoot, { recursive: true });
    await checkoutWorktree(opts.repo, dir, ['--detach'], opts.base);

    // The test side of the diff, and nothing else, on top of the base tree.
    for (const c of changed) {
      const gone = c.status === 'deleted' ? c.path : c.from;
      if (gone && isTestPath(gone)) {
        const target = inside(dir, gone);
        if (target) await fsp.rm(withinScratch(dir, target, gone), { recursive: true, force: true });
      }
      if (c.status === 'deleted' || !isTestPath(c.path)) continue;
      const from = inside(opts.jailDir, c.path);
      const to = inside(dir, c.path);
      if (!from || !to || !exists(from)) continue;
      withinScratch(dir, to, c.path);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true });
    }

    await provisionDeps(dir, opts.repo, { allowInstall: false });

    const present = candidates.filter((file) => {
      const abs = inside(dir, file);
      return abs !== null && exists(abs);
    });
    if (present.length > 0 && perFileTestCmd(dir, present[0]!) === null) {
      return {
        status: 'skipped',
        reason: 'the test script is not `node --test`, so one test file cannot be run on its own',
        files: notRun(present),
      };
    }
    const tests = present.filter((file) => isRunnableTest(dir, file));
    if (tests.length === 0) return na('no test in the diff: the changed test-side files are not ones the test command runs');

    const files: FileOutcome[] = [];
    const loadErrors: string[] = [];
    const unknown = new Map<string, string[]>();
    const unreadable = unreadableReport(nodeTestScript(dir)?.flags ?? []);
    for (const file of tests) {
      const left = budget - (Date.now() - started);
      if (left <= 0) {
        files.push({ file, outcome: 'not-run' });
        continue;
      }
      const res = await opts.run(dir, perFileTestCmd(dir, file)!, Math.min(perFile, left));
      // A timeout first: a killed run says nothing about the test, whatever else it reports.
      files.push({ file, outcome: res.timedOut ? 'timeout' : res.passed ? 'passes-without-change' : 'fails-without-change' });
      if (res.timedOut || res.passed) continue;
      const output = typeof res.output === 'string' ? res.output : '';
      // Silence is not a report, and a report that is not read here is not guessed at: both are said, not dropped.
      const why = !output.trim() ? 'the run printed nothing'
        : unreadable ?? (summaryCut(output) ? 'the test report has no summary: the output was cut or is not a spec or tap report' : null);
      if (why !== null) unknown.set(why, [...(unknown.get(why) ?? []), file]);
      else if (noTestRan(dir, file, output)) loadErrors.push(file);
    }
    // The statuses are decided by the outcomes alone; this only says which failures never reached a test.
    const loadUnknown = [...unknown.values()].flat();
    const loaded = { ...(loadErrors.length > 0 ? { loadErrors } : {}), ...(loadUnknown.length > 0 ? { loadUnknown } : {}) };
    const unloaded = (loadErrors.length > 0 ? `; no test ran (the file did not load without the change) in: ${loadErrors.join(', ')}` : '')
      + [...unknown].map(([why, list]) => `; cannot tell whether any test ran (${why}) in: ${list.join(', ')}`).join('');

    const names = (outcome: FileOutcome['outcome']): string[] => files.filter((f) => f.outcome === outcome).map((f) => f.file);
    const passing = names('passes-without-change');
    if (passing.length > 0) {
      return { status: 'gap', reason: `passes without the change: ${passing.join(', ')}${unloaded}`, files, ...loaded };
    }
    const timedOut = names('timeout');
    const unrun = names('not-run');
    if (timedOut.length > 0 || unrun.length > 0) {
      const parts = [
        timedOut.length > 0 ? `timed out without the change: ${timedOut.join(', ')}` : '',
        unrun.length > 0 ? `the ${Math.round(budget / 1000)} s budget ran out before: ${unrun.join(', ')}` : '',
      ].filter(Boolean);
      return { status: 'inconclusive', reason: parts.join('; ') + unloaded, files, ...loaded };
    }
    return { status: 'pass', reason: `${files.length} changed test file${files.length === 1 ? '' : 's'} fail${files.length === 1 ? 's' : ''} without the change${unloaded}`, files, ...loaded };
  } catch (err) {
    return { status: 'inconclusive', reason: `revert check could not run: ${oneLine(messageOf(err))}`, files: notRun(candidates) };
  } finally {
    await git(opts.repo, ['worktree', 'remove', '--force', dir]).catch(() => '');
    removeScratch(dir);
    await git(opts.repo, ['worktree', 'prune']).catch(() => '');
  }
}

/**
 * Would the work's tree still merge onto where the repo's HEAD is now? Asked
 * with plumbing only: a dangling commit for the tree (no ref is written) and
 * `git merge-tree`, which builds the merged tree in the object store. Nothing
 * is checked out and neither the index nor the working tree is read or written.
 */
export async function appliesOnMain(opts: { repo: string; base: string; tree: string }): Promise<{
  status: 'same-base' | 'clean' | 'conflict';
  head: string;
  conflicted: string[];
  mergedTree?: string;
}> {
  const head = (await git(opts.repo, ['rev-parse', 'HEAD'])).trim();
  const base = (await git(opts.repo, ['rev-parse', '--verify', `${opts.base}^{commit}`])).trim();
  if (head === base) return { status: 'same-base', head, conflicted: [] };

  // An identity of its own: commit-tree refuses to run in a repo with none configured.
  const commit = (await git(opts.repo, [
    '-c', 'user.name=foreman', '-c', 'user.email=foreman@localhost',
    'commit-tree', opts.tree, '-p', base, '-m', 'revert-check',
  ])).trim();

  let stdout: string;
  let conflict = false;
  try {
    stdout = await git(opts.repo, ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', head, commit]);
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    // Exit 1 is the answer "it conflicts"; anything else is git failing to answer.
    if (e.code !== 1 || typeof e.stdout !== 'string') throw err;
    stdout = e.stdout;
    conflict = true;
  }
  const [tree = '', ...rest] = stdout.split('\0').map((s) => s.trim());
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree named no tree');
  if (!conflict) return { status: 'clean', head, conflicted: [], mergedTree: tree };
  return { status: 'conflict', head, conflicted: [...new Set(rest.filter(Boolean))] };
}

/**
 * A typecheck to run beside the revert check, when the project has one and the
 * gate does not already run it (a `verify` script is taken to include it).
 */
export function typecheckCmd(dir: string, gateCmd: string | null): string | null {
  if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) return null;
  if (gateCmd && /verify|tsc/.test(gateCmd)) return null;
  return 'npx tsc --noEmit';
}

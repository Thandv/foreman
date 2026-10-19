/**
 * What a ticket's test stage can say besides "passed" and "a test failed", worked out from the test command's
 * result and from the repo. Nothing here decides a run: the scheduler asks, and holds or annotates.
 *
 *  - A gate TIMEOUT. Kiln's gate ended `verify: TIMEOUT after 1200s` on a loaded machine with no failing test
 *    named; Foreman recorded "TESTS FAILED", wrote a fail verdict whose critique was a log of passing tests, and
 *    spent a repair round on a worker that had broken nothing.
 *  - A jail that is behind main where main has since changed the tests. A ticket's jail was cut before a test-only
 *    change the gate needed had landed; its gate failed ~20 tests the ticket never touched, and nothing said why.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { jailBase, type Jail } from '../isolate.ts';
import { isTestPath } from './literals.ts';
import { FailingBlocks } from './suiteOutput.ts';
import type { TestResult } from './tests.ts';

const exec = promisify(execFile);
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plainLines = (output: string): string[] => output.replace(ANSI_RE, '').split('\n');

/** Printed after the command's own last word: npm's notices, and what Foreman appends (the kill line, the sandbox note). */
const AFTERWORD = /^(npm (notice|warn|error|ERR!)|foreman: )/;
/** A last line that says the command stopped on its own wall-clock bound: `verify: TIMEOUT after 1200s`, `TIMEOUT`. */
const SAYS_TIMEOUT = /^\s*(?:[\w./-]{1,40}:\s*)?TIMEOUT\b(.*)$/;
const DURATION = /\b(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/;

export interface GateTimeout {
  /** How long the run was given, in seconds; null when the command's line does not say. */
  seconds: number | null;
  /** Who stopped it: Foreman's own bound (FOREMAN_TEST_TIMEOUT_MIN), or the command, by its last line. */
  by: 'foreman' | 'command';
}

/**
 * Lines by which a run says a test or a check of its own FAILED, in the runners a repo's gate is likely to be: a
 * run that prints one is a failure whatever its last line says, so a `TIMEOUT` after it never turns a red suite into
 * "the gate ran out of time". Read line by line; a false hit costs what a failure cost before this module existed
 * (a repair round), a miss parks failed work as a timeout. Each is anchored to the line's start, so a passing
 * test whose TITLE quotes such a line (`✔ reports error TS2322: …`) is not one.
 */
const SAYS_FAILED: readonly RegExp[] = [
  /^\s*✖\s/, /failing tests:/, // node:test, spec reporter
  /^\s*(?:ℹ|#)\s*fail(?:ed|ures)?\s+[1-9]/, // node:test's closing count (spec and TAP), when the ✖ lines scrolled out of the kept output
  /^\s*[\w./-]{1,40}:\s*FAIL(?:ED|URE)?\b/, // a gate script's own verdict: `verify: FAIL (tests exited 1)`
  /^(?:FAILED|ERROR)\s+\S/, /^=+ .*\b[1-9]\d* (?:failed|errors?)\b/, /^[1-9]\d* (?:failed|errors?)\b.*\bin [\d.]+ ?s\b/, // pytest
  /^test .* \.\.\. FAILED\s*$/, /^test result: FAILED/, // cargo
  /^\s*--- FAIL:/, /^FAIL(?:\s|$)/, // go
  /^\s*(?:FAIL|ERROR)\s+\S/, /^\s*Tests?( Files)?:?\s.*\b[1-9]\d* failed\b/, /^\s*[×✗✘]\s/, // jest, vitest
  /^\s*[1-9]\d* failing\b/, // mocha
  /^(?:\S+\(\d+,\d+\): )?error TS\d+:/, // tsc
];

/** True when the output says a test or check failed: a TAP `not ok` (not a skip or a todo), or a line SAYS_FAILED knows. */
export function namesFailingTest(output: string): boolean {
  return plainLines(output).some((line) =>
    (/^\s*not ok\b/.test(line) && !/#\s*(skip|todo)\b/i.test(line)) || SAYS_FAILED.some((re) => re.test(line)));
}

/**
 * The timeout a red test result is, or null when it is anything else. A timeout is a run Foreman killed at its own
 * bound, or one whose command's last line (npm's notices and Foreman's own lines aside) says TIMEOUT — and in which
 * no failing test is named: a run that names one is a failure whatever else happened to it.
 */
export function gateTimeout(result: TestResult): GateTimeout | null {
  if (!result.ran || result.passed) return null;
  // Named on a line the kept output has since dropped (tests.ts reads every line): still the work's own failure.
  if (result.namedFailure) return null;
  // Killed at Foreman's bound: only what was printed before the kill can name a failure of the work's own.
  if (result.killedAfterSec !== undefined) {
    return namesFailingTest(result.outputBeforeKill ?? result.output) ? null : { seconds: result.killedAfterSec, by: 'foreman' };
  }
  if (namesFailingTest(result.output)) return null;
  const lines = plainLines(result.output).filter((l) => l.trim() && !AFTERWORD.test(l.trim()));
  const said = SAYS_TIMEOUT.exec(lines.at(-1) ?? '');
  if (!said) return null;
  const d = DURATION.exec(said[1] ?? '');
  if (!d) return { seconds: null, by: 'command' };
  const unit = d[2]!;
  const n = Number(d[1]);
  return { seconds: Math.round(unit === 'ms' ? n / 1000 : unit.startsWith('m') ? n * 60 : n), by: 'command' };
}

/**
 * The tests a cut-short run had started and not finished, as far as its output says: node:test's spec reporter
 * lists them under "Interrupted while running:", and in TAP a top-level `# Subtest:` with no `ok`/`not ok` line
 * after it is one. Null when the output shows neither — which is "cannot tell", not "none".
 */
export function unfinishedTests(output: string): string[] | null {
  const lines = plainLines(output);
  const names: string[] = [];
  const add = (name: string): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  const at = lines.findLastIndex((l) => /Interrupted while running:/.test(l));
  if (at >= 0) {
    for (const line of lines.slice(at + 1)) {
      const m = /^\s*⚠\s+(.+?)(?:\s+\([^()]*\))?\s*$/.exec(line);
      if (!m) break;
      add(m[1]!.trim());
    }
  }
  let sawTap = false;
  const open: string[] = [];
  for (const line of lines) {
    const started = /^# Subtest: (.+)$/.exec(line);
    if (started) {
      sawTap = true;
      open.push(started[1]!.trim());
      continue;
    }
    const ended = /^(?:not )?ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
    if (ended) {
      const i = open.lastIndexOf(ended[1]!.trim());
      if (i >= 0) open.splice(i, 1);
    }
  }
  for (const name of open) add(name);
  return names.length || at >= 0 || sawTap ? names : null;
}

const secs = (t: GateTimeout): string => (t.seconds === null ? 'time not stated' : `${t.seconds} s`);

/** `gate timed out twice (<N> s each); not charged to the worker`, then what had not finished, then the output's end. */
export function timedOutTwiceNote(first: GateTimeout, second: GateTimeout, output: string, max: number): string {
  const each = first.seconds === second.seconds ? `${secs(first)} each` : `${secs(first)}, then ${secs(second)}`;
  const open = unfinishedTests(output);
  const shown = open?.slice(0, 8) ?? [];
  const unfinished = !open || !open.length
    ? 'cannot tell which test did not finish'
    : `started and not finished: ${shown.join(', ')}${open.length > shown.length ? ` (+${open.length - shown.length} more)` : ''}`;
  const head = `gate timed out twice (${each}); not charged to the worker — ${unfinished}. No failing test was named and no reviewer was called: a person decides.`;
  const room = max - head.length - 24;
  const tail = plainLines(output).filter((l) => l.trim()).slice(-12).join('\n');
  return room > 80 && tail ? `${head}\nlast output:\n${tail.slice(-room)}` : head.slice(0, max);
}

// --- a jail behind main ---------------------------------------------------------------------------------------------

/**
 * The same pins as every git call in isolate.ts (its `gitExec` is not exported, and that file is not this one's to
 * change): no hooks, no fsmonitor program, no extra attributes file, objects read as stored, and none of the GIT_*
 * variables that would point the call at another repository. Run in the REAL repo only, and read-only.
 *
 * One more than isolate.ts needs, because this file is the first to run `git log`: the repo's config (which a jail
 * can write) may set `log.showSignature`, and `git log` then starts `gpg.program` — any program the config names —
 * for every commit in the range that carries a signature header. Switched off here and again on the command itself.
 *
 * And no lazy fetch (GIT_NO_LAZY_FETCH, git 2.39.4 and later): `git log --name-only` reads trees, and for one that is
 * missing from the object store git otherwise fetches from the "promisor" remote the config names — whose URL may
 * be a program (`ext::…`). With it the call fails, and the caller logs that it could not tell.
 */
const PINNED = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false',
  '-c', 'log.showSignature=false',
];
const NOT_INHERITED = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(_.*)?)$/;

async function repoGit(repo: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!NOT_INHERITED.test(key)) env[key] = value;
  const { stdout } = await exec('git', [...PINNED, '--no-optional-locks', ...args], {
    cwd: repo,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/** Commits of main read for their paths; a jail further behind than this is counted in full and listed in part. */
const MAX_COMMITS_READ = 500;

/** Lists a suite reads to decide what may be skipped or may fail: `test-skips.txt`, `expected-skips.json`, `known-failures`. */
const SKIP_LIST = /(^|\/)(expected|known|allowed|test)[-_.]?(skips?|skipped|failures?|flak(y|es))\b[^/]*$/i;

/**
 * Files the test command itself is: path-shaped words of the command, and of the package.json script it names
 * (`npm run verify` → `bash scripts/verify.sh` → scripts/verify.sh), that exist in `dir`. Never package.json — every
 * dependency bump changes it.
 */
export function testCommandFiles(dir: string, cmd: string | null): string[] {
  if (!cmd) return [];
  const texts = [cmd];
  const script = /\bnpm (?:run(?:-script)? )?([\w:.-]+)/.exec(cmd)?.[1];
  if (script) {
    try {
      // The jail's file, read in the daemon: only a regular file of a sane size. A worker can leave a FIFO or a
      // link to a device under this name, and reading one never returns.
      const file = path.join(dir, 'package.json');
      const stat = fs.lstatSync(file);
      const pkg = (stat.isFile() && stat.size <= 4 * 1024 * 1024 ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as { scripts?: Record<string, unknown> };
      const body = pkg.scripts?.[script];
      if (typeof body === 'string') texts.push(body);
    } catch {
      /* no readable package.json: the command's own words are all there is */
    }
  }
  const out: string[] = [];
  for (const word of texts.join(' ').split(/[\s"'=;&|()<>]+/)) {
    const rel = word.replace(/^\.\//, '');
    if (!rel || rel.startsWith('-') || rel.startsWith('/') || rel.includes('..') || rel === 'package.json' || out.includes(rel)) continue;
    try {
      if (fs.statSync(path.join(dir, rel)).isFile()) out.push(rel);
    } catch {
      /* not a file here */
    }
  }
  return out;
}

export interface BehindMain {
  /** Commits main has that the run's base does not. */
  commits: number;
  /** How many of them change a test file or test support. */
  testCommits: number;
  /** Every such path those commits name. */
  testPaths: string[];
}

/**
 * How far the real repo's HEAD is ahead of the commit this jail was cut from, and which test files (isTestPath),
 * test-command files and skip lists those commits change. Null when the jail is not behind, or has no repo.
 * Throws when git cannot say; the caller logs that and goes on.
 */
export async function behindMain(jail: Jail, cmd: string | null): Promise<BehindMain | null> {
  if (!jail.repo) return null;
  const base = await jailBase(jail);
  const head = (await repoGit(jail.repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (head === base) return null;
  const commits = Number((await repoGit(jail.repo, ['rev-list', '--count', `${base}..${head}`])).trim());
  if (!Number.isFinite(commits) || commits <= 0) return null;
  const gateFiles = new Set(testCommandFiles(jail.dir, cmd));
  const counts = (rel: string): boolean => isTestPath(rel) || gateFiles.has(rel) || SKIP_LIST.test(rel);
  // One record per commit: a line of \x01 and the hash, then the paths it changes. A merge names none of its own;
  // the commits it brought in are in the range and name theirs.
  const log = await repoGit(jail.repo, ['log', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', `--max-count=${MAX_COMMITS_READ}`, '--format=%x01%H', `${base}..${head}`]);
  const testPaths: string[] = [];
  let testCommits = 0;
  for (const record of log.split('\x01').slice(1)) {
    const hit = record.split('\n').slice(1).map((l) => l.trim()).filter((rel) => rel && counts(rel));
    if (!hit.length) continue;
    testCommits++;
    for (const rel of hit) if (!testPaths.includes(rel)) testPaths.push(rel);
  }
  return { commits, testCommits, testPaths: testPaths.sort() };
}

/** `jail is <n> commits behind main; <m> of them change test files: <up to 5 paths>`. */
export function behindLine(b: BehindMain): string {
  const shown = b.testPaths.slice(0, 5);
  const more = b.testPaths.length > shown.length ? ` (+${b.testPaths.length - shown.length} more)` : '';
  return `jail is ${b.commits} commit${b.commits === 1 ? '' : 's'} behind main; ${b.testCommits} of them change test files` +
    (shown.length ? `: ${shown.join(', ')}${more}` : '');
}

/** What follows that line on a failure. */
export const BEHIND_ADVICE = 'the failing tests may be ones main has since changed: compare before repairing';

/**
 * The test files a red run's output names as failing, relative to the jail: paths in its TAP `not ok` blocks, its
 * spec "failing tests:" section and its `✖` lines. Null when none can be named — the caller then claims nothing.
 */
export function failingTestFiles(output: string, jailDir: string): string[] | null {
  const blocks = new FailingBlocks();
  const lines: string[] = [];
  for (const line of plainLines(output)) {
    blocks.feed(line);
    if (/^\s*✖\s/.test(line)) lines.push(line);
  }
  lines.push(...blocks.lines);
  let real = jailDir;
  try {
    real = fs.realpathSync(jailDir);
  } catch {
    /* compared as given */
  }
  const roots = [...new Set([real, jailDir])].map((r) => (r.endsWith('/') ? r : `${r}/`));
  const found: string[] = [];
  for (const line of lines) {
    for (const raw of line.match(/[\w@%+.~/-]*[\w-]\.[A-Za-z]{1,5}\b/g) ?? []) {
      let rel = raw.replace(/^file:\/\//, '');
      // A path outside the jail is not one of its test files.
      const root = roots.find((r) => rel.startsWith(r));
      if (root) rel = rel.slice(root.length);
      else if (rel.startsWith('/')) continue;
      rel = rel.replace(/^\.\//, '');
      if (isTestPath(rel) && !rel.includes('node_modules/') && !found.includes(rel)) found.push(rel);
    }
  }
  return found.length ? found : null;
}

/**
 * True when every failing test file the output names is one main has changed since the jail's base (and one is
 * named) — and the run itself changed none of them (`ownPaths`: the paths in its own diff). A failing test file the
 * ticket edited, deleted or added is the ticket's to repair, whatever main did to it since.
 */
export function failuresAllChangedOnMain(output: string, jailDir: string, behind: BehindMain | null, ownPaths: readonly string[] = []): boolean {
  if (!behind || !behind.testPaths.length) return false;
  const failing = failingTestFiles(output, jailDir);
  return failing !== null && failing.every((rel) => behind.testPaths.includes(rel) && !ownPaths.includes(rel));
}

/** The gate note for a failure that parks instead of spending a repair round. */
export function behindParkNote(b: BehindMain, output: string, max: number): string {
  const head = `${behindLine(b)}; ${BEHIND_ADVICE}. Every failing test file named is one main changed since this jail was cut, ` +
    'so no repair round was spent and a person decides.';
  const room = max - head.length - 24;
  const tail = plainLines(output).filter((l) => l.trim()).slice(-12).join('\n');
  return room > 80 && tail ? `${head}\nlast output:\n${tail.slice(-room)}` : head.slice(0, max);
}

// --- parks for a person ---------------------------------------------------------------------------------------------

/** The gate note of a code run that changed nothing, before the worker's own words. */
export const NOTHING_TO_CHANGE_NOTE = 'no change produced — approve to close as "nothing to change", or reject with what is missing.';
/** The merge reason an approval of such a run reports: nothing was merged, and that is the outcome. */
export const NOTHING_TO_CHANGE_CLOSED = 'closed: nothing to change';

/** `<NOTHING_TO_CHANGE_NOTE> Worker said: <the last 600 characters of the summary>`. */
export function nothingToChangeNote(summary: string | null | undefined): string {
  const said = (summary ?? '').trim().slice(-600);
  return `${NOTHING_TO_CHANGE_NOTE} Worker said: ${said || '(nothing)'}`;
}

/**
 * Which of the three parks above a gate note is, or null: no reviewer read these and no test run passed, so a person
 * decides them whatever is written on the run afterwards. Read anywhere in the note — it may lead with the core-guard
 * warning or the re-approval line — which can only ever add a hold.
 */
export function personPark(note: string | null | undefined): string | null {
  const text = note ?? '';
  if (text.includes(NOTHING_TO_CHANGE_NOTE)) return 'the run produced no change — a person decides whether that closes the ticket';
  if (/(^|[|;] )gate timed out twice \(/.test(text)) return 'the gate timed out twice and never finished — a person decides';
  if (/(^|[|;] )jail is \d+ commits? behind main; \d+ of them change test files/.test(text)) {
    return 'the checks failed on tests main has changed since the jail was cut — a person decides';
  }
  return null;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubbedEnv, spawnStreaming } from '../runners/proc.ts';
import { SandboxError, sandboxNote, sandboxState, worktreeGitDir, wrapChecked } from '../security/sandbox.ts';
import { VerifyWaitAborted, withVerifySlot } from './slots.ts';
import { namesFailingTest } from './gateOutcome.ts';

/** Best-effort detection of how this project runs its tests. */
export function detectTestCmd(dir: string): string | null {
  const has = (rel: string): boolean => fs.existsSync(path.join(dir, rel));

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      // verify first: where a project has one it is the whole gate (Kiln's runs
      // tsc, then the tests), and `test` alone let a ticket with no test_cmd
      // pass with a type error that failed the operator's gate.
      if (pkg.scripts?.['verify']) return 'npm run verify --silent';
      if (pkg.scripts?.['test']) return 'npm test --silent';
    } catch {
      /* an unparseable package.json is not a test command */
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tests') || has('setup.cfg')) return 'python3 -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('Makefile')) {
    // Its own try, like package.json's: an unreadable Makefile (a directory,
    // no permission) is no test command, and must not throw out of detection.
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(dir, 'Makefile'), 'utf8'))) return 'make test';
    } catch {
      /* not a readable Makefile */
    }
  }
  return null;
}

export interface TestResult {
  ran: boolean;
  passed: boolean;
  cmd: string | null;
  output: string;
  /** Seconds the command had run when Foreman's own bound (testTimeoutMs) killed it; absent on every other result. */
  killedAfterSec?: number;
  /** With it: the kept output as it stood when the kill was sent. What a dying suite prints after that is the kill's doing. */
  outputBeforeKill?: string;
  /**
   * On a red result: some line of the run said a test or check failed (gateOutcome.ts namesFailingTest) — any line,
   * not only the 400 that `output` keeps, and none printed after Foreman's own kill.
   */
  namedFailure?: boolean;
  /** Nothing was spawned: the sandbox was asked for and could not be used. The reason is the output. */
  refused?: boolean;
}

/**
 * How long one test command may run, FOREMAN_TEST_TIMEOUT_MIN minutes (default 30). A suite with one test awaiting
 * forever under --test-timeout=0 never exits on its own; a post-merge check sat 25 minutes on an idle
 * test/dbperf.test.ts holding one of the two verify slots, so every ticket's gate queued behind it. On timeout the
 * whole process group is killed and the run fails with a line saying why, which the flake re-run then treats like
 * any other red. The result says so too (`killedAfterSec`): at a ticket's gate that is a timeout, not a failing
 * test (verify/gateOutcome.ts).
 */
export function testTimeoutMs(): number {
  const min = Number(process.env['FOREMAN_TEST_TIMEOUT_MIN']);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60_000;
}

/** What a sandboxed run may read besides its jail (security/sandbox.ts). */
export interface SandboxRunOpts {
  /**
   * The real repo's git directory, read-only, for a worktree jail. A caller that knows the repo names it (the
   * post-merge check); unset, it is worked out from the jail's `.git` file and believed only when the real repo
   * points back at this jail (worktreeGitDir). null: none.
   */
  realGit?: string | null;
  /** Extra read-only trees for this run. */
  readOnly?: string[];
  /** A shorter limit for this one command; never a longer one than testTimeoutMs(). */
  timeoutMs?: number;
}

export async function runTests(
  dir: string,
  cmd: string | null,
  signal: AbortSignal,
  onLine?: (line: string) => void,
  onSpawn?: (pid: number | null) => void,
  sandbox?: SandboxRunOpts,
): Promise<TestResult> {
  if (!cmd) return { ran: false, passed: false, cmd: null, output: 'no test command' };
  const lines: string[] = [];
  // A run the sandbox refuses: nothing was spawned, and the reason is the whole output.
  const refused = (reason: string): TestResult => {
    const note = `foreman: ${reason}`;
    onLine?.(note);
    onSpawn?.(null);
    return { ran: true, passed: false, cmd, output: note, refused: true };
  };
  // FOREMAN_SANDBOX (security/sandbox.ts): 'on' runs the command under sandbox-exec; 'off', and a process that is
  // itself already sandboxed, run it as before. A sandbox that is asked for and cannot start fails the run.
  let box: 'off' | 'on' | 'nested';
  try {
    box = await sandboxState();
  } catch (err) {
    if (err instanceof SandboxError) return refused(err.message);
    throw err;
  }
  if (box === 'on' && (process.env['FOREMAN_TEST_REAL_HOME'] ?? '').trim() === '1') {
    return refused(
      'FOREMAN_TEST_REAL_HOME=1 cannot be used with the sandbox on: a sandboxed test command has no access to the real home. ' +
        'Unset it, or set FOREMAN_SANDBOX=off to run without the sandbox.',
    );
  }
  const home = isolatedHome();
  const own = sandbox?.timeoutMs;
  const shorter = own !== undefined && Number.isFinite(own) && own > 0 && own < testTimeoutMs();
  const limit = shorter ? own : testTimeoutMs();
  const timer = AbortSignal.timeout(limit);
  let beforeKill: string | null = null;
  timer.addEventListener('abort', () => { beforeKill = lines.join('\n'); }, { once: true });
  // Read as the lines arrive: only the last 400 are kept, and a suite of a few thousand lines prints its red test
  // long before the line it is cut short on. Kept output alone called that run a timeout with no failing test named.
  let namedFailure = false;
  let code: number;
  try {
    let launch = { cmd: '/bin/sh', args: ['-c', cmd] };
    if (box === 'on' && home) {
      const realGit = sandbox?.realGit === undefined ? await worktreeGitDir(dir) : sandbox.realGit;
      launch = await wrapChecked('tests', { jail: dir, tmp: home.tmp, home: home.dir, realGit, readOnly: sandbox?.readOnly }, launch.cmd, launch.args);
    }
    code = await spawnStreaming(launch.cmd, launch.args, {
      cwd: dir,
      signal: AbortSignal.any([signal, timer]),
      onSpawn,
      env: testEnv(home?.env),
      replaceEnv: true,
      onLine: (line) => {
        if (!namedFailure && !timer.aborted && namesFailingTest(line)) namedFailure = true;
        // Keep the tail; a failing suite's last lines are the useful ones.
        lines.push(line);
        if (lines.length > 400) lines.shift();
        onLine?.(line);
      },
    });
  } catch (err) {
    // The sandbox could not be built for this run (a path, a list too long, a profile that does not start).
    if (err instanceof SandboxError) return refused(err.message);
    throw err;
  } finally {
    onSpawn?.(null);
    // On every path — pass, fail, timeout, spawn error — so the home and the
    // TMPDIR never pile up in the shared temp dir. Never throws: a suite that
    // left an unreadable dir behind must not turn its own result into a rejection.
    if (home) for (const dir of home.dirs) removeScratch(dir);
  }
  // A red run under the sandbox says so, last, so "works on my machine" has somewhere to start.
  const sandboxed = (): void => {
    if (box !== 'on') return;
    const note = sandboxNote();
    lines.push(note);
    onLine?.(note);
  };
  if (timer.aborted && !signal.aborted) {
    const note = shorter
      ? `foreman: the command timed out after ${Math.round(limit / 1000)} s and was killed`
      : `foreman: test command timed out after ${Math.round(limit / 60_000) || limit / 60_000} min and was killed (FOREMAN_TEST_TIMEOUT_MIN)`;
    lines.push(note);
    onLine?.(note);
    sandboxed();
    return { ran: true, passed: false, cmd, output: lines.join('\n'), killedAfterSec: Math.round(limit / 1000), outputBeforeKill: beforeKill ?? '', namedFailure };
  }
  if (code !== 0) sandboxed();
  return { ran: true, passed: code === 0, cmd, output: lines.join('\n'), ...(code !== 0 && namedFailure ? { namedFailure } : {}) };
}

/**
 * How the shell runner and the api runner's run_shell launch `/bin/sh -c <command>` in a jail: as it is with the
 * sandbox off (or when this process is already inside one), and under the tests sandbox with a private HOME and
 * TMPDIR otherwise. `env` is what to add to the child's environment; `done()` removes the private dirs. Throws
 * SandboxError when the sandbox is asked for and cannot start — the caller reports it and runs nothing.
 */
export function sandboxedShell(
  dir: string,
  command: string,
  sandbox?: SandboxRunOpts,
): Promise<{ cmd: string; args: string[]; env: Record<string, string>; done: () => void }> {
  return sandboxedCommand(dir, '/bin/sh', ['-c', command], sandbox);
}

/** sandboxedShell for a program that is not a shell line: a catalog tool's `node tool.js` (tools/run.ts). */
export async function sandboxedCommand(
  dir: string,
  cmd: string,
  args: string[],
  sandbox?: SandboxRunOpts,
): Promise<{ cmd: string; args: string[]; env: Record<string, string>; done: () => void }> {
  const plain = { cmd, args, env: {}, done: (): void => {} };
  if ((await sandboxState()) !== 'on') return plain;
  const home = privateHome();
  const done = (): void => {
    for (const d of home.dirs) removeScratch(d);
  };
  try {
    const realGit = sandbox?.realGit === undefined ? await worktreeGitDir(dir) : sandbox.realGit;
    const launch = await wrapChecked('tests', { jail: dir, tmp: home.tmp, home: home.dir, realGit, readOnly: sandbox?.readOnly }, plain.cmd, plain.args);
    return { ...launch, env: home.env, done };
  } catch (err) {
    done();
    throw err;
  }
}

/**
 * The environment a test command runs in: the daemon's own, minus every
 * credential-shaped variable (proc.ts scrubbedEnv 'deny'), plus `extra`. A
 * test command runs code a worker wrote — the suite, and the package.json
 * script that names it — so it gets the same treatment as a `run_shell`
 * command the model wrote, which already never saw ANTHROPIC_API_KEY and the
 * like. Nor the colour switches the daemon inherited (proc.ts COLOUR_ENV):
 * FORCE_COLOR and the rest. FOREMAN_TEST_KEEP_ENV (comma-separated names)
 * passes named variables through for a suite that genuinely needs one.
 */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep: Record<string, string> = {};
  for (const name of (process.env['FOREMAN_TEST_KEEP_ENV'] ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
    const value = process.env[name];
    if (value !== undefined) keep[name] = value;
  }
  return scrubbedEnv('deny', { ...keep, ...extra });
}

/**
 * runTests behind the process-wide verify semaphore (slots.ts). Every test
 * command Foreman spawns for a run goes through here; `onWaited` gets the
 * queueing time when it was above 0. An abort while queued fails the run
 * without spawning anything.
 */
export async function runTestsSlotted(
  dir: string,
  cmd: string | null,
  signal: AbortSignal,
  onLine?: (line: string) => void,
  onSpawn?: (pid: number | null) => void,
  onWaited?: (ms: number) => void,
  onQueue?: (queued: boolean) => void,
  sandbox?: SandboxRunOpts,
): Promise<TestResult> {
  if (!cmd) return runTests(dir, cmd, signal, onLine, onSpawn, sandbox);
  try {
    return await withVerifySlot(signal, () => runTests(dir, cmd, signal, onLine, onSpawn, sandbox), onWaited, onQueue);
  } catch (err) {
    if (err instanceof VerifyWaitAborted) return { ran: true, passed: false, cmd, output: err.message };
    throw err;
  }
}

/**
 * A throwaway HOME (and XDG dirs) for one test run. A jail is a worktree, not a
 * sandbox: a ticket's tests could write anywhere under the operator's home, and
 * on the Kiln Easy epic one did — a test created ~/Kiln Projects/guard-made in
 * the real home folder through a default path nothing guarded. Node's
 * os.homedir(), Python's expanduser and most tools follow HOME, so a default
 * like '~/Something' now lands in the throwaway dir. ~/.gitconfig is copied in
 * so suites that commit still have an identity. TMPDIR/TMP/TEMP point at a
 * second throwaway dir, removed with the home, so the suite's temp files go too.
 * It is a short sibling, not a tmp/ inside the home: a unix socket path is
 * capped at 104 bytes on macOS, and Kiln's race test (81 bytes under the real
 * TMPDIR) went over it, failing every gate run with listen EINVAL.
 * FOREMAN_TEST_REAL_HOME=1 opts out for a suite that genuinely needs the real home.
 */
export function isolatedHome(): { dir: string; tmp: string; dirs: string[]; env: Record<string, string> } | null {
  if ((process.env['FOREMAN_TEST_REAL_HOME'] ?? '').trim() === '1') return null;
  return privateHome();
}

/** isolatedHome without the opt-out: a sandboxed command always gets its own HOME and TMPDIR. */
function privateHome(): { dir: string; tmp: string; dirs: string[]; env: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-home-'));
  const realGitconfig = path.join(process.env['HOME'] ?? os.homedir(), '.gitconfig');
  try {
    if (fs.statSync(realGitconfig).isFile()) fs.copyFileSync(realGitconfig, path.join(dir, '.gitconfig'));
  } catch {
    /* no global git identity to carry over */
  }
  // TMPDIR too: suites mktemp freely and rarely clean up, and the shared
  // per-user temp dir had grown past 300k entries from test runs alone.
  // os.tmpdir() + '/ft' + 6 random chars: 9 bytes over the real TMPDIR.
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft'));
  } catch (err) {
    removeScratch(dir);
    throw err;
  }
  const env: Record<string, string> = { HOME: dir, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  for (const [k, sub] of [['XDG_CONFIG_HOME', '.config'], ['XDG_DATA_HOME', '.local/share'], ['XDG_CACHE_HOME', '.cache'], ['XDG_STATE_HOME', '.local/state']] as const) {
    env[k] = path.join(dir, sub);
  }
  return { dir, tmp, dirs: [dir, tmp], env };
}

/** Give the owner rwx on every directory under `p`, so a mode-000 dir a suite left behind can be emptied. */
function makeRemovable(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    /* not ours to change; the retry will say so */
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(p);
  } catch {
    return;
  }
  for (const name of names) makeRemovable(path.join(p, name));
}

/**
 * Remove a per-run scratch dir without ever throwing: on failure, make every
 * dir under it writable and try once more, then log and move on — a leftover
 * temp dir is not worth a test result.
 */
export function removeScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    makeRemovable(dir);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`foreman: could not remove test scratch dir ${dir}: ${(err as Error).message}\n`);
  }
}

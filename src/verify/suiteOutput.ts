/**
 * Where the slot wrapper (testSlot.ts) keeps a suite run's whole output, so nobody runs a suite again to read more
 * of it.
 *
 * A worker piped its 20-minute suite through `tail -25`, then ran it again through `head -40`, then again through
 * `grep`: each run showed a different slice and the rest was gone. The wrapper now writes every line to a file as it
 * arrives (never held in memory: a suite can print hundreds of megabytes), prints only the end and the failing tests
 * itself, and names the file on its last line.
 *
 * The file is in the wrapper process's temp dir (`os.tmpdir()`, i.e. the worker session's TMPDIR): today that is the
 * operator's per-user temp dir, which an unsandboxed worker reads freely; under the planned worker sandbox it is the
 * run's private temp dir, the one place besides the jail that profile lets a worker read and write. Never inside
 * the working tree — a jail is committed with `git add -A`, and the file would land in the ticket's diff.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The folder under the temp dir; one for every run, so pruning never lists the whole temp dir. */
export const OUTPUT_DIR_NAME = 'foreman-suite-output';
/** Saved outputs kept per run: the newest ones. */
export const KEEP_PER_RUN = 3;
/** Anything in the folder older than this goes, whoever's run it was (a private temp dir is removed with its run anyway). */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Lines of failing-test blocks kept for printing; the rest are counted and stay in the file. */
export const FAILING_LINES_MAX = 300;
/** How much output is gathered before one write to the file. */
const FLUSH_CHARS = 64 * 1024;
/**
 * And how long a line may wait for that write. A quiet suite's last lines — the failing ones, before it hangs —
 * are on disk within this, so a wrapper that is killed outright (SIGKILL, a tool timeout) loses at most this much.
 */
export const FLUSH_AFTER_MS = 1_000;

const isInside = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + path.sep);

/** The tracked tree `cwd` is in: the nearest directory up from it that holds a `.git`, or null when there is none. No git is run. */
function treeRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * The private folder saved outputs go in, created if need be; null when there is no temp dir outside the working
 * tree to put it in. Owner-only, and refused when the name is taken by something that is not our own directory
 * (a link someone left in a shared /tmp).
 */
export function outputDir(cwd: string): string | null {
  let tree: string | null;
  try {
    tree = treeRoot(fs.realpathSync(cwd));
  } catch {
    return null;
  }
  for (const base of [os.tmpdir(), '/tmp']) {
    try {
      const dir = path.join(fs.realpathSync(base), OUTPUT_DIR_NAME);
      if (tree && isInside(tree, dir)) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) continue;
      fs.chmodSync(dir, 0o700);
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/** The part of a file name a run id becomes; a run that has none (an older worker env, a person at a shell) is `norun`. */
export function runKey(runId: string | null | undefined): string {
  const safe = (runId ?? '').trim().replace(/[^A-Za-z0-9._]/g, '_').replace(/^\.+/, '_').slice(0, 80);
  return safe || 'norun';
}

/** The saved outputs of one run in `dir`, newest first. */
export function savedOutputs(dir: string, runId: string | null | undefined): string[] {
  const prefix = `${runKey(runId)}-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const mine: Array<{ name: string; at: number; seq: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    // <run>-<ms since epoch>-<pid>.log, and nothing looser: `r_1-…` must not match run `r_1-2`.
    const m = /^(\d+)-(\d+)\.log$/.exec(name.slice(prefix.length));
    if (m) mine.push({ name, at: Number(m[1]), seq: Number(m[2]) });
  }
  mine.sort((a, b) => b.at - a.at || b.seq - a.seq || (a.name < b.name ? 1 : -1));
  return mine.map((f) => path.join(dir, f.name));
}

/** Keep the newest KEEP_PER_RUN of this run's outputs (always `keep`), and drop anything in the folder past its age. */
function prune(dir: string, runId: string | null | undefined, keep: string, now: number): void {
  const mine = savedOutputs(dir, runId).filter((f) => f !== keep);
  for (const old of mine.slice(KEEP_PER_RUN - 1)) fs.rmSync(old, { force: true });
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (file !== keep && now - fs.lstatSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      /* gone already, or not ours to remove */
    }
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * The failing tests of a `node --test` run, picked out as the lines go by: TAP `not ok` blocks (to the next test
 * line) and the spec reporter's "failing tests:" section — what scripts/verify.sh prints last for the gate. Colour
 * codes are ignored for the matching and kept in what is printed.
 */
export class FailingBlocks {
  readonly lines: string[] = [];
  /** Lines that belonged here but came after FAILING_LINES_MAX. */
  dropped = 0;
  private tap = false;
  private spec = false;

  feed(raw: string): void {
    const line = raw.replace(ANSI_RE, '');
    if (/^\s*not ok /.test(line)) {
      this.tap = true;
      return this.keep(raw);
    }
    if (this.tap && (/^\s*ok /.test(line) || /^\s*# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(line))) this.tap = false;
    if (/failing tests:/.test(line)) this.spec = true;
    if (this.tap || this.spec) this.keep(raw);
  }

  private keep(raw: string): void {
    if (this.lines.length < FAILING_LINES_MAX) this.lines.push(raw);
    else this.dropped++;
  }
}

/** One suite run's output on its way to a file: every line written, only the end and the failing blocks remembered. */
export class SuiteLog {
  /** The file, or null when nothing is being saved (`problem` says why). */
  readonly file: string | null;
  /** Why the output is not (or no longer) being saved. */
  problem: string | null = null;
  /** Lines taken so far. */
  lines = 0;
  readonly failing = new FailingBlocks();
  private readonly tailMax: number;
  private readonly tail: string[] = [];
  private fd: number | null = null;
  private pending: string[] = [];
  private pendingChars = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor(file: string | null, problem: string | null, tailMax: number) {
    this.file = file;
    this.problem = problem;
    this.tailMax = tailMax;
  }

  /** The path a run's next output would be saved at, before anything is created (the wrapper names it when it asks for a slot). */
  static pathFor(cwd: string, runId: string | null | undefined, now = Date.now(), pid = process.pid): string | null {
    const dir = outputDir(cwd);
    return dir ? path.join(dir, `${runKey(runId)}-${now}-${pid}.log`) : null;
  }

  /** Create `file` (owner-only, never over something already there) and prune the run's older outputs. */
  static open(file: string | null, runId: string | null | undefined, tailMax: number): SuiteLog {
    if (!file) return new SuiteLog(null, 'no temp dir outside the working tree', tailMax);
    const log = new SuiteLog(file, null, tailMax);
    try {
      log.fd = fs.openSync(file, 'wx', 0o600);
      prune(path.dirname(file), runId, file, Date.now());
    } catch (err) {
      log.stopSaving(err);
    }
    return log;
  }

  line(text: string): void {
    this.lines++;
    this.tail.push(text);
    if (this.tail.length > this.tailMax) this.tail.shift();
    this.failing.feed(text);
    if (this.fd === null) return;
    this.pending.push(text, '\n');
    this.pendingChars += text.length + 1;
    if (this.pendingChars >= FLUSH_CHARS) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
      this.flushTimer.unref?.();
    }
  }

  /** The last lines taken, oldest first. */
  lastLines(n: number): string[] {
    return this.tail.slice(-n);
  }

  /** Everything is on disk (or `problem` says it is not) and the file is closed. */
  close(): void {
    this.flush();
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch (err) {
      this.problem = (err as Error).message;
    }
    this.fd = null;
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.fd === null || !this.pending.length) return;
    const data = Buffer.from(this.pending.join(''), 'utf8');
    this.pending = [];
    this.pendingChars = 0;
    try {
      for (let off = 0; off < data.length; ) off += fs.writeSync(this.fd, data, off, data.length - off);
    } catch (err) {
      this.stopSaving(err);
    }
  }

  /** A full disk or a vanished temp dir ends the saving, never the suite run. */
  private stopSaving(err: unknown): void {
    this.problem = err instanceof Error ? err.message : String(err);
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* nothing more to do with it */
      }
    }
    this.fd = null;
    this.pending = [];
    this.pendingChars = 0;
  }
}

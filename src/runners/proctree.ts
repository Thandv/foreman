import { execFile, spawnSync } from 'node:child_process';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { FREEZE_MEMBERS_MAX, activeRecorder, type FreezeGroup, type FreezeRecorder } from './freezeRecord.ts';

/**
 * Process-tree reaping. Killing a child's recorded process group is not enough:
 * anything under it that made its own group (a worker's `npm run verify`, a
 * suite spawning `detached: true`) survives the group signal and keeps running
 * — and eating the load — after a deadline, cancel, stop or restart. So before
 * signalling, snapshot the tree under the recorded pid/pgid and signal every
 * group found in it.
 */

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Parse `ps -axo pid=,ppid=,pgid=` output. Malformed lines are skipped. */
export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [pid, ppid, pgid] = parts.map(Number) as [number, number, number];
    if ([pid, ppid, pgid].every((n) => Number.isInteger(n) && n >= 0)) rows.push({ pid, ppid, pgid });
  }
  return rows;
}

/**
 * Every process group in the tree rooted at `root`: the root's own group, the
 * group of each member of it, and the group of every descendant of any of
 * them (members are walked too, since the leader may already be gone). Never
 * returns pgid 0/1 or `selfPid`'s own group, so a reused pid or a confused
 * table cannot make us signal ourselves or launchd.
 *
 * `root` is walked as a pid only while it still leads its own group: once the
 * recorded leader has died its pid can be reused by an unrelated process, and
 * that process's descendants (and its group) are none of ours. Then only the
 * members of group `root` and their descendants count.
 */
export function treeGroups(rows: PsRow[], root: number, selfPid: number): number[] {
  const selfPgid = rows.find((r) => r.pid === selfPid)?.pgid;
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const leads = byPid.get(root)?.pgid === root;
  const stack = [...(leads ? [root] : []), ...rows.filter((r) => r.pgid === root).map((r) => r.pid)];
  const groups = new Set<number>([root]);
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid) || pid <= 1 || pid === selfPid) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) groups.add(row.pgid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return [...groups].filter((g) => g > 1 && g !== selfPgid);
}

/** The live process table, or [] if ps could not be run. Stdlib only. */
export function snapshotPs(): PsRow[] {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0 ? parsePsRows(r.stdout) : [];
  } catch {
    return [];
  }
}

/** The groups currently in the tree under `root` (always at least `root` itself unless it is ours). */
export function snapshotTreeGroups(root: number): number[] {
  return treeGroups(snapshotPs(), root, process.pid);
}

/**
 * The groups a delayed SIGKILL escalation may signal: the ones remembered at
 * the abort, plus — only while the child has not exited (its 'exit', not
 * 'close', which waits for stdio a grandchild may hold), so its pid is still
 * ours — whatever the tree under it holds now; minus the child's own group
 * (signalled separately) and any group with no member left in `rows`, since a
 * remembered id may have been freed and reused. Pure, for testing.
 */
export function escalationGroups(remembered: number[], childPid: number, childExited: boolean, rows: PsRow[], selfPid: number): number[] {
  const now = childExited ? [] : treeGroups(rows, childPid, selfPid);
  const live = new Set(rows.map((r) => r.pgid));
  return [...new Set([...remembered, ...now])].filter((g) => g !== childPid && live.has(g));
}

/**
 * escalationGroups for a live ChildProcess: "exited" is its exit status being
 * known (the 'exit' event), never its 'close' — a grandchild holding stdio
 * keeps 'close' from firing long after the pid was reaped and freed for reuse.
 */
export function escalationFor(
  child: { pid?: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | string | null },
  remembered: number[],
  rows: PsRow[],
  selfPid: number,
): number[] {
  if (child.pid === undefined) return [];
  return escalationGroups(remembered, child.pid, child.exitCode !== null || child.signalCode !== null, rows, selfPid);
}

/**
 * Signal each group; returns the ones a signal reached. A delayed escalation
 * filters its groups for liveness first (escalationGroups).
 */
export function signalGroups(groups: Iterable<number>, sig: NodeJS.Signals): number[] {
  const hit: number[] = [];
  for (const g of new Set(groups)) {
    if (g <= 1) continue;
    try {
      process.kill(-g, sig);
      hit.push(g);
    } catch {
      /* already gone */
    }
  }
  return hit;
}

// ------------------------------------------------------------ leftovers at a normal exit

/**
 * What a command left running when it exited by itself. Its own group is not
 * signalled on a normal 'close' otherwise, so a `cmd >/dev/null 2>&1 &` kept
 * running after the run was handed on — and could, for one, rewrite the jail's
 * git config between the daemon's driver listing and its git call
 * (isolate.ts driverlessEnv / pinnedGit).
 *
 * Once the command has exited its pid is gone and anything it orphaned is
 * launchd's child, so the ppid walk alone finds nothing. What still ties a
 * leftover to the command:
 *  - its session: the command is spawned detached, so it leads a session whose
 *    id is its pid, and setpgid does not leave a session. The kernel hands out
 *    no pid that is still a session or group id, so while any member is left
 *    the id is the command's. macOS's ps prints no session id; it is read with
 *    getsid(2) through the system perl (sessionIds), and without it only the
 *    command's group counts. Linux has it in /proc/<pid>/stat (readProcFs).
 *  - having been seen in the command's tree while the command ran (a sample
 *    every few seconds, LeftoverReaper.start): a process whose pid and start
 *    time were seen there, and the members of a session or group led by one.
 *  - descending, by ppid, from any of the above.
 * A process that made its own session (setsid) and lost its parent before any
 * sample saw it is tied to nothing and escapes: that is the limit without the
 * worker sandbox. Claude Code's Bash tool starts every command in its own
 * session, so for a claude-code worker only the samples tie a Bash command's
 * leftovers to the run.
 */

export interface ProcRow extends PsRow {
  /** Session id, or null where it could not be read. */
  sid: number | null;
  /**
   * With the pid, the process's identity. Opaque: compared for equality only, never read as a date. On macOS the
   * start time as ps prints it (lstart, C locale; one-second resolution, enough there since a pid cannot come round
   * within a second); on Linux the kernel's start time in clock ticks from /proc/<pid>/stat (readProcFs).
   */
  start: string;
}

/** Parse `ps -axo pid=,ppid=,pgid=,lstart=` output (sid unknown). Malformed lines are skipped. */
export function parseProcRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, ppid, pgid] = parts.slice(0, 3).map(Number) as [number, number, number];
    if (![pid, ppid, pgid].every((n) => Number.isInteger(n) && n >= 0)) continue;
    rows.push({ pid, ppid, pgid, sid: null, start: parts.slice(3).join(' ') });
  }
  return rows;
}

/** Parse `pid sid` lines into a map. */
export function parseSidLines(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const [pid, sid] = parts.map(Number) as [number, number];
    if (Number.isInteger(pid) && Number.isInteger(sid) && pid > 0 && sid > 0) out.set(pid, sid);
  }
  return out;
}

/** The environment ps and perl run with: nothing inherited that changes their output or what they load. */
const TOOL_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' };

/**
 * The env ps receives: `base` with TOOL_ENV's keys forced over it. TZ is one of them: lstart is printed in the
 * system zone, so a zone change would otherwise change the identity the reaper holds for its own groups.
 */
export function toolEnv(base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, ...TOOL_ENV };
}

function run(cmd: string, args: string[], input: string | null, timeoutMs: number, base: NodeJS.ProcessEnv = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: toolEnv(base) }, (err, stdout) =>
        resolve(err ? null : String(stdout)),
      );
    } catch {
      resolve(null);
      return;
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** getsid(2) for each pid on stdin (syscall 310 on macOS, both architectures). */
const GETSID_PERL = 'while (<STDIN>) { s/\\s+//g; next unless /^\\d+$/; my $s = syscall(310, $_ + 0); print "$_ $s\\n" if $s > 0 }';

/** Session ids for `pids`, or null where they cannot be read. */
export async function sessionIds(pids: number[], timeoutMs: number): Promise<Map<number, number> | null> {
  if (process.platform === 'darwin') {
    const out = await run('/usr/bin/perl', ['-e', GETSID_PERL], pids.join('\n') + '\n', timeoutMs);
    return out === null ? null : parseSidLines(out);
  }
  if (process.platform === 'linux') {
    const out = await run('ps', ['-axo', 'pid=,sid='], null, timeoutMs);
    return out === null ? null : parseSidLines(out);
  }
  return null;
}

/**
 * One `/proc/<pid>/stat` line as a row, or null if it is not one. Field 2 (comm) is in parentheses and may itself hold
 * spaces and `)`, so the fields after it are split after the LAST `)`: 3 state, 4 ppid, 5 pgrp, 6 session, ...
 * 22 starttime (clock ticks since boot, USER_HZ: 10 ms where it is 100, so a pid reused within the same second does
 * not match; within the same tick it would, which needs a whole pid wrap inside that tick). The start is
 * kept as the kernel's decimal digits, prefixed so it can never equal a ps lstart string. A session of 0 (a kernel
 * thread) is unknown, as getsid would give.
 */
export function parseProcStat(text: string): ProcRow | null {
  const open = text.indexOf(' (');
  const close = text.lastIndexOf(')');
  if (open <= 0 || close < open) return null;
  const pid = Number(text.slice(0, open));
  const f = text.slice(close + 1).trim().split(/\s+/);
  if (f.length < 20) return null;
  const [ppid, pgid, sid] = [f[1], f[2], f[3]].map(Number) as [number, number, number];
  const ticks = f[19]!;
  if (![pid, ppid, pgid, sid].every((n) => Number.isInteger(n) && n >= 0) || !/^\d+$/.test(ticks)) return null;
  return { pid, ppid, pgid, sid: sid > 0 ? sid : null, start: `ticks:${ticks}` };
}

/** More than any stat line (comm is at most 64 bytes, the numbers about 50 fields of 20 digits). */
const STAT_MAX = 4096;

/**
 * The process table from a Linux /proc (`procRoot`, injectable for tests), or null if it cannot be listed, holds no
 * process, a stat file fails for a reason other than its process being gone or hidden, or the scan runs past
 * `timeoutMs` (checked between files). Each stat file is read once, async, non-blocking and at most STAT_MAX bytes; a
 * pid whose process exited mid-scan (the usual case) or is hidden from us is skipped.
 */
export async function readProcFs(procRoot = '/proc', timeoutMs = 5_000): Promise<ProcRow[] | null> {
  const deadline = Date.now() + timeoutMs;
  let names: string[];
  try {
    names = await fsp.readdir(procRoot);
  } catch {
    return null;
  }
  const rows: ProcRow[] = [];
  const buf = Buffer.alloc(STAT_MAX);
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    if (Date.now() > deadline) return null;
    let text: string;
    try {
      const fh = await fsp.open(path.join(procRoot, name, 'stat'), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const { bytesRead } = await fh.read(buf, 0, STAT_MAX, 0);
        text = buf.toString('utf8', 0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (err) {
      // Gone since the listing (ENOENT; ESRCH once open), or hidden from us (hidepid, an LSM: EACCES, EPERM), which
      // ps skips the same way. Anything else (EMFILE, ENFILE, EIO, ...) can drop a live process that the ownership
      // rule or the fence needs, which ps, in a process of its own, would have read: no table rather than part of one.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') continue;
      return null;
    }
    const row = parseProcStat(text);
    if (row && String(row.pid) === name) rows.push(row);
  }
  return rows.length ? rows : null;
}

/** Where snapshotProcs reads from; injectable for tests. */
export interface ProcSource {
  platform?: NodeJS.Platform;
  procRoot?: string;
  /** The env ps starts from, before toolEnv forces its keys over it; a test varies the zone here. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The live process table with session ids where they can be read, or null if it could not be read. Never blocks.
 * Linux: /proc only (readProcFs), never ps — ps's lstart has one-second resolution, and a low pid_max can hand a pid
 * out again within the second; and procps's ps reads that same /proc, so where /proc cannot be read ps gives nothing
 * better: null, the reaper's no-table fail-safe. One source per platform, so a sample and a reap compare like with like.
 */
export async function snapshotProcs(timeoutMs = 5_000, source: ProcSource = {}): Promise<ProcRow[] | null> {
  if ((source.platform ?? process.platform) === 'linux') return readProcFs(source.procRoot ?? '/proc', timeoutMs);
  const out = await run('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], null, timeoutMs, source.env);
  if (out === null) return null;
  const rows = parseProcRows(out);
  if (rows.length === 0) return null;
  const sids = await sessionIds(rows.map((r) => r.pid), timeoutMs);
  if (sids) for (const r of rows) r.sid = sids.get(r.pid) ?? null;
  return rows;
}

/** pid -> start time of every process seen in a command's tree while it ran. */
export type SeenProcs = Map<number, string>;

/**
 * The pids that belong to the command `root` in `rows`. While the command
 * runs (`rootAlive`): its pid, its session and group, and their descendants.
 * After it exited: the members of its session and group — unless a process now
 * holds the pid `root`, which the kernel allows only once that session and
 * group are gone — plus every process `seen` (same pid and start time), the
 * members of any session or group whose id is a seen pid and provably still
 * the one we saw (see idIsOurs), and the descendants of all of them. Pure.
 *
 * `recentIds`: the session and group ids that processes of the command's held
 * at the latest sample.
 */
export function ownedPids(rows: ProcRow[], root: number, seen: SeenProcs, rootAlive: boolean, recentIds: ReadonlySet<number> = new Set()): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const isSeen = (r: ProcRow): boolean => seen.get(r.pid) === r.start;
  const liveSeenIds = new Set<number>();
  for (const r of rows) {
    if (!isSeen(r)) continue;
    liveSeenIds.add(r.pgid);
    if (r.sid !== null) liveSeenIds.add(r.sid);
  }
  // A seen pid's number is not the process: a seen process that exited early in a long run can, after a pid
  // wrap, come back as a stranger's session or group whose leader has exited too, leaving members that are
  // not ours. So an id counts only while that cannot have happened: the process holding the pid is the one
  // we saw, or a process we saw is still in that session or group (it could not have been emptied and
  // reused), or a process of ours held it at the latest sample (a reuse since then needs a whole pid wrap).
  const idIsOurs = (id: number): boolean => {
    const holder = byPid.get(id);
    if (holder !== undefined) return isSeen(holder);
    return liveSeenIds.has(id) || recentIds.has(id);
  };
  const rootIds = rootAlive || !byPid.has(root);
  const owned = new Set<number>();
  for (const r of rows) {
    if (rootAlive && r.pid === root) owned.add(r.pid);
    else if (rootIds && (r.sid === root || r.pgid === root)) owned.add(r.pid);
    else if (isSeen(r)) owned.add(r.pid);
    else if (r.sid !== null && r.sid !== root && seen.has(r.sid) && idIsOurs(r.sid)) owned.add(r.pid);
    else if (r.pgid !== root && seen.has(r.pgid) && idIsOurs(r.pgid)) owned.add(r.pid);
  }
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const stack = [...owned];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const c of children.get(pid) ?? []) {
      if (!owned.has(c)) {
        owned.add(c);
        stack.push(c);
      }
    }
  }
  owned.delete(0);
  owned.delete(1);
  return owned;
}

/**
 * The groups that must never be signalled from `selfPid`: its own and every
 * ancestor's (walked by ppid), plus 0 and 1. Null when `selfPid` is not in the
 * table — then nothing found in it can be checked against us.
 */
export function forbiddenGroups(rows: PsRow[], selfPid: number): Set<number> | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  if (!byPid.has(selfPid)) return null;
  const out = new Set<number>([0, 1]);
  const seenPids = new Set<number>();
  for (let r = byPid.get(selfPid); r && !seenPids.has(r.pid); r = byPid.get(r.ppid)) {
    seenPids.add(r.pid);
    out.add(r.pgid);
    out.add(r.pid);
  }
  return out;
}

/** The groups of the processes `ownedPids` finds, minus every forbidden one. Pure. */
export function leftoverGroups(
  rows: ProcRow[],
  root: number,
  seen: SeenProcs,
  rootAlive: boolean,
  forbidden: Set<number>,
  recentIds: ReadonlySet<number> = new Set(),
): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const groups = new Set<number>();
  for (const pid of ownedPids(rows, root, seen, rootAlive, recentIds)) {
    const g = byPid.get(pid)?.pgid;
    if (g !== undefined && Number.isInteger(g) && g > 1 && !forbidden.has(g)) groups.add(g);
  }
  return [...groups].sort((a, b) => a - b);
}

export class UnsafeSignal extends Error {}

/** Throws unless every group is a whole number > 1 and none is forbidden (our own group, an ancestor's, launchd's). */
export function assertSignallable(groups: Iterable<number>, forbidden: Set<number>): void {
  for (const g of groups) {
    if (!Number.isInteger(g) || g <= 1 || forbidden.has(g)) throw new UnsafeSignal(`refusing to signal process group ${g}`);
  }
}

export interface ReapReport {
  /** Every group found and signalled. */
  groups: number[];
  /** The groups still alive after the grace, which were SIGKILLed. */
  killed: number[];
  /** Groups with a member left after the SIGKILL wait (a zombie counts). */
  survivors: number[];
  /** No process table: only the command's own group was signalled. */
  noTable: boolean;
  /**
   * The reap ran past its bound. Every group it had frozen was sent SIGTERM and SIGCONT before this was reported, and
   * it freezes nothing more; it carries on in the background without freezing (SIGTERM, the grace, SIGKILL).
   */
  timedOut: boolean;
  error: string | null;
}

export interface ReaperOptions {
  /** How often the tree is sampled while the command runs; 0 turns sampling off. */
  sampleMs?: number;
  /** SIGTERM to SIGKILL. */
  graceMs?: number;
  /** How long after the SIGKILL the reap waits for the groups to empty. */
  killWaitMs?: number;
  /** The longest a caller waits for a reap; past it the reap is reported timed out and carries on unawaited. */
  boundMs?: number;
  /** Injected for tests. */
  snapshot?: () => Promise<ProcRow[] | null>;
  kill?: (pid: number, sig: NodeJS.Signals | 0) => void;
  selfPid?: number;
}

/** Samples of a command's tree are taken this often while it runs (FOREMAN_LEFTOVER_SAMPLE_MS; 0 = off). */
export function leftoverSampleMs(): number {
  const raw = Number(process.env['FOREMAN_LEFTOVER_SAMPLE_MS'] ?? 3_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}

/** At most this many processes are remembered per command (a suite that forks thousands stops adding, not growing). */
const SEEN_CAP = 20_000;

/**
 * Finds and ends what a command left running (see the block comment above).
 * `start()` when the command is spawned, `childExited()` on its 'exit', and
 * await `reap()` before its result is handed on. The reap freezes every group
 * found (SIGSTOP, then a fresh look for anything forked meanwhile, up to three
 * rounds), sends SIGTERM and SIGCONT, waits `graceMs` for the groups to empty,
 * SIGKILLs what is left (after one more look) and waits `killWaitMs` more.
 * Never throws: a failure is in the report, and the run goes on as before.
 */
export class LeftoverReaper {
  private readonly seen: SeenProcs = new Map();
  /** The session and group ids the command's processes held at the latest sample. */
  private recent: Set<number> = new Set();
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  private exited = false;
  private noPs = false;
  private reaping: Promise<ReapReport> | null = null;
  /** The groups stopped by the reap and not yet continued. Every one passed the ownership check before its SIGSTOP. */
  private readonly frozen = new Set<number>();
  /** Set when the bound fires: from then on the reap freezes nothing more (it still ends what it finds). */
  private gaveUp = false;
  /** Installed on 'exit' while groups are frozen, so a daemon that exits mid-freeze does not leave them stopped. */
  private readonly onExit = (): void => this.release();
  /**
   * Installed on SIGHUP while groups are frozen: a hangup (a closed terminal) emits no 'exit', so without this the
   * frozen groups would stay stopped. It releases them, then, if nothing else listens for SIGHUP, raises it again so
   * the process still ends the way a hangup ends it (a listener otherwise swallows the signal's default action).
   * Like the bound, it ends the freeze for good: a host with a SIGHUP listener of its own (the daemon) lives on into
   * its shutdown, and a later round must not stop a group with neither this handler nor the 'exit' one installed.
   */
  private readonly onHup = (): void => {
    this.gaveUp = true;
    this.release();
    if (process.listenerCount('SIGHUP') === 0) process.kill(process.pid, 'SIGHUP');
  };
  private readonly opts: Required<Omit<ReaperOptions, 'snapshot' | 'kill' | 'selfPid'>> & Pick<ReaperOptions, 'snapshot' | 'kill' | 'selfPid'>;

  private readonly root: number;

  constructor(root: number, opts: ReaperOptions = {}) {
    this.root = root;
    this.opts = { sampleMs: leftoverSampleMs(), graceMs: 2_000, killWaitMs: 1_000, boundMs: 15_000, ...opts };
  }

  private snap(): Promise<ProcRow[] | null> {
    return (this.opts.snapshot ?? snapshotProcs)();
  }

  private send(pid: number, sig: NodeJS.Signals | 0): void {
    (this.opts.kill ?? ((p, s) => process.kill(p, s)))(pid, sig);
  }

  private get self(): number {
    return this.opts.selfPid ?? process.pid;
  }

  start(): void {
    if (this.opts.sampleMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.sample(), this.opts.sampleMs);
    this.timer.unref?.();
  }

  childExited(): void {
    this.exited = true;
    clearInterval(this.timer);
  }

  /** Take one sample now (what the timer does); for tests and callers that know a moment worth recording. */
  sampleNow(): Promise<void> {
    return this.sample();
  }

  private async sample(): Promise<void> {
    if (this.sampling || this.exited || this.noPs) return;
    this.sampling = true;
    try {
      const rows = await this.snap();
      if (rows === null) {
        this.noPs = true; // no table now (a sandbox), none later: stop asking
        clearInterval(this.timer);
        return;
      }
      if (this.exited) return; // the table may be from after the exit, when `root` no longer names it
      const byPid = new Map(rows.map((r) => [r.pid, r]));
      const recent = new Set<number>();
      for (const pid of ownedPids(rows, this.root, this.seen, true, this.recent)) {
        const r = byPid.get(pid);
        if (!r) continue;
        recent.add(r.pgid);
        if (r.sid !== null) recent.add(r.sid);
        if (this.seen.size < SEEN_CAP) this.seen.set(r.pid, r.start);
      }
      this.recent = recent;
    } catch {
      /* a sample is best effort */
    } finally {
      this.sampling = false;
    }
  }

  private alive(g: number): boolean {
    try {
      this.send(-g, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private signal(groups: Iterable<number>, sig: NodeJS.Signals, forbidden: Set<number>): void {
    const list = [...new Set(groups)];
    assertSignallable(list, forbidden);
    for (const g of list) {
      try {
        this.send(-g, sig);
      } catch {
        /* already gone */
      }
    }
  }

  private async waitEmpty(groups: number[], ms: number): Promise<number[]> {
    const deadline = Date.now() + ms;
    let left = groups.filter((g) => this.alive(g));
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      left = left.filter((g) => this.alive(g));
    }
    return left;
  }

  /**
   * SIGTERM then SIGCONT to every frozen group, one at a time and unchecked: each was checked when it was stopped,
   * and a check that throws now (a later table that reads differently) must not leave them stopped for good. TERM
   * so a continued group does not simply run on. Synchronous: it is also the 'exit' handler.
   */
  private release(): void {
    for (const g of this.frozen) {
      for (const sig of ['SIGTERM', 'SIGCONT'] as const) {
        try {
          this.send(-g, sig);
        } catch {
          /* already gone */
        }
      }
    }
    this.frozen.clear();
    process.removeListener('exit', this.onExit);
    process.removeListener('SIGHUP', this.onHup);
  }

  /** Idempotent: every call gets the same reap. Resolves within `boundMs`. */
  reap(): Promise<ReapReport> {
    if (this.reaping) return this.reaping;
    clearInterval(this.timer);
    const work = this.doReap().catch((err: unknown): ReapReport => ({
      groups: [], killed: [], survivors: [], noTable: false, timedOut: false, error: (err as Error).message ?? String(err),
    }));
    let bound: NodeJS.Timeout | undefined;
    const late = new Promise<ReapReport>((resolve) => {
      bound = setTimeout(() => {
        // Nothing is left frozen behind a snapshot still pending: the caller may exit as soon as this resolves.
        this.gaveUp = true;
        this.release();
        resolve({ groups: [], killed: [], survivors: [], noTable: false, timedOut: true, error: null });
      }, this.opts.boundMs);
      bound.unref?.();
    });
    this.reaping = Promise.race([work, late]).finally(() => clearTimeout(bound));
    return this.reaping;
  }

  private async doReap(): Promise<ReapReport> {
    const root = this.root;
    if (!Number.isInteger(root) || root <= 1 || root === this.self) throw new UnsafeSignal(`refusing to reap pid ${root}`);
    const rootAlive = !this.exited;
    let rows = await this.snap();
    let forbidden = rows ? forbiddenGroups(rows, this.self) : null;
    if (!rows || !forbidden) {
      // No table to look in: the command's own group only, which is never ours (it was spawned detached).
      const groups = this.alive(root) ? [root] : [];
      if (!groups.length) return { groups, killed: [], survivors: [], noTable: true, timedOut: false, error: null };
      const fence = new Set([0, 1, this.self]);
      this.signal(groups, 'SIGTERM', fence);
      const left = await this.waitEmpty(groups, this.opts.graceMs);
      if (left.length) this.signal(left, 'SIGKILL', fence);
      const survivors = await this.waitEmpty(left, this.opts.killWaitMs);
      return { groups, killed: left, survivors, noTable: true, timedOut: false, error: null };
    }
    let groups = leftoverGroups(rows, root, this.seen, rootAlive, forbidden, this.recent);
    if (!groups.length) return { groups, killed: [], survivors: [], noTable: false, timedOut: false, error: null };
    // The freeze record (none installed: nothing is written and the reap is as it was). Forgotten once the reap settles.
    const recorder = activeRecorder();
    const recorded = new Set<number>();
    try {
      return await this.freezeAndEnd(root, rootAlive, rows, groups, forbidden, recorder, recorded);
    } finally {
      // After the grace and the SIGKILL, on every path (normal, end-for-good, the bound, an error); never at release().
      if (recorder && recorded.size) {
        const r = recorder.forget([...recorded]);
        if (!r.ok) console.error(`foreman: could not clear the freeze record: ${r.error}`);
      }
    }
  }

  private async freezeAndEnd(
    root: number,
    rootAlive: boolean,
    rows: ProcRow[],
    groups: number[],
    forbidden: Set<number>,
    recorder: FreezeRecorder | null,
    recorded: Set<number>,
  ): Promise<ReapReport> {
    // Freeze first: a stopped process forks nothing, so a fresh look then finds
    // every child made since the last one, still under a living parent.
    const stopped = new Set<number>();
    process.on('exit', this.onExit);
    process.on('SIGHUP', this.onHup);
    // A look that throws once the freeze has begun: the groups it already stopped passed the ownership check before
    // their SIGSTOP, so they still get the grace and the SIGKILL below instead of only TERM and CONT.
    let failure: unknown = null;
    try {
      for (let round = 0; round < 3; round++) {
        const fresh = groups.filter((g) => !stopped.has(g));
        // Past the bound the freeze is over (release() has run): no SIGSTOP from here, the reap goes on without one.
        if (!fresh.length || this.gaveUp) break;
        assertSignallable(fresh, forbidden);
        if (recorder) {
          // Written before the SIGSTOP; if it cannot be, nothing is stopped (the TERM below still goes out).
          const res = recorder.record(freezeGroups(rows, fresh));
          if (!res.ok) {
            console.error(`foreman: freeze record failed, leftovers are ended without a freeze: ${res.error}`);
            break;
          }
          for (const g of fresh) recorded.add(g);
        }
        for (const g of fresh) {
          stopped.add(g);
          this.frozen.add(g);
        }
        this.signal(fresh, 'SIGSTOP', forbidden);
        const next = await this.snap();
        const nextForbidden = next ? forbiddenGroups(next, this.self) : null;
        if (!next || !nextForbidden) break;
        rows = next;
        forbidden = new Set([...forbidden, ...nextForbidden]);
        groups = [...new Set([...groups, ...leftoverGroups(rows, root, this.seen, rootAlive, forbidden, this.recent)])];
      }
      this.signal(groups, 'SIGTERM', forbidden);
      // Sent: on the normal path only SIGCONT is left to send to each frozen group.
      for (const g of this.frozen) {
        try {
          this.send(-g, 'SIGCONT');
        } catch {
          /* already gone */
        }
      }
      this.frozen.clear();
    } catch (err) {
      failure = err;
    } finally {
      // An error after a SIGSTOP (or a return above, where the set is already empty): TERM and CONT what is still frozen.
      this.release();
    }
    if (failure !== null) {
      // Only what this reap stopped: each passed the ownership check before its SIGSTOP, and TERM has just been sent.
      const stoppedHere = [...stopped];
      const remaining = await this.waitEmpty(stoppedHere, this.opts.graceMs);
      if (remaining.length) {
        try {
          this.signal(remaining, 'SIGKILL', forbidden);
        } catch {
          /* the error below is what the report says */
        }
      }
      throw failure;
    }
    let left = await this.waitEmpty(groups, this.opts.graceMs);
    // A last look that fails is no reason to skip the SIGKILL: what is still alive of the groups found so far gets it.
    const last = await this.snap().catch(() => null);
    const lastForbidden = last ? forbiddenGroups(last, this.self) : null;
    if (last && lastForbidden) {
      forbidden = new Set([...forbidden, ...lastForbidden]);
      const more = leftoverGroups(last, root, this.seen, rootAlive, forbidden, this.recent).filter((g) => !groups.includes(g));
      groups = [...groups, ...more];
      left = [...new Set([...left, ...more])];
    }
    if (left.length) this.signal(left, 'SIGKILL', forbidden);
    const survivors = await this.waitEmpty(left, this.opts.killWaitMs);
    return { groups: groups.sort((a, b) => a - b), killed: left.sort((a, b) => a - b), survivors, noTable: false, timedOut: false, error: null };
  }
}

/** The record entries for `pgids`: each group and up to FREEZE_MEMBERS_MAX of its members as the snapshot has them. */
function freezeGroups(rows: ProcRow[], pgids: number[]): FreezeGroup[] {
  return pgids.map((pgid) => ({
    pgid,
    members: rows.filter((r) => r.pgid === pgid).slice(0, FREEZE_MEMBERS_MAX).map((r): [number, string] => [r.pid, r.start]),
  }));
}

/** One line for the daemon's log about a reap, or null when there is nothing to say. */
export function describeReap(what: string, report: ReapReport): string | null {
  if (report.error) return `foreman: ending what ${what} left running failed: ${report.error}`;
  if (report.timedOut) return `foreman: ending what ${what} left running took too long; the run goes on and the reap carries on in the background`;
  if (!report.groups.length) return null;
  const parts = [`foreman: ${what} left ${report.groups.length} process group(s) running at exit (${report.groups.join(', ')}); ended them`];
  if (report.killed.length) parts.push(`SIGKILL after the grace: ${report.killed.join(', ')}`);
  if (report.survivors.length) parts.push(`still present: ${report.survivors.join(', ')}`);
  if (report.noTable) parts.push('no process table: only its own group was signalled');
  return parts.join('; ');
}

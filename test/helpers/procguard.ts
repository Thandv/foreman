import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realHomes } from '../env.ts';
import { parseRecordName } from '../../src/runners/freezeRecord.ts';

/**
 * A guard for tests that start or freeze processes: the test gets a throwaway FOREMAN_HOME, the real home's frozen/
 * directory is checked to be as it was, and the pids the test made are checked not to be stopped (state T) and then
 * killed, so a test that goes wrong cannot leave a frozen process behind or write to the operator's home.
 *
 * The real homes are shared: every `foreman` command, `foreman serve` and `testSlot.ts` writes its presence marker
 * (`<pid>-<start>.json`) and the groups it freezes there while a test runs. A change to a record file whose recorder
 * pid is alive and is neither this process, a tracked pid nor a descendant of either is another process's, and is not
 * counted; nor is the removal of a record whose recorder was such a process when the guard started (it exited and
 * removed its own file). Everything else counts: names that are not record names (the sweep's cursor), a record of
 * this process or of one it made, and a record whose recorder is gone (whose it was cannot be told). Where ps cannot
 * be run every change counts.
 */

/**
 * name -> "kind size mtimeMs" for everything under `dir`, or null where `dir` does not exist or cannot be listed. A
 * suite run inside the Foreman sandbox (a worker's testSlot, the gate) is refused Foreman's home: `existsSync` still
 * says yes there, and a listing would throw EPERM in every guarded test. What the suite cannot read it cannot write
 * either, so there is nothing to watch.
 */
export type FrozenSnapshot = Map<string, string> | null;

export function snapshotFrozen(dir: string): FrozenSnapshot {
  if (!fs.existsSync(dir)) return null;
  const out = new Map<string, string>();
  // Another process's recorder renames and removes its files while this reads: an entry gone between the listing and
  // its lstat (or a directory gone before it is listed) is simply not there.
  const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
  const closed = (e: unknown): boolean => ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
  const walk = (d: string, prefix: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      if (gone(e) && prefix !== '') return;
      throw e;
    }
    for (const name of names) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(d, name));
      } catch (e) {
        if (gone(e)) continue;
        throw e;
      }
      const rel = prefix + name;
      out.set(rel, `${st.isDirectory() ? 'dir' : 'file'} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(path.join(d, name), rel + '/');
    }
  };
  try {
    walk(dir, '');
  } catch (e) {
    if (gone(e) || closed(e)) return null;
    throw e;
  }
  return out;
}

/** One difference between two snapshots: `names` are the entries it is about (for `appeared`, everything in it). */
export interface FrozenChange {
  kind: 'added' | 'changed' | 'removed' | 'appeared' | 'disappeared';
  names: string[];
  text: string;
}

export function frozenChangeList(before: FrozenSnapshot, after: FrozenSnapshot): FrozenChange[] {
  if (before === null && after === null) return [];
  if (before === null) return [{ kind: 'appeared', names: [...after!.keys()], text: 'frozen/ appeared' }];
  if (after === null) return [{ kind: 'disappeared', names: [...before.keys()], text: 'frozen/ disappeared' }];
  const changes: FrozenChange[] = [];
  for (const [name, v] of after) {
    if (!before.has(name)) changes.push({ kind: 'added', names: [name], text: `added ${name}` });
    else if (before.get(name) !== v) changes.push({ kind: 'changed', names: [name], text: `changed ${name}: ${before.get(name)} -> ${v}` });
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push({ kind: 'removed', names: [name], text: `removed ${name}` });
  return changes;
}

/** What differs between two snapshots, one line each; empty when they are the same. */
export function frozenChanges(before: FrozenSnapshot, after: FrozenSnapshot): string[] {
  return frozenChangeList(before, after).map((c) => c.text);
}

/** The recorder pid a top-level `<pid>-<key>.json` or `<pid>-<key>.json.tmp` name carries, else null. */
export function recordPid(name: string): number | null {
  return parseRecordName(name.endsWith('.json.tmp') ? name.slice(0, -'.tmp'.length) : name)?.pid ?? null;
}

/** pid -> ppid for every process, by one `ps`; null when ps cannot be run (then nothing is taken to be foreign). */
export function processParents(psBin = 'ps'): Map<number, number> | null {
  const r = spawnSync(psBin, ['-axo', 'pid=,ppid='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
  if (r.error || r.status !== 0) return null;
  const parents = new Map<number, number>();
  for (const line of String(r.stdout).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
}

/**
 * Of `pids`, those alive in `parents` that are not ours: not in `ours` and with no process of `ours` on their parent
 * chain. `ours` always holds this process.
 */
export function foreignPids(pids: Iterable<number>, parents: Map<number, number> | null, ours: Iterable<number> = []): Set<number> {
  const out = new Set<number>();
  if (!parents) return out;
  const mine = new Set([process.pid, ...ours]);
  for (const pid of pids) {
    if (!parents.has(pid) || mine.has(pid)) continue;
    let p: number | undefined = pid;
    let ourOwn = false;
    for (let depth = 0; p !== undefined && p > 1 && depth < 128; depth++) {
      if (mine.has(p)) {
        ourOwn = true;
        break;
      }
      p = parents.get(p);
    }
    if (!ourOwn) out.add(pid);
  }
  return out;
}

/** Every record pid named in these snapshots. */
export function recordPids(...snaps: FrozenSnapshot[]): Set<number> {
  const out = new Set<number>();
  for (const s of snaps) for (const name of s?.keys() ?? []) {
    const pid = recordPid(name);
    if (pid !== null) out.add(pid);
  }
  return out;
}

/**
 * The changes between `before` and `after` that this test may have made (see the guard's comment above): `foreignNow`
 * are recorders alive and not ours now, `foreignAtStart` those that were when `before` was taken.
 */
export function ownFrozenChanges(before: FrozenSnapshot, after: FrozenSnapshot, foreignNow: Set<number>, foreignAtStart: Set<number>): string[] {
  const foreign = (kind: FrozenChange['kind'], name: string): boolean => {
    const pid = recordPid(name);
    if (pid === null) return false;
    return foreignNow.has(pid) || ((kind === 'removed' || kind === 'disappeared') && foreignAtStart.has(pid));
  };
  return frozenChangeList(before, after)
    .filter((c) => !(c.names.length > 0 && c.names.every((n) => foreign(c.kind, n))))
    .map((c) => c.text);
}

function usable(pids: number[]): number[] {
  return pids.filter((p) => Number.isInteger(p) && p > 1);
}

/** The pids among `pids` that are in state T (stopped), by `ps -o pid=,stat=`. Gone pids are not listed. */
export function stoppedPids(pids: number[], psBin = 'ps'): number[] {
  const list = usable(pids);
  if (list.length === 0) return [];
  const r = spawnSync(psBin, ['-o', 'pid=,stat=', '-p', list.join(',')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
  if (r.error) throw new Error(`cannot check pids for state T, ps failed: ${r.error.message}`);
  const stopped: number[] = [];
  for (const line of String(r.stdout).split('\n')) {
    const [pid, stat] = line.trim().split(/\s+/);
    if (pid && stat?.startsWith('T')) stopped.push(Number(pid));
  }
  return stopped;
}

/** The pids in these process groups, by `ps -axo pid=,pgid=`; throws when ps fails (as stoppedPids does). */
export function groupMembers(pgids: number[], psBin = 'ps'): number[] {
  const want = new Set(usable(pgids));
  if (want.size === 0) return [];
  const r = spawnSync(psBin, ['-axo', 'pid=,pgid='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
  if (r.error) throw new Error(`cannot list tracked groups, ps failed: ${r.error.message}`);
  const out: number[] = [];
  for (const line of String(r.stdout).split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && want.has(pgid!)) out.push(pid!);
  }
  return out;
}

/** SIGKILL each group (a stopped member dies of it too); a group already gone is not an error. */
export function killGroups(pgids: number[]): void {
  for (const pgid of usable(pgids)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** SIGKILL each pid (a stopped process dies of it too); a pid already gone is not an error. */
export function killPids(pids: number[]): void {
  for (const pid of usable(pids)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * A test that needs the live process table skips only where ps is refused at exec (EPERM), which is what a sandboxed
 * suite run gets on macOS (test/proctree.test.ts does the same); any other ps failure runs the test, and it fails.
 */
export const NEEDS_PS = {
  skip:
    (spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)]).error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
      ? 'ps cannot be started here (this suite is running inside a sandbox): there is no process table to read'
      : false,
};

export interface ProcGuard {
  /** A fresh FOREMAN_HOME, removed when the test ends. */
  home: string;
  /** The process env with FOREMAN_HOME pointing at `home`. */
  env: NodeJS.ProcessEnv;
  /** Hand over a pid the test created; it is checked and killed at the end. */
  track(pid: number | undefined): void;
  /**
   * Hand over a process group the test created (its pgid): every member found at the end is checked for state T and
   * the group is SIGKILLed, so a member the test never saw (a loop's current `sleep`) cannot be left stopped.
   */
  trackGroup(pgid: number | undefined): void;
  /** The end-of-test checks; runs once (the test's own t.after calls it), throwing if any failed. */
  finish(): void;
}

/** `realHomes`: the homes whose frozen/ is watched (default: test/env.ts's); `psBin`: the ps to ask, for a test of ps failing. */
export function procGuard(t: TestContext, opts: { realHomes?: string[]; psBin?: string } = {}): ProcGuard {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-procguard-'));
  const before = new Map((opts.realHomes ?? realHomes).map((h) => [path.join(h, 'frozen'), snapshotFrozen(path.join(h, 'frozen'))]));
  const atStart = recordPids(...before.values());
  // ps only when a real home holds a record: usually none does.
  const foreignAtStart = atStart.size ? foreignPids(atStart, processParents(opts.psBin)) : new Set<number>();
  const pids: number[] = [];
  const groups: number[] = [];
  let finished = false;
  const guard: ProcGuard = {
    home,
    env: { ...process.env, FOREMAN_HOME: home },
    track(pid) {
      if (pid !== undefined) pids.push(pid);
    },
    trackGroup(pgid) {
      if (pgid !== undefined) groups.push(pgid);
    },
    finish() {
      if (finished) return;
      finished = true;
      const problems: string[] = [];
      let ends: number[] = []; // groups are killed only once ps has shown they do not hold this process
      try {
        // A group this process is in is never ended (a wrong pgid handed over must not kill the suite).
        const ownGroups = new Set(groups.filter((pg) => groupMembers([pg], opts.psBin).includes(process.pid)));
        if (ownGroups.size) problems.push(`tracked group(s) ${[...ownGroups].join(', ')} hold this process: not killed`);
        ends = groups.filter((pg) => !ownGroups.has(pg));
        const members = groupMembers(ends, opts.psBin);
        const stopped = stoppedPids([...new Set([...pids, ...members])], opts.psBin);
        if (stopped.length) problems.push(`pids left in state T: ${stopped.join(', ')}`);
      } catch (e) {
        problems.push((e as Error).message);
      }
      killGroups(ends);
      killPids(pids);
      fs.rmSync(home, { recursive: true, force: true });
      const after = new Map([...before.keys()].map((dir) => [dir, snapshotFrozen(dir)]));
      const changed = [...before].some(([dir, snap]) => frozenChangeList(snap, after.get(dir)!).length > 0);
      const now = changed ? recordPids(...before.values(), ...after.values()) : new Set<number>();
      const foreignNow = now.size ? foreignPids(now, processParents(opts.psBin), [...pids, ...groups]) : new Set<number>();
      for (const [dir, snap] of before) {
        for (const c of ownFrozenChanges(snap, after.get(dir)!, foreignNow, foreignAtStart)) problems.push(`real home ${dir}: ${c}`);
      }
      if (problems.length) throw new Error(problems.join('; '));
    },
  };
  t.after(() => guard.finish());
  return guard;
}

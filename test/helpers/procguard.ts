import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realHomes } from '../env.ts';

/**
 * A guard for tests that start or freeze processes: the test gets a throwaway FOREMAN_HOME, the real home's frozen/
 * directory is checked to be as it was, and the pids the test made are checked not to be stopped (state T) and then
 * killed, so a test that goes wrong cannot leave a frozen process behind or write to the operator's home.
 */

/** name -> "kind size mtimeMs" for everything under `dir`, or null where `dir` does not exist. */
export type FrozenSnapshot = Map<string, string> | null;

export function snapshotFrozen(dir: string): FrozenSnapshot {
  if (!fs.existsSync(dir)) return null;
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const name of fs.readdirSync(d)) {
      const st = fs.lstatSync(path.join(d, name));
      const rel = prefix + name;
      out.set(rel, `${st.isDirectory() ? 'dir' : 'file'} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(path.join(d, name), rel + '/');
    }
  };
  walk(dir, '');
  return out;
}

/** What differs between two snapshots, one line each; empty when they are the same. */
export function frozenChanges(before: FrozenSnapshot, after: FrozenSnapshot): string[] {
  if (before === null && after === null) return [];
  if (before === null) return ['frozen/ appeared'];
  if (after === null) return ['frozen/ disappeared'];
  const changes: string[] = [];
  for (const [name, v] of after) {
    if (!before.has(name)) changes.push(`added ${name}`);
    else if (before.get(name) !== v) changes.push(`changed ${name}: ${before.get(name)} -> ${v}`);
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push(`removed ${name}`);
  return changes;
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
  /** The end-of-test checks; runs once (the test's own t.after calls it), throwing if any failed. */
  finish(): void;
}

/** `realHomes`: the homes whose frozen/ is watched (default: test/env.ts's); `psBin`: the ps to ask, for a test of ps failing. */
export function procGuard(t: TestContext, opts: { realHomes?: string[]; psBin?: string } = {}): ProcGuard {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-procguard-'));
  const before = new Map((opts.realHomes ?? realHomes).map((h) => [path.join(h, 'frozen'), snapshotFrozen(path.join(h, 'frozen'))]));
  const pids: number[] = [];
  let finished = false;
  const guard: ProcGuard = {
    home,
    env: { ...process.env, FOREMAN_HOME: home },
    track(pid) {
      if (pid !== undefined) pids.push(pid);
    },
    finish() {
      if (finished) return;
      finished = true;
      const problems: string[] = [];
      try {
        const stopped = stoppedPids(pids, opts.psBin);
        if (stopped.length) problems.push(`pids left in state T: ${stopped.join(', ')}`);
      } catch (e) {
        problems.push((e as Error).message);
      }
      killPids(pids);
      fs.rmSync(home, { recursive: true, force: true });
      for (const [dir, snap] of before) {
        for (const c of frozenChanges(snap, snapshotFrozen(dir))) problems.push(`real home ${dir}: ${c}`);
      }
      if (problems.length) throw new Error(problems.join('; '));
    },
  };
  t.after(() => guard.finish());
  return guard;
}

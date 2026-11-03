import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** What is known about a running process, for deciding whether it is a foreman daemon for one home. */
export interface ProcInfo {
  command: string;
  /** FOREMAN_HOME in its environment; undefined when unset or unreadable. */
  home?: string;
}

export interface OwnerDeps {
  home: string;
  /** The home a process with no FOREMAN_HOME runs in. */
  defaultHome: string;
  port: number;
  alive: (pid: number) => boolean;
  /** Pids listening on the daemon's TCP port. */
  listeners: (port: number) => number[];
  describe: (pid: number) => ProcInfo | undefined;
}

export function pidfileHolder(home: string): number {
  try {
    const n = Number(fs.readFileSync(path.join(home, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : NaN;
  } catch {
    return NaN;
  }
}

/** True only for a `foreman serve` process whose home is this one. */
export function isDaemonFor(info: ProcInfo | undefined, home: string, defaultHome: string): boolean {
  if (!info) return false;
  if (!/(^|[\s/])(cli\.ts|foreman)(\s|$)/.test(info.command) || !/(^|\s)serve(\s|$)/.test(info.command)) return false;
  return path.resolve(info.home ?? defaultHome) === path.resolve(home);
}

/**
 * The live foreman daemon that owns `home`: the pid in daemon.pid when that is one, otherwise whichever verified
 * daemon for this home listens on the port (the pidfile can name a dead pid while the real owner runs). Anything
 * that is not a foreman daemon for this home is never returned.
 */
export function findDaemonOwner(deps: OwnerDeps): number | undefined {
  const { home, defaultHome, port } = deps;
  const ok = (pid: number): boolean => deps.alive(pid) && isDaemonFor(deps.describe(pid), home, defaultHome);
  const held = pidfileHolder(home);
  if (Number.isInteger(held) && ok(held)) return held;
  for (const pid of deps.listeners(port)) if (pid !== held && ok(pid)) return pid;
  return undefined;
}

export function systemListeners(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0) return [];
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

export function systemDescribe(pid: number): ProcInfo | undefined {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('FOREMAN_HOME='));
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    return { command, home: env?.slice('FOREMAN_HOME='.length) };
  } catch {
    /* no /proc (macOS): ask ps, which shows the environment of our own processes */
  }
  try {
    const out = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    if (!out) return undefined;
    const m = /(?:^|\s)FOREMAN_HOME=(\S+)/.exec(out);
    // Environment entries follow the arguments; the command is everything before the first KEY=value token.
    const command = out.split(/\s+(?=[A-Z_][A-Z0-9_]*=)/)[0] ?? out;
    return { command, home: m?.[1] };
  } catch {
    return undefined;
  }
}

export interface StopDeps extends OwnerDeps {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  graceMs?: number;
}

/** `foreman stop`: signal the verified owner and wait for it; clear the pidfile only when no owner exists. */
export async function stopDaemon(deps: StopDeps): Promise<number> {
  const pidFile = path.join(deps.home, 'daemon.pid');
  const held = pidfileHolder(deps.home);
  const owner = findDaemonOwner(deps);
  if (owner === undefined) {
    if (!fs.existsSync(pidFile)) {
      deps.out(`no daemon pidfile at ${pidFile}\n`);
      return 0;
    }
    if (!Number.isInteger(held)) throw new Error(`unreadable pidfile: ${pidFile}`);
    deps.out(`daemon ${held} was not running; clearing a stale pidfile\n`);
    fs.rmSync(pidFile, { force: true });
    return 0;
  }
  if (owner !== held) deps.out(`pidfile names ${Number.isInteger(held) ? held : 'no one'}; the daemon for this home is ${owner}\n`);
  try {
    deps.kill(owner, 'SIGTERM');
  } catch {
    deps.out(`daemon ${owner} was not running\n`);
    return 0;
  }
  // Shutdown aborts in-flight runs and escalates to SIGKILL, so give it room.
  const grace = deps.graceMs ?? 90_000;
  const deadline = deps.now() + grace;
  for (;;) {
    await deps.sleep(200);
    try {
      deps.kill(owner, 0);
    } catch {
      deps.out(`daemon ${owner} stopped\n`);
      return 0;
    }
    if (deps.now() > deadline) {
      deps.err(`daemon ${owner} is still shutting down after ${Math.round(grace / 1000)}s; check ${deps.home}\n`);
      return 1;
    }
  }
}

import { spawn } from 'node:child_process';
import { describeReap, escalationFor, LeftoverReaper, signalGroups, snapshotPs, snapshotTreeGroups } from './proctree.ts';

/** Names that look like credentials, whatever the process happens to hold. */
const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|COOKIE|AUTH)/i;
/** The only variables a forged tool is allowed to see. */
const TOOL_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'USER', 'SHELL', 'PWD']);

/**
 * Variables that switch a program's colour output on or off whatever it writes to. The daemon takes them from
 * whatever started it: the desktop app that launches it sets FORCE_COLOR=1, and with that a child process's
 * `console.log(5)` printed the 5 inside colour codes, so a repo's suite compared the output to "5" and went red —
 * under the daemon only. None of them is inherited by a test command, a check or a shell ticket (withoutColourEnv),
 * so a suite sees one colour environment whoever started the daemon. TERM stays: with output on a pipe it forces
 * nothing, and `tput` and the like need it.
 */
export const COLOUR_ENV: readonly string[] = ['FORCE_COLOR', 'NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'NODE_DISABLE_COLORS', 'COLORTERM'];

/** `env` without the colour switches above. What a caller then sets itself is its own business. */
export function withoutColourEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !COLOUR_ENV.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * `deny` drops credential-shaped variables but keeps the rest, so a project's
 * own test command still works. `allow` keeps only the handful a tool needs —
 * forged code is the least trusted thing Foreman runs. Neither inherits a
 * colour switch (COLOUR_ENV); one named in `extra` is passed on.
 */
export function scrubbedEnv(mode: 'deny' | 'allow', extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(withoutColourEnv(process.env))) {
    if (value === undefined) continue;
    if (mode === 'allow' ? TOOL_ALLOWLIST.has(key) : !SECRET_RE.test(key)) out[key] = value;
  }
  return { ...out, ...extra };
}

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Replace the inherited environment instead of extending it. */
  replaceEnv?: boolean;
  onLine(line: string, stream: 'stdout' | 'stderr'): void;
  /** The child's pid (== its pgid, since it is detached), for orphan reaping. */
  onSpawn?(pid: number): void;
}

/**
 * Spawn a child, stream it line-by-line, and guarantee it dies with us.
 * Resolves with the exit code; a signalled death resolves as a non-zero code
 * rather than throwing, so callers get one uniform failure path.
 *
 * Nothing it starts outlives it: when the child exits — by itself or on an
 * abort — what it left running is found and ended (proctree.ts
 * LeftoverReaper: SIGTERM, a 2 s grace, SIGKILL), and the promise settles only
 * once that is done or has run past its 15 s bound. The caller's next step
 * (a git call on the jail, the run's result) therefore never races a process
 * the command left behind, except one that made its own session before any
 * sample saw it. A reap that fails or runs long is logged and the result goes
 * on as before: the reap is a fence, not a verdict on the command.
 */
export function spawnStreaming(cmd: string, args: string[], opts: SpawnOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.replaceEnv ? (opts.env ?? {}) : { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can kill descendants too
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const reaper = child.pid !== undefined ? new LeftoverReaper(child.pid) : null;
    reaper?.start();
    let reaped: Promise<void> | null = null;
    // Started on 'exit', not 'close': a leftover still holding the child's stdout would keep 'close' from ever firing.
    const reapLeftovers = (): Promise<void> => {
      reaped ??= reaper
        ? reaper.reap().then((report) => {
            const line = describeReap(`'${cmd}'`, report);
            if (line) process.stderr.write(`${line}\n`);
          }).catch(() => {})
        : Promise.resolve();
      return reaped;
    };
    child.on('exit', () => {
      reaper?.childExited();
      void reapLeftovers();
    });

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    // Groups found under the child when the abort came: anything in the tree
    // that made its own group (a worker's `npm run verify`) would otherwise
    // outlive the group signal. Snapshotted before signalling, since a dead
    // parent reparents its children to launchd and drops them from the walk.
    let treeAtAbort: number[] = [];
    const onAbort = (): void => {
      if (child.pid !== undefined) {
        treeAtAbort = snapshotTreeGroups(child.pid).filter((g) => g !== child.pid);
        signalGroups(treeAtAbort, 'SIGTERM');
      }
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
        if (child.pid === undefined) return;
        // Escalate on the remembered groups plus whatever the tree holds now
        // (only while the child has not exited — once reaped its pid may be
        // reused; 'close' is later, it waits for stdio), and only groups that
        // still have a member.
        const rows = snapshotPs();
        signalGroups(escalationFor(child, treeAtAbort, rows, process.pid), 'SIGKILL');
      }, 5000);
      killTimer.unref?.();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    // The first throw from opts.onLine (a ledger fault in the caller's callback) fails closed: no later line reaches
    // it, the child's group ends as on an abort, and the promise rejects once the child has closed and been reaped.
    let lineFault: Error | null = null;
    const deliver = (line: string, stream: 'stdout' | 'stderr'): void => {
      if (lineFault) return;
      try {
        opts.onLine(line, stream);
      } catch (err) {
        lineFault = err instanceof Error ? err : new Error(String(err));
        process.stderr.write(`'${cmd}': onLine threw, ending the command: ${lineFault.message}\n`);
        onAbort();
      }
    };

    const cleanup = (): void => {
      // A descendant in its own group can outlive the child, so its escalation
      // stays armed (it is unref'd and re-checks liveness before signalling).
      if (treeAtAbort.length === 0) clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
    };

    for (const stream of ['stdout', 'stderr'] as const) {
      let buf = '';
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) deliver(line, stream);
        }
        // Guard against a child that never emits a newline.
        if (buf.length > 1_000_000) {
          deliver(buf.slice(0, 1_000_000), stream);
          buf = '';
        }
      });
      child[stream]?.on('end', () => {
        if (buf.trim()) deliver(buf, stream);
        buf = '';
      });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reaper?.childExited(); // no reap: the child may never have run, or may still be running
      reject(err);
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      void reapLeftovers().then(() => {
        if (lineFault) reject(new Error(`onLine threw: ${lineFault.message}`, { cause: lineFault }));
        else resolve(code ?? (sig ? 128 : 1));
      });
    });
  });
}

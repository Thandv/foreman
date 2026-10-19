import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { alignDir } from './extract.ts';

/**
 * One local model at a time, across every process on this machine.
 *
 * Per-subsystem locks are not enough. Training held its own lock and the
 * adoption gate held nothing, so a gate run (a 4.5 GB base under mlx) and a
 * chapter-flagging run (an 8.5 GB model under ollama) started at the same time
 * on a 17 GB machine: 13 GB of weights, 33 GB of swap, and the ollama request
 * failed outright. Neither job was wrong; they simply could not see each other.
 *
 * The lock is a file holding a pid and a label, at a path any process can find
 * — including the book's own shell scripts, which are not Foreman and never
 * will be. A lock whose pid is gone is stale and is cleared rather than waited
 * on, so a crash cannot wedge the machine's inference forever.
 */
export interface LockHolder {
  pid: number;
  label: string;
  since: number;
}

export function localModelLockFile(): string {
  return process.env['FOREMAN_LOCAL_LOCK'] ?? path.join(alignDir(), 'local-model.lock');
}

/** Who holds the lock, or null when it is free (clearing a stale one on the way). */
export function localModelLockHolder(): LockHolder | null {
  const file = localModelLockFile();
  if (!fs.existsSync(file)) return null;
  let holder: LockHolder;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8')) as LockHolder;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
  if (!Number.isFinite(holder.pid) || holder.pid <= 0) {
    fs.rmSync(file, { force: true });
    return null;
  }
  try {
    process.kill(holder.pid, 0); // existence check; sends nothing
    return holder;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
}

/** Take the lock, or return the holder that already has it. */
export function acquireLocalModelLock(label: string, pid = process.pid): LockHolder | null {
  const held = localModelLockHolder();
  if (held) return held;
  const file = localModelLockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_CREAT|O_EXCL, exactly as the daemon lock does it (lock.ts). A plain
  // write is a TOCTOU: two processes both read "free" a millisecond apart and
  // both write, and both believe they hold it — which is precisely the
  // collision this lock exists to prevent. It has already happened once for
  // real on this machine: 4.5 GB under mlx plus 8.5 GB under ollama, 33 GB of
  // swap, and the ollama request failed outright.
  try {
    fs.writeFileSync(file, JSON.stringify({ pid, label, since: Date.now() }), { flag: 'wx' });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lost the race, or a holder appeared between the check and the write.
    // Re-read: a stale file is cleared by localModelLockHolder, so a second
    // attempt after a genuine crash still succeeds.
    return localModelLockHolder() ?? acquireLocalModelLock(label, pid);
  }
}

/** Release it, but only if we are the holder: never free someone else's lock. */
export function releaseLocalModelLock(pid = process.pid): void {
  const held = localModelLockHolder();
  if (held && held.pid !== pid) return;
  fs.rmSync(localModelLockFile(), { force: true });
}

/** Human-readable, for the message a blocked job prints. */
export function describeHolder(holder: LockHolder): string {
  const mins = Math.round((Date.now() - holder.since) / 60_000);
  return `${holder.label} (pid ${holder.pid}, ${mins}m)`;
}

/**
 * Wait for the lock to free, up to `timeoutMs`. Returns the holder still in the
 * way on timeout, or null once taken. Scripts poll; nothing blocks forever.
 */
export async function waitForLocalModelLock(
  label: string,
  timeoutMs: number,
  pollMs = 5_000,
): Promise<LockHolder | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blocked = acquireLocalModelLock(label);
    if (!blocked) return null;
    if (Date.now() >= deadline) return blocked;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** The whole machine's memory, for callers sizing a job against it. */
export const totalMemoryBytes = (): number => os.totalmem();

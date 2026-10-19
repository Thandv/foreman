/**
 * A process-wide FIFO semaphore on the test commands Foreman itself spawns:
 * worker gate checks, playbook (crew) checks, and the post-merge main check
 * with its flake re-run. At most FOREMAN_MAX_VERIFIES (default 2) run at once
 * across every task; the rest wait in arrival order. A worker's own full-suite
 * run takes a slot too, through the daemon's /api/verify-slot lease
 * (testSlot.ts); a targeted single-file run it makes directly does not.
 */

export const DEFAULT_MAX_VERIFIES = 2;

/** Read lazily, never captured at module load, so tests can flip it per case. */
export function maxVerifies(): number {
  const n = Math.floor(Number(process.env['FOREMAN_MAX_VERIFIES']));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_VERIFIES;
}

interface Waiter {
  grant: () => void;
}

let active = 0;
const queue: Waiter[] = [];

function pump(): void {
  while (active < maxVerifies() && queue.length) {
    active++;
    queue.shift()!.grant();
  }
}

/** Thrown when the signal aborts while the caller is still queued for a slot. */
export class VerifyWaitAborted extends Error {
  constructor() {
    super('aborted while waiting for a verify slot');
  }
}

/**
 * Wait for a slot. Resolves with a release function (idempotent) and the
 * milliseconds spent waiting; rejects, leaving the queue, if `signal` aborts first.
 */
export function acquireVerifySlot(signal?: AbortSignal): Promise<{ release: () => void; waitedMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new VerifyWaitAborted());
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        let released = false;
        resolve({
          waitedMs: Date.now() - started,
          release: () => {
            if (released) return;
            released = true;
            active--;
            pump();
          },
        });
      },
    };
    const onAbort = (): void => {
      const i = queue.indexOf(waiter);
      if (i >= 0) queue.splice(i, 1);
      reject(new VerifyWaitAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
    pump();
  });
}

/**
 * Run `fn` holding a slot; the slot is released on success, failure, timeout,
 * throw or abort. `onWaited` is told how long the caller queued, only when > 0.
 */
export async function withVerifySlot<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  onWaited?: (ms: number) => void,
  onQueue?: (queued: boolean) => void,
): Promise<T> {
  // onQueue(true) before taking a place in the queue and onQueue(false) once a slot is held (or the wait ended), so a
  // caller can stop its own clock while it waits: a run's deadline is for its work, not for other runs' tests.
  onQueue?.(true);
  let slot: Awaited<ReturnType<typeof acquireVerifySlot>>;
  try {
    slot = await acquireVerifySlot(signal);
  } finally {
    onQueue?.(false);
  }
  try {
    if (slot.waitedMs > 0) onWaited?.(slot.waitedMs);
    return await fn();
  } finally {
    slot.release();
  }
}

/** Slots held and callers queued right now (for diagnostics and tests). */
export function verifySlotStats(): { active: number; waiting: number } {
  return { active, waiting: queue.length };
}

// ---------------------------------------------------------------- one suite run per run

/** The request headers the slot wrapper (testSlot.ts) names itself with on POST /api/verify-slot. */
export const RUN_HEADER = 'x-foreman-run';
export const WRAPPER_PID_HEADER = 'x-foreman-wrapper-pid';
export const OUTPUT_HEADER = 'x-foreman-output';

/** A path the slot wrapper could have built for a saved output: absolute, no whitespace, in its folder, its file name. */
const SAVED_OUTPUT_PATH = /^\/[\x21-\x7e]*\/foreman-suite-output\/[A-Za-z0-9._]+-\d+-\d+\.log$/;

interface RunLeaseHolder {
  since: number;
  pid: number | null;
  output: string | null;
}

/**
 * Runs with a slot request open right now — waiting or granted. Keyed by run id and by nothing else: the entry
 * lives exactly as long as its request's connection (the handler releases it on close), so a wrapper that died
 * leaves none behind, and the pid in it is only ever printed, never trusted to say who is alive.
 */
const runLeases = new Map<string, RunLeaseHolder>();

export interface RunLease {
  /** The run the request named, or null when it named none (an older worker env): nothing is enforced then. */
  runId: string | null;
  /** Set when this run already has a slot request open: the line to answer with, and nothing was claimed. */
  busy: string | null;
  /** Give the claim back. Idempotent; a no-op for a request that claimed nothing. */
  release: () => void;
}

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();

/**
 * A worker's suite run asks for a slot: one request per run at a time. A second one for the same run while the
 * first is open is refused here, before it takes a place in the queue — a worker that started two suite runs a
 * second apart held both of the two slots and then waited on itself. A different run, a request that names no
 * run, and the daemon's own test stage (which never comes through here) are not affected.
 */
export function claimRunLease(headers: Record<string, string | string[] | undefined>, now: () => number = Date.now): RunLease {
  const runId = one(headers[RUN_HEADER]);
  if (!/^[\w.-]{1,80}$/.test(runId)) return { runId: null, busy: null, release: () => {} };
  const holder = runLeases.get(runId);
  if (holder) {
    const secs = Math.max(0, Math.round((now() - holder.since) / 1000));
    return { runId, busy: `busy ${secs} ${holder.pid ?? '-'} ${holder.output ?? ''}`.trimEnd(), release: () => {} };
  }
  const pid = Number(one(headers[WRAPPER_PID_HEADER]));
  const output = one(headers[OUTPUT_HEADER]);
  const mine: RunLeaseHolder = {
    since: now(),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    // Echoed into the transcript of the same run's next wrapper, and the header is anyone's to send: only the
    // shape the wrapper itself builds (suiteOutput.ts: <dir>/foreman-suite-output/<run>-<ms>-<pid>.log, no spaces)
    // is repeated, so the line cannot carry a sentence addressed to the worker.
    output: output.length <= 1024 && SAVED_OUTPUT_PATH.test(output) ? output : null,
  };
  runLeases.set(runId, mine);
  return {
    runId,
    busy: null,
    release: () => {
      if (runLeases.get(runId) === mine) runLeases.delete(runId);
    },
  };
}

/** How many callers are queued ahead of one that asks now, or null when a slot is free and it would not wait. */
export function slotsAhead(): number | null {
  return active >= maxVerifies() || queue.length > 0 ? queue.length : null;
}

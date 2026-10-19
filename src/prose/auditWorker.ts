/**
 * `auditDir` in a worker thread, for the daemon.
 *
 * One worker per audit, not a long-lived pool: an audit happens once per run,
 * a thread costs tens of milliseconds to start, and a per-call worker means a
 * wedged manuscript is terminated with the request rather than left to poison
 * every later audit. The CLI keeps calling `auditDir` directly — it is a
 * standalone process with nothing else to block.
 */
import { Worker } from 'node:worker_threads';
import type { ProseAuditResult } from './audit.ts';

/** A manuscript that has not been audited in this long is not going to be. */
export const AUDIT_TIMEOUT_MS = 60_000;

export interface AuditWorkerOptions {
  timeoutMs?: number;
  /** Task cancellation: a run being torn down must not hold a thread. */
  signal?: AbortSignal;
}

export function auditDirAsync(dir: string, opts: AuditWorkerOptions = {}): Promise<ProseAuditResult> {
  const timeoutMs = opts.timeoutMs ?? AUDIT_TIMEOUT_MS;
  const signal = opts.signal;
  return new Promise<ProseAuditResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('prose audit aborted'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const worker = new Worker(new URL('./audit.worker.ts', import.meta.url));

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Terminated, never merely abandoned: a thread still chewing on a
      // pathological book is the CPU this module exists to give back.
      void worker.terminate();
      act();
    };
    const onAbort = (): void => finish(() => reject(new Error('prose audit aborted')));

    timer = setTimeout(
      () => finish(() => reject(new Error(`prose audit timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg: { result?: ProseAuditResult; error?: string }) => {
      const { error, result } = msg;
      if (error) finish(() => reject(new Error(error)));
      else if (result) finish(() => resolve(result));
    });
    worker.on('error', (e: Error) => finish(() => reject(new Error(`prose audit worker failed: ${e.message}`))));
    // A worker that dies takes the request with it; a promise that never
    // settles would park the run at the test stage for the whole task timeout.
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`prose audit worker exited with ${code}`)));
    });

    // Deliberately NOT unref'd: the audit is on the run's critical path, and an
    // unref'd worker lets the process exit with this promise unsettled.
    worker.postMessage({ id: 1, dir });
  });
}

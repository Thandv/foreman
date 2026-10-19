/**
 * The whole-book audit, off the thread that runs the pool.
 *
 * `auditDir` is pure, deterministic and the most expensive thing Foreman does
 * without asking a model: crutch words, cross-scene echoes and proper-noun
 * variants all walk every scene against every other. The original app ran this
 * computation and measured the echo merge alone at 505 s on a 16 MB book —
 * and the scheduler calls it from inside a single-threaded tick, where those
 * seconds are seconds no other task is claimed, launched, gated or reaped.
 *
 * The READ stays with the caller's filesystem view; only the CPU crosses.
 */
import { parentPort } from 'node:worker_threads';
import { auditDir } from './audit.ts';

parentPort?.on('message', (msg: { id: number; dir: string }) => {
  try {
    parentPort?.postMessage({ id: msg.id, result: auditDir(msg.dir) });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, error: (e as Error).message });
  }
});

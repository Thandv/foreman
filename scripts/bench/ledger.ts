// How the ledger's hot paths scale with the number of tasks: p50 and p99 of reconcileBlocked(), claimable(),
// the board snapshot (GET /api/state) and record(), each over a temp ledger seeded with N tasks.
// Usage: node scripts/bench/ledger.ts [--sizes 1000,10000,100000] [--iterations 20] [--json]
// Not part of npm run verify (too slow); docs/capacity.md holds the numbers it printed and how to read them.
import { scratch, options, count } from './env.ts';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { percentile } from '../../src/latency.ts';
import { Store } from '../../src/queue.ts';
import { Scheduler } from '../../src/scheduler.ts';
import { createServer } from '../../src/server.ts';

export interface LedgerResult {
  tasks: number;
  op: 'reconcileBlocked' | 'claimable' | 'snapshot' | 'record';
  samples: number;
  p50Ms: number;
  p99Ms: number;
}

/** Shares of the seeded tasks by status; the rest are done, each with one finished run. */
const QUEUED = 0.05;
const BLOCKED = 0.02;
const AWAITING = 0.01;

/**
 * N tasks: one running task, blocked tasks waiting on it (so every reconcileBlocked pass reads
 * them all and promotes none), queued ones for claimable, a few at the gate, and finished ones with a run each.
 */
function seed(store: Store, n: number): string {
  const anchor = store.addTask({ title: 'anchor', prompt: 'x', runner: 'echo' });
  store.startRun(anchor.id);
  store.setStatus(anchor.id, 'running');
  for (let i = 1; i < n; i++) {
    const share = i / n;
    if (share < BLOCKED) {
      store.addTask({ title: `blocked ${i}`, prompt: 'x', runner: 'echo', deps: [anchor.id] });
      continue;
    }
    const t = store.addTask({ title: `task ${i}`, prompt: 'x', runner: 'echo', priority: i % 3 });
    if (share < BLOCKED + QUEUED) continue;
    const run = store.startRun(t.id);
    store.endRun(run.id, 'succeeded', { summary: `run ${i}` });
    store.setStatus(t.id, share < BLOCKED + QUEUED + AWAITING ? 'awaiting-approval' : 'done');
  }
  return anchor.id;
}

async function time(iterations: number, fn: () => unknown): Promise<{ samples: number; p50Ms: number; p99Ms: number }> {
  await fn(); // warm: the first call prepares its statements and fills the page cache
  const ms: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return { samples: iterations, p50Ms: round(percentile(ms, 0.5)), p99Ms: round(percentile(ms, 0.99)) };
}

export async function benchLedger(sizes: number[], iterations: number): Promise<LedgerResult[]> {
  const out: LedgerResult[] = [];
  for (const n of sizes) {
    const store = new Store(path.join(scratch('ledger'), 'foreman.db'));
    const sched = new Scheduler(store, { maxWorkers: 1, verifyEnabled: false });
    const server = createServer(store, sched);
    try {
      const anchor = seed(store, n);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      const state = async (): Promise<void> => {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`);
        if (!res.ok) throw new Error(`GET /api/state answered ${res.status}`);
        await res.arrayBuffer();
      };
      const ops: Array<[LedgerResult['op'], () => unknown]> = [
        ['reconcileBlocked', () => store.reconcileBlocked()],
        ['claimable', () => store.claimable(8)],
        ['snapshot', state],
        ['record', () => store.record({ taskId: anchor, type: 'log', message: 'bench' })],
      ];
      for (const [op, fn] of ops) out.push({ tasks: n, op, ...(await time(iterations, fn)) });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sched.stop();
      store.close();
    }
  }
  return out;
}

const { values, json } = options({ sizes: '1000,10000,100000', iterations: '20' });
const sizes = values.sizes.split(',').map((s) => count('sizes', s.trim()));
const results = await benchLedger(sizes, count('iterations', values.iterations));
if (json) {
  console.log(JSON.stringify(results));
} else {
  console.log('tasks\top\tp50 ms\tp99 ms');
  for (const r of results) console.log(`${r.tasks}\t${r.op}\t${r.p50Ms}\t${r.p99Ms}`);
}

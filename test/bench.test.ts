import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/queue.ts';
import { outcome } from '../scripts/bench/outcome.ts';

// The benchmarks in scripts/bench are too slow for the suite at their real sizes. These runs are the smallest sizes
// that still exercise every path: each script runs from the checkout, with no network, and writes nothing to the
// caller's home. scripts/bench/env.ts drops any FOREMAN_HOME it inherits and sets a temp home of its own; without that
// line src/config.ts would fall back to <HOME>/.foreman, the operator's (and a running daemon's) home. So each run gets
// a scratch HOME, and the test asserts it, and the FOREMAN_HOME passed in, are both still empty when the bench exits.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function bench(script: string, args: string[]): Promise<unknown> {
  // The caller's homes: the bench must write to neither (nor anywhere but its own temp dirs).
  const userHome = scratchDir('foreman-bench-caller-home-');
  const foremanHome = scratchDir('foreman-bench-caller-foreman-');
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'bench', script), ...args, '--json'], {
    cwd: root,
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, FOREMAN_HOME: foremanHome },
    timeout: 120_000,
  });
  assert.deepEqual(fs.readdirSync(userHome), [], 'the caller\'s HOME is untouched');
  assert.deepEqual(fs.readdirSync(foremanHome), [], 'the caller\'s FOREMAN_HOME is untouched');
  return JSON.parse(stdout) as unknown;
}

test('tsconfig typechecks scripts/bench, so npm run verify does', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as { include: string[] };
  assert.ok(tsconfig.include.includes('scripts/bench'), `include is ${JSON.stringify(tsconfig.include)}`);
});

test('the ledger bench reports p50 and p99 of each operation at each size, and writes nothing to the caller\'s home', async () => {
  const out = await bench('ledger.ts', ['--sizes', '50,100', '--iterations', '3']);
  const rows = out as Array<{ tasks: number; op: string; p50Ms: number; p99Ms: number; samples: number }>;
  for (const tasks of [50, 100]) {
    assert.deepEqual(
      rows.filter((r) => r.tasks === tasks).map((r) => r.op),
      ['reconcileBlocked', 'claimable', 'snapshot', 'record'],
      `every operation is measured at ${tasks} tasks`,
    );
  }
  for (const r of rows) {
    assert.equal(r.samples, 3);
    assert.ok(r.p50Ms >= 0 && r.p99Ms >= r.p50Ms, JSON.stringify(r));
  }
});

test('the pipeline bench lands every ticket with gate batching on and off, and batching makes fewer model calls', async () => {
  // --model-ms widens the window in which the second and third tickets park while the first ticket's gate call (which
  // it gets alone, being first) is still running, so they share one batched call: at most 2 calls with batching on.
  const out = await bench('pipeline.ts', ['--tickets', '3', '--suite-ms', '10', '--model-ms', '300']);
  const runs = out as Array<{
    gateBatch: 'on' | 'off'; tickets: number; landed: number; modelCalls: number; ticketsPerHour: number;
    suiteRunsPerLanded: number; unlanded: unknown[]; dispatchMs: { p50: number }; gateMs: { p50: number }; landingMs: { p50: number };
  }>;
  assert.deepEqual(runs.map((r) => r.gateBatch), ['on', 'off']);
  for (const r of runs) {
    assert.equal(r.landed, 3, `${r.gateBatch}: every ticket landed; not landed: ${JSON.stringify(r.unlanded)}`);
    assert.ok(r.ticketsPerHour > 0);
    // Each landing runs the suite at least twice: the ticket's own check, then the post-merge check on main.
    assert.ok(r.suiteRunsPerLanded >= 2, `${r.gateBatch}: ${r.suiteRunsPerLanded} suite runs per landed ticket`);
    for (const ms of [r.dispatchMs.p50, r.gateMs.p50, r.landingMs.p50]) assert.ok(ms >= 0);
  }
  const [on, off] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(off.modelCalls, 3, 'batching off: one owner-gate call per ticket');
  assert.ok(on.modelCalls < off.modelCalls, `batching on made ${on.modelCalls} calls`);
});

test('the pipeline bench waits for the owner gate to finish a landing before it counts the ticket', () => {
  // An approval's post-merge check can end its landing hold (the ticket is done, nothing is landing) before the
  // approval has written its decision row and the gate its verdict: both wait on git after the merge. Counted then,
  // a ticket that does land was reported as not landed when the machine was loaded.
  const store = new Store(path.join(scratchDir('foreman-bench-outcome-'), 'foreman.db'));
  try {
    const id = store.addTask({ title: 'bench ticket', prompt: 'true', runner: 'shell' }).id;
    assert.equal(outcome(store, id), 'pending', 'queued');
    store.setStatus(id, 'done');
    assert.equal(outcome(store, id), 'pending', 'done, but the gate has not spoken');
    store.noteDecision({ taskId: id, runId: null, action: 'approve', actor: 'owner-model', note: null, statusAfter: 'done' });
    assert.equal(outcome(store, id), 'pending', 'the decision row, but not yet the gate\'s verdict');
    store.markGateDecision(id, 'approved');
    assert.equal(outcome(store, id), 'landed');
    const failed = store.addTask({ title: 'bench ticket 2', prompt: 'true', runner: 'shell' }).id;
    store.setStatus(failed, 'failed');
    assert.equal(outcome(store, failed), 'not-landed');
  } finally {
    store.close();
  }
});

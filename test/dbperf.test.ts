import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

/**
 * Close what a server test opened, also when an assertion threw: the timing assertion fails now and then on a loaded
 * machine, and a server left listening kept the whole file alive forever, so a post-merge check of main hung on it.
 */
async function shutdown(server: ReturnType<typeof createServer>, sched: Scheduler, store: Store): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await sched.stop();
  store.close();
}

function seed(store: Store, tasks: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < tasks; i++) {
    const t = store.addTask({ title: `task ${i}`, prompt: 'x', runner: 'echo' });
    const run = store.startRun(t.id);
    store.endRun(run.id, 'succeeded', { summary: `run ${i}` });
    store.addArtifact({ runId: run.id, taskId: t.id, type: 'log', path: `/tmp/${i}.log`, summary: null });
    ids.push(t.id);
  }
  return ids;
}

test('the batched snapshot returns the same shape as the per-task queries', () => {
  const store = new Store(':memory:');
  const ids = seed(store, 12);
  // A second run on one task: the batch must pick the same "latest" as latestRun.
  const extra = store.startRun(ids[0]!);
  store.endRun(extra.id, 'succeeded', { summary: 'newer' });
  store.addArtifact({ runId: extra.id, taskId: ids[0]!, type: 'diff', path: '/tmp/x.diff', summary: null });

  const batchedRuns = store.latestRunByTask();
  const batchedArtifacts = store.artifactsByTask();
  for (const id of ids) {
    assert.equal(batchedRuns.get(id)!.id, store.latestRun(id)!.id, `latest run mismatch for ${id}`);
    assert.deepEqual(
      batchedArtifacts.get(id)!.map((a) => a.id),
      store.artifactsForTask(id).map((a) => a.id),
      `artifact mismatch for ${id}`,
    );
  }
  assert.equal(batchedRuns.get(ids[0]!)!.summary, 'newer');
  store.close();
});

test('a task with no run or artifacts is still present in the snapshot', async () => {
  const store = new Store(':memory:');
  const bare = store.addTask({ title: 'bare', prompt: 'x', runner: 'echo' });
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  try {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    const row = state.tasks.find((t: { id: string }) => t.id === bare.id);
    assert.ok(row, 'the task is listed');
    assert.equal(row.run, null);
    assert.deepEqual(row.artifacts, []);
  } finally {
    await shutdown(server, sched, store);
  }
});

test('GET /state does not scale with the length of the history', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  // Count statements, not milliseconds. The payload itself grows with the history, so even a correct snapshot costs
  // 7-10x the time for 13x the tasks; a timing ratio only passed on its fixed slack and failed whenever another suite
  // shared the machine. What must not grow is the number of queries: the Store prepares every query where it runs it,
  // so a per-task query (the N+1 this guards against) shows up as more prepares at the larger history.
  const prepare = store.db.prepare.bind(store.db);
  let prepared = 0;
  store.db.prepare = ((sql: string) => {
    prepared++;
    return prepare(sql);
  }) as typeof store.db.prepare;
  const snapshot = async (): Promise<{ statements: number; ms: number }> => {
    const before = prepared;
    const started = Date.now();
    await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    return { statements: prepared - before, ms: Date.now() - started };
  };

  try {
    seed(store, 50);
    await snapshot(); // warm the path
    const small = await snapshot();
    seed(store, 600);
    const large = await snapshot();

    assert.ok(small.statements > 0, 'the counter sees the snapshot\'s queries');
    assert.equal(large.statements, small.statements, `queries per snapshot went from ${small.statements} to ${large.statements} as history grew 13x`);
    // A loose ceiling for a pathological slowdown the count cannot see; ~50ms on an idle machine.
    assert.ok(large.ms < 5000, `a 650-task snapshot took ${large.ms}ms`);
  } finally {
    await shutdown(server, sched, store);
  }
});

test('retention trims old ledger rows but never touches an undecided task', () => {
  const store = new Store(':memory:');
  const old = Date.now() - 200 * 86_400_000;

  const decided = store.addTask({ title: 'decided', prompt: 'x', runner: 'echo' });
  const decidedRun = store.startRun(decided.id);
  store.addVerdict({ runId: decidedRun.id, taskId: decided.id, verdict: 'pass', disagreement: false, council: [] });
  store.addReceipt({ taskId: decided.id, runId: decidedRun.id, kind: 'council', provider: 'ollama', model: 'm', local: true });
  store.setStatus(decided.id, 'awaiting-approval');
  store.decide(decided.id, true);

  const waiting = store.addTask({ title: 'waiting', prompt: 'x', runner: 'echo' });
  const waitingRun = store.startRun(waiting.id);
  store.addVerdict({ runId: waitingRun.id, taskId: waiting.id, verdict: 'split', disagreement: true, council: [] });
  store.addReceipt({ taskId: waiting.id, runId: waitingRun.id, kind: 'council', provider: 'ollama', model: 'm', local: true });
  store.setStatus(waiting.id, 'awaiting-approval');

  // Age every ledger row past the retention window.
  store.db.prepare('UPDATE receipts SET created_at = ?').run(old);
  store.db.prepare('UPDATE verdicts SET created_at = ?').run(old);

  const trimmed = store.pruneLedgers(90);
  assert.ok(trimmed.receipts >= 1 && trimmed.verdicts >= 1, 'old rows for a finished task are trimmed');
  assert.equal(store.verdictsForTask(waiting.id).length, 1, 'an undecided task keeps its verdict');
  assert.equal(store.receiptsForTask(waiting.id).length, 1, 'and its receipts');
  assert.equal(store.verdictsForTask(decided.id).length, 0);
  store.close();
});

test('recent ledger rows are kept regardless of task status', () => {
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'x', prompt: 'x', runner: 'echo' });
  const run = store.startRun(t.id);
  store.addReceipt({ taskId: t.id, runId: run.id, kind: 'council', provider: 'ollama', model: 'm', local: true });
  store.setStatus(t.id, 'awaiting-approval');
  store.decide(t.id, false, 'no');
  assert.deepEqual(store.pruneLedgers(90), { receipts: 0, verdicts: 0 });
  assert.equal(store.receiptsForTask(t.id).length, 1);
  store.close();
});

test('the durability pragmas are the WAL-safe pair, not a data-losing one', () => {
  const store = new Store(':memory:');
  const journal = String((store.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>)['journal_mode']).toLowerCase();
  const sync = Number((store.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>)['synchronous']);
  // memory databases report journal_mode=memory; a file database must be WAL.
  assert.ok(journal === 'wal' || journal === 'memory', journal);
  assert.equal(sync, 1, 'NORMAL (1), never OFF (0)');
  store.close();
});

test('the batched latest-run agrees with latestRun even when the clock steps backwards', () => {
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'x', prompt: 'x', runner: 'echo' });
  const older = store.startRun(t.id);
  const newer = store.startRun(t.id);
  // A clock step: the later-inserted run carries an earlier timestamp.
  store.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(5000, older.id);
  store.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000, newer.id);

  const batched = store.latestRunByTask().get(t.id);
  assert.ok(batched, 'the task must not vanish from the snapshot');
  assert.equal(batched!.id, store.latestRun(t.id)!.id, 'batched and per-task lookups must agree');
  store.close();
});

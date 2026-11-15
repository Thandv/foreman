import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { collectMetrics, toProm } from '../src/metrics.ts';
import { removeAfterStops } from './helpers/removal.ts';

process.env['FOREMAN_PREWARM'] = 'off';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;
const REPO = '/repos/a';

/** A store whose clock (Date) starts at T0 and moves only when the test moves it. */
function clocked(t: TestContext): Store {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function park(store: Store, title = 'parked'): string {
  const task = store.addTask({ title, prompt: 'p', repo: REPO });
  store.setStatus(task.id, 'awaiting-approval');
  return task.id;
}

test('pin: awaitingApproval lists parked tickets oldest first', (t) => {
  const store = clocked(t);
  const a = park(store, 'a');
  t.mock.timers.tick(MIN);
  const b = park(store, 'b');
  t.mock.timers.tick(MIN);
  const c = park(store, 'c');
  assert.deepEqual(store.awaitingApproval().map((x) => x.id), [a, b, c]);
});

test('pin: the updated_at approval age keeps its name, value and Prometheus line', (t) => {
  const store = clocked(t);
  const id = park(store);
  t.mock.timers.tick(3 * HOUR);
  store.setGate(id, 'owner');
  const m = collectMetrics(store, new Map(), T0 + 3 * HOUR);
  assert.deepEqual(m.awaitingApprovalAgeP95Ms, { [REPO]: 0 });
  assert.ok(toProm(m).split('\n').includes(`foreman_awaiting_approval_age_p95_ms{repo="${REPO}"} 0`));
});

test('a gate change while parked leaves the since-park age at the time parked, in JSON and Prometheus', (t) => {
  const store = clocked(t);
  const id = park(store);
  t.mock.timers.tick(3 * HOUR);
  store.setGate(id, 'owner');
  assert.equal(store.getTask(id)!.awaitingSince, T0);
  const m = collectMetrics(store, new Map(), T0 + 3 * HOUR);
  assert.deepEqual(m.awaitingSinceParkP95Ms, { [REPO]: 3 * HOUR });
  assert.ok(toProm(m).split('\n').includes(`foreman_awaiting_approval_since_park_p95_ms{repo="${REPO}"} ${3 * HOUR}`));
});

test('awaitingApproval orders by time parked, not by the last write', (t) => {
  const store = clocked(t);
  const a = park(store, 'a');
  t.mock.timers.tick(MIN);
  const b = park(store, 'b');
  t.mock.timers.tick(MIN);
  store.setGate(a, 'owner');
  assert.deepEqual(store.awaitingApproval().map((x) => x.id), [a, b]);
});

test('awaitingSince is stamped on entry, kept on a re-park, and cleared when the task leaves by setStatus', (t) => {
  const store = clocked(t);
  const id = store.addTask({ title: 'x', prompt: 'p' }).id;
  assert.equal(store.getTask(id)!.awaitingSince, null);
  store.setStatus(id, 'awaiting-approval');
  assert.equal(store.getTask(id)!.awaitingSince, T0);
  t.mock.timers.tick(HOUR);
  store.setStatus(id, 'awaiting-approval', 'parked again');
  assert.equal(store.getTask(id)!.awaitingSince, T0);
  store.setStatus(id, 'queued');
  assert.equal(store.getTask(id)!.awaitingSince, null);
  t.mock.timers.tick(HOUR);
  store.setStatus(id, 'awaiting-approval');
  assert.equal(store.getTask(id)!.awaitingSince, T0 + 2 * HOUR);
});

test('approve, merge conflict, conflict repair: awaitingSince is cleared, then stamped again on the next park', (t) => {
  const store = clocked(t);
  const id = park(store);
  const run = store.startRun(id);
  store.decide(id, true, 'ok');
  assert.ok(store.scheduleConflictRepair(id, run.id, null));
  assert.equal(store.getTask(id)!.status, 'queued');
  assert.equal(store.getTask(id)!.awaitingSince, null);
  t.mock.timers.tick(HOUR);
  store.setStatus(id, 'awaiting-approval');
  assert.equal(store.getTask(id)!.awaitingSince, T0 + HOUR);
});

const RAW_MOVERS: Array<[string, (store: Store, id: string) => void]> = [
  ['schedulePreReviewRepair', (store, id) => assert.ok(store.schedulePreReviewRepair(id, 'notes', 1))],
  ['scheduleConflictRepair', (store, id) => assert.ok(store.scheduleConflictRepair(id, store.startRun(id).id, null))],
  ['scheduleRepair', (store, id) => assert.ok(store.scheduleRepair(id, 'critique'))],
  ['endLostRun (requeue)', (store, id) => store.endLostRun(id, { failed: 'failed', requeued: 'requeued' })],
];

for (const [name, move] of RAW_MOVERS) {
  test(`${name} clears awaitingSince when it moves a parked task`, (t) => {
    const store = clocked(t);
    const id = park(store);
    assert.equal(store.getTask(id)!.awaitingSince, T0);
    move(store, id);
    assert.equal(store.getTask(id)!.status, 'queued');
    assert.equal(store.getTask(id)!.awaitingSince, null);
  });
}

test('a ledger from before the column migrates twice cleanly, and its parked row falls back to updated_at', (t) => {
  const dir = removeAfterStops(t, scratchDir('foreman-awaiting-since-'));
  const file = path.join(dir, 'ledger.db');
  const seeded = new Store(file);
  const id = park(seeded);
  seeded.close();
  // The ledger as version 1 left it: no awaiting_since column, stamped 1.
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN awaiting_since');
  raw.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(T0, id);
  raw.exec('PRAGMA user_version = 1');
  raw.close();

  new Store(file, { migrate: true }).close();
  const store = new Store(file, { migrate: true });
  t.after(() => store.close());
  assert.equal(store.getTask(id)!.awaitingSince, null);
  const m = collectMetrics(store, new Map(), T0 + 2 * HOUR);
  assert.deepEqual(m.awaitingSinceParkP95Ms, { [REPO]: 2 * HOUR });
  assert.deepEqual(m.awaitingApprovalAgeP95Ms, { [REPO]: 2 * HOUR });
});

test('GET /api/state task rows carry awaitingSince', async (t) => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const id = park(store);
  const parkedAt = store.getTask(id)!.awaitingSince;
  assert.equal(typeof parkedAt, 'number');
  const port = (server.address() as AddressInfo).port;
  const body = await new Promise<string>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
  const rows = (JSON.parse(body) as { tasks: Array<{ id: string; awaitingSince: number | null }> }).tasks;
  assert.equal(rows.find((r) => r.id === id)!.awaitingSince, parkedAt);
});

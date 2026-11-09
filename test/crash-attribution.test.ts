import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';

/*
 * Unclean restarts (the `daemon_starts` table): each scheduler start writes a row, an orderly stop marks it
 * clean_exit. A start that finds the previous row unmarked follows a crash. One run in flight across it keeps today's
 * path (its attempt is spent) and says how many crashes it was in flight for; several each get one stop refund; a
 * crash loop no single run accounts for starts the daemon under a dispatch hold.
 */

const MIN = 60_000;
const TEST_HOLD = 'test: nothing is dispatched';

function ledger(): string {
  return path.join(scratchDir('foreman-crash-'), 'foreman.db');
}

/** A previous daemon start, `agoMs` before now; clean says whether it stopped in order. */
function priorStart(store: Store, agoMs: number, clean: boolean): void {
  store.db.prepare('INSERT INTO daemon_starts (at, clean_exit) VALUES (?, ?)').run(Date.now() - agoMs, clean ? 1 : 0);
}

/** Starts a scheduler on `store` under a test hold (so recovery is all that runs), and returns it. */
function boot(store: Store): Scheduler {
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  sched.dispatchHold(TEST_HOLD);
  sched.start();
  return sched;
}

const inFlight = (store: Store, maxAttempts: number): string => {
  const t = store.addTask({ title: 't', prompt: 'p', runner: 'echo', maxAttempts });
  assert.ok(store.claim(t.id));
  store.startRun(t.id);
  return t.id;
};

const attempts = (store: Store, id: string): { attempts: number; stops: number } => {
  const r = store.db.prepare('SELECT attempts, stop_requeues FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
  return { attempts: Number(r['attempts']), stops: Number(r['stop_requeues']) };
};

test('one run in flight across an unclean exit spends its attempt and names the crashes it was in flight for', async () => {
  const store = new Store(ledger());
  priorStart(store, 3 * MIN, false);
  priorStart(store, 1 * MIN, false);
  const spent = inFlight(store, 1);
  const sched = boot(store);
  try {
    const t = store.getTask(spent)!;
    assert.equal(t.status, 'failed');
    assert.match(t.error ?? '', /in flight across 2 daemon crashes/);
    assert.deepEqual(attempts(store, spent), { attempts: 1, stops: 0 }, 'no refund');
    assert.equal(sched.dispatchHoldState?.reason, TEST_HOLD, 'a crash loop tied to one run holds nothing');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('one run with attempts left is requeued with its attempt spent, as today', async () => {
  const store = new Store(ledger());
  priorStart(store, MIN, false);
  const id = inFlight(store, 3);
  const sched = boot(store);
  try {
    assert.equal(store.getTask(id)!.status, 'queued');
    assert.deepEqual(attempts(store, id), { attempts: 1, stops: 0 });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('several runs in flight across an unclean exit each get one stop refund', async () => {
  const store = new Store(ledger());
  priorStart(store, MIN, false);
  const a = inFlight(store, 1);
  const b = inFlight(store, 1);
  const sched = boot(store);
  try {
    for (const id of [a, b]) {
      assert.equal(store.getTask(id)!.status, 'queued', 'refunded, not failed on its last attempt');
      assert.deepEqual(attempts(store, id), { attempts: 0, stops: 1 }, 'the refund shares the stop_requeues bound');
    }
    assert.equal(sched.dispatchHoldState?.reason, TEST_HOLD, 'one unclean start is no crash loop');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('the refund is bounded by the stop requeue count: a ticket past it goes to the operator', async () => {
  const store = new Store(ledger());
  priorStart(store, MIN, false);
  const a = inFlight(store, 1);
  inFlight(store, 1);
  store.db.prepare('UPDATE tasks SET stop_requeues = 3 WHERE id = ?').run(a);
  const sched = boot(store);
  try {
    assert.equal(store.getTask(a)!.status, 'awaiting-human');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('two unclean starts within 10 minutes that no single run accounts for start the daemon under a dispatch hold', async () => {
  for (const runs of [0, 2]) {
    const store = new Store(ledger());
    priorStart(store, 4 * MIN, false);
    priorStart(store, 2 * MIN, false);
    for (let i = 0; i < runs; i++) inFlight(store, 3);
    const sched = boot(store);
    try {
      assert.match(sched.dispatchHoldState?.reason ?? '', /crash loop: 2 unclean daemon starts within 10 minutes/, `${runs} in flight`);
      assert.ok(store.eventsSince(0).some((e) => e.type === 'warning' && e.message.includes('crash loop')));
    } finally {
      await sched.stop();
      store.close();
    }
  }
});

test('unclean starts spread over more than 10 minutes are no crash loop', async () => {
  const store = new Store(ledger());
  priorStart(store, 30 * MIN, false);
  priorStart(store, 15 * MIN, false);
  const sched = boot(store);
  try {
    assert.equal(sched.dispatchHoldState?.reason, TEST_HOLD);
  } finally {
    await sched.stop();
    store.close();
  }
});

test('an orderly stop records clean_exit and changes no task; the next start keeps today\'s recovery', async () => {
  const dbPath = ledger();
  const store = new Store(dbPath);
  const waiting = store.addTask({ title: 'w', prompt: 'p', runner: 'echo' });
  const sched = boot(store);
  await sched.stop();
  const rows = store.db.prepare('SELECT clean_exit FROM daemon_starts').all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => Number(r['clean_exit'])), [1]);
  assert.equal(store.getTask(waiting.id)!.status, 'queued', 'unchanged by the stop');

  // A run left marked running behind a clean exit (a stop that ran out of time is not clean, see below) takes
  // today's path: its attempt is spent and the text names no crash.
  const a = inFlight(store, 1);
  const b = inFlight(store, 1);
  const again = boot(store);
  try {
    for (const id of [a, b]) {
      assert.equal(store.getTask(id)!.status, 'failed');
      assert.equal(store.getTask(id)!.error, 'interrupted by daemon restart; no attempts left');
    }
    assert.equal(again.dispatchHoldState?.reason, TEST_HOLD);
  } finally {
    await again.stop();
    store.close();
  }
});

test('the daemon_starts migration runs twice without error', () => {
  const dbPath = ledger();
  openDb(dbPath).close();
  const db = openDb(dbPath);
  db.prepare('INSERT INTO daemon_starts (at, clean_exit) VALUES (?, 0)').run(1);
  db.close();
});

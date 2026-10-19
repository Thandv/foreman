import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { backfillRunDecisions, openDb } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { abortCause, abortFor } from '../src/abort.ts';

// `runs.decision` is where the training sets read "a person ruled on THIS run".
// New decisions write it (Store.decide); runs decided before the column existed
// are labelled once, from the status timeline, when the column arrives.

const decisionOf = (store: Store, runId: string): string | null =>
  ((store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(runId) as Record<string, unknown>)['decision'] as string | null) ?? null;

/** A run, and status lines at explicit times — a legacy timeline, written the way setStatus wrote it. */
function legacy(store: Store, taskId: string, startedAt: number, lines: Array<[number, string]>): string {
  const run = store.startRun(taskId);
  store.endRun(run.id, 'succeeded', { summary: 'did it' });
  store.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(startedAt, run.id);
  for (const [ts, message] of lines) {
    store.db.prepare("INSERT INTO events (task_id, run_id, ts, type, message) VALUES (?, NULL, ?, 'status', ?)").run(taskId, ts, message);
  }
  return run.id;
}

test('a decision at the approval gate labels the run it ruled on; one off the operator’s desk labels none', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'x', prompt: 'do x', runner: 'echo' });
    const first = store.startRun(t.id);
    store.endRun(first.id, 'succeeded', { summary: 'first try' });
    store.setStatus(t.id, 'awaiting-approval');
    store.decide(t.id, false, 'not like this');
    assert.equal(decisionOf(store, first.id), 'rejected');

    store.retry(t.id);
    store.reassign(t.id, 'human');
    store.decide(t.id, true);
    assert.equal(decisionOf(store, first.id), 'rejected', 'finishing it by hand approves no run');
  } finally {
    store.close();
  }
});

test('the backfill reads gate decisions back from the timeline, and only those', () => {
  const store = new Store(':memory:');
  try {
    // Approved at the gate (a hold and a merge line in between are not moves).
    const a = store.addTask({ title: 'a', prompt: 'a', runner: 'echo' }).id;
    const aRun = legacy(store, a, 1_000, [
      [1_100, 'verifying'], [1_200, 'awaiting-approval: council split — needs your call'],
      [1_250, 'owner-gate: hold — the operator decides this one'], [1_300, 'done'], [1_310, 'merge: merged 1 commit'],
    ]);
    // Rejected at the gate, retried, then finished on the operator's desk.
    const b = store.addTask({ title: 'b', prompt: 'b', runner: 'echo' }).id;
    const bRun = legacy(store, b, 2_000, [
      [2_200, 'awaiting-approval'], [2_300, 'rejected: you touched unrelated files'],
      [2_400, 'queued'], [2_500, 'awaiting-human'], [2_600, 'done'],
    ]);
    // Two attempts, each decided at the gate: each decision lands on its own run.
    const c = store.addTask({ title: 'c', prompt: 'c', runner: 'echo' }).id;
    const cFirst = legacy(store, c, 3_000, [[3_200, 'awaiting-approval'], [3_300, 'rejected: only the parser']]);
    const cSecond = legacy(store, c, 3_400, [[3_500, 'awaiting-approval'], [3_600, 'done']]);
    // A council FAIL that went straight to repair never reached the gate.
    const d = store.addTask({ title: 'd', prompt: 'd', runner: 'echo' }).id;
    const dRun = legacy(store, d, 4_000, [[4_100, 'verifying'], [4_200, 'failed: rejected by the council']]);
    // Never at the gate at all: its run failed, then the operator did it by hand.
    const e = store.addTask({ title: 'e', prompt: 'e', runner: 'echo' }).id;
    const eRun = legacy(store, e, 5_000, [[5_100, 'failed: tests failed'], [5_200, 'awaiting-human'], [5_300, 'done']]);

    for (const id of [aRun, bRun, cFirst, cSecond, dRun, eRun]) store.db.prepare('UPDATE runs SET decision = NULL WHERE id = ?').run(id);
    assert.equal(backfillRunDecisions(store.db), 4);
    assert.equal(decisionOf(store, aRun), 'approved');
    assert.equal(decisionOf(store, bRun), 'rejected', 'the hand-finished `done` approves nothing');
    assert.equal(decisionOf(store, cFirst), 'rejected');
    assert.equal(decisionOf(store, cSecond), 'approved');
    assert.equal(decisionOf(store, dRun), null);
    assert.equal(decisionOf(store, eRun), null, 'done from the operator’s desk approves no run');

    // Only ever fills blanks.
    store.db.prepare("UPDATE runs SET decision = 'rejected' WHERE id = ?").run(aRun);
    assert.equal(backfillRunDecisions(store.db), 0);
    assert.equal(decisionOf(store, aRun), 'rejected');
  } finally {
    store.close();
  }
});

test('opening a ledger from before the column labels its old decisions once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rundecision-'));
  const file = path.join(dir, 'foreman.db');
  try {
    const old = new Store(file);
    const t = old.addTask({ title: 'x', prompt: 'x', runner: 'echo' }).id;
    const run = legacy(old, t, 1_000, [[1_100, 'awaiting-approval'], [1_200, 'done']]);
    old.close();
    // Roll the file back to the schema it had before `runs.decision` existed.
    const raw = openDb(file);
    raw.exec('ALTER TABLE runs DROP COLUMN decision');
    raw.close();

    const reopened = new Store(file);
    try {
      assert.equal(decisionOf(reopened, run), 'approved', 'labelled when the column arrived');
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the backfill tells the owner gate's decisions from a person's", () => {
  const store = new Store(':memory:');
  try {
    const owner = store.addTask({ title: 'o', prompt: 'o', runner: 'echo' }).id;
    const ownerRun = legacy(store, owner, 1_000, [[1_100, 'awaiting-approval'], [1_200, 'done']]);
    store.db.prepare("INSERT INTO events (task_id, run_id, ts, type, message) VALUES (?, ?, 1250, 'verdict', 'owner-gate: approved — does what it says')").run(owner, ownerRun);
    const signed = store.addTask({ title: 's', prompt: 's', runner: 'echo' }).id;
    const signedRun = legacy(store, signed, 2_000, [[2_100, 'awaiting-approval'], [2_200, 'rejected: owner-gate: touches the lexer']]);
    const person = store.addTask({ title: 'p', prompt: 'p', runner: 'echo' }).id;
    const personRun = legacy(store, person, 3_000, [[3_100, 'awaiting-approval'], [3_200, 'rejected: wrong scope']]);
    for (const id of [ownerRun, signedRun, personRun]) store.db.prepare('UPDATE runs SET decision = NULL WHERE id = ?').run(id);
    backfillRunDecisions(store.db);
    assert.equal(decisionOf(store, ownerRun), 'owner-approved');
    assert.equal(decisionOf(store, signedRun), 'owner-rejected');
    assert.equal(decisionOf(store, personRun), 'rejected');
  } finally {
    store.close();
  }
});

test('a daemon start labels decisions an older daemon made after the ledger was migrated', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 50, verifyEnabled: false });
  try {
    const t = store.addTask({ title: 'x', prompt: 'x', runner: 'echo' }).id;
    const run = legacy(store, t, 1_000, [[1_100, 'awaiting-approval'], [1_200, 'done']]);
    store.db.prepare('UPDATE runs SET decision = NULL WHERE id = ?').run(run);
    sched.start();
    assert.equal(decisionOf(store, run), 'approved');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('abort causes rank cancel over stop over deadline, whatever order they arrived in', () => {
  const late = new AbortController();
  abortFor(late, 'deadline');
  abortFor(late, 'cancel');
  assert.equal(abortCause(late.signal), 'cancel', 'a cancel after the deadline is still a cancel');
  const stopped = new AbortController();
  abortFor(stopped, 'deadline');
  abortFor(stopped, 'stop');
  assert.equal(abortCause(stopped.signal), 'stop');
  const plain = new AbortController();
  plain.abort();
  assert.equal(abortCause(plain.signal), null, 'an abort that named no cause');
  assert.equal(abortCause(new AbortController().signal), null);
});

test('the daemon-stop bound lives on the row: pruned events cannot erase it, and a fresh start resets it', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'long', prompt: 'x', runner: 'echo', maxAttempts: 1 });
    const claim = (): void => {
      store.db.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(t.id);
    };
    for (let stop = 1; stop <= 3; stop++) {
      claim();
      store.requeueAfterStop(t.id);
      assert.equal(store.getTask(t.id)!.status, 'queued', `stop ${stop}`);
      // A verbose run's events are pruned between stops; the count must not go with them.
      store.db.prepare('DELETE FROM events WHERE task_id = ?').run(t.id);
    }
    claim();
    store.requeueAfterStop(t.id);
    const desk = store.getTask(t.id)!;
    assert.equal(desk.status, 'awaiting-human');
    assert.equal(desk.assignee, 'human', 'on the operator\'s desk, not just in their column');
    assert.match(desk.error ?? '', /interrupted by 4 daemon stops/);
    assert.ok(store.eventsForTask(t.id).some((e) => e.type === 'assign' && /assigned to human/.test(e.message)), 'the hand-over is on the timeline');

    // Give to AI is a fresh start: one routine stop later it is requeued, not sent back.
    store.reassign(t.id, 'ai');
    claim();
    store.requeueAfterStop(t.id);
    assert.equal(store.getTask(t.id)!.status, 'queued');

    // So is a repair round.
    for (let i = 0; i < 3; i++) { claim(); store.requeueAfterStop(t.id); }
    store.db.prepare("UPDATE tasks SET max_repairs = 1, repairs = 0 WHERE id = ?").run(t.id);
    assert.equal(store.scheduleRepair(t.id, 'fix the parser'), true);
    claim();
    store.requeueAfterStop(t.id);
    assert.equal(store.getTask(t.id)!.status, 'queued', 'a repair round starts the count over');

    // So is a Retry.
    for (let i = 0; i < 3; i++) { claim(); store.requeueAfterStop(t.id); }
    store.setStatus(t.id, 'failed', 'x');
    store.retry(t.id);
    claim();
    store.requeueAfterStop(t.id);
    assert.equal(store.getTask(t.id)!.status, 'queued', 'a retried ticket starts the count over');
  } finally {
    store.close();
  }
});

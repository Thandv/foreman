import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { acquireLocalModelLock, releaseLocalModelLock } from '../src/align/localLock.ts';

/**
 * `acquireLocalModelLock` returns the EXISTING holder when acquisition fails
 * and null when it succeeds — inverted from the usual truthy-means-success
 * reading, and its callers rely on that shape. Wrapped so a case says what it
 * means rather than asserting on a null.
 */
function take(label: string): void {
  assert.equal(acquireLocalModelLock(label), null, `could not take the lock for ${label}`);
}

/**
 * The collision this prevents is on the record: a gate run (4.5 GB under mlx)
 * and a chapter-flagging run (8.5 GB under ollama) started at the same time on
 * a 17 GB machine — 13 GB of weights, 33 GB of swap, and the ollama request
 * failed outright. Neither job was wrong; they simply could not see each other.
 * The lock made them visible; this makes the scheduler act on what it sees.
 */
function withLockFile<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-lock-'));
  const prev = process.env['FOREMAN_LOCAL_LOCK'];
  process.env['FOREMAN_LOCAL_LOCK'] = path.join(dir, 'local-model.lock');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_LOCAL_LOCK'];
    else process.env['FOREMAN_LOCAL_LOCK'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sched = (store: Store): Scheduler => new Scheduler(store, { verifyEnabled: false });

test('no new work starts while a trainer holds the local-model lock', async () => {
  await withLockFile(async () => {
    const store = new Store(':memory:');
    const s = sched(store);
    const t = store.addTask({ title: 'would thrash the machine', prompt: 'x', runner: 'echo' });

    take('training publishing.author');
    await s.tick();
    assert.equal(store.getTask(t.id)!.status, 'queued', 'the task must not have been claimed');

    // ...and the queue drains the moment the lock frees.
    releaseLocalModelLock();
    await s.tick();
    assert.notEqual(store.getTask(t.id)!.status, 'queued');
    await s.stop();
    store.close();
  });
});

test('the pause is announced once, and so is the resume', async () => {
  await withLockFile(async () => {
    const store = new Store(':memory:');
    const s = sched(store);
    store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });

    take('adoption gate publishing.author');
    await s.tick();
    await s.tick();
    await s.tick();
    const paused = store.eventsSince(0).filter((e) => /dispatch paused/.test(e.message));
    assert.equal(paused.length, 1, 'a per-tick log line is noise, not information');
    assert.match(paused[0]!.message, /adoption gate publishing\.author/, 'it should name who holds it');

    releaseLocalModelLock();
    await s.tick();
    const resumed = store.eventsSince(0).filter((e) => /dispatch resumed/.test(e.message));
    assert.equal(resumed.length, 1);
    await s.stop();
    store.close();
  });
});

test('an operator with the headroom can opt out', async () => {
  await withLockFile(async () => {
    const store = new Store(':memory:');
    const s = sched(store);
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
    take('training something');
    process.env['FOREMAN_IGNORE_TRAINING_LOCK'] = '1';
    try {
      await s.tick();
      assert.notEqual(store.getTask(t.id)!.status, 'queued');
    } finally {
      delete process.env['FOREMAN_IGNORE_TRAINING_LOCK'];
      releaseLocalModelLock();
    }
    await s.stop();
    store.close();
  });
});

test('a stale lock from a dead process does not wedge the queue forever', async () => {
  await withLockFile(async () => {
    const store = new Store(':memory:');
    const s = sched(store);
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
    // A pid that cannot exist: the holder is gone, so the lock is stale and
    // localModelLockHolder() clears it rather than waiting on it.
    fs.writeFileSync(
      process.env['FOREMAN_LOCAL_LOCK']!,
      JSON.stringify({ pid: 2147483000, label: 'a trainer that crashed', since: Date.now() }),
    );
    await s.tick();
    assert.notEqual(store.getTask(t.id)!.status, 'queued', 'a crash must not stop the machine forever');
    await s.stop();
    store.close();
  });
});

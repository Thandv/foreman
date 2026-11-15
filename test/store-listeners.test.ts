import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';

test('a throwing event listener fails neither record() nor the listeners after it', () => {
  const store = new Store(':memory:');
  const written: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const seen: number[] = [];
    store.on('event', () => {
      throw new Error('listener broke');
    });
    store.on('event', (ev: { id: number }) => seen.push(ev.id));
    const a = store.record({ type: 'status', message: 'x' });
    const b = store.record({ type: 'status', message: 'y' });
    assert.equal(a.message, 'x');
    assert.deepEqual(seen, [a.id, b.id], 'later listeners still receive every event');
    assert.deepEqual(store.eventsSince(0).map((e) => e.id), [a.id, b.id]);
    assert.equal(store.listenerErrors, 2);
    const reports = written.filter((w) => w.includes('listener broke'));
    assert.equal(reports.length, 1, 'stderr at most once a minute per listener');
  } finally {
    process.stderr.write = realWrite;
    store.close();
  }
});

test('a once listener fires exactly once across two record() calls', () => {
  const store = new Store(':memory:');
  try {
    let fired = 0;
    store.once('event', () => fired++);
    store.record({ type: 'status', message: 'a' });
    store.record({ type: 'status', message: 'b' });
    assert.equal(fired, 1);
    assert.equal(store.listenerCount('event'), 0);
  } finally {
    store.close();
  }
});

test('a scheduler tick with a throwing event listener attached still dispatches', async (t) => {
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 5, verifyEnabled: false });
  const realWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  t.after(async () => {
    process.stderr.write = realWrite;
    await s.stop();
    store.close();
  });
  store.on('event', () => {
    throw new Error('listener broke');
  });
  const task = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
  await s.tick();
  assert.notEqual(store.getTask(task.id)!.status, 'queued');
  assert.ok(store.listenerErrors > 0);
});

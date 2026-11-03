import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { freeMb, minFreeMb } from '../src/diskSpace.ts';

const MB = 1024 * 1024;

test('FOREMAN_MIN_FREE_MB parses with a fallback on empty or non-numeric input', () => {
  assert.equal(minFreeMb(undefined), 2048);
  assert.equal(minFreeMb(''), 2048);
  assert.equal(minFreeMb('lots'), 2048);
  assert.equal(minFreeMb('-5'), 2048);
  assert.equal(minFreeMb('512'), 512);
});

test('low free space pauses dispatch with one event, and recovery resumes it', async () => {
  const prev = process.env['FOREMAN_MIN_FREE_MB'];
  process.env['FOREMAN_MIN_FREE_MB'] = '1000';
  let freeMbNow = 100;
  const store = new Store(':memory:');
  const s = new Scheduler(store, {
    tickMs: 5,
    verifyEnabled: false,
    statfs: () => ({ bavail: freeMbNow, bsize: MB }),
  });
  try {
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
    await s.tick();
    await s.tick();
    await s.tick();
    assert.equal(store.getTask(t.id)!.status, 'queued', 'nothing dispatched on a full disk');
    const paused = store.eventsSince(0).filter((e) => /dispatch paused: disk/.test(e.message));
    assert.equal(paused.length, 1, 'one event per pause, not per tick');

    freeMbNow = 5000;
    await s.tick();
    assert.notEqual(store.getTask(t.id)!.status, 'queued', 'dispatch resumed on its own');
    assert.equal(store.eventsSince(0).filter((e) => /disk space recovered/.test(e.message)).length, 1);
    assert.equal(store.eventsSince(0).filter((e) => /dispatch paused: disk/.test(e.message)).length, 1);
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_MIN_FREE_MB'];
    else process.env['FOREMAN_MIN_FREE_MB'] = prev;
    await s.stop();
    store.close();
  }
});

test('a missing dir is measured on its nearest existing ancestor; a volume that cannot be read is null (dispatch goes on)', () => {
  const statfs = (d: string) => {
    if (d !== '/a') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { bavail: 3, bsize: MB };
  };
  assert.equal(freeMb('/a/not/yet', statfs), 3);
  assert.equal(freeMb('/a', () => { throw new Error('EIO'); }), null);
});

test('a task whose repo volume is low stays queued while work elsewhere is dispatched', async (t) => {
  process.env['FOREMAN_MIN_FREE_MB'] = '1000';
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 5, verifyEnabled: false, statfs: (d) => ({ bavail: d.startsWith('/vol-low') ? 100 : 5000, bsize: MB }) });
  t.after(async () => {
    delete process.env['FOREMAN_MIN_FREE_MB'];
    await s.stop();
    store.close();
  });
  const held = store.addTask({ title: 'held', prompt: 'x', runner: 'echo', repo: '/vol-low/repo' });
  const other = store.addTask({ title: 'other', prompt: 'x', runner: 'echo' });
  await s.tick();
  assert.equal(store.getTask(held.id)!.status, 'queued');
  assert.notEqual(store.getTask(other.id)!.status, 'queued');
  assert.match(store.eventsSince(0).map((e) => e.message).join('\n'), /dispatch paused: disk — 100 MB free under \/vol-low\/repo/);
});

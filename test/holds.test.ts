import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { acquireLocalModelLock, releaseLocalModelLock } from '../src/align/localLock.ts';
import { registerExtension } from '../src/extensions.ts';
import { alignExtension } from '../src/align/extension.ts';

registerExtension(alignExtension);

const MB = 1024 * 1024;
const heldEvents = (store: Store, id: string) =>
  store.eventsForTask(id, 100).filter((e) => e.message.startsWith('held:'));

function setup(opts: { statfs?: (d: string) => { bavail: number; bsize: number } } = {}) {
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 5, verifyEnabled: false, ...opts });
  return { store, s, done: async () => { await s.stop(); store.close(); } };
}

test('a queued ticket on a red main gets one held event per episode, and show/ls data carries it', async () => {
  const { store, s, done } = setup();
  try {
    const repo = '/nonexistent/fm-holds-red';
    store.markRepoRed(repo, { head: 'abcdef1234567', taskId: 't_x', testCmd: null, reason: 'post-merge verify failed', since: Date.now(), nextCheckAt: Date.now() + 3_600_000 });
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo', repo });
    await s.tick(); await s.tick(); await s.tick();
    const ev = heldEvents(store, t.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.message, /main of \/nonexistent\/fm-holds-red is red since abcdef1234.*HEAD moves and its tests pass/);
    assert.equal(store.getTask(t.id)!.status, 'queued', 'what is held is unchanged');

    const server = createServer(store, s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const state = await (await fetch(`${base}/api/state`)).json() as { tasks: Array<{ id: string; hold: string | null }> };
      assert.match(state.tasks.find((x) => x.id === t.id)!.hold ?? '', /is red since/);
      const detail = await (await fetch(`${base}/api/tasks/${t.id}`)).json() as { task: { hold: string | null } };
      assert.match(detail.task.hold ?? '', /is red since/);
    } finally {
      server.close();
    }

    // A real post-merge reason is the test output's tail: the hold names where to read it instead of printing it.
    store.markRepoRed(repo, { head: 'fedcba9876543', taskId: 't_x', testCmd: 'npm run verify', reason: '\u001b[32m✔ ok\u001b[39m\n✖ broke\nverify: FAIL', since: Date.now(), nextCheckAt: Date.now() + 3_600_000 });
    await s.tick();
    assert.equal(heldEvents(store, t.id).length, 1, 'the same hold at a new HEAD is no new episode');
    assert.match(store.holdOf(t.id) ?? '', /^held: main of \S+ is red since fedcba9876 \(its tests failed; output in foreman show t_x\); new work waits/);
    assert.doesNotMatch(store.holdOf(t.id) ?? '', /[\u0000-\u001f]/);

    store.clearRepoRed(repo);
    await s.tick();
    assert.equal(store.holdOf(t.id), null);
  } finally {
    await done();
  }
});

test('a queued ticket on a dirty checkout gets one held event per episode', async () => {
  const { store, s, done } = setup();
  try {
    const repo = '/nonexistent/fm-holds-dirty';
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo', repo });
    (s as unknown as { holdDirtyRepo(r: string, f: string): void }).holdDirtyRepo(repo, 'a.txt');
    await s.tick(); await s.tick();
    const ev = heldEvents(store, t.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.message, /uncommitted changes \(a\.txt\).*checkout is clean/);
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    await done();
  }
});

test('a queued ticket on a low repo volume gets one held event per episode', async () => {
  process.env['FOREMAN_MIN_FREE_MB'] = '1000';
  const { store, s, done } = setup({ statfs: (d) => ({ bavail: d.startsWith('/vol-low') ? 100 : 5000, bsize: MB }) });
  try {
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo', repo: '/vol-low/repo' });
    await s.tick(); await s.tick();
    const ev = heldEvents(store, t.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.message, /low disk under \/vol-low\/repo.*FOREMAN_MIN_FREE_MB.*space is freed/);
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    delete process.env['FOREMAN_MIN_FREE_MB'];
    await done();
  }
});

test('a queued ticket under the local-model lock gets one held event per episode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-holds-lock-'));
  const prev = process.env['FOREMAN_LOCAL_LOCK'];
  process.env['FOREMAN_LOCAL_LOCK'] = path.join(dir, 'local-model.lock');
  const { store, s, done } = setup();
  try {
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
    assert.equal(acquireLocalModelLock('training holds.test'), null);
    await s.tick(); await s.tick();
    const ev = heldEvents(store, t.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.message, /training holds\.test.*local-model lock.*releases the lock/);
    releaseLocalModelLock();
    await s.tick();
    assert.equal(store.holdOf(t.id), null);
  } finally {
    releaseLocalModelLock();
    if (prev === undefined) delete process.env['FOREMAN_LOCAL_LOCK'];
    else process.env['FOREMAN_LOCAL_LOCK'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    await done();
  }
});

test('a claude-code ticket under a provider limit or auth fallback gets one held event per episode', async () => {
  const { store, s, done } = setup();
  const prevMode = process.env['FOREMAN_LOCAL_ONLY'];
  try {
    const t = store.addTask({ title: 'a', prompt: 'x', runner: 'claude-code' });
    const other = store.addTask({ title: 'b', prompt: 'x', runner: 'echo' });
    s.limitHoldUntil = Date.now() + 3_600_000;
    await s.tick(); await s.tick();
    let ev = heldEvents(store, t.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0]!.message, /provider usage limit; waits until \d{4}-/);
    assert.equal(heldEvents(store, other.id).length, 0, 'only claude-code tickets are held');

    s.limitHoldUntil = 0;
    process.env['FOREMAN_LOCAL_ONLY'] = 'auto';
    setCloudDown('signed out');
    await s.tick(); await s.tick();
    ev = heldEvents(store, t.id);
    assert.equal(ev.length, 2, 'a different hold is a new episode');
    assert.match(ev[1]!.message, /sign-in lapsed.*signed in again/);
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    setCloudDown(null);
    if (prevMode === undefined) delete process.env['FOREMAN_LOCAL_ONLY'];
    else process.env['FOREMAN_LOCAL_ONLY'] = prevMode;
    await done();
  }
});

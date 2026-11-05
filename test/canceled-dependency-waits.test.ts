import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { hermeticGitEnv } from './helpers/git.ts';

process.env['FOREMAN_PREWARM'] = 'off';
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

const waitingNote = (dependent: string, x: string): string =>
  `waiting: dependency ${x} was canceled - foreman deps ${dependent} --drop ${x}, foreman landed ${x}, or foreman retry ${x}`;

/** x, and two tickets that wait on it. */
function trio(store: Store): { x: string; d1: string; d2: string } {
  const x = store.addTask({ title: 'x', prompt: 'p' });
  const d1 = store.addTask({ title: 'd1', prompt: 'p', deps: [x.id] });
  const d2 = store.addTask({ title: 'd2', prompt: 'p', deps: [x.id] });
  return { x: x.id, d1: d1.id, d2: d2.id };
}

function expectWaiting(store: Store, x: string, ...ids: string[]): void {
  for (const id of ids) {
    const t = store.getTask(id)!;
    assert.equal(t.status, 'blocked', `${id} stays blocked`);
    assert.equal(t.error, waitingNote(id, x));
  }
}

test('after an operator cancel, two dependents are blocked with the exact waiting note and neither is failed', () => {
  const store = new Store(':memory:');
  const { x, d1, d2 } = trio(store);
  store.cancel(x, 'not now');
  store.reconcileBlocked();
  expectWaiting(store, x, d1, d2);
  store.close();
});

test('retrying the canceled ticket lets both waiting dependents proceed once it lands', () => {
  const store = new Store(':memory:');
  const { x, d1, d2 } = trio(store);
  store.cancel(x);
  store.reconcileBlocked();
  store.retry(x);
  store.reconcileBlocked();
  assert.equal(store.getTask(d1)!.status, 'blocked', 'still waiting while x has not landed');
  assert.equal(store.getTask(d2)!.status, 'blocked');
  store.setStatus(x, 'done');
  store.reconcileBlocked();
  assert.equal(store.getTask(d1)!.status, 'queued');
  assert.equal(store.getTask(d2)!.status, 'queued');
  assert.equal(store.getTask(d1)!.error, null, 'the stale waiting note is gone');
  store.close();
});

test('foreman landed on the canceled ticket releases both waiting dependents', async (t) => {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-cancel-wait-');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'by hand');
  const landed = git('rev-parse', 'HEAD');

  const store = new Store(':memory:');
  const x = store.addTask({ title: 'x', prompt: 'p', repo });
  const d1 = store.addTask({ title: 'd1', prompt: 'p', deps: [x.id] });
  const d2 = store.addTask({ title: 'd2', prompt: 'p', deps: [x.id] });
  store.cancel(x.id);
  store.reconcileBlocked();
  expectWaiting(store, x.id, d1.id, d2.id);
  await store.markLanded(x.id, { commit: landed, actor: 'human' });
  store.reconcileBlocked();
  assert.equal(store.getTask(d1.id)!.status, 'queued');
  assert.equal(store.getTask(d2.id)!.status, 'queued');
  store.close();
});

test('foreman deps --drop X releases one waiting dependent and leaves the other waiting', () => {
  const store = new Store(':memory:');
  const { x, d1, d2 } = trio(store);
  store.cancel(x);
  store.reconcileBlocked();
  const after = store.dropDependency(d1, x, 'human');
  assert.equal(after.status, 'blocked');
  store.reconcileBlocked();
  assert.equal(store.getTask(d1)!.status, 'queued');
  expectWaiting(store, x, d2);
  store.close();
});

test('cancel --cascade and an epic cascade cancel fail dependents as before', async (t) => {
  const store = new Store(':memory:');
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const ad = store.addTask({ title: 'ad', prompt: 'p', deps: [a.id] });
  store.cancel(a.id, undefined, { cascade: true });
  store.reconcileBlocked();
  assert.equal(store.getTask(ad.id)!.status, 'failed');
  assert.equal(store.getTask(ad.id)!.error, `dependency ${a.id} ended as canceled`);

  const epic = store.addTask({ title: 'e', prompt: 'p', isEpic: true });
  const child = store.addTask({ title: 'c', prompt: 'p', parentId: epic.id });
  const cd = store.addTask({ title: 'cd', prompt: 'p', deps: [child.id] });
  store.cancel(epic.id);
  assert.equal(store.getTask(child.id)!.status, 'canceled');
  assert.equal(store.decisionsForTask(child.id).filter((d) => d.action === 'cancel').length, 1, 'the child has a cancel row, written by the system');
  store.reconcileBlocked();
  assert.equal(store.getTask(cd.id)!.status, 'failed');
  assert.equal(store.getTask(cd.id)!.error, `dependency ${child.id} ended as canceled`);

  // The route takes `cascade` too.
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const port = (server.address() as AddressInfo).port;
  const f = trio(store);
  const plain = trio(store);
  assert.equal((await post(port, `/api/tasks/${f.x}/cancel`, { cascade: true })).status, 200);
  assert.equal((await post(port, `/api/tasks/${plain.x}/cancel`, {})).status, 200);
  store.reconcileBlocked();
  assert.equal(store.getTask(f.d1)!.status, 'failed');
  assert.equal(store.getTask(f.d2)!.status, 'failed');
  expectWaiting(store, plain.x, plain.d1, plain.d2);
});

test('a failed dependency still cascade-fails its dependent', () => {
  const store = new Store(':memory:');
  const x = store.addTask({ title: 'x', prompt: 'p' });
  const d = store.addTask({ title: 'd', prompt: 'p', deps: [x.id] });
  store.setStatus(x.id, 'failed', 'boom');
  store.reconcileBlocked();
  assert.equal(store.getTask(d.id)!.status, 'failed');
  assert.equal(store.getTask(d.id)!.error, `dependency ${x.id} ended as failed`);
  store.close();
});

test('a rejected dependency still cascade-fails its dependent', () => {
  const store = new Store(':memory:');
  const x = store.addTask({ title: 'x', prompt: 'p' });
  const d = store.addTask({ title: 'd', prompt: 'p', deps: [x.id] });
  store.setStatus(x.id, 'rejected', 'no');
  store.reconcileBlocked();
  assert.equal(store.getTask(d.id)!.status, 'failed');
  assert.equal(store.getTask(d.id)!.error, `dependency ${x.id} ended as rejected`);
  store.close();
});

test('a canceled dependency with no cancel decisions row cascades, even when the dependent note text matches', () => {
  const store = new Store(':memory:');
  const x = store.addTask({ title: 'x', prompt: 'p' });
  const d = store.addTask({ title: 'd', prompt: 'p', deps: [x.id] });
  // Canceled by a raw status change: no decisions row. The dependent's note already reads like the waiting note.
  store.setStatus(x.id, 'canceled', 'canceled by operator');
  store.setStatus(d.id, 'blocked', waitingNote(d.id, x.id));
  assert.equal(store.decisionsForTask(x.id).length, 0);
  store.reconcileBlocked();
  assert.equal(store.getTask(d.id)!.status, 'failed');
  assert.equal(store.getTask(d.id)!.error, `dependency ${x.id} ended as canceled`);
  store.close();
});

test('1,000 reconcileBlocked ticks never re-fail a waiting dependent', () => {
  const store = new Store(':memory:');
  const { x, d1, d2 } = trio(store);
  store.cancel(x);
  assert.ok(store.reconcileBlocked() >= 0);
  const events = (): number => Number((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as Record<string, unknown>)['n']);
  const before = events();
  for (let i = 0; i < 1000; i++) {
    store.reconcileBlocked();
    if (i % 250 === 0) expectWaiting(store, x, d1, d2);
  }
  expectWaiting(store, x, d1, d2);
  assert.equal(events(), before, 'ticks after the first write nothing');
  store.close();
});

test('/api/state and foreman show carry the waiting note', async (t) => {
  const store = new Store(':memory:');
  const { x, d1 } = trio(store);
  store.cancel(x);
  store.reconcileBlocked();
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const port = (server.address() as AddressInfo).port;

  const state = JSON.parse(await get(port, '/api/state'));
  const row = (state.tasks as Array<{ id: string; error: string | null }>).find((tk) => tk.id === d1)!;
  assert.equal(row.error, waitingNote(d1, x));

  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'show', d1], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.on('close', () => resolve(text));
  });
  assert.ok(out.includes(`error: ${waitingNote(d1, x)}`), out);
});

function get(port: number, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
}

function post(port: number, urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

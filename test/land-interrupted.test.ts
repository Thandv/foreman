import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { ApprovalTracker, applyApproval } from '../src/gate.ts';

/*
 * The durable landing marker (the `landings` table): written before a merge, deleted once its ref update is
 * recorded. A row the daemon finds at start is a merge a crash cut short: it holds that repo's dependents and shows
 * in /api/state until the operator clears it.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const landingRows = (store: Store): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM landings').get() as Record<string, unknown>)['n']);

interface Interrupted { repo: string; taskId: string; since: number }

test('a landing row left by a crash holds that repo\'s dependents and shows in /api/state until the operator clears it', async () => {
  const home = fs.realpathSync(scratchDir('foreman-landint-'));
  const dbPath = path.join(home, 'foreman.db');
  const repo = path.join(home, 'repo');
  const other = path.join(home, 'other');

  // The daemon that crashed: it marked the parent done and wrote its landing row, then died inside the merge.
  const before = new Store(dbPath);
  const parent = before.addTask({ title: 'parent', prompt: 'p', runner: 'echo', repo });
  const otherParent = before.addTask({ title: 'other-parent', prompt: 'p', runner: 'echo', repo: other });
  const child = before.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo, deps: [parent.id] });
  const otherChild = before.addTask({ title: 'other-child', prompt: 'p', runner: 'echo', repo: other, deps: [otherParent.id] });
  before.setStatus(parent.id, 'done');
  before.setStatus(otherParent.id, 'done');
  before.db.prepare('INSERT INTO landings (repo, task_id, run_id, started_at) VALUES (?, ?, NULL, ?)').run(repo, parent.id, 1_000);
  before.close();

  const store = new Store(dbPath);
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  sched.dispatchHold('test: nothing is dispatched');
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const state = async (): Promise<Interrupted[]> =>
    ((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { landInterrupted: Interrupted[] }).landInterrupted;
  try {
    sched.start();
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'blocked', 'held: its repo\'s landing was cut short');
    assert.equal(store.getTask(otherChild.id)!.status, 'queued', 'another repo is not held');
    assert.deepEqual(await state(), [{ repo, taskId: parent.id, since: 1_000 }]);
    assert.ok(store.eventsForTask(parent.id).some((e) => e.type === 'warning' && e.message.startsWith(`land-interrupted(${repo})`)));

    const code = await new Promise<number | null>((resolve) => {
      spawn(process.execPath, [CLI, 'land-clear', repo], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } })
        .on('close', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(await state(), []);
    assert.equal(landingRows(store), 0, 'the row is gone: a later start does not hold the repo again');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued', 'released once cleared');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  }
});

test('clearing a repo with no interrupted landing is refused', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/land-interrupted/clear`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: '/nowhere' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  }
});

test('a landing in progress when the scheduler restarts in the same process is not taken for an interrupted one', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  sched.dispatchHold('test: nothing is dispatched');
  try {
    const marker = store.openLanding('/live', 't-live', null);
    sched.start();
    assert.equal(store.landInterrupted('/live'), null);
    store.closeLanding(marker);
    assert.equal(landingRows(store), 0);
  } finally {
    await sched.stop();
    store.close();
  }
});

test('a normal approval leaves no landing row', async () => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = fs.realpathSync(scratchDir('foreman-landint-repo-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'work');
  git(dir, 'checkout', '-q', '-');
  const store = new Store(':memory:');
  try {
    const task = store.addTask({ title: 'work', prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
    const run = store.startRun(task.id);
    store.setRunMeta(run.id, { branch: 'work', worktreePath: null });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(task.id, 'awaiting-approval');
    const out = await applyApproval(store, task.id, { principal: 'operator', tracker: new ApprovalTracker() });
    assert.equal(out.merge.code, 'merged', out.merge.reason);
    assert.equal(landingRows(store), 0);
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
});

test('the landings migration runs twice without error', () => {
  const dbPath = path.join(scratchDir('foreman-landint-mig-'), 'foreman.db');
  openDb(dbPath).close();
  const db = openDb(dbPath);
  try {
    const cols = (db.prepare('PRAGMA table_info(landings)').all() as Record<string, unknown>[]).map((c) => String(c['name']));
    assert.deepEqual(cols, ['id', 'repo', 'task_id', 'run_id', 'started_at']);
  } finally {
    db.close();
  }
});

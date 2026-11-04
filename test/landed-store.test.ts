import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import type { TaskStatus } from '../src/types.ts';
import { scratchDir } from './env.ts';
import { hermeticGitEnv } from './helpers/git.ts';

interface Fixture {
  store: Store;
  repo: string;
  /** The commit a jail is cut from, and the commit a person landed on main after it. */
  base: string;
  landed: string;
  /** A commit on a side branch that main does not contain. */
  side: string;
  git: (...a: string[]) => string;
}

function fixture(t: test.TestContext): Fixture {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-landed-');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'side.txt'), 's\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'side');
  const side = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'by hand');
  const landed = git('rev-parse', 'HEAD');
  const store = new Store(':memory:');
  return { store, repo, base, landed, side, git };
}

/** Every row of every table a landing could touch, as text, so "unchanged" is byte-equal. */
function snapshot(store: Store): string {
  return ['tasks', 'decisions', 'events', 'runs', 'artifacts', 'task_deps']
    .map((tb) => JSON.stringify(store.db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()))
    .join('\n');
}

function ticket(f: Fixture, status: TaskStatus, o: { run?: boolean; jail?: boolean; deps?: string[]; title?: string } = {}): string {
  const task = f.store.addTask({ title: o.title ?? 't', prompt: 'p', repo: f.repo, deps: o.deps });
  if (o.run) {
    const run = f.store.startRun(task.id);
    const meta: Parameters<Store['setRunMeta']>[1] = { baseCommit: f.base };
    if (o.jail) {
      const dir = path.join(scratchDir('foreman-landed-jail-'), 'jail');
      f.git('worktree', 'add', '-q', '-b', `foreman/${task.id}`, dir, f.base);
      meta.worktreePath = dir;
      meta.branch = `foreman/${task.id}`;
    }
    f.store.setRunMeta(run.id, meta);
  }
  if (status !== 'queued') f.store.setStatus(task.id, status, status === 'failed' ? 'boom' : null);
  return task.id;
}

const land = (f: Fixture, id: string, commit = f.landed): Promise<unknown> =>
  f.store.markLanded(id, { commit, by: 'gokul', note: 'by hand', actor: 'human' });

test('markLanded refuses an unknown sha, an unreachable sha, a jail-base ancestor and a missing base branch, changing nothing', async (t) => {
  const f = fixture(t);
  const id = ticket(f, 'awaiting-approval', { run: true });
  const before = snapshot(f.store);
  await assert.rejects(land(f, id, 'deadbeef'.repeat(5)), /not a commit/);
  await assert.rejects(land(f, id, f.side), /not reachable from the base branch/);
  await assert.rejects(land(f, id, f.base), /ancestor of the run's base/);
  assert.equal(snapshot(f.store), before);
  f.git('checkout', '-q', '--detach');
  await assert.rejects(land(f, id), /base branch is missing/);
  assert.equal(snapshot(f.store), before);
});

test('markLanded refuses every state it does not accept, changing nothing, and landing twice leaves one landed row', async (t) => {
  const f = fixture(t);
  for (const status of ['queued', 'running', 'verifying', 'awaiting-human', 'done', 'rejected'] as TaskStatus[]) {
    const id = ticket(f, status, { run: true });
    const before = snapshot(f.store);
    await assert.rejects(land(f, id), new RegExp(`it is ${status}`), status);
    assert.equal(snapshot(f.store), before, status);
  }
  const epic = f.store.addTask({ title: 'e', prompt: 'p', repo: f.repo, isEpic: true });
  const child = f.store.addTask({ title: 'c', prompt: 'p', repo: f.repo, parentId: epic.id });
  f.store.cancel(epic.id);
  assert.equal(f.store.getTask(child.id)!.status, 'canceled');
  const before = snapshot(f.store);
  await assert.rejects(land(f, child.id), /canceled by its parent epic/);
  assert.equal(snapshot(f.store), before);

  const id = ticket(f, 'awaiting-approval', { run: true });
  await land(f, id);
  const once = snapshot(f.store);
  await assert.rejects(land(f, id), /it is done/);
  assert.equal(snapshot(f.store), once);
  assert.equal(f.store.decisionsForTask(id).filter((d) => d.action === 'landed').length, 1);
});

test('markLanded accepts awaiting-approval, failed, blocked and own-cancel canceled with one landed row and status done', async (t) => {
  const f = fixture(t);
  const tree = f.git('rev-parse', `${f.landed}^{tree}`);
  const own = ticket(f, 'blocked', { run: true });
  f.store.cancel(own, 'changed my mind');
  for (const id of [ticket(f, 'awaiting-approval', { run: true }), ticket(f, 'failed', { run: true }), ticket(f, 'blocked', { run: true }), own]) {
    const done = await land(f, id) as { status: string };
    assert.equal(done.status, 'done');
    const rows = f.store.decisionsForTask(id).filter((d) => d.action === 'landed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.landedTree, tree);
    assert.equal(rows[0]!.actor, 'human');
    assert.match(rows[0]!.note ?? '', new RegExp(f.landed));
    assert.match(rows[0]!.note ?? '', /--by gokul/);
    assert.equal(f.store.getTask(id)!.status, 'done');
  }
});

test('markLanded queues two planned dependents', async (t) => {
  const f = fixture(t);
  const x = ticket(f, 'awaiting-approval', { run: true });
  const d1 = ticket(f, 'blocked', { deps: [x], title: 'd1' });
  const d2 = ticket(f, 'blocked', { deps: [x], title: 'd2' });
  await land(f, x);
  f.store.reconcileBlocked();
  assert.equal(f.store.getTask(d1)!.status, 'queued');
  assert.equal(f.store.getTask(d2)!.status, 'queued');
});

test('markLanded revives a dependent cascade-failed before it, and none whose error has no edge to the landed ticket', async (t) => {
  const f = fixture(t);
  const x = ticket(f, 'failed', { run: true });
  const dep = ticket(f, 'blocked', { deps: [x], title: 'dep' });
  const stray = ticket(f, 'blocked', { title: 'stray' });
  f.store.reconcileBlocked();
  assert.equal(f.store.getTask(dep)!.status, 'failed');
  assert.equal(f.store.getTask(dep)!.error, `dependency ${x} ended as failed`);
  assert.equal(f.store.decisionsForTask(dep).length, 0, 'no decisions row, as in the live ledger');
  f.store.setStatus(stray, 'failed', `dependency ${x} ended as failed`);
  const strayBefore = JSON.stringify(f.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(stray));
  await land(f, x);
  assert.equal(f.store.getTask(dep)!.status, 'blocked');
  f.store.reconcileBlocked();
  assert.equal(f.store.getTask(dep)!.status, 'queued');
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(stray)), strayBefore);
});

test('markLanded skips the jail-base check for a ticket with no run and says so in the note', async (t) => {
  const f = fixture(t);
  const blocked = ticket(f, 'blocked');
  const pre = ticket(f, 'blocked');
  f.store.cancel(pre);
  // f.base is an ancestor of any jail base; with no run there is no jail base to compare with.
  for (const id of [blocked, pre]) {
    await land(f, id, f.base);
    const row = f.store.decisionsForTask(id).find((d) => d.action === 'landed')!;
    assert.match(row.note ?? '', /jail-base ancestor check was skipped/);
    assert.equal(f.store.getTask(id)!.status, 'done');
  }
});

test('markLanded removes the jail directory and keeps the artifacts rows and files', async (t) => {
  const f = fixture(t);
  const id = ticket(f, 'awaiting-approval', { run: true, jail: true });
  const run = f.store.latestRun(id)!;
  const keep = path.join(scratchDir('foreman-landed-art-'), 'diff.patch');
  fs.writeFileSync(keep, 'patch\n');
  f.store.addArtifact({ runId: run.id, taskId: id, type: 'diff', path: keep, summary: null });
  assert.ok(fs.existsSync(run.worktreePath!));
  await land(f, id);
  assert.equal(fs.existsSync(run.worktreePath!), false);
  assert.equal(f.store.artifactsForTask(id).length, 1);
  assert.ok(fs.existsSync(keep));
});

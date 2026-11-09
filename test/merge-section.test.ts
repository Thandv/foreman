import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval } from '../src/gate.ts';
import type { MainCheck } from '../src/postMerge.ts';
import { mergeSectionsPending, withRepoMergeSection } from '../src/landing/queue.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-mergesection-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A ticket parked at the gate whose run left `branch` carrying a file of its own. */
function parkedOnBranch(store: Store, dir: string, branch: string) {
  git(dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, `${branch}.txt`), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', branch);
  git(dir, 'checkout', '-q', '-');
  const task = store.addTask({ title: branch, prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch, worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Resolves once `cond` holds, checked once per turn of the event loop. */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setImmediate(r));
}

const green = (dir: string): MainCheck => ({ ok: true, head: git(dir, 'rev-parse', 'HEAD'), cmd: null, tail: '', firstTail: '' });

test('an approval queued behind a merge in its repo waits, still parked and unmerged, until that merge section settles', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const b = parkedOnBranch(store, dir, 'second');
    // An earlier landing holds the repo's merge section until released.
    const held = deferred();
    const first = withRepoMergeSection(dir, () => held.promise);
    const second = applyApproval(store, b.id, { tracker, mainCheck: async (repoDir) => green(repoDir) });
    await until(() => mergeSectionsPending(dir) === 2);
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval', 'nothing decided while queued');
    assert.equal(fs.existsSync(path.join(dir, 'second.txt')), false, 'nothing merged while queued');
    held.resolve();
    await first;
    assert.equal((await second).merge.code, 'merged');
    assert.equal(store.getTask(b.id)!.status, 'done');
  } finally {
    store.close();
  }
});

test('a second approval of the same ticket waits its turn and is then refused: the ticket landed once', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, dir, 'once');
    let checks = 0;
    const mainCheck = async (repoDir: string): Promise<MainCheck> => { checks += 1; return green(repoDir); };
    const first = applyApproval(store, a.id, { tracker, mainCheck });
    const again = applyApproval(store, a.id, { tracker, mainCheck });
    assert.equal(mergeSectionsPending(dir), 2, 'both approvals are in the repo\'s queue');
    const refused = assert.rejects(again, /is done, not awaiting-approval/);
    assert.equal((await first).merge.code, 'merged');
    await refused;
    assert.equal(checks, 1, 'the merged main was checked once');
    assert.equal(store.getTask(a.id)!.status, 'done');
  } finally {
    store.close();
  }
});

test('approvals in two repos still land side by side', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const one = repo();
  const two = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, one, 'left');
    const b = parkedOnBranch(store, two, 'right');
    const aIn = deferred();
    const bIn = deferred();
    // Each main check waits for the other's to start: this settles only when the two landings are open together.
    const waitFor = (mine: () => void, theirs: Promise<void>) => async (repoDir: string): Promise<MainCheck> => {
      mine();
      await theirs;
      return green(repoDir);
    };
    const [x, y] = await Promise.all([
      applyApproval(store, a.id, { tracker, mainCheck: waitFor(aIn.resolve, bIn.promise) }),
      applyApproval(store, b.id, { tracker, mainCheck: waitFor(bIn.resolve, aIn.promise) }),
    ]);
    assert.equal(x.merge.code, 'merged');
    assert.equal(y.merge.code, 'merged');
  } finally {
    store.close();
  }
});

test('a section that throws releases its repo: the next one runs, and the repo is no longer counted', async () => {
  const dir = scratchDir('foreman-mergesection-');
  const gate = deferred();
  const failing = withRepoMergeSection(dir, async () => { await gate.promise; throw new Error('merge blew up'); });
  let ran = false;
  const next = withRepoMergeSection(dir, async () => { ran = true; return 'landed'; });
  assert.equal(mergeSectionsPending(dir), 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false, 'waits while the first section is open');
  gate.resolve();
  await assert.rejects(failing, /merge blew up/);
  assert.equal(await next, 'landed');
  assert.equal(ran, true);
  assert.equal(mergeSectionsPending(dir), 0);
});

test('sections in two repos do not wait on each other', async () => {
  const one = scratchDir('foreman-mergesection-');
  const two = scratchDir('foreman-mergesection-');
  const held = deferred();
  const first = withRepoMergeSection(one, () => held.promise);
  assert.equal(await withRepoMergeSection(two, async () => 'other repo'), 'other repo', 'ran while the first repo is held');
  held.resolve();
  await first;
});

test('an approval queued behind a landing lands nothing if its ticket is re-parked on a new run while it waits', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const b = parkedOnBranch(store, dir, 'seen');
    // An earlier landing holds the repo's merge section until released.
    const aOut = deferred();
    const first = withRepoMergeSection(dir, () => aOut.promise);
    const second = applyApproval(store, b.id, { tracker, mainCheck: async (repoDir) => green(repoDir) });
    await until(() => mergeSectionsPending(dir) === 2);
    // While B's approval waits, B is rejected, retried and parked again on a run the approver never saw.
    git(dir, 'checkout', '-q', '-b', 'unseen');
    fs.writeFileSync(path.join(dir, 'unseen.txt'), 'x\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'unseen');
    git(dir, 'checkout', '-q', '-');
    const run2 = store.startRun(b.id);
    store.setRunMeta(run2.id, { branch: 'unseen', worktreePath: null });
    store.addVerdict({ runId: run2.id, taskId: b.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(run2.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    aOut.resolve();
    await first;
    await assert.rejects(second, /work changed while the approval waited/);
    assert.equal(fs.existsSync(path.join(dir, 'unseen.txt')), false, 'the run the approver never saw did not land');
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    assert.equal(store.decisionsForTask(b.id).length, 0, 'no approval is on record for it');
  } finally {
    store.close();
  }
});

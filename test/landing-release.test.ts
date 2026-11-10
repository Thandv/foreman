import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval, type ApprovalResult } from '../src/gate.ts';
import type { MergeResult } from '../src/merge.ts';
import type { MainCheck } from '../src/postMerge.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-landrelease-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A ticket parked at the gate whose run left `branch` carrying a file of its own (none when `empty`). */
function parkedOnBranch(store: Store, dir: string, branch: string, empty = false) {
  git(dir, 'checkout', '-q', '-b', branch);
  if (!empty) {
    fs.writeFileSync(path.join(dir, `${branch}.txt`), 'x\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', branch);
  }
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

/** Resolves once `cond` holds or `ms` have passed, checked once per turn of the event loop; says which. */
async function within(ms: number, cond: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setImmediate(r));
  }
  return true;
}

/** The merge commit the landing of `taskId` wrote (merge.ts names the task id in its subject). */
const mergeOf = (dir: string, taskId: string): string =>
  git(dir, 'log', '--merges', '-n', '1', '--fixed-strings', `--grep=(${taskId})`, '--format=%H', 'HEAD');

/** An approval's merge result once its post-merge check has run (applyApproval returns before it does). */
async function checked(approval: Promise<ApprovalResult>): Promise<MergeResult> {
  const out = await approval;
  return (await out.postMerge) ?? out.merge;
}

const result = (ok: boolean, head: string): MainCheck => ({ ok, head, cmd: null, tail: ok ? '' : 'boom', firstTail: '' });

test('a dependent stays blocked while its parent\'s main check runs, and is released when it passes', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const a = parkedOnBranch(store, dir, 'parent');
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    const inCheck = deferred();
    const pass = deferred();
    const landing = applyApproval(store, a.id, {
      tracker: new ApprovalTracker(),
      mainCheck: async (repoDir) => { inCheck.resolve(); await pass.promise; return result(true, git(repoDir, 'rev-parse', 'HEAD')); },
    });
    await inCheck.promise;
    assert.equal(store.getTask(a.id)!.status, 'done', 'decided before its check');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'blocked', 'held while the parent lands');
    pass.resolve();
    assert.equal((await checked(landing)).code, 'merged');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued', 'released by the passing check');
  } finally {
    store.close();
  }
});

test('a red main check holds the dependent and names the parent\'s merge', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const a = parkedOnBranch(store, dir, 'parent');
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    const merge = await checked(applyApproval(store, a.id, {
      tracker: new ApprovalTracker(),
      mainCheck: async (repoDir) => result(false, git(repoDir, 'rev-parse', 'HEAD')),
    }));
    assert.match(merge.reason, /MAIN IS RED after the merge — dependents held/);
    const red = store.repoRed(dir);
    assert.equal(red?.taskId, a.id);
    assert.equal(red?.head, mergeOf(dir, a.id));
    assert.ok(store.eventsForTask(a.id).some((e) => e.message.startsWith(`MAIN IS RED after merging ${a.id}`)));
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'blocked', 'held while the repo is red');
  } finally {
    store.close();
  }
});

test('with the post-merge check off, the dependent is released at once and no check runs', async () => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const a = parkedOnBranch(store, dir, 'parent');
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    let checks = 0;
    const out = await applyApproval(store, a.id, {
      tracker: new ApprovalTracker(),
      mainCheck: async (repoDir) => { checks += 1; return result(true, git(repoDir, 'rev-parse', 'HEAD')); },
    });
    assert.equal(out.merge.code, 'merged');
    assert.equal(checks, 0);
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued');
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
});

test('an approval that merged nothing releases the dependent at once and runs no check', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const a = parkedOnBranch(store, dir, 'parent', true);
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    let checks = 0;
    const out = await applyApproval(store, a.id, {
      tracker: new ApprovalTracker(),
      mainCheck: async (repoDir) => { checks += 1; return result(true, git(repoDir, 'rev-parse', 'HEAD')); },
    });
    assert.equal(out.merge.merged, false);
    assert.equal(store.getTask(a.id)!.status, 'done');
    assert.equal(checks, 0);
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued');
  } finally {
    store.close();
  }
});

// These three pin FOREMAN_POSTMERGE_MODE=per-merge: each landing's own check, at once, at its own merge HEAD.
// The coalesced mode's counterparts are in test/landing-coalesce.test.ts.
test('a second approval in the repo merges while the first one\'s main check runs; each dependent waits for its own parent\'s check', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, dir, 'first');
    const b = parkedOnBranch(store, dir, 'second');
    const aChild = store.addTask({ title: 'a-child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    const bChild = store.addTask({ title: 'b-child', prompt: 'p', runner: 'echo', repo: dir, deps: [b.id] });
    const aIn = deferred();
    const aPass = deferred();
    const bIn = deferred();
    const bPass = deferred();
    const first = applyApproval(store, a.id, {
      tracker, postMergeMode: 'per-merge', mainCheck: async (repoDir) => { aIn.resolve(); await aPass.promise; return result(true, git(repoDir, 'rev-parse', 'HEAD')); },
    });
    await aIn.promise;
    const second = applyApproval(store, b.id, {
      tracker, postMergeMode: 'per-merge', mainCheck: async (repoDir) => { bIn.resolve(); await bPass.promise; return result(true, git(repoDir, 'rev-parse', 'HEAD')); },
    });
    const mergedAlongside = await within(5_000, () => fs.existsSync(path.join(dir, 'second.txt')));
    if (!mergedAlongside) aPass.resolve(); // let the first landing finish so the test ends
    assert.equal(mergedAlongside, true, 'the second merge waited for the first landing\'s main check');
    await bIn.promise;
    assert.equal(store.getTask(b.id)!.status, 'done');
    store.reconcileBlocked();
    assert.equal(store.getTask(aChild.id)!.status, 'blocked', 'A\'s check has not passed');
    assert.equal(store.getTask(bChild.id)!.status, 'blocked', 'B\'s check has not passed');
    bPass.resolve();
    assert.equal((await checked(second)).code, 'merged');
    store.reconcileBlocked();
    assert.equal(store.getTask(bChild.id)!.status, 'queued', 'B\'s check passed');
    assert.equal(store.getTask(aChild.id)!.status, 'blocked', 'still held: A\'s own check is running');
    aPass.resolve();
    assert.equal((await checked(first)).code, 'merged');
    store.reconcileBlocked();
    assert.equal(store.getTask(aChild.id)!.status, 'queued');
  } finally {
    store.close();
  }
});

test('a red from the first landing\'s check names its own merge, though a second merge landed while it ran', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, dir, 'first');
    const b = parkedOnBranch(store, dir, 'second');
    const aIn = deferred();
    const bDone = deferred();
    const tested = new Map<string, string | undefined>();
    // Each fake check reports the HEAD it was asked to test, as checkMain does.
    const first = applyApproval(store, a.id, {
      tracker, postMergeMode: 'per-merge',
      mainCheck: async (_repoDir: string, _cmd: string | null, _signal: AbortSignal, head?: string) => {
        tested.set('a', head);
        aIn.resolve();
        await Promise.race([bDone.promise, new Promise((r) => setTimeout(r, 5_000))]);
        return result(false, head ?? '');
      },
    });
    await aIn.promise;
    const second = applyApproval(store, b.id, {
      tracker, postMergeMode: 'per-merge', mainCheck: async (_repoDir: string, _cmd: string | null, _signal: AbortSignal, head?: string) => { tested.set('b', head); return result(true, head ?? ''); },
    });
    assert.equal((await second).merge.code, 'merged');
    bDone.resolve();
    const one = await checked(first);
    assert.match(one.reason, /MAIN IS RED after the merge — dependents held/);
    assert.equal(tested.get('a'), mergeOf(dir, a.id), 'A\'s check tested the HEAD A\'s merge made');
    assert.equal(tested.get('b'), mergeOf(dir, b.id), 'B\'s check tested the HEAD B\'s merge made');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mergeOf(dir, b.id));
    const red = store.repoRed(dir);
    assert.equal(red?.taskId, a.id, 'the red is A\'s');
    assert.equal(red?.head, mergeOf(dir, a.id), 'at A\'s merge, not the HEAD B moved it to');
    assert.equal(store.eventsForTask(b.id).some((e) => e.message.startsWith('MAIN IS RED')), false, 'nothing red is said of B');
  } finally {
    store.close();
  }
});

test('a first landing\'s check interrupted after a second merge passed is held at the first merge, not the HEAD that moved on', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, dir, 'first');
    const b = parkedOnBranch(store, dir, 'second');
    const aIn = deferred();
    // A's check never finishes on its own: only the shutdown ends it.
    const first = applyApproval(store, a.id, {
      tracker, postMergeMode: 'per-merge',
      mainCheck: (_repoDir, _cmd, signal) => {
        aIn.resolve();
        return new Promise<MainCheck>((resolve) => signal.addEventListener('abort', () => resolve(result(true, '')), { once: true }));
      },
    });
    await aIn.promise;
    const second = applyApproval(store, b.id, {
      tracker, postMergeMode: 'per-merge', mainCheck: async (repoDir) => result(true, git(repoDir, 'rev-parse', 'HEAD')),
    });
    assert.equal((await second).merge.code, 'merged');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mergeOf(dir, b.id), 'HEAD moved past A\'s merge while A\'s check ran');
    assert.equal(await tracker.shutdown(5_000), 0);
    const one = await checked(first);
    assert.match(one.reason, /main check interrupted by shutdown — untested, dependents held/);
    const red = store.repoRed(dir);
    assert.equal(red?.taskId, a.id, 'the hold names A');
    assert.equal(red?.head, mergeOf(dir, a.id), 'at the HEAD A\'s merge made, captured in the merge section');
  } finally {
    store.close();
  }
});

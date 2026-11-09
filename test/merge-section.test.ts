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

test('two approvals in one repo land one after the other: the second waits, still parked, for the first landing to settle', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const a = parkedOnBranch(store, dir, 'first');
    const b = parkedOnBranch(store, dir, 'second');
    const aIn = deferred();
    const open = new Set<string>();
    let overlapped = false;
    let whileQueued: { status: string; merged: boolean } | null = null;
    // A's landing stays open until B reaches its own main check (the landings overlap), or until B, queued behind
    // it, has had ample time to merge if it were not waiting. What B looks like then is kept to assert on.
    const aHold = async (): Promise<void> => {
      await until(() => overlapped || mergeSectionsPending(dir) === 2);
      const deadline = Date.now() + 1_500;
      await until(() => overlapped || Date.now() > deadline);
      whileQueued = { status: store.getTask(b.id)!.status, merged: fs.existsSync(path.join(dir, 'second.txt')) };
    };
    const check = (id: string, entered: () => void, hold: () => Promise<unknown>) => async (repoDir: string): Promise<MainCheck> => {
      open.add(id);
      if (open.size > 1) overlapped = true;
      entered();
      await hold();
      open.delete(id);
      return green(repoDir);
    };
    const first = applyApproval(store, a.id, { tracker, mainCheck: check('a', aIn.resolve, aHold) });
    await aIn.promise;
    const second = applyApproval(store, b.id, { tracker, mainCheck: check('b', () => {}, () => Promise.resolve()) });
    const [one, two] = await Promise.all([first, second]);
    assert.equal(overlapped, false, 'the second landing ran inside the first: two merges on one checkout at once');
    assert.deepEqual(whileQueued, { status: 'awaiting-approval', merged: false },
      'while queued the second approval has neither merged nor marked its ticket done');
    assert.equal(one.merge.code, 'merged');
    assert.equal(two.merge.code, 'merged');
    assert.equal(store.getTask(b.id)!.status, 'done');
    assert.equal(fs.existsSync(path.join(dir, 'first.txt')) && fs.existsSync(path.join(dir, 'second.txt')), true, 'both landed');
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
    assert.equal((await first).merge.code, 'merged');
    await assert.rejects(again, /is done, not awaiting-approval/);
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

import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval, pruneStaleMainWorktrees, type ApprovalResult } from '../src/gate.ts';
import type { MergeResult } from '../src/merge.ts';
import type { MainCheck } from '../src/postMerge.ts';

/*
 * The single-merge attribution table of the post-merge check, through the one approve path: what each outcome of
 * the check does to the landing hold, the red-repo marker and the task's timeline. Pinned so the check can move
 * between files without any of it changing.
 */

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-verifypin-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A parent parked at the gate on a branch with a file of its own, and a child that depends on it. */
function parentAndChild(store: Store, dir: string) {
  git(dir, 'checkout', '-q', '-b', 'parent');
  fs.writeFileSync(path.join(dir, 'parent.txt'), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'parent');
  git(dir, 'checkout', '-q', '-');
  const parent = store.addTask({ title: 'parent', prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
  const run = store.startRun(parent.id);
  store.setRunMeta(run.id, { branch: 'parent', worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: parent.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(parent.id, 'awaiting-approval');
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [parent.id] });
  return { parent, child };
}

async function checked(approval: Promise<ApprovalResult>): Promise<MergeResult> {
  const out = await approval;
  return (await out.postMerge) ?? out.merge;
}

const mergeOf = (dir: string, taskId: string): string =>
  git(dir, 'log', '--merges', '-n', '1', '--fixed-strings', `--grep=(${taskId})`, '--format=%H', 'HEAD');

function withStore(fn: (store: Store, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    const store = new Store(':memory:');
    try {
      await fn(store, repo());
    } finally {
      delete process.env['FOREMAN_POSTMERGE_CHECK'];
      store.close();
    }
  };
}

test('green: the landing hold ends and the dependent is released', withStore(async (store, dir) => {
  const { parent, child } = parentAndChild(store, dir);
  const merge = await checked(applyApproval(store, parent.id, {
    principal: 'operator',
    tracker: new ApprovalTracker(),
    mainCheck: async (_r, _c, _s, head) => ({ ok: true, head, cmd: 'npm test', tail: 'ok', firstTail: '' }),
  }));
  assert.equal(merge.code, 'merged');
  assert.doesNotMatch(merge.reason, /MAIN IS RED|interrupted/);
  assert.equal(store.repoRed(dir), null);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
}));

test('red: the repo is marked red naming the task, with the MAIN IS RED event', withStore(async (store, dir) => {
  const { parent, child } = parentAndChild(store, dir);
  const merge = await checked(applyApproval(store, parent.id, {
    principal: 'operator',
    tracker: new ApprovalTracker(),
    mainCheck: async (_r, _c, _s, head) => ({ ok: false, head, cmd: 'npm test', tail: 'boom', firstTail: '' }),
  }));
  assert.match(merge.reason, /; MAIN IS RED after the merge — dependents held$/);
  const red = store.repoRed(dir)!;
  assert.equal(red.taskId, parent.id);
  assert.equal(red.head, mergeOf(dir, parent.id));
  assert.equal(red.reason, 'boom');
  const events = store.eventsForTask(parent.id).filter((e) => e.message.startsWith('MAIN IS RED'));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'error');
  assert.equal(events[0]!.message,
    `MAIN IS RED after merging ${parent.id} (npm test): new work for this repo is held until HEAD moves and its tests pass.\nboom`);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'blocked');
}));

test('flaky: a first failure then a pass records a status event and no red', withStore(async (store, dir) => {
  const { parent, child } = parentAndChild(store, dir);
  const merge = await checked(applyApproval(store, parent.id, {
    principal: 'operator',
    tracker: new ApprovalTracker(),
    mainCheck: async (_r, _c, _s, head) => ({ ok: true, head, cmd: 'npm test', tail: 'second ok', firstTail: 'first boom' }),
  }));
  assert.doesNotMatch(merge.reason, /MAIN IS RED/);
  assert.equal(store.repoRed(dir), null);
  const flaky = store.eventsForTask(parent.id).filter((e) => e.message.includes('failed once, then passed'));
  assert.equal(flaky.length, 1);
  assert.equal(flaky[0]!.type, 'status');
  assert.equal(flaky[0]!.message,
    `main check after ${parent.id} failed once, then passed on an immediate re-run at the same HEAD (flaky; repo not marked red)` +
    '\n--- first run (failed) ---\nfirst boom\n--- second run ---\nsecond ok');
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
}));

test('FOREMAN_POSTMERGE_CHECK=off: no check runs and the dependent is released at once', withStore(async (store, dir) => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const { parent, child } = parentAndChild(store, dir);
  let checks = 0;
  const out = await applyApproval(store, parent.id, {
    principal: 'operator',
    tracker: new ApprovalTracker(),
    mainCheck: async (_r, _c, _s, head) => { checks += 1; return { ok: true, head, cmd: null, tail: '', firstTail: '' }; },
  });
  assert.equal(out.merge.code, 'merged');
  assert.equal(out.postMerge, undefined);
  assert.equal(checks, 0);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
}));

test('shutdown during the check: the interrupted marker is due at once and the scratch worktree is pruned', withStore(async (store, dir) => {
  const { parent, child } = parentAndChild(store, dir);
  const tracker = new ApprovalTracker();
  const scratch = path.join(fs.realpathSync(os.tmpdir()), `foreman-main-${process.pid}-pin${Date.now()}`);
  let entered!: () => void;
  const inCheck = new Promise<void>((r) => { entered = r; });
  const landing = applyApproval(store, parent.id, {
    principal: 'operator',
    tracker,
    // Registers a scratch checkout as checkMain does, then never finishes on its own.
    mainCheck: (repoDir, _c, _s, head) => {
      git(repoDir, 'worktree', 'add', '-q', '--detach', scratch, head);
      entered();
      return new Promise<MainCheck>(() => {});
    },
  });
  await inCheck;
  const before = Date.now();
  assert.equal(await tracker.shutdown(5_000), 0);
  const merge = await checked(landing);
  assert.match(merge.reason, /; main check interrupted by shutdown — untested, dependents held$/);
  const red = store.repoRed(dir)!;
  assert.equal(red.taskId, parent.id);
  assert.equal(red.head, mergeOf(dir, parent.id));
  assert.equal(red.reason, 'post-merge check interrupted — untested');
  assert.ok(red.nextCheckAt! >= before && red.nextCheckAt! <= Date.now(), 'due for a re-check at once');
  assert.ok(store.eventsForTask(parent.id).some((e) => e.type === 'warning' &&
    e.message === `main check after merging ${parent.id} was interrupted by a daemon shutdown and did not run: ` +
      'the merged HEAD is untested; new work for this repo is held until a re-check passes'));
  assert.equal(fs.existsSync(scratch), false, 'the scratch worktree is removed');
  assert.doesNotMatch(git(dir, 'worktree', 'list', '--porcelain'), /foreman-main-/);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'blocked');
}));

test('the startup prune removes a stale foreman-main-* worktree', withStore(async (store, dir) => {
  store.addTask({ title: 't', prompt: 'p', runner: 'echo', repo: dir });
  const stale = path.join(fs.realpathSync(os.tmpdir()), `foreman-main-${process.pid}-stale${Date.now()}`);
  git(dir, 'worktree', 'add', '-q', '--detach', stale, 'HEAD');
  assert.deepEqual(await pruneStaleMainWorktrees(store), [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.doesNotMatch(git(dir, 'worktree', 'list', '--porcelain'), /foreman-main-/);
}));

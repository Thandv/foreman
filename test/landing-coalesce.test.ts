import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval, type ApprovalResult } from '../src/gate.ts';
import type { MergeResult } from '../src/merge.ts';
import type { MainCheck } from '../src/postMerge.ts';
import type { MainChecker } from '../src/landing/verify.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { Task } from '../src/types.ts';

/*
 * Post-merge checks under a burst of landings in one repo (FOREMAN_POSTMERGE_MODE, src/landing/verify.ts): each
 * fake check is held open by the test and finished by hand, so which merges land during which check is exact.
 */

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-coalesce-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A ticket parked at the gate on a branch with a file of its own, and a child that depends on it. */
function parked(store: Store, dir: string, name: string, testCmd: string | null = null): { task: Task; child: Task } {
  git(dir, 'checkout', '-q', '-b', name);
  fs.writeFileSync(path.join(dir, `${name}.txt`), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', name);
  git(dir, 'checkout', '-q', '-');
  const task = store.addTask({ title: name, prompt: 'p', kind: 'code', runner: 'echo', repo: dir, testCmd });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch: name, worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  const child = store.addTask({ title: `${name}-child`, prompt: 'p', runner: 'echo', repo: dir, deps: [task.id] });
  return { task, child };
}

interface Call {
  cmd: string | null;
  head: string;
  finish: (ok: boolean) => void;
}

/** A fake check per call that stays open until the test finishes it; `called(n)` waits for the n-th call. */
function heldChecks(): { calls: Call[]; mainCheck: MainChecker; called: (n: number) => Promise<Call> } {
  const calls: Call[] = [];
  const waiters: Array<() => void> = [];
  const mainCheck: MainChecker = (_repo, cmd, _signal, head) => new Promise<MainCheck>((resolve) => {
    calls.push({ cmd, head, finish: (ok) => resolve({ ok, head, cmd: cmd ?? 'npm test', tail: ok ? 'ok' : 'boom', firstTail: '' }) });
    for (const w of waiters.splice(0)) w();
  });
  const called = async (n: number): Promise<Call> => {
    while (calls.length < n) await new Promise<void>((r) => waiters.push(r));
    return calls[n - 1]!;
  };
  return { calls, mainCheck, called };
}

async function checked(out: ApprovalResult): Promise<MergeResult> {
  return (await out.postMerge) ?? out.merge;
}

const mergeOf = (dir: string, taskId: string): string =>
  git(dir, 'log', '--merges', '-n', '1', '--fixed-strings', `--grep=(${taskId})`, '--format=%H', 'HEAD');

function withStore(fn: (store: Store, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const store = new Store(':memory:');
    try {
      await fn(store, repo());
    } finally {
      store.close();
    }
  };
}

test('coalesced: three same-command merges landing during one check cause one more suite, at the newest HEAD', { timeout: 60_000 }, withStore(async (store, dir) => {
  const tickets = ['t0', 't1', 't2', 't3'].map((n) => parked(store, dir, n, 'npm test'));
  const tracker = new ApprovalTracker();
  const { calls, mainCheck, called } = heldChecks();
  const outs: ApprovalResult[] = [await applyApproval(store, tickets[0]!.task.id, { tracker, mainCheck })];
  const first = await called(1);
  for (const t of tickets.slice(1)) outs.push(await applyApproval(store, t.task.id, { tracker, mainCheck }));
  assert.equal(calls.length, 1, 'no check starts while one runs in the repo');
  first.finish(true);
  const second = await called(2);
  assert.equal(second.head, mergeOf(dir, tickets[3]!.task.id), 'the next check runs at the newest merged HEAD');
  second.finish(true);
  for (const out of outs) assert.equal((await checked(out)).code, 'merged');
  assert.equal(calls.length, 2, 'two suites in total');
  store.reconcileBlocked();
  for (const t of tickets) {
    assert.equal(store.isLanding(t.task.id), false);
    assert.equal(store.getTask(t.child.id)!.status, 'queued');
  }
}));

test('per-merge: the same burst runs one suite per merge, each at its own merge HEAD', { timeout: 60_000 }, withStore(async (store, dir) => {
  const tickets = ['t0', 't1', 't2', 't3'].map((n) => parked(store, dir, n, 'npm test'));
  const tracker = new ApprovalTracker();
  const { calls, mainCheck, called } = heldChecks();
  const outs: ApprovalResult[] = [];
  for (const t of tickets) outs.push(await applyApproval(store, t.task.id, { tracker, mainCheck, postMergeMode: 'per-merge' }));
  await called(4);
  assert.deepEqual(calls.map((c) => c.head), tickets.map((t) => mergeOf(dir, t.task.id)));
  for (const c of calls) c.finish(true);
  for (const out of outs) assert.equal((await checked(out)).code, 'merged');
  assert.equal(calls.length, 4);
}));

test('merges with different test commands each get their own run, in landing order', { timeout: 60_000 }, withStore(async (store, dir) => {
  const t0 = parked(store, dir, 't0', 'cmd-a');
  const t1 = parked(store, dir, 't1', 'cmd-b');
  const t2 = parked(store, dir, 't2', 'cmd-a');
  const tracker = new ApprovalTracker();
  const { calls, mainCheck, called } = heldChecks();
  const outs = [await applyApproval(store, t0.task.id, { tracker, mainCheck })];
  const first = await called(1);
  outs.push(await applyApproval(store, t1.task.id, { tracker, mainCheck }));
  outs.push(await applyApproval(store, t2.task.id, { tracker, mainCheck }));
  first.finish(true);
  const second = await called(2);
  assert.deepEqual([second.cmd, second.head], ['cmd-b', mergeOf(dir, t1.task.id)]);
  assert.ok(store.isLanding(t1.task.id) && store.isLanding(t2.task.id), 'neither is covered by the cmd-a check at t0');
  second.finish(true);
  const third = await called(3);
  assert.deepEqual([third.cmd, third.head], ['cmd-a', mergeOf(dir, t2.task.id)]);
  assert.equal(store.isLanding(t1.task.id), false);
  assert.equal(store.isLanding(t2.task.id), true, 'the cmd-b green does not release a cmd-a merge');
  third.finish(true);
  for (const out of outs) await checked(out);
  assert.equal(calls.length, 3);
}));

test('a red covering two merges names both in one event, ends both holds, and a later green re-check releases both', { timeout: 60_000 }, withStore(async (store, dir) => {
  const first = parked(store, dir, 'first', 'npm test');
  const a = parked(store, dir, 'a', 'npm test');
  const b = parked(store, dir, 'b', 'npm test');
  const tracker = new ApprovalTracker();
  const { mainCheck, called } = heldChecks();
  await applyApproval(store, first.task.id, { tracker, mainCheck });
  const c1 = await called(1);
  const outs = [await applyApproval(store, a.task.id, { tracker, mainCheck }), await applyApproval(store, b.task.id, { tracker, mainCheck })];
  c1.finish(true);
  (await called(2)).finish(false);
  for (const out of outs) assert.match((await checked(out)).reason, /; MAIN IS RED after the merge — dependents held$/);
  assert.equal(store.isLanding(a.task.id), false);
  assert.equal(store.isLanding(b.task.id), false);
  const red = store.repoRed(dir)!;
  assert.equal(red.taskId, b.task.id, 'the marker names the merge whose HEAD failed');
  assert.equal(red.head, mergeOf(dir, b.task.id));
  const events = [...store.eventsForTask(a.task.id), ...store.eventsForTask(b.task.id)].filter((e) => e.message.startsWith('MAIN IS RED'));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.message,
    `MAIN IS RED after merging ${a.task.id}, ${b.task.id} (npm test): new work for this repo is held until HEAD moves and its tests pass.\nboom`);
  store.reconcileBlocked();
  assert.equal(store.getTask(a.child.id)!.status, 'blocked');
  assert.equal(store.getTask(b.child.id)!.status, 'blocked');

  // A fix moves HEAD; the scheduler's red re-check passes there and releases the dependents of both.
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'fix\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fix');
  const fixed = git(dir, 'rev-parse', 'HEAD');
  const sched = new Scheduler(store, {
    tickMs: 5, verifyEnabled: false, maxWorkers: 1,
    checkMain: async () => ({ ok: true, head: fixed, cmd: 'npm test', tail: 'ok', firstTail: '' }),
  });
  try {
    sched['recheckRedRepos']();
    while (sched['redChecking'].size > 0) await new Promise<void>((r) => setImmediate(r));
  } finally {
    await sched.stop();
  }
  assert.equal(store.repoRed(dir), null);
  assert.equal(store.getTask(a.child.id)!.status, 'queued');
  assert.equal(store.getTask(b.child.id)!.status, 'queued');
}));

test('shutdown during a coalesced check: the interrupted marker names every covered task and their holds end', { timeout: 60_000 }, withStore(async (store, dir) => {
  const first = parked(store, dir, 'first', 'npm test');
  const a = parked(store, dir, 'a', 'npm test');
  const b = parked(store, dir, 'b', 'npm test');
  const tracker = new ApprovalTracker();
  const { mainCheck, called } = heldChecks();
  await applyApproval(store, first.task.id, { tracker, mainCheck });
  const c1 = await called(1);
  const outs = [await applyApproval(store, a.task.id, { tracker, mainCheck }), await applyApproval(store, b.task.id, { tracker, mainCheck })];
  c1.finish(true);
  await called(2); // never finished: only the shutdown ends it
  assert.equal(await tracker.shutdown(5_000), 0);
  for (const out of outs) assert.match((await checked(out)).reason, /; main check interrupted by shutdown — untested, dependents held$/);
  assert.equal(store.isLanding(a.task.id), false);
  assert.equal(store.isLanding(b.task.id), false);
  const red = store.repoRed(dir)!;
  assert.equal(red.reason, 'post-merge check interrupted — untested');
  assert.equal(red.head, mergeOf(dir, b.task.id));
  assert.ok(store.eventsForTask(b.task.id).some((e) => e.type === 'warning' &&
    e.message === `main check after merging ${a.task.id}, ${b.task.id} was interrupted by a daemon shutdown and did not run: ` +
      'the merged HEAD is untested; new work for this repo is held until a re-check passes'));
}));

test('a bad FOREMAN_POSTMERGE_MODE fails start with a named error', { timeout: 60_000 }, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'config', '--effective'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FOREMAN_POSTMERGE_MODE: 'batched' },
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /FOREMAN_POSTMERGE_MODE must be coalesced or per-merge, got "batched"/);
});

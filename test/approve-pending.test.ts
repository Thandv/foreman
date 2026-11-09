import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { acquireVerifySlot, verifySlotStats } from '../src/verify/slots.ts';
import type { Decision } from '../src/types.ts';

/*
 * POST /api/tasks/:id/approve through the real merge and the real post-merge
 * check (postMerge.ts checkMain). The repo's "slow suite" is the one verify
 * slot, held by the test: the check waits in the slot queue until the test
 * lets it run, so how long the suite takes is in the test's hands, not a clock's.
 */

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-approve-pending-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A ticket parked at the gate whose run left `branch` carrying a file of its own; `testCmd` is the repo's suite. */
function parkedOnBranch(store: Store, dir: string, branch: string, testCmd: string) {
  git(dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, `${branch}.txt`), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', branch);
  git(dir, 'checkout', '-q', '-');
  const task = store.addTask({ title: branch, prompt: 'p', kind: 'code', runner: 'echo', repo: dir, testCmd });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch, worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
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

interface Approved {
  merge: { merged: boolean; code: string; reason: string };
  decision: Decision | null;
  postMerge?: string;
}

async function daemon() {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const approve = async (id: string): Promise<Approved> => {
    const res = await fetch(`${base}/api/tasks/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    return (await res.json()) as Approved;
  };
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  };
  return { store, approve, close };
}

test('an approve answers only after the post-merge suite has run, and the dependent is released by then', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  process.env['FOREMAN_MAX_VERIFIES'] = '1';
  const d = await daemon();
  const suite = await acquireVerifySlot();
  try {
    const dir = repo();
    const a = parkedOnBranch(d.store, dir, 'parent', 'true');
    const child = d.store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: dir, deps: [a.id] });
    let answered = false;
    const reply = d.approve(a.id).finally(() => { answered = true; });
    assert.ok(await within(20_000, () => verifySlotStats().waiting === 1), 'the post-merge check is waiting on the suite');
    assert.equal(answered, false, 'no answer while the suite has not run');
    suite.release();
    const out = await reply;
    assert.equal(out.merge.code, 'merged', out.merge.reason);
    assert.equal(out.postMerge, undefined);
    d.store.reconcileBlocked();
    assert.notEqual(d.store.getTask(child.id)!.status, 'blocked', 'the check passed before the answer');
  } finally {
    suite.release();
    delete process.env['FOREMAN_MAX_VERIFIES'];
    await d.close();
  }
});

test('a green landing\'s decision row carries the merge reason', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const d = await daemon();
  try {
    const a = parkedOnBranch(d.store, repo(), 'green', 'true');
    const out = await d.approve(a.id);
    assert.equal(out.merge.code, 'merged', out.merge.reason);
    const rows = d.store.decisionsForTask(a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, 'approve');
    assert.equal(rows[0]!.merged, true);
    assert.equal(rows[0]!.mergeReason, out.merge.reason);
    assert.doesNotMatch(rows[0]!.mergeReason ?? '', /MAIN IS RED|main check/);
    assert.deepEqual(out.decision, rows[0]);
  } finally {
    await d.close();
  }
});

test('a red landing\'s decision row carries the MAIN IS RED suffix', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const d = await daemon();
  try {
    const dir = repo();
    const a = parkedOnBranch(d.store, dir, 'red', 'false');
    const out = await d.approve(a.id);
    assert.equal(out.merge.code, 'merged', out.merge.reason);
    assert.match(out.merge.reason, /; MAIN IS RED after the merge — dependents held$/);
    const rows = d.store.decisionsForTask(a.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.mergeReason, out.merge.reason);
    assert.equal(d.store.repoRed(dir)?.taskId, a.id, 'marked red before the answer');
    assert.ok(d.store.eventsForTask(a.id).some((e) => e.message.startsWith(`MAIN IS RED after merging ${a.id}`)));
  } finally {
    await d.close();
  }
});

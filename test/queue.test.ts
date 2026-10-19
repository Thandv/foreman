import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';

const store = (): Store => new Store(':memory:');

test('rejects empty title and prompt', () => {
  const s = store();
  assert.throws(() => s.addTask({ title: '  ', prompt: 'x' }), /title is required/);
  assert.throws(() => s.addTask({ title: 'x', prompt: '' }), /prompt is required/);
  s.close();
});

test('rejects unknown enums and bad attempt counts', () => {
  const s = store();
  assert.throws(() => s.addTask({ title: 'a', prompt: 'b', kind: 'nope' as never }), /unknown kind/);
  assert.throws(() => s.addTask({ title: 'a', prompt: 'b', runner: 'nope' as never }), /unknown runner/);
  assert.throws(() => s.addTask({ title: 'a', prompt: 'b', maxAttempts: 0 }), /positive integer/);
  s.close();
});

test('rejects numbers that are not numbers, and negative caps and budgets', () => {
  const s = store();
  const base = { title: 'a', prompt: 'b', runner: 'echo' as const };
  assert.throws(() => s.addTask({ ...base, priority: NaN }), /priority must be a finite number/);
  assert.throws(() => s.addTask({ ...base, maxRepairs: NaN }), /maxRepairs must be a non-negative integer/);
  assert.throws(() => s.addTask({ ...base, maxRepairs: -1 }), /maxRepairs/);
  assert.throws(() => s.addTask({ ...base, maxRepairs: 1.5 }), /maxRepairs/);
  assert.throws(() => s.addTask({ ...base, budgetUsd: -5 }), /budgetUsd must be a non-negative number/);
  assert.throws(() => s.addTask({ ...base, budgetUsd: NaN }), /budgetUsd/);
  assert.throws(() => s.addTask({ ...base, points: NaN }), /points/);
  assert.throws(() => s.addTask({ ...base, repo: 5 as never }), /repo must be a path/);
  assert.equal(s.listTasks().length, 0, 'nothing half-valid was stored');
  // The edges stay legal.
  const ok = s.addTask({ ...base, priority: -10, maxRepairs: 0, budgetUsd: 0, points: 0 });
  assert.equal(ok.maxRepairs, 0);
  assert.equal(ok.priority, -10);
  s.close();
});

test('a task with deps starts blocked and is promoted only when every dep is done', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo' });
  const c = s.addTask({ title: 'c', prompt: 'c', runner: 'echo', deps: [a.id, b.id] });
  assert.equal(c.status, 'blocked');
  assert.deepEqual(c.deps.sort(), [a.id, b.id].sort());

  s.setStatus(a.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(c.id)!.status, 'blocked');

  s.setStatus(b.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(c.id)!.status, 'queued');
  s.close();
});

test('a dead dependency fails its dependents instead of hanging them', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  s.setStatus(a.id, 'failed', 'boom');
  s.reconcileBlocked();
  const after = s.getTask(b.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /dependency .* ended as failed/);
  s.close();
});

test('unknown dependency is refused at add time', () => {
  const s = store();
  assert.throws(() => s.addTask({ title: 'a', prompt: 'a', deps: ['t_nope'] }), /dependency not found/);
  assert.equal(s.listTasks().length, 0, 'failed add must not leave a row behind');
  s.close();
});

test('claim is exactly-once', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  assert.equal(s.claim(t.id), true);
  assert.equal(s.claim(t.id), false);
  assert.equal(s.getTask(t.id)!.attempts, 1);
  s.close();
});

test('claimable orders by priority then age', () => {
  const s = store();
  const low = s.addTask({ title: 'low', prompt: 'x', runner: 'echo' });
  const high = s.addTask({ title: 'high', prompt: 'x', runner: 'echo', priority: 5 });
  const ids = s.claimable(2).map((t) => t.id);
  assert.deepEqual(ids, [high.id, low.id]);
  s.close();
});

test('the gate only accepts tasks parked at awaiting-approval', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  assert.throws(() => s.decide(t.id, true), /not awaiting-approval/);
  s.setStatus(t.id, 'awaiting-approval');
  assert.equal(s.decide(t.id, true).status, 'done');
  assert.throws(() => s.decide(t.id, true), /not awaiting-approval/, 'double approval must not re-open a task');
  s.close();
});

test('approval stamps the pending artifacts', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const run = s.startRun(t.id);
  s.addArtifact({ runId: run.id, taskId: t.id, type: 'diff', path: '/tmp/x.diff', summary: null });
  s.setStatus(t.id, 'awaiting-approval');
  s.decide(t.id, false, 'no');
  assert.equal(s.artifactsForTask(t.id)[0]!.approved, 0);
  s.close();
});

test('deleting a depended-on task is refused', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  assert.throws(() => s.deleteTask(a.id), /depend on it/);
  s.close();
});

test('recoverOrphans requeues an interrupted task and fails one out of attempts', () => {
  const s = store();
  const retryable = s.addTask({ title: 'a', prompt: 'a', runner: 'echo', maxAttempts: 3 });
  const spent = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', maxAttempts: 1 });
  s.claim(retryable.id);
  s.claim(spent.id);
  const run = s.startRun(retryable.id);
  s.recoverOrphans();
  assert.equal(s.getTask(retryable.id)!.status, 'queued');
  assert.equal(s.getTask(spent.id)!.status, 'failed');
  assert.equal(s.getRun(run.id)!.status, 'canceled');
  s.close();
});

test('progress is clamped to 0..1', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const run = s.startRun(t.id);
  s.setRunProgress(run.id, t.id, 4);
  assert.equal(s.getRun(run.id)!.progress, 1);
  s.setRunProgress(run.id, t.id, -2);
  assert.equal(s.getRun(run.id)!.progress, 0);
  s.close();
});

test('unicode titles and prompts round-trip', () => {
  const s = store();
  const t = s.addTask({ title: '修复 🦺 café', prompt: 'naïve — 𝔘𝔫𝔦', runner: 'echo' });
  const back = s.getTask(t.id)!;
  assert.equal(back.title, '修复 🦺 café');
  assert.equal(back.prompt, 'naïve — 𝔘𝔫𝔦');
  s.close();
});

test('retry does not promote a ticket past its unfinished dependencies', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  // b fails on its own account while a is still in flight.
  s.setStatus(b.id, 'failed', 'boom');

  const retried = s.retry(b.id);
  assert.equal(retried.status, 'blocked', 'a dep that has not finished still blocks');

  s.setStatus(a.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'queued');
  s.close();
});

test('retry runs cold: the previous run\'s session is not carried into it', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'claude-code' });
  const run = s.startRun(t.id);
  s.setRunMeta(run.id, { sessionId: 'sess-1', worktreePath: '/tmp/old-jail', branch: 'foreman/t-r' });
  s.endRun(run.id, 'failed', { summary: 'tests failed' });
  s.setStatus(t.id, 'failed', 'tests failed');

  const retried = s.retry(t.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempts, 0);
  // The session is what pins a run to the old worktree — and that worktree is
  // cut from the base commit the operator has just fixed things on top of.
  assert.equal(s.latestRun(t.id)!.sessionId, null);
  s.close();
});

test('retrying a dead dependency revives the dependents it killed, transitively, and nothing else', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  const c = s.addTask({ title: 'c', prompt: 'c', runner: 'echo', deps: [b.id] });
  const own = s.addTask({ title: 'own', prompt: 'own', runner: 'echo', deps: [a.id] });
  s.setStatus(a.id, 'failed', 'review said no');
  s.reconcileBlocked();
  s.reconcileBlocked(); // c dies a tick after b
  assert.equal(s.getTask(b.id)!.status, 'failed');
  assert.equal(s.getTask(c.id)!.status, 'failed');
  // `own` failed for its own reasons after dying of `a` — a retry of `a` is not its retry.
  s.setStatus(own.id, 'failed', 'its own run failed');

  s.retry(a.id);
  assert.equal(s.getTask(a.id)!.status, 'queued');
  assert.equal(s.getTask(b.id)!.status, 'blocked', 'the direct dependent comes back');
  assert.equal(s.getTask(c.id)!.status, 'blocked', 'and so does its dependent');
  assert.equal(s.getTask(own.id)!.status, 'failed');

  s.setStatus(a.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'queued', 'revived work runs once the retried dependency lands');
  assert.equal(s.getTask(c.id)!.status, 'blocked');
  s.close();
});

test('a revived dependent whose other dependency is still dead fails again, not hangs', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const x = s.addTask({ title: 'x', prompt: 'x', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id, x.id] });
  s.setStatus(a.id, 'failed', 'no');
  s.reconcileBlocked();
  s.setStatus(x.id, 'failed', 'also no');
  s.retry(a.id);
  assert.equal(s.getTask(b.id)!.status, 'blocked');
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'failed');
  assert.match(s.getTask(b.id)!.error!, new RegExp(`dependency ${x.id} ended as failed`));
  s.retry(x.id);
  assert.equal(s.getTask(b.id)!.status, 'blocked', 'retrying the other one revives it too');
  s.close();
});

test('a retry carries the review that ended the task, not the one before it', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  const run1 = s.startRun(t.id).id;
  s.addVerdict({ runId: run1, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique: 'FIRST: add tests' });
  s.db.prepare("UPDATE tasks SET repair_notes = 'FIRST: add tests', repairs = 1 WHERE id = ?").run(t.id);
  const run2 = s.startRun(t.id).id;
  s.addVerdict({ runId: run2, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique: 'FINAL: deadlock on large paste' });
  s.setStatus(t.id, 'failed', 'review said no');
  s.retry(t.id);
  const notes = s.getTask(t.id)!.repairNotes ?? '';
  assert.match(notes, /FINAL: deadlock on large paste/);
  assert.doesNotMatch(notes, /FIRST: add tests/);
  s.close();
});

test('a retry gets a fresh repair budget', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  s.db.prepare('UPDATE tasks SET repairs = 1 WHERE id = ?').run(t.id);
  s.setStatus(t.id, 'failed', 'review said no');
  s.retry(t.id);
  assert.equal(s.getTask(t.id)!.repairs, 0, 'or its first review after the retry would end it for good');
  s.close();
});

test('retrying a rejected ticket carries the operator\'s reason and revives what the rejection killed', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  s.db.prepare("UPDATE tasks SET repair_notes = 'EARLIER: fix the deadlock' WHERE id = ?").run(a.id);
  s.setStatus(a.id, 'awaiting-approval');
  s.decide(a.id, false, 'SIGPIPE is still ignored in the child');
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'failed');
  s.retry(a.id);
  const notes = s.getTask(a.id)!.repairNotes ?? '';
  assert.match(notes, /REJECTED at the gate by the operator/);
  assert.match(notes, /SIGPIPE is still ignored/);
  assert.match(notes, /EARLIER: fix the deadlock/, 'what the earlier review demanded is still owed');
  assert.equal(s.getTask(b.id)!.status, 'blocked');
  s.close();
});

test("an operator's rejection outlives the repair rounds after it and accumulates across rejections", () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo', maxAttempts: 3 });
  s.db.prepare('UPDATE tasks SET max_repairs = 2 WHERE id = ?').run(t.id);
  assert.equal(s.getTask(t.id)!.operatorDemands, null);
  s.setStatus(t.id, 'awaiting-approval');
  s.decide(t.id, false, 'hide __pycache__ in Simple mode');
  s.retry(t.id);
  assert.equal(s.getTask(t.id)!.operatorDemands, 'hide __pycache__ in Simple mode');
  s.scheduleRepair(t.id, 'reviewer: add a test for the tree filter');
  const after = s.getTask(t.id)!;
  assert.doesNotMatch(after.repairNotes ?? '', /pycache/, 'repair notes are the latest critique only');
  assert.equal(after.operatorDemands, 'hide __pycache__ in Simple mode', 'the human finding survives the round');
  s.setStatus(t.id, 'awaiting-approval');
  s.decide(t.id, false, 'style the preview link');
  s.retry(t.id);
  const both = s.getTask(t.id)!.operatorDemands ?? '';
  assert.match(both, /pycache[\s\S]*a later rejection[\s\S]*preview link/);
  s.close();
});

test('a retry after a failed review leaves the operator demands as they were', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  s.setStatus(t.id, 'awaiting-approval');
  s.decide(t.id, false, 'mark the error line');
  s.retry(t.id);
  s.setStatus(t.id, 'failed');
  s.retry(t.id);
  assert.equal(s.getTask(t.id)!.operatorDemands, 'mark the error line');
  s.close();
});

test('a dependency that is done but still landing does not release its dependents', () => {
  const s = store();
  const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
  s.beginLanding(a.id);
  s.setStatus(a.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'blocked', 'cut from a HEAD the merge has not reached yet otherwise');
  s.endLanding(a.id);
  s.reconcileBlocked();
  assert.equal(s.getTask(b.id)!.status, 'queued');
  s.close();
});

test('a retry carries the last REVIEWED run with work, not a canceled run that never reached review', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  const reviewed = s.startRun(t.id).id;
  s.addArtifact({ runId: reviewed, taskId: t.id, type: 'diff', path: '/tmp/x.diff', summary: '1 file' });
  s.addVerdict({ runId: reviewed, taskId: t.id, verdict: 'pass', disagreement: false, council: [] });
  s.endRun(reviewed, 'succeeded', { exitCode: 0, summary: 'ok' });
  const canceled = s.startRun(t.id).id; // a fresh rerun canceled before review
  s.addArtifact({ runId: canceled, taskId: t.id, type: 'diff', path: '/tmp/y.diff', summary: '0 files' });
  s.endRun(canceled, 'canceled', { exitCode: null, summary: 'canceled' });
  s.setStatus(t.id, 'canceled');
  s.retry(t.id);
  assert.equal(s.carryRun(t.id), reviewed);
  s.clearCarryRun(t.id);
  assert.equal(s.carryRun(t.id), null, 'one-shot');
  s.close();
});

test("a retry note leads the repair notes, keeps the critique, and binds every reviewer as an operator demand", () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  const run = s.startRun(t.id).id;
  s.addVerdict({ runId: run, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique: 'FAIL: report the live checks' });
  s.setStatus(t.id, 'failed', 'review said no');
  s.retry(t.id, '  the operator ran the live checks; they passed  ');
  const after = s.getTask(t.id)!;
  assert.match(after.repairNotes ?? '', /^OPERATOR NOTE on this retry[^\n]*\nthe operator ran the live checks; they passed\n\n[\s\S]*FAIL: report the live checks/);
  assert.match(after.operatorDemands ?? '', /Operator note on retry: the operator ran the live checks; they passed/);
  s.close();
});

test('a retry without a note leaves the operator demands alone', () => {
  const s = store();
  const t = s.addTask({ title: 't', prompt: 't', runner: 'echo' });
  s.setStatus(t.id, 'failed', 'x');
  s.retry(t.id, '   ');
  assert.equal(s.getTask(t.id)!.operatorDemands, null);
  assert.doesNotMatch(s.getTask(t.id)!.repairNotes ?? '', /OPERATOR NOTE/);
  s.close();
});

test('reopen puts a review-failed ticket back at the human gate with its work, and revives what the failure killed', () => {
  const s = store();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-reopen-'));
  try {
    const a = s.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
    const b = s.addTask({ title: 'b', prompt: 'b', runner: 'echo', deps: [a.id] });
    const run = s.startRun(a.id).id;
    s.setRunMeta(run, { worktreePath: wt });
    s.addVerdict({ runId: run, taskId: a.id, verdict: 'fail', disagreement: false, council: [], critique: 'no live report' });
    s.setStatus(a.id, 'failed', 'review said no');
    s.reconcileBlocked();
    assert.equal(s.getTask(b.id)!.status, 'failed');
    const t = s.reopen(a.id, 'I ran the live checks');
    assert.equal(t.status, 'awaiting-approval');
    assert.match(t.error ?? '', /reopened by the operator: I ran the live checks/);
    assert.equal(s.getTask(b.id)!.status, 'blocked', 'it waits on the operator decision');
  } finally {
    s.close();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('reopen refuses what is not a review failure with work left to decide on', () => {
  const s = store();
  const live = s.addTask({ title: 'q', prompt: 'q', runner: 'echo' });
  assert.throws(() => s.reopen(live.id), /only a failed task can be reopened/);
  const crashed = s.addTask({ title: 'c', prompt: 'c', runner: 'echo' });
  s.startRun(crashed.id);
  s.setStatus(crashed.id, 'failed', 'runner crashed');
  assert.throws(() => s.reopen(crashed.id), /did not fail review/);
  const gone = s.addTask({ title: 'g', prompt: 'g', runner: 'echo' });
  const run = s.startRun(gone.id).id;
  s.setRunMeta(run, { worktreePath: path.join(os.tmpdir(), 'foreman-no-such-worktree-xyz') });
  s.addVerdict({ runId: run, taskId: gone.id, verdict: 'fail', disagreement: false, council: [], critique: 'x' });
  s.setStatus(gone.id, 'failed', 'review said no');
  assert.throws(() => s.reopen(gone.id), /worktree is gone/);
  assert.equal(s.getTask(gone.id)!.status, 'failed');
  s.close();
});

test('claimable pages by key in exactly the order of the plain sorted query, skipping held rows', () => {
  const s = new Store(':memory:');
  try {
    const ids: string[] = [];
    for (let i = 0; i < 260; i++) {
      ids.push(s.addTask({ title: `t${i}`, prompt: 'x', runner: 'echo', priority: i % 4, repo: i % 3 === 0 ? '/held' : null } as never).id);
    }
    // Ties on created_at across page boundaries: rowid must break them identically.
    s.db.prepare('UPDATE tasks SET created_at = 1000 + (rowid % 7)').run();
    const usable = (t: { repo: string | null }): boolean => t.repo !== '/held';
    const want = (s.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority DESC, created_at ASC, rowid ASC").all() as Array<Record<string, unknown>>)
      .filter((r) => usable({ repo: r['repo'] == null ? null : String(r['repo']) }))
      .map((r) => String(r['id']));
    for (const limit of [1, 7, 50, 120, 400]) {
      assert.deepEqual(s.claimable(limit, { usable }).map((t) => t.id), want.slice(0, limit), `limit ${limit}`);
    }
  } finally {
    s.close();
  }
});

// The ledger's own records of what `foreman debrief` used to guess: one `decisions` row per approve / reject /
// cancel / retry / reopen, a `decision` line on the timeline, and what a run records about itself when it ends.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.ts';
import { boundBrief, collectBriefCuts } from '../src/context.ts';
import { briefCutCount, classifyGate, collectDebrief, openLedgerReadOnly, renderMarkdown, type DebriefReport } from '../src/debrief.ts';
import { applyApproval, applyRejection, ownerGate } from '../src/gate.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { reloadSpecs } from '../src/models.ts';
import { clearPlaybookCache } from '../src/playbooks.ts';
import { DECISION_NOTE_MAX_BYTES, Store, boundDecisionNote } from '../src/queue.ts';
import { RunClock } from '../src/runClock.ts';
import { endedReason, newRunFacts } from '../src/runFacts.ts';
import { claudeCodeSpec, handleCliLine, initialCliState, resetPreflightCache, turnLimitOf } from '../src/runners/cliRunners.ts';
import type { RunnerContext } from '../src/runners/index.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import type { Decision, Run, Task } from '../src/types.ts';
import { NOTHING_TO_CHANGE_CLOSED } from '../src/verify/gateOutcome.ts';
import { FakeTime } from './fakeclock.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous freeze guard: nothing here asserts on wall time. */
async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

function repo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A shell ticket the scheduler ran and parked at the gate, with its reviewed tree on the run. */
async function reviewed(opts: { prompt?: string; over?: Partial<Parameters<Store['addTask']>[0]> } = {}) {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo({ 'a.txt': 'one\n' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const t = store.addTask({
    title: 'ticket', prompt: opts.prompt ?? "printf 'TICKET\\n' > a.txt; printf 'new\\n' > new.txt", kind: 'code', runner: 'shell',
    repo: dir, testCmd: 'test -f a.txt', maxAttempts: 1, ...(opts.over ?? {}),
  });
  await sched.drain(60_000);
  const task = store.getTask(t.id)!;
  const run = store.latestRun(t.id)!;
  const done = async (): Promise<void> => {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    await sched.stop();
    store.close();
  };
  return { dir, store, sched, task, run, jail: run.worktreePath!, done };
}

/** A ticket parked at the gate with no repo: enough for every path that does not merge. */
function parked(store: Store, over: Partial<Parameters<Store['addTask']>[0]> = {}): { task: Task; run: Run } {
  const task = store.addTask({ title: 'Add token auth', prompt: 'Add bearer-token auth.', kind: 'code', runner: 'echo', ...over });
  const started = store.startRun(task.id);
  store.setTestsPassed(started.id, true);
  store.addVerdict({ runId: started.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], critique: 'read' });
  store.endRun(started.id, 'succeeded', { exitCode: 0, summary: 'added the middleware' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, run: store.getRun(started.id)! };
}

const rows = (store: Store, taskId: string): Decision[] => store.decisionsForTask(taskId);
const decisionEvents = (store: Store, taskId: string): string[] =>
  store.eventsForTask(taskId, 100_000).filter((e) => e.type === 'decision').map((e) => e.message);
const fact = (store: Store, scope: string, taskId: string) =>
  store.recallFacts(scope, 200).find((f) => f.key === `preference:${taskId}`) ?? null;

// ------------------------------------------------------------- approvals

test('an approval that merges writes one row: the trees, merged, the merge reason, corrected NULL when nothing is stated', async () => {
  const f = await reviewed();
  try {
    const out = await applyApproval(f.store, f.task.id, { note: 'looks right; landed' });
    assert.equal(out.merge.merged, true, out.merge.reason);
    const all = rows(f.store, f.task.id);
    assert.equal(all.length, 1, 'exactly one row');
    const d = all[0]!;
    assert.equal(d.action, 'approve');
    assert.equal(d.actor, 'human');
    assert.equal(d.runId, f.run.id);
    assert.equal(d.note, 'looks right; landed');
    assert.equal(d.statusAfter, 'done');
    assert.equal(d.merged, true);
    assert.match(d.mergeReason ?? '', /^merged 1 commit\(s\) from /);
    assert.equal(d.asIs, false);
    assert.equal(d.reviewedTree, f.run.reviewedTree);
    assert.equal(d.landedTree, git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), 'the tree read back from git after the merge');
    assert.equal(d.landedTree, d.reviewedTree);
    assert.equal(d.corrected, null, 'not stated: never inferred');
    assert.equal(d.correctedSource, null);
    assert.equal(out.decision?.id, d.id, 'the approval hands its row back');
    // The table holds 0/1/NULL, countable without reading prose.
    const raw = f.store.db.prepare('SELECT corrected, as_is, merged FROM decisions WHERE id = ?').get(d.id) as Record<string, unknown>;
    assert.deepEqual({ ...raw }, { corrected: null, as_is: 0, merged: 1 });
    assert.deepEqual(decisionEvents(f.store, f.task.id), ['approve by human; corrected: not stated — looks right; landed']);
    // The memory fact is what main writes for the same input: value, confidence, source, scope.
    const pref = fact(f.store, f.dir, f.task.id)!;
    assert.equal(pref.value, 'approved "ticket" — looks right; landed');
    assert.equal(pref.confidence, 0.6);
    assert.equal(pref.source, f.task.id);
  } finally {
    await f.done();
  }
});

test('a note that only SOUNDS like a correction leaves corrected NULL: wording is never read at write time', async () => {
  const f = await reviewed();
  try {
    await applyApproval(f.store, f.task.id, { note: 'approve + on-top corrections, landed by hand' });
    assert.equal(rows(f.store, f.task.id)[0]!.corrected, null);
  } finally {
    await f.done();
  }
});

test('--corrected and --clean are recorded as stated, as true and false', async () => {
  for (const [stated, source] of [[true, 'operator'], [false, 'operator']] as const) {
    const f = await reviewed();
    try {
      await applyApproval(f.store, f.task.id, { corrected: stated, reviewSource: 'independent reviewer, verify 3040/0/1' });
      const d = rows(f.store, f.task.id)[0]!;
      assert.equal(d.corrected, stated);
      assert.equal(d.correctedSource, source);
      assert.equal(d.reviewSource, 'independent reviewer, verify 3040/0/1');
      assert.equal(d.note, null, 'no note was given');
      assert.equal(fact(f.store, f.dir, f.task.id), null, 'a bare approval still writes no memory fact, as on main');
      assert.deepEqual(decisionEvents(f.store, f.task.id), [`approve by human; corrected: ${stated ? 'yes' : 'no'}`]);
    } finally {
      await f.done();
    }
  }
});

test('--as-is landing another tree is corrected by definition, with both trees, whatever was stated; each refused attempt is its own row', async () => {
  const f = await reviewed();
  try {
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'the operator wrote this by hand\n');
    const refused = await applyApproval(f.store, f.task.id, {});
    const now = /--as-is ([0-9a-f]{40})$/.exec(refused.merge.reason)?.[1] ?? '';
    assert.match(now, /^[0-9a-f]{40}$/, refused.merge.reason);
    const first = rows(f.store, f.task.id);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.merged, false);
    assert.equal(first[0]!.statusAfter, 'awaiting-approval', 'the refused approval is recorded as leaving the ticket parked');
    assert.match(first[0]!.mergeReason ?? '', /^work changed after review/);
    assert.equal(first[0]!.landedTree, null, 'nothing merged, nothing landed');
    assert.equal(first[0]!.corrected, null);

    // The operator says --clean; the trees say otherwise, and the trees win.
    const out = await applyApproval(f.store, f.task.id, { acceptTree: now, corrected: false, note: 'my own edit' });
    assert.equal(out.merge.merged, true, out.merge.reason);
    const all = rows(f.store, f.task.id);
    assert.equal(all.length, 2);
    const d = all[1]!;
    assert.equal(d.asIs, true);
    assert.equal(d.reviewedTree, f.run.reviewedTree);
    assert.equal(d.landedTree, now);
    assert.notEqual(d.landedTree, d.reviewedTree);
    assert.equal(d.corrected, true);
    assert.equal(d.correctedSource, 'trees');
    assert.deepEqual(d.extra, { stated: 'clean' }, 'what the operator said is kept beside what the trees show');
    assert.equal(d.statusAfter, 'done');
    // The first row is exactly as it was written.
    assert.deepEqual(rows(f.store, f.task.id)[0], first[0]);
  } finally {
    await f.done();
  }
});

test('an --as-is approval naming the reviewed tree itself is not a correction: the flag, or NULL, decides', async () => {
  const f = await reviewed();
  try {
    const out = await applyApproval(f.store, f.task.id, { acceptTree: f.run.reviewedTree!, corrected: true });
    assert.equal(out.merge.merged, true, out.merge.reason);
    const d = rows(f.store, f.task.id)[0]!;
    assert.equal(d.asIs, true);
    assert.equal(d.landedTree, d.reviewedTree);
    assert.equal(d.corrected, true);
    assert.equal(d.correctedSource, 'operator', 'from the statement, not from the trees: they are the same tree');
  } finally {
    await f.done();
  }
});

test('an approval that closes a run which changed nothing records the closing reason and no landed tree', async () => {
  const f = await reviewed({ prompt: 'true' });
  try {
    assert.equal(f.task.status, 'awaiting-approval', f.task.error ?? '');
    const out = await applyApproval(f.store, f.task.id, { corrected: false });
    assert.equal(out.merge.reason, NOTHING_TO_CHANGE_CLOSED);
    const all = rows(f.store, f.task.id);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.merged, false);
    assert.equal(all[0]!.mergeReason, 'closed: nothing to change');
    assert.equal(all[0]!.landedTree, null);
    assert.equal(all[0]!.statusAfter, 'done');
    assert.equal(all[0]!.corrected, false);
  } finally {
    await f.done();
  }
});

test('an approval of a ticket that does not merge on approval records merged 0 with that reason', async () => {
  const f = await reviewed({ over: { mergeOnApprove: false } });
  try {
    const head = git(f.dir, 'rev-parse', 'HEAD');
    const out = await applyApproval(f.store, f.task.id, { note: 'read it' });
    assert.equal(out.merge.merged, false);
    const all = rows(f.store, f.task.id);
    assert.equal(all.length, 1);
    assert.match(all[0]!.mergeReason ?? '', /^merge-on-approve disabled/);
    assert.equal(all[0]!.merged, false);
    assert.equal(all[0]!.landedTree, null);
    assert.equal(all[0]!.reviewedTree, f.run.reviewedTree);
    assert.equal(all[0]!.statusAfter, 'done');
    assert.equal(git(f.dir, 'rev-parse', 'HEAD'), head);
  } finally {
    await f.done();
  }
});

test('a ticket finished on the operator\'s own desk is an approval of no run', async () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'by hand', prompt: 'p', runner: 'echo', assignee: 'human' });
    assert.equal(store.getTask(t.id)!.status, 'awaiting-human');
    await applyApproval(store, t.id, { note: 'completed by the operator' });
    const d = rows(store, t.id);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.runId, null);
    assert.equal(d[0]!.reviewedTree, null);
    assert.equal(d[0]!.statusAfter, 'done');
  } finally {
    store.close();
  }
});

test('an approval of a ticket that is not at the gate decides nothing and records nothing', async () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'queued', prompt: 'p', runner: 'echo' });
    await assert.rejects(() => applyApproval(store, t.id, { corrected: true }), /not awaiting-approval/);
    assert.equal(rows(store, t.id).length, 0);
    assert.deepEqual(decisionEvents(store, t.id), []);
  } finally {
    store.close();
  }
});

// ------------------------------------------- reject, cancel, retry, reopen

test('a rejection writes one row with its note, and the memory fact main writes', () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    applyRejection(store, task.id, 'too long; split it');
    const all = rows(store, task.id);
    assert.equal(all.length, 1);
    assert.deepEqual(
      { action: all[0]!.action, actor: all[0]!.actor, runId: all[0]!.runId, note: all[0]!.note, statusAfter: all[0]!.statusAfter, corrected: all[0]!.corrected, merged: all[0]!.merged, asIs: all[0]!.asIs },
      { action: 'reject', actor: 'human', runId: run.id, note: 'too long; split it', statusAfter: 'rejected', corrected: null, merged: null, asIs: null },
    );
    assert.deepEqual(decisionEvents(store, task.id), ['reject by human — too long; split it']);
    const pref = fact(store, 'global', task.id)!;
    assert.equal(pref.value, 'rejected "Add token auth" — too long; split it. Do not repeat this.');
    assert.equal(pref.confidence, 0.75);
    assert.equal(pref.source, task.id);
  } finally {
    store.close();
  }
});

test('a cancel writes one row, with its note when one is given and none when not; the status note is unchanged', () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    store.cancel(task.id, 'superseded by t_other');
    const d = rows(store, task.id);
    assert.equal(d.length, 1);
    assert.deepEqual(
      { action: d[0]!.action, actor: d[0]!.actor, note: d[0]!.note, runId: d[0]!.runId, statusAfter: d[0]!.statusAfter, extra: d[0]!.extra },
      { action: 'cancel', actor: 'human', note: 'superseded by t_other', runId: run.id, statusAfter: 'canceled', extra: { statusBefore: 'awaiting-approval' } },
    );
    assert.equal(store.getTask(task.id)!.error, 'canceled by operator', 'the fixed sentence other code matches on');
    assert.deepEqual(decisionEvents(store, task.id), ['cancel by human — superseded by t_other']);

    const bare = store.addTask({ title: 'queued one', prompt: 'p', runner: 'echo' });
    store.cancel(bare.id);
    const b = rows(store, bare.id);
    assert.equal(b.length, 1);
    assert.equal(b[0]!.note, null);
    assert.equal(b[0]!.runId, null);
    assert.deepEqual(decisionEvents(store, bare.id), ['cancel by human']);
    // An already-ended task: refused as before, and nothing recorded.
    assert.throws(() => store.cancel(bare.id, 'again'), /already canceled/);
    assert.equal(rows(store, bare.id).length, 1);
  } finally {
    store.close();
  }
});

test('a cancel still reaches its worker when the ledger cannot take the row', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'running', prompt: 'p', runner: 'echo' });
    const heard: string[] = [];
    store.on('cancel', (id: string) => heard.push(id));
    store.db.exec('DROP TRIGGER decisions_no_update; DROP TRIGGER decisions_no_delete; DROP TABLE decisions');
    const after = store.cancel(t.id, 'why');
    assert.equal(after.status, 'canceled');
    assert.deepEqual(heard, [t.id], 'the abort was still sent');
    assert.ok(store.eventsForTask(t.id).some((e) => e.type === 'error' && /^decision not recorded \(cancel\)/.test(e.message)), 'and the gap is said on the timeline');
  } finally {
    store.close();
  }
});

test('cancelling an epic records the person\'s cancel on it and a system cancel on each ticket it took down', () => {
  const store = new Store(':memory:');
  try {
    const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo', isEpic: true });
    const a = store.addTask({ title: 'a', prompt: 'p', runner: 'echo', parentId: epic.id });
    const b = store.addTask({ title: 'b', prompt: 'p', runner: 'echo', parentId: epic.id });
    store.cancel(b.id);
    store.cancel(epic.id, 'the ask changed');
    assert.deepEqual(rows(store, epic.id).map((d) => [d.actor, d.note]), [['human', 'the ask changed']]);
    assert.deepEqual(rows(store, a.id).map((d) => [d.action, d.actor, d.note]), [['cancel', 'system', `parent ${epic.id} was canceled`]]);
    assert.deepEqual(rows(store, b.id).map((d) => d.actor), ['human'], 'a ticket already canceled gets no second row');
  } finally {
    store.close();
  }
});

test('a retry writes one row, with its note and with the skills it was given', () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    applyRejection(store, task.id, 'no');
    store.retry(task.id, 'I ran the browser checks myself');
    let d = rows(store, task.id).filter((r) => r.action === 'retry');
    assert.equal(d.length, 1);
    assert.deepEqual(
      { actor: d[0]!.actor, note: d[0]!.note, runId: d[0]!.runId, statusAfter: d[0]!.statusAfter, extra: d[0]!.extra },
      { actor: 'human', note: 'I ran the browser checks myself', runId: run.id, statusAfter: 'queued', extra: null },
    );
    // The demands the note joins are written exactly as before.
    assert.match(store.getTask(task.id)!.operatorDemands ?? '', /Operator note on retry: I ran the browser checks myself$/);

    store.cancel(task.id);
    store.retry(task.id, null, { skills: ['test-first'] });
    d = rows(store, task.id).filter((r) => r.action === 'retry');
    assert.equal(d.length, 2);
    assert.equal(d[1]!.note, null);
    assert.deepEqual(d[1]!.extra, { skills: ['test-first'] });
    assert.equal(rows(store, task.id).length, 4, 'reject, retry, cancel, retry: one row each');
  } finally {
    store.close();
  }
});

test('a reopen writes one row with its note', () => {
  const store = new Store(':memory:');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-reopen-'));
  try {
    const task = store.addTask({ title: 'failed review', prompt: 'p', runner: 'echo' });
    const run = store.startRun(task.id);
    store.setRunMeta(run.id, { worktreePath: work, branch: 'b' });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [], critique: 'no live check' });
    store.endRun(run.id, 'failed', { exitCode: 1, summary: 's' });
    store.setStatus(task.id, 'failed', 'no live check');
    store.reopen(task.id, 'I ran the live checks: pass');
    const d = rows(store, task.id);
    assert.equal(d.length, 1);
    assert.deepEqual(
      { action: d[0]!.action, actor: d[0]!.actor, note: d[0]!.note, runId: d[0]!.runId, statusAfter: d[0]!.statusAfter },
      { action: 'reopen', actor: 'human', note: 'I ran the live checks: pass', runId: run.id, statusAfter: 'awaiting-approval' },
    );
    // A reopen that is refused records nothing.
    const other = store.addTask({ title: 'queued', prompt: 'p', runner: 'echo' });
    assert.throws(() => store.reopen(other.id, 'x'), /only a failed task can be reopened/);
    assert.equal(rows(store, other.id).length, 0);
  } finally {
    store.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- the owner gate

const AUTO = `---\n${JSON.stringify({
  id: 'auto', description: 'Autonomous delivery.', triggers: ['auto'],
  roles: { planner: { tier: 'owner' }, dev: { tier: 'worker' } }, reviewers: [],
  escalation: { chair: 'planner', afterFailures: 2 }, checks: [],
  gate: { default: 'owner', hardHuman: ['S2', 'budget', 'allowCore'] }, constraints: [],
}, null, 2)}\n---\n\n## role: planner\n\nYou decompose the ask.\n\n## role: dev\n\nYou implement the ticket.\n`;

/** A stand-in claude CLI that answers the owner gate with `reply`, and a playbook whose gate is the owner's. */
function ownerRig(decision: string, rationale: string): { cleanup: () => void } {
  const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-pb-'));
  fs.writeFileSync(path.join(pbDir, 'auto.md'), AUTO);
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  clearPlaybookCache();
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-cli-'));
  const bin = path.join(cliDir, 'claude');
  const body = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, result: JSON.stringify({ decision, rationale }) });
  fs.writeFileSync(path.join(cliDir, 'body'), body);
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(cliDir, 'body')}"\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  return {
    cleanup: () => {
      delete process.env['FOREMAN_PLAYBOOKS_DIR'];
      delete process.env['FOREMAN_CLAUDE_BIN'];
      clearPlaybookCache();
      fs.rmSync(pbDir, { recursive: true, force: true });
      fs.rmSync(cliDir, { recursive: true, force: true });
    },
  };
}

test('an owner-model approval is one row by owner-model, corrected NULL; its memory fact is main\'s', async () => {
  const rig = ownerRig('approve', 'the diff matches the ticket');
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store, { playbook: 'auto', role: 'dev', acceptance: 'requests without a token get 401' });
    assert.equal(await ownerGate({ task, run, store }), 'approved');
    const d = rows(store, task.id);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.action, 'approve');
    assert.equal(d[0]!.actor, 'owner-model');
    assert.equal(d[0]!.runId, run.id);
    assert.equal(d[0]!.note, 'owner-gate: the diff matches the ticket');
    assert.equal(d[0]!.corrected, null);
    assert.equal(d[0]!.asIs, false);
    assert.equal(d[0]!.statusAfter, 'done');
    const pref = fact(store, 'global', task.id)!;
    assert.equal(pref.value, 'the owner gate (not the operator) approved "Add token auth" — owner-gate: the diff matches the ticket');
    assert.equal(pref.confidence, 0.6 - 0.2, "main's own arithmetic for an owner-gate approval");
    assert.equal(pref.source, `owner-gate:${task.id}`);
  } finally {
    store.close();
    rig.cleanup();
  }
});

test('an owner-model approval cannot state a correction or a verifier: only a person can', async () => {
  const store = new Store(':memory:');
  try {
    const { task } = parked(store);
    await applyApproval(store, task.id, { source: 'owner-gate', corrected: true, reviewSource: 'me', note: 'owner-gate: fine' });
    const d = rows(store, task.id)[0]!;
    assert.equal(d.actor, 'owner-model');
    assert.equal(d.corrected, null);
    assert.equal(d.reviewSource, null);
  } finally {
    store.close();
  }
});

test('an owner-model rejection is one row by owner-model', async () => {
  const rig = ownerRig('reject', 'it edits three files the ticket never mentioned');
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store, { playbook: 'auto', role: 'dev' });
    assert.equal(await ownerGate({ task, run, store }), 'rejected');
    const d = rows(store, task.id);
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]!.action, d[0]!.actor, d[0]!.statusAfter], ['reject', 'owner-model', 'rejected']);
    assert.match(d[0]!.note ?? '', /^owner-gate: it edits three files/);
  } finally {
    store.close();
    rig.cleanup();
  }
});

test('an owner-model HOLD is not a decision: no row and no decision event, only its own timeline line', async () => {
  const rig = ownerRig('hold', 'the acceptance is ambiguous');
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store, { playbook: 'auto', role: 'dev' });
    assert.equal(await ownerGate({ task, run, store }), 'hold');
    assert.equal(rows(store, task.id).length, 0);
    assert.deepEqual(decisionEvents(store, task.id), []);
    assert.ok(store.eventsForTask(task.id).some((e) => e.type === 'status' && /^owner-gate: hold — the acceptance is ambiguous/.test(e.message)));
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  } finally {
    store.close();
    rig.cleanup();
  }
});

// -------------------------------------------------- the table and its rows

test('a decision row is never updated or deleted, and outlives its ticket', async () => {
  const store = new Store(':memory:');
  try {
    const { task } = parked(store);
    applyRejection(store, task.id, 'first');
    const before = rows(store, task.id);
    assert.throws(() => store.db.prepare("UPDATE decisions SET note = 'rewritten' WHERE task_id = ?").run(task.id), /append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM decisions WHERE task_id = ?').run(task.id), /append-only/);
    // Every later decision path on the same ticket, and the housekeeping that deletes other rows.
    store.retry(task.id, 'again');
    store.cancel(task.id, 'never mind');
    store.pruneLedgers(0);
    assert.deepEqual(rows(store, task.id)[0], before[0], 'the first row is as it was written');
    assert.equal(rows(store, task.id).length, 3);
    store.deleteTask(task.id);
    assert.equal(store.getTask(task.id), null);
    assert.equal(rows(store, task.id).length, 3, 'deleting the ticket leaves its decisions');
  } finally {
    store.close();
  }
});

test('a note over 16 KB is stored cut, with a marker that says how much went; a short one is stored whole', () => {
  const store = new Store(':memory:');
  try {
    const { task } = parked(store);
    const long = `${'é'.repeat(20_000)}\nTAIL`;
    applyRejection(store, task.id, long);
    const d = rows(store, task.id)[0]!;
    const size = Buffer.byteLength(long, 'utf8');
    assert.ok(Buffer.byteLength(d.note!, 'utf8') <= DECISION_NOTE_MAX_BYTES, `${Buffer.byteLength(d.note!, 'utf8')} bytes stored`);
    assert.match(d.note!, /… \[FOREMAN cut this note here: \d+ more bytes were NOT stored\]$/);
    assert.equal(d.noteCutBytes, Number(/(\d+) more bytes/.exec(d.note!)![1]));
    const keptBytes = Buffer.byteLength(d.note!.slice(0, d.note!.indexOf('\n… [FOREMAN')), 'utf8');
    assert.equal(keptBytes + d.noteCutBytes, size, 'kept + cut is the whole note');
    assert.ok(!d.note!.includes('�'), 'no character was cut in half');
    assert.ok(decisionEvents(store, task.id)[0]!.length < 400, 'the timeline carries the short form only');
    // At the bound exactly: whole.
    const exact = 'x'.repeat(DECISION_NOTE_MAX_BYTES);
    assert.deepEqual(boundDecisionNote(exact), { note: exact, cut: 0 });
    assert.deepEqual(boundDecisionNote('   '), { note: null, cut: 0 });
  } finally {
    store.close();
  }
});

test('an unknown action or actor is refused by the store', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 't', prompt: 'p', runner: 'echo' });
    assert.throws(() => store.addDecision({ taskId: t.id, action: 'hold' as never }), /unknown decision action/);
    assert.throws(() => store.addDecision({ taskId: t.id, action: 'approve', actor: 'owner-gate' as never }), /unknown decision actor/);
    assert.equal(rows(store, t.id).length, 0);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- pruning

test('the decision and skills events survive the end-of-run prune that drops ordinary lines', async () => {
  const cap = config as { logLinesPerRun: number };
  const lines = cap.logLinesPerRun;
  cap.logLinesPerRun = 3;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({ title: 'pruned', prompt: 'x', runner: 'echo', maxAttempts: 3 });
    await sched.drain(60_000);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    store.record({ taskId: t.id, runId: store.latestRun(t.id)!.id, type: 'skills', message: '{"role":"soft.dev","skills":["test-first"]}' });
    store.record({ taskId: t.id, type: 'log', message: 'an ordinary line from before the retry' });
    applyRejection(store, t.id, 'not like that');
    store.retry(t.id, 'do it the other way');
    await sched.drain(60_000);
    const left = store.eventsForTask(t.id, 100_000);
    assert.ok(left.length <= 3 + 3, `the prune ran: ${left.length} events left`);
    assert.ok(!left.some((e) => e.message === 'an ordinary line from before the retry'), 'an ordinary old line is gone');
    assert.deepEqual(
      left.filter((e) => e.type === 'decision').map((e) => e.message),
      ['reject by human — not like that', 'retry by human — do it the other way'],
    );
    assert.equal(left.filter((e) => e.type === 'skills').length, 1, 'the run-start skills line is kept');
  } finally {
    cap.logLinesPerRun = lines;
    await sched.stop();
    store.close();
  }
});

// ------------------------------------------------------------ run columns

/** A stand-in `claude` that records its `-p` prompt, replays `transcript` and exits with `code`. */
function fakeClaude(transcript: string[], code: number, opts: { block?: boolean } = {}): { dir: string; bin: string; prompt: () => string; release: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-claude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(path.join(dir, 'transcript'), transcript.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'case "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac',
    `while [ $# -gt 0 ]; do if [ "$1" = "-p" ]; then printf '%s' "$2" > "${path.join(dir, 'prompt')}"; fi; shift; done`,
    `cat "${path.join(dir, 'transcript')}"`,
    ...(opts.block ? [`while [ ! -f "${path.join(dir, 'release')}" ]; do sleep 0.1; done`] : []),
    `exit ${code}`,
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return {
    dir, bin,
    prompt: () => fs.readFileSync(path.join(dir, 'prompt'), 'utf8'),
    release: () => fs.writeFileSync(path.join(dir, 'release'), ''),
  };
}

async function withClaude<T>(bin: string, args: string | undefined, fn: () => Promise<T>): Promise<T> {
  const keys = ['FOREMAN_CLAUDE_BIN', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_CLAUDE_ARGS', 'FOREMAN_LIMIT_BACKOFF_MS'] as const;
  const prev = keys.map((k) => process.env[k]);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  process.env['FOREMAN_LOCAL_ONLY'] = 'off';
  process.env['FOREMAN_LIMIT_BACKOFF_MS'] = '60000';
  if (args === undefined) delete process.env['FOREMAN_CLAUDE_ARGS'];
  else process.env['FOREMAN_CLAUDE_ARGS'] = args;
  setCloudDown(null);
  reloadSpecs();
  resetPreflightCache();
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
    setCloudDown(null);
    reloadSpecs();
    resetPreflightCache();
  }
}

const assistant = (id: string, block: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: 5 }, content: [block] } });
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });
const runRow = (store: Store, taskId: string): Run | undefined => store.runsForTask(taskId).at(-1);

test('a claude-code run that ends ok records its turns (both counts), the ceiling, the brief, its cuts and the report size', async () => {
  const report = `DONE. ${'é'.repeat(5000)}\nACCEPTANCE MAP\n1. (review)`;
  const cli = fakeClaude([
    INIT,
    // One model response written as two stream events (one per content block), then a second response.
    assistant('msg_1', { type: 'text', text: 'reading the ticket' }),
    assistant('msg_1', { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }),
    assistant('msg_2', { type: 'text', text: 'writing the report' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 5, session_id: 's-1', result: report }),
  ], 0);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    await withClaude(cli.bin, '--max-turns 7', async () => {
      const acceptance = Array.from({ length: 400 }, (_, i) => `${i + 1}. acceptance line number ${i + 1} which is fairly long`).join('\n');
      assert.ok(acceptance.length > config.acceptanceBytes, 'the fixture is over the acceptance bound');
      const t = store.addTask({ title: 'ok run', prompt: 'do the thing', runner: 'claude-code', maxAttempts: 1, acceptance });
      await sched.drain(120_000);
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
      const r = runRow(store, t.id)!;
      assert.equal(r.endedReason, 'ok');
      assert.equal(r.turns, 2, 'two model responses, though three assistant events were streamed');
      assert.equal(r.turnsReported, 5, "the CLI's own num_turns, kept beside it");
      assert.equal(r.turnLimit, 7);
      assert.equal(r.reportBytes, Buffer.byteLength(report, 'utf8'), 'the whole report, before the 4000-character summary cut');
      assert.ok((r.summary ?? '').length < report.length, 'the stored summary was cut, which is why the size is recorded');
      assert.equal(r.briefBytes, Buffer.byteLength(cli.prompt(), 'utf8'), 'the size of the brief the worker was actually handed');
      assert.deepEqual(r.briefCuts!.map((c) => [c.section, c.limit, c.before]), [['acceptance', config.acceptanceBytes, acceptance.length]]);
      assert.ok(r.briefCuts![0]!.cut > 0 && r.briefCuts![0]!.cut < acceptance.length);
      // A brief with nothing over its bounds records an empty list, not NULL.
      const small = store.addTask({ title: 'small', prompt: 'do the thing', runner: 'claude-code', maxAttempts: 1, acceptance: '1. it works' });
      await sched.drain(120_000);
      assert.deepEqual(runRow(store, small.id)!.briefCuts, []);
    });
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(cli.dir, { recursive: true, force: true });
  }
});

test('a claude-code run that stops on its turn ceiling records turn-ceiling and the ceiling', async () => {
  const cli = fakeClaude([
    INIT,
    assistant('msg_1', { type: 'text', text: 'Now converting to the curly quotes' }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 4, session_id: 's-1' }),
  ], 1);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    await withClaude(cli.bin, '--max-turns 3', async () => {
      const t = store.addTask({ title: 'ceiling', prompt: 'x', runner: 'claude-code', maxAttempts: 1, maxRepairs: 0 });
      await sched.drain(120_000);
      assert.equal(store.getTask(t.id)!.status, 'failed');
      const r = runRow(store, t.id)!;
      assert.equal(r.endedReason, 'turn-ceiling');
      assert.equal(r.turnLimit, 3);
      assert.equal(r.turns, 1);
      assert.equal(r.turnsReported, 4);
    });
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(cli.dir, { recursive: true, force: true });
  }
});

test('a claude-code run refused by the provider limit records provider-limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-limit-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\necho "You've hit your session limit · resets 4:30pm (Europe/London)"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    await withClaude(bin, undefined, async () => {
      const t = store.addTask({ title: 'limited', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
      const end = Date.now() + 120_000;
      while (!(runRow(store, t.id)?.endedAt && store.getTask(t.id)!.status === 'queued' && sched.limitHoldUntil > 0)) {
        if (Date.now() > end) throw new Error('timed out waiting for the limit hold');
        await sched.tick();
        await sleep(20);
      }
      await until(() => runRow(store, t.id)?.endedReason != null, 'the run facts');
      const r = runRow(store, t.id)!;
      assert.equal(r.endedReason, 'provider-limit');
      assert.equal(r.turns, 0, 'no model response was seen');
      assert.equal(r.turnLimit, null, 'no ceiling was passed to this run');
    });
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a claude-code run stopped by its own deadline records deadline', { timeout: 180_000 }, async () => {
  const cli = fakeClaude([INIT, assistant('msg_1', { type: 'text', text: 'still working' })], 0, { block: true });
  const time = new FakeTime();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, verifyEnabled: false, maxWorkers: 1, taskTimeoutMs: 60 * 60_000,
    runClock: (budgetMs, onExpire) => new RunClock(budgetMs, onExpire, time.now, time),
  });
  try {
    await withClaude(cli.bin, '--max-turns 9', async () => {
      const t = store.addTask({ title: 'slow', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
      void sched.tick();
      // The worker has said something, so it is in its turn; then the run's own hour passes on the fake clock.
      await until(() => store.eventsForTask(t.id, 10_000).some((e) => e.type === 'log' && e.message === 'still working'), 'the worker to be mid-turn');
      time.advance(61 * 60_000);
      await until(() => runRow(store, t.id)?.endedReason != null, 'the run to end');
      const r = runRow(store, t.id)!;
      assert.equal(r.endedReason, 'deadline');
      assert.equal(r.status, 'failed', 'a deadline is a timeout, not a cancel');
      assert.equal(r.turnLimit, 9);
      assert.match(store.getTask(t.id)!.error ?? '', /run deadline \(60 min\) reached/);
    });
  } finally {
    cli.release();
    await sched.stop();
    store.close();
    fs.rmSync(cli.dir, { recursive: true, force: true });
  }
});

test('an operator cancel of a running claude-code run records canceled', { timeout: 180_000 }, async () => {
  const cli = fakeClaude([INIT, assistant('msg_1', { type: 'text', text: 'still working' })], 0, { block: true });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    await withClaude(cli.bin, undefined, async () => {
      const t = store.addTask({ title: 'stopped', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
      void sched.tick();
      await until(() => store.eventsForTask(t.id, 10_000).some((e) => e.type === 'log' && e.message === 'still working'), 'the worker to be mid-turn');
      store.cancel(t.id, 'wrong ticket');
      await until(() => runRow(store, t.id)?.endedReason != null, 'the run to end');
      assert.equal(runRow(store, t.id)!.endedReason, 'canceled');
      assert.deepEqual(rows(store, t.id).map((d) => [d.action, d.note, d.runId]), [['cancel', 'wrong ticket', runRow(store, t.id)!.id]]);
    });
  } finally {
    cli.release();
    await sched.stop();
    store.close();
    fs.rmSync(cli.dir, { recursive: true, force: true });
  }
});

test('the stream parser counts distinct model responses and keeps the CLI\'s own num_turns apart', () => {
  const state = initialCliState();
  const ctx = { dir: os.tmpdir(), log() {}, stage() {}, progress() {}, usage() {}, session() {}, child() {} } as unknown as RunnerContext;
  for (const line of [
    assistant('a', { type: 'text', text: 'one' }), assistant('a', { type: 'text', text: 'two' }), assistant('b', { type: 'text', text: 'three' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 11 }),
  ]) handleCliLine(claudeCodeSpec, ctx, state, line, 'stdout');
  assert.equal(state.turns, 4, 'the event count the progress bar uses is unchanged');
  assert.equal(state.responses.size + state.unidentified, 3);
  assert.equal(state.reportedTurns, 11);
  assert.equal(turnLimitOf(['-p', 'x', '--max-turns', '30', '--max-turns', '12']), 12, 'a later flag wins, as in the CLI');
  assert.equal(turnLimitOf(['-p', 'x']), null);
  assert.equal(turnLimitOf(['--max-turns', 'lots']), null);
});

test('how a run ended is one of the recorded words, from what the scheduler already knows', () => {
  const f = (over: Partial<ReturnType<typeof newRunFacts>>) => ({ ...newRunFacts(), ...over });
  assert.equal(endedReason(f({ workerOk: true }), null, 'succeeded'), 'ok');
  assert.equal(endedReason(f({ workerOk: true }), null, 'failed'), 'ok', 'a failed review is not how the run ended: verdict says that');
  assert.equal(endedReason(f({ workerOk: false }), null, 'failed'), 'error');
  assert.equal(endedReason(f({ workerOk: false, endedBy: 'turn-ceiling' }), null, 'failed'), 'turn-ceiling');
  assert.equal(endedReason(f({ workerOk: false, endedBy: 'tripwire' }), null, 'failed'), 'tripwire');
  assert.equal(endedReason(f({ workerOk: true }), 'deadline', 'succeeded'), 'ok', 'a deadline that came during review did not end the run');
  assert.equal(endedReason(f({ workerOk: false, threw: true }), 'deadline', 'failed'), 'deadline');
  assert.equal(endedReason(f({ workerOk: true }), 'cancel', 'canceled'), 'canceled');
  assert.equal(endedReason(f({ threw: true }), 'cancel', 'canceled'), 'canceled');
  assert.equal(endedReason(f({ threw: true, providerLimited: true, workerOk: false }), null, 'failed'), 'provider-limit');
  assert.equal(endedReason(f({ threw: true }), null, 'failed'), 'error');
  assert.equal(endedReason(f({ threw: true, workerOk: true }), 'stop', 'canceled'), null, 'a daemon stop is none of the recorded states');
  assert.equal(endedReason(f({}), null, 'succeeded'), null);
});

// ------------------------------------------------------------- boundBrief

/** boundBrief as it is on main (6a87d08), copied here: the reference its output must match byte for byte. */
function boundBriefOnMain(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const marker = `\n… [FOREMAN cut this section here at ${maxBytes} bytes; the rest was NOT sent]`;
  const budget = maxBytes - marker.length;
  if (budget <= 0) return text.slice(0, maxBytes);
  const cut = text.slice(0, budget);
  const lastNl = cut.lastIndexOf('\n');
  return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}${marker}`;
}

test('boundBrief returns exactly what it did, and reports each cut to the caller that asked', () => {
  const texts = [
    '', 'short', 'x'.repeat(500), Array.from({ length: 80 }, (_, i) => `line ${i} of the notes`).join('\n'),
    `\n${'y'.repeat(300)}`, 'é'.repeat(400), `${'a'.repeat(120)}\n${'b'.repeat(400)}`,
  ];
  const limits = [0, 1, 10, 76, 77, 78, 120, 200, 499, 500, 501, 4000];
  const { value: outputs, cuts } = collectBriefCuts(() => texts.flatMap((t) => limits.map((n) => boundBrief(t, n, 'acceptance'))));
  let i = 0;
  let expectedCuts = 0;
  for (const t of texts) {
    for (const n of limits) {
      const want = boundBriefOnMain(t, n);
      assert.equal(outputs[i], want, `text ${texts.indexOf(t)} at ${n}`);
      assert.equal(boundBrief(t, n), want, 'and with no section named, outside any collection');
      if (t.length > n) expectedCuts++;
      i++;
    }
  }
  assert.equal(cuts.length, expectedCuts, 'one report per cut, none for a text that fit');
  for (const c of cuts) {
    assert.equal(c.section, 'acceptance');
    assert.ok(c.cut > 0 && c.cut <= c.before && c.before > c.limit);
  }
  // What was reported is what was dropped: the kept head plus the cut is the whole text.
  const text = Array.from({ length: 80 }, (_, k) => `line ${k} of the notes`).join('\n');
  const one = collectBriefCuts(() => boundBrief(text, 300, 'repair-notes'));
  const kept = one.value.slice(0, one.value.indexOf('\n… [FOREMAN cut'));
  assert.deepEqual(one.cuts, [{ section: 'repair-notes', limit: 300, before: text.length, cut: text.length - kept.length }]);
  // Unnamed sections are still told apart by their limit; nested collections do not leak into each other.
  const outer = collectBriefCuts(() => {
    boundBrief('z'.repeat(50), 10);
    const inner = collectBriefCuts(() => boundBrief('z'.repeat(50), 20, 'inner'));
    assert.deepEqual(inner.cuts.map((c) => c.section), ['inner']);
    return null;
  });
  assert.deepEqual(outer.cuts.map((c) => c.section), ['limit-10']);
  assert.deepEqual(collectBriefCuts(() => 1).cuts, [], 'nothing is left over from an earlier collection');
});

// -------------------------------------------------------------- migration

const NEW_RUN_COLUMNS = ['turns', 'turns_reported', 'turn_limit', 'ended_reason', 'brief_bytes', 'brief_cuts', 'report_bytes'];

/** Take a ledger back to the schema of main (6a87d08): no decisions table, none of the run columns, no decision events. */
function toBaseSchema(file: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('DROP TRIGGER IF EXISTS decisions_no_update; DROP TRIGGER IF EXISTS decisions_no_delete; DROP INDEX IF EXISTS idx_decisions_task; DROP TABLE IF EXISTS decisions');
    for (const c of NEW_RUN_COLUMNS) raw.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
    raw.exec("DELETE FROM events WHERE type = 'decision'");
  } finally {
    raw.close();
  }
}

test('a base-schema ledger gains the table and the columns once, keeps its rows, and base-era statements still run on it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-db-'));
  const file = path.join(dir, 'f.db');
  const schema = (): { tables: string[]; runCols: string[]; triggers: string[] } => {
    const raw = new DatabaseSync(file);
    try {
      const names = (type: string): string[] => (raw.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as Array<Record<string, unknown>>).map((r) => String(r['name']));
      return { tables: names('table'), triggers: names('trigger'), runCols: (raw.prepare('PRAGMA table_info(runs)').all() as Array<Record<string, unknown>>).map((c) => String(c['name'])) };
    } finally {
      raw.close();
    }
  };
  try {
    const first = new Store(file);
    const old = first.addTask({ title: 'old ticket', prompt: 'p', runner: 'echo' });
    const oldRun = first.startRun(old.id).id;
    first.endRun(oldRun, 'succeeded', { exitCode: 0, summary: 'old' });
    first.close();
    toBaseSchema(file);
    const base = schema();
    assert.ok(!base.tables.includes('decisions'));
    assert.ok(NEW_RUN_COLUMNS.every((c) => !base.runCols.includes(c)));

    const second = new Store(file);
    const migrated = schema();
    assert.ok(migrated.tables.includes('decisions'));
    assert.deepEqual(migrated.triggers, ['decisions_no_delete', 'decisions_no_replace', 'decisions_no_update']);
    assert.deepEqual(migrated.runCols.filter((c) => NEW_RUN_COLUMNS.includes(c)), NEW_RUN_COLUMNS);
    const r = second.getRun(oldRun)!;
    assert.deepEqual(
      [r.turns, r.turnsReported, r.turnLimit, r.endedReason, r.briefBytes, r.briefCuts, r.reportBytes],
      [null, null, null, null, null, null, null], 'an old run reads NULL in every new column',
    );
    assert.equal(r.summary, 'old');
    assert.deepEqual(second.decisionsForTask(old.id), []);
    second.setStatus(old.id, 'awaiting-approval');
    applyRejection(second, old.id, 'recorded after the migration');
    second.setRunFacts(oldRun, { turns: 3, turnsReported: 4, turnLimit: 30, endedReason: 'ok', briefBytes: 10, briefCuts: [], reportBytes: 5 });
    second.close();

    // Opening it again changes nothing.
    new Store(file).close();
    assert.deepEqual(schema(), migrated);

    // Rollback: the statements main's code runs still work on the migrated file — a run insert that names none of
    // the new columns, a task delete (no foreign key ties a decision to it), and main's whole schema script.
    const raw = new DatabaseSync(file);
    try {
      raw.exec('PRAGMA foreign_keys = ON');
      raw.prepare("INSERT INTO runs (id, task_id, status, stage, progress, started_at) VALUES ('r_base', ?, 'running', 'admit', 0, 1)").run(old.id);
      raw.prepare("UPDATE runs SET status = 'failed', ended_at = 2, exit_code = 1, summary = 's' WHERE id = 'r_base'").run();
      raw.prepare("INSERT INTO events (task_id, run_id, ts, type, stage, message) VALUES (?, NULL, 3, 'status', NULL, 'queued')").run(old.id);
      raw.prepare('DELETE FROM tasks WHERE id = ?').run(old.id);
      assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM decisions').get() as Record<string, unknown>)['n'], 1, 'the decision outlives the task under base-era deletes');
      assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM runs').get() as Record<string, unknown>)['n'], 0, 'the cascade main relies on still works');
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- server routes

async function harness(): Promise<{ base: string; store: Store; close: () => Promise<void> }> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  sched.pauseDispatch();
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sched.stop();
      store.close();
    },
  };
}

const postRaw = (url: string, body?: string): Promise<Response> =>
  fetch(url, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }) });
const post = (url: string, body?: unknown): Promise<Response> => postRaw(url, body === undefined ? undefined : JSON.stringify(body));

test('the approve route passes corrected, reviewSource and the note through to the row, and answers with it', async () => {
  const h = await harness();
  try {
    const { task } = parked(h.store);
    const res = await post(`${h.base}/api/tasks/${task.id}/approve`, { note: 'r2 patch landed by hand', corrected: true, reviewSource: 'independent reviewer, verify 3040/0/1' });
    assert.equal(res.status, 200);
    const out = await res.json() as { status: string; decision: Decision };
    assert.equal(out.status, 'done');
    const d = rows(h.store, task.id);
    assert.equal(d.length, 1);
    assert.deepEqual(out.decision, d[0]);
    assert.deepEqual([d[0]!.corrected, d[0]!.correctedSource, d[0]!.reviewSource, d[0]!.note], [true, 'operator', 'independent reviewer, verify 3040/0/1', 'r2 patch landed by hand']);

    // --clean is false, and it is not confused with "not stated".
    const clean = parked(h.store).task;
    await post(`${h.base}/api/tasks/${clean.id}/approve`, { corrected: false });
    assert.equal(rows(h.store, clean.id)[0]!.corrected, false);
    // An empty body (the board's button) is still an approval, with nothing stated.
    const bare = parked(h.store).task;
    assert.equal((await post(`${h.base}/api/tasks/${bare.id}/approve`, {})).status, 200);
    assert.equal(rows(h.store, bare.id)[0]!.corrected, null);
    const none = parked(h.store).task;
    assert.equal((await postRaw(`${h.base}/api/tasks/${none.id}/approve`)).status, 200, 'no body at all');
    assert.equal(h.store.getTask(none.id)!.status, 'done');
    // GET lists them for `foreman show`.
    const shown = await (await fetch(`${h.base}/api/tasks/${task.id}`)).json() as { decisions: Decision[] };
    assert.deepEqual(shown.decisions, d);
  } finally {
    await h.close();
  }
});

test('a malformed value on the approve route is a 400 and nothing is decided', async () => {
  const h = await harness();
  try {
    const { task } = parked(h.store);
    const url = `${h.base}/api/tasks/${task.id}/approve`;
    for (const [body, why] of [
      [{ corrected: 'yes' }, /corrected must be true/],
      [{ corrected: 1 }, /corrected must be true/],
      [{ reviewSource: 'x'.repeat(201) }, /reviewSource is 201 characters; at most 200/],
      [{ reviewSource: 7 }, /reviewSource must be text/],
      [{ note: { text: 'x' } }, /note must be text/],
      [['corrected'], /must be a JSON object/],
    ] as const) {
      const res = await post(url, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json() as { error: string }).error, why);
      assert.equal(h.store.getTask(task.id)!.status, 'awaiting-approval', 'still parked');
      assert.equal(rows(h.store, task.id).length, 0);
    }
    assert.equal((await post(url, { reviewSource: 'x'.repeat(200), corrected: null })).status, 200, '200 characters and an explicit null are fine');
  } finally {
    await h.close();
  }
});

test('a body that cannot be read is a 400 on approve, retry and reopen: nothing is done without what the caller sent (a cancel goes ahead)', async () => {
  const h = await harness();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-reopen-'));
  try {
    const broken = '{"note": "the checks passed", "corrected": tru';
    const approve = parked(h.store).task;
    let res = await postRaw(`${h.base}/api/tasks/${approve.id}/approve`, broken);
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /could not be read, so nothing was done/);
    assert.equal(h.store.getTask(approve.id)!.status, 'awaiting-approval', 'not approved without its --corrected');

    // Cancel is the stop button: since the follow-ups batch it goes ahead and drops the note it could not read
    // (test/followups-leftovers.test.ts has the cases). Approve, retry and reopen keep their 400s.
    const stopped = parked(h.store).task;
    res = await postRaw(`${h.base}/api/tasks/${stopped.id}/cancel`, broken);
    assert.equal(res.status, 200);
    assert.equal(h.store.getTask(stopped.id)!.status, 'canceled');

    const ended = parked(h.store).task;
    applyRejection(h.store, ended.id, 'no');
    res = await postRaw(`${h.base}/api/tasks/${ended.id}/retry`, broken);
    assert.equal(res.status, 400);
    assert.equal(h.store.getTask(ended.id)!.status, 'rejected', 'not requeued without its note');
    assert.equal(rows(h.store, ended.id).filter((d) => d.action === 'retry').length, 0);

    const failed = h.store.addTask({ title: 'failed review', prompt: 'p', runner: 'echo' });
    const run = h.store.startRun(failed.id);
    h.store.setRunMeta(run.id, { worktreePath: work, branch: 'b' });
    h.store.addVerdict({ runId: run.id, taskId: failed.id, verdict: 'fail', disagreement: false, council: [], critique: 'c' });
    h.store.endRun(run.id, 'failed', { exitCode: 1, summary: 's' });
    h.store.setStatus(failed.id, 'failed', 'c');
    res = await postRaw(`${h.base}/api/tasks/${failed.id}/reopen`, broken);
    assert.equal(res.status, 400);
    assert.equal(h.store.getTask(failed.id)!.status, 'failed', 'not reopened without its note');
    assert.equal(rows(h.store, approve.id).length + rows(h.store, failed.id).length, 0);

    // The same four with a readable body go through, each answering with its row.
    for (const [id, action, body] of [
      [failed.id, 'reopen', { note: 'ran the live checks' }], [ended.id, 'retry', { note: 'try again', skills: 'default' }],
      [approve.id, 'cancel', { note: 'superseded' }],
    ] as const) {
      const ok = await post(`${h.base}/api/tasks/${id}/${action}`, body);
      assert.equal(ok.status, 200, action);
      const out = await ok.json() as { decision: Decision };
      assert.equal(out.decision.action, action);
      assert.equal(out.decision.note, body.note);
      assert.deepEqual(rows(h.store, id).at(-1), out.decision);
    }
    assert.deepEqual(rows(h.store, ended.id).at(-1)!.extra, { skills: null }, 'the retry row says the skills were put back on the role default');
    // A skills list the ticket may not carry is refused before the requeue, and no retry is recorded.
    const again = parked(h.store).task;
    applyRejection(h.store, again.id, 'no');
    res = await post(`${h.base}/api/tasks/${again.id}/retry`, { note: 'n', skills: ['not-a-skill'] });
    assert.equal(res.status, 400);
    assert.equal(h.store.getTask(again.id)!.status, 'rejected');
    assert.equal(rows(h.store, again.id).filter((d) => d.action === 'retry').length, 0);
    // A route whose row the ledger could not take answers null, never an older row of the same ticket.
    const lost = parked(h.store).task;
    applyRejection(h.store, lost.id, 'an earlier decision on the same ticket');
    h.store.db.exec("CREATE TRIGGER refuse_rows BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const unrecorded = await (await post(`${h.base}/api/tasks/${lost.id}/retry`, { note: 'n' })).json() as { status: string; decision: Decision | null };
    assert.equal(unrecorded.status, 'queued', 'the retry itself took effect');
    assert.equal(unrecorded.decision, null, 'not the earlier rejection, which is still the last row');
    assert.equal(rows(h.store, lost.id).at(-1)!.action, 'reject');
    assert.ok(h.store.eventsForTask(lost.id).some((e) => e.type === 'error' && /^decision not recorded \(retry\): disk full/.test(e.message)));
    h.store.db.exec('DROP TRIGGER refuse_rows');
    // And a ledger that cannot even be read back does not turn a cancel that took effect into an error.
    h.store.db.exec('ALTER TABLE decisions RENAME TO decisions_away');
    const unread = await post(`${h.base}/api/tasks/${lost.id}/cancel`, { note: 'n' });
    h.store.db.exec('ALTER TABLE decisions_away RENAME TO decisions');
    assert.equal(unread.status, 200);
    assert.deepEqual((({ status, decision }) => [status, decision])(await unread.json() as { status: string; decision: Decision | null }), ['canceled', null]);
    // A cancel with no body at all (the CLI without --note, the board) still cancels.
    const plain = parked(h.store).task;
    assert.equal((await postRaw(`${h.base}/api/tasks/${plain.id}/cancel`)).status, 200);
    assert.deepEqual(rows(h.store, plain.id).map((d) => [d.action, d.note]), [['cancel', null]]);
    // And the reject route answers with its row too.
    const rej = parked(h.store).task;
    const rejected = await (await post(`${h.base}/api/tasks/${rej.id}/reject`, { note: 'too long' })).json() as { status: string; decision: Decision };
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual([rejected.decision.action, rejected.decision.note], ['reject', 'too long']);
  } finally {
    await h.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- debrief

/** A fixture ledger on disk with every kind of row, and a copy of it taken back to main's schema. */
function debriefFixture(): { dir: string; withRows: string; without: string; ids: Record<string, string>; epic: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-debrief-'));
  const withRows = path.join(dir, 'with.db');
  const store = new Store(withRows);
  const epic = store.addTask({ title: 'the epic', prompt: 'ship it', runner: 'echo', isEpic: true });
  const ids: Record<string, string> = {};
  const ticket = (key: string): { task: Task; run: Run } => {
    const p = parked(store, { title: `ticket ${key}`, parentId: epic.id, gate: 'human' });
    ids[key] = p.task.id;
    return p;
  };
  // What applyApproval leaves, without a repo: decide, the memory fact, then the row (as recordApproval writes it).
  const approve = (p: { task: Task; run: Run }, note: string | null, over: Partial<Decision> = {}): void => {
    const task = store.decide(p.task.id, true);
    if (note) store.rememberFact({ scope: 'global', key: `preference:${task.id}`, value: `approved "${task.title}" — ${note}`.slice(0, 1000), confidence: 0.6, source: task.id });
    store.addDecision({
      taskId: task.id, runId: p.run.id, action: 'approve', note, statusAfter: 'done', asIs: false, merged: true, mergeReason: 'merged 1 commit(s) from b',
      reviewedTree: 'a'.repeat(40), landedTree: 'a'.repeat(40), ...over,
    });
  };
  approve(ticket('corrected'), 'fine as far as I can see', { corrected: true, correctedSource: 'operator', reviewSource: 'independent reviewer, verify 3040/0/1' });
  // The note reads like a correction; the operator said --clean.
  approve(ticket('clean'), 'approve + no corrections needed, on-top of nothing', { corrected: false, correctedSource: 'operator' });
  approve(ticket('asis'), null, { asIs: true, landedTree: 'b'.repeat(40), corrected: true, correctedSource: 'trees' });
  approve(ticket('worded'), 'approve + on-top fix landed by hand');
  approve(ticket('bare'), null);
  const cancelled = ticket('cancel');
  store.cancel(cancelled.task.id, 'superseded by the r2 ticket');
  // Runs whose rows say how they ended, in words no failure pattern matches.
  const ran = ticket('runs');
  for (const [reason, limit] of [['turn-ceiling', 30], ['deadline', 30]] as const) {
    const r = store.startRun(ran.task.id);
    store.endRun(r.id, 'failed', { exitCode: 1, summary: 'the run stopped' });
    store.setRunFacts(r.id, {
      turns: 12, turnsReported: 31, turnLimit: limit, endedReason: reason, briefBytes: 9000, reportBytes: 5000,
      briefCuts: reason === 'deadline' ? [{ section: 'acceptance', limit: 4000, before: 5210, cut: 1300 }] : [],
    });
  }
  store.close();
  const without = path.join(dir, 'without.db');
  fs.copyFileSync(withRows, without);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(withRows + ext)) fs.copyFileSync(withRows + ext, without + ext);
  new DatabaseSync(without).exec('PRAGMA wal_checkpoint(TRUNCATE)');
  toBaseSchema(without);
  return { dir, withRows, without, ids, epic: epic.id };
}

test('debrief on a ledger with the new rows: classes rest on the ledger, a cancel carries its note, stops and brief cuts are counted from the run rows', () => {
  const fx = debriefFixture();
  const store = openLedgerReadOnly(fx.withRows);
  try {
    const doc = collectDebrief(store, fx.epic, { home: fx.dir });
    const t = (key: string) => doc.tickets.find((x) => x.id === fx.ids[key])!;
    assert.deepEqual([t('corrected').gateDisagreement.class, t('corrected').gateDisagreement.how], ['corrected-at-gate', 'ledger']);
    assert.match(t('corrected').gateDisagreement.signals.join('\n'), /--corrected/);
    assert.match(t('corrected').gateDisagreement.signals.join('\n'), /independent reviewer, verify 3040\/0\/1/);
    assert.deepEqual([t('clean').gateDisagreement.class, t('clean').gateDisagreement.how], ['agreed', 'ledger'], 'the statement rules, not the wording of the note');
    assert.deepEqual([t('asis').gateDisagreement.class, t('asis').gateDisagreement.how], ['corrected-at-gate', 'ledger']);
    assert.match(t('asis').gateDisagreement.signals.join('\n'), /--as-is landing of tree bbbbbbbbbbbb, not the reviewed tree aaaaaaaaaaaa/);
    assert.equal(t('asis').operator.find((o) => o.action.startsWith('approve'))!.action, 'approve-as-is');
    // corrected NULL: read from the note's wording, and said so, exactly as before.
    assert.deepEqual([t('worded').gateDisagreement.class, t('worded').gateDisagreement.how], ['corrected-at-gate', 'note-wording']);
    assert.deepEqual([t('bare').gateDisagreement.class, t('bare').gateDisagreement.how], ['agreed', 'nothing']);
    assert.deepEqual(doc.gate['corrected-at-gate'].sort(), [fx.ids['corrected'], fx.ids['asis'], fx.ids['worded']].sort());

    const cancel = t('cancel').operator.filter((o) => o.action === 'cancel');
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0]!.note, 'while awaiting-approval');
    assert.equal(cancel[0]!.said, 'superseded by the r2 ticket');
    assert.match(t('cancel').gateDisagreement.signals.join('\n'), /the cancel's note: "superseded by the r2 ticket"/);
    assert.match(doc.signals.find((s) => s.kind === 'operator-cancel')!.example, /superseded by the r2 ticket/);
    assert.deepEqual(t('cancel').ledgerDecisions!.map((d) => [d.action, d.actor, d.note]), [['cancel', 'human', 'superseded by the r2 ticket']]);

    const stops = t('runs').failures.map((f) => [f.cause, f.n, f.recorded]);
    assert.deepEqual(stops, [['turn-ceiling', 30, true], ['run-deadline', null, true]]);
    assert.equal(doc.signals.find((s) => s.kind === 'failure:turn-ceiling')!.count, 1);
    assert.match(doc.signals.find((s) => s.kind === 'failure:run-deadline')!.example, /^1 of these are the run row's own ended_reason/);
    const recorded = t('runs').runs.filter((r) => r.endedReason !== undefined);
    assert.deepEqual(recorded.map((r) => [r.endedReason, r.turns, r.turnsReported, r.turnLimit, r.briefBytes, r.reportBytes]), [['turn-ceiling', 12, 31, 30, 9000, 5000], ['deadline', 12, 31, 30, 9000, 5000]]);
    assert.deepEqual(t('runs').briefCuts, [{ runId: recorded[1]!.id, section: 'acceptance', limit: 4000, before: 5210, cut: 1300 }]);
    assert.deepEqual(briefCutCount(doc), { runs: 2, cut: 1 });

    const report: DebriefReport = { version: doc.version, collect: doc, notes: [], noteProblems: [], diagnosis: { state: 'skipped', reason: '', alias: null, local: false, costUsd: 0, estimatedUsd: 0, findings: [], proposalsRanked: [], dropped: [], promptCuts: [], rawReply: '' } as never };
    const md = renderMarkdown(report);
    assert.match(md, /^- briefs: 1 of 2 runs had a section cut$/m);
    assert.match(md, /- \*\*corrected-at-gate\*\* \(3 — 2 on the ledger's record, 1 read from a note's wording, 0 with nothing on record\)/);
    assert.match(md, /note read from decisions/);
    assert.match(md, /Decisions in the ledger \(`decisions` table\): 6 read for 6 ticket\(s\)/);
    // The read-only contract: nothing was written, and nothing can be.
    assert.throws(() => store.addDecision({ taskId: fx.epic, action: 'cancel' }), /readonly|read-only|query_only/i);
  } finally {
    store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('debrief on a ledger without the table or the columns reads what exists, creates nothing, and classes as it did', () => {
  const fx = debriefFixture();
  const store = openLedgerReadOnly(fx.without);
  try {
    const doc = collectDebrief(store, fx.epic, { home: fx.dir });
    const t = (key: string) => doc.tickets.find((x) => x.id === fx.ids[key])!;
    // No record of the statement: every class is back to what the note's wording, or nothing, gives.
    assert.deepEqual([t('corrected').gateDisagreement.class, t('corrected').gateDisagreement.how], ['agreed', 'note-wording']);
    assert.deepEqual([t('clean').gateDisagreement.class, t('clean').gateDisagreement.how], ['corrected-at-gate', 'note-wording'], '"no corrections needed" reads as corrected, the known misreading');
    assert.deepEqual([t('asis').gateDisagreement.class, t('asis').gateDisagreement.how], ['agreed', 'nothing']);
    assert.deepEqual([t('worded').gateDisagreement.class, t('worded').gateDisagreement.how], ['corrected-at-gate', 'note-wording']);
    assert.deepEqual([t('bare').gateDisagreement.class, t('bare').gateDisagreement.how], ['agreed', 'nothing']);
    const cancel = t('cancel').operator.filter((o) => o.action === 'cancel');
    assert.deepEqual(cancel.map((o) => [o.note, o.said]), [['while awaiting-approval', undefined]]);
    assert.match(t('cancel').gateDisagreement.signals.join('\n'), /the ledger does not say why/);
    // None of the new keys appears anywhere in the document: an older epic's JSON has main's shape.
    const json = JSON.stringify(doc);
    for (const key of ['ledgerDecisions', 'briefCuts', 'endedReason', 'turnsReported', 'turnLimit', 'briefBytes', 'reportBytes', '"recorded"', '"said"']) {
      assert.ok(!json.includes(key), `${key} is not in the document`);
    }
    assert.deepEqual(t('runs').failures, [], 'a stop nobody worded is not counted: there is no run-row record here');
    assert.equal(briefCutCount(doc), null);
    const report: DebriefReport = { version: doc.version, collect: doc, notes: [], noteProblems: [], diagnosis: { state: 'skipped', reason: '', alias: null, local: false, costUsd: 0, estimatedUsd: 0, findings: [], proposalsRanked: [], dropped: [], promptCuts: [], rawReply: '' } as never };
    const md = renderMarkdown(report);
    assert.ok(!/briefs: /.test(md) && !/decisions` table/.test(md), 'the report says nothing about records this ledger does not have');
    assert.match(md, /Whether an approval carried a correction, as a fact: it is read out of the note's wording/);
    // It did not create the table or the columns.
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>).map((r) => String(r['name']));
    assert.ok(!names.includes('decisions'));
    const cols = (store.db.prepare('PRAGMA table_info(runs)').all() as Array<Record<string, unknown>>).map((c) => String(c['name']));
    assert.ok(NEW_RUN_COLUMNS.every((c) => !cols.includes(c)));
  } finally {
    store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('classifyGate: the recorded statement rules where there is one; a rejection still outranks it; NULL falls back to the wording', () => {
  const approve = (note: string) => [{ at: 10, action: 'approve' as const, by: 'human' as const, note, noteSource: 'decisions' as const }];
  const landing = { asIs: '', changedAfterReview: 0 };
  const pass = [{ at: 5, source: 'crew', verdict: 'pass' }];
  const fail = [{ at: 5, source: 'crew', verdict: 'fail' }];
  assert.deepEqual(
    (({ class: c, how }) => [c, how])(classifyGate(approve('all good'), pass, landing, 'done', { corrected: true, source: 'operator' })),
    ['corrected-at-gate', 'ledger'],
  );
  assert.deepEqual(
    (({ class: c, how }) => [c, how])(classifyGate(approve('on-top corrections'), pass, landing, 'done', { corrected: false, source: 'operator' })),
    ['agreed', 'ledger'],
  );
  assert.deepEqual(
    (({ class: c, how }) => [c, how])(classifyGate(approve('on-top corrections'), pass, landing, 'done', { corrected: null, source: null })),
    ['corrected-at-gate', 'note-wording'],
  );
  assert.deepEqual(
    (({ class: c, how }) => [c, how])(classifyGate(approve('checked it myself'), fail, landing, 'done', { corrected: false, source: 'operator' })),
    ['overruled-at-gate', 'ledger'], 'a clean approval of a failed review is still an overruling',
  );
  const rejectedFirst = [{ at: 3, action: 'reject' as const, by: 'human' as const, note: 'no', noteSource: 'decisions' as const }, ...approve('ok')];
  assert.equal(classifyGate(rejectedFirst, pass, landing, 'done', { corrected: false, source: 'operator' }).class, 'rejected-at-gate');
  // With no row at all the function is main's.
  assert.deepEqual(classifyGate(approve('on-top'), pass, landing, 'done'), classifyGate(approve('on-top'), pass, landing, 'done', null));
});

// --------------------------------------------------------------------- CLI

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Run the CLI against a stub daemon that answers each `METHOD /path` with the JSON given; what it was sent is kept. */
async function cli(argv: string[], routes: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number | null; sent: Array<{ key: string; body: string }> }> {
  const sent: Array<{ key: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      sent.push({ key, body });
      const answer = routes[key];
      res.writeHead(answer === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer ?? { error: 'not found' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    return { stdout, stderr, code, sent };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const ROW: Decision = {
  id: 'd_abc', taskId: 't_x', runId: 'r_1', at: Date.parse('2026-10-12T09:00:00Z'), action: 'approve', actor: 'human',
  note: 'landed r2\'s on-top patch by hand', noteCutBytes: 0, statusAfter: 'done', reviewedTree: '1111111111112222222222223333333333334444',
  landedTree: '1111111111112222222222223333333333334444', asIs: false, merged: true, mergeReason: 'merged 1 commit(s) from b',
  corrected: true, correctedSource: 'operator', reviewSource: 'independent reviewer, verify 3040/0/1', extra: null,
};

test('CLI approve --corrected sends the statement and prints one line confirming what was recorded', async () => {
  const r = await cli(
    ['approve', 't_x', '--corrected', '--note', 'landed r2\'s on-top patch by hand', '--review-source', 'independent reviewer, verify 3040/0/1'],
    { 'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', merge: { branch: 'b', reason: 'merged 1 commit(s) from b', merged: true }, decision: ROW } },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.sent[0]!.body), { note: 'landed r2\'s on-top patch by hand', corrected: true, reviewSource: 'independent reviewer, verify 3040/0/1' });
  const confirmed = r.stdout.split('\n').filter((l) => l.startsWith('recorded '));
  assert.equal(confirmed.length, 1, r.stdout);
  assert.equal(
    confirmed[0],
    'recorded d_abc: approve by human; corrected: yes (stated); merged: yes; reviewed 111111111111 → landed 111111111111; ' +
      'verified by: independent reviewer, verify 3040/0/1; → done; note: landed r2\'s on-top patch by hand',
  );
});

test('CLI approve --clean sends false; neither flag sends neither key; both together, or one given a value, is refused before anything is sent', async () => {
  const routes = { 'POST /api/tasks/t_x/approve': { id: 't_x', status: 'done', decision: { ...ROW, corrected: false } } };
  const clean = await cli(['approve', 't_x', '--clean'], routes);
  assert.equal(clean.code, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.sent[0]!.body), { corrected: false });
  assert.match(clean.stdout, /corrected: no \(stated\)/);

  const both = await cli(['approve', 't_x', '--corrected', '--clean'], routes);
  assert.notEqual(both.code, 0);
  assert.match(both.stderr, /--corrected and --clean say opposite things/);
  assert.deepEqual(both.sent, [], 'nothing was approved');

  const swallowed = await cli(['approve', '--corrected', 't_x'], routes);
  assert.notEqual(swallowed.code, 0);
  assert.match(swallowed.stderr + swallowed.stdout, /--corrected takes no value|usage: foreman approve/);
  assert.deepEqual(swallowed.sent, []);
});

test('CLI cancel --note sends the note; a daemon that answers without a decision record is said, not confirmed', async () => {
  const r = await cli(['cancel', 't_x', '--note', 'superseded by t_y'], { 'POST /api/tasks/t_x/cancel': { id: 't_x', status: 'canceled' } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.sent[0]!.body), { note: 'superseded by t_y' });
  assert.match(r.stdout, /^t_x → canceled$/m);
  assert.match(r.stdout, /^NOT RECORDED: the daemon at .* answered without a decision record for this cancel/m);
  assert.ok(!/^recorded /m.test(r.stdout));
});

test('foreman show lists the decisions on a task: action, who, corrected, the trees short, the note\'s head', async () => {
  const cancelRow: Decision = { ...ROW, id: 'd_c', action: 'cancel', actor: 'system', note: 'parent t_e was canceled', statusAfter: 'canceled', corrected: null, correctedSource: null, asIs: null, merged: null, mergeReason: null, reviewedTree: null, landedTree: null, reviewSource: null };
  const asIs: Decision = { ...ROW, id: 'd_a', asIs: true, correctedSource: 'trees', landedTree: '9999999999998888888888887777777777776666', reviewSource: null, note: 'n'.repeat(200) };
  const r = await cli(['show', 't_x'], {
    'GET /api/tasks/t_x': {
      task: { id: 't_x', title: 'the ticket', status: 'done', runner: 'echo', kind: 'code' }, runs: [], artifacts: [], verdicts: [], events: [],
      decisions: [ROW, asIs, cancelRow],
    },
  });
  assert.equal(r.code, 0, r.stderr);
  const section = r.stdout.slice(r.stdout.indexOf('decisions:\n'), r.stdout.indexOf('\nrecent activity:'));
  const lines = section.split('\n').slice(1).filter(Boolean);
  assert.equal(lines.length, 3, r.stdout);
  assert.match(lines[0]!, /approve by human; corrected: yes \(stated\); merged: yes; reviewed 111111111111 → landed 111111111111; verified by: independent reviewer, verify 3040\/0\/1; → done; note: landed r2's on-top patch by hand$/);
  assert.match(lines[1]!, /corrected: yes \(the trees differ\); merged: yes \(--as-is\); reviewed 111111111111 → landed 999999999999; → done; note: n{120}…$/);
  assert.match(lines[2]!, /cancel by system; → canceled; note: parent t_e was canceled$/);
  // A daemon from before the table answers without the list: no section, no crash.
  const old = await cli(['show', 't_x'], { 'GET /api/tasks/t_x': { task: { id: 't_x', title: 'the ticket', status: 'done', runner: 'echo', kind: 'code' }, runs: [], artifacts: [], verdicts: [], events: [] } });
  assert.equal(old.code, 0, old.stderr);
  assert.ok(!old.stdout.includes('decisions:'));
});

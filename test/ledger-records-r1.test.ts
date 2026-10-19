// Review r1 on the decisions ledger: the tree a row calls "landed" is read from what main received, not from a
// branch name that anything left behind by a run can move after the merge; and a row cannot be replaced.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectBriefCuts } from '../src/context.ts';
import { applyApproval, applyRejection } from '../src/gate.ts';
import type { MainCheck } from '../src/postMerge.ts';
import { Store } from '../src/queue.ts';
import { newRunFacts, noteResult, noteResumed } from '../src/runFacts.ts';
import { Scheduler, operatorBrief, repairBrief } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import type { Decision } from '../src/types.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ledger-r1-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A shell ticket the scheduler ran and parked at the gate, with its reviewed tree on the run. */
async function reviewed() {
  const dir = repo({ 'a.txt': 'one\n' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const t = store.addTask({
    title: 'ticket', prompt: "printf 'TICKET\\n' > a.txt; printf 'new\\n' > new.txt", kind: 'code', runner: 'shell',
    repo: dir, testCmd: 'test -f a.txt', maxAttempts: 1,
  });
  await sched.drain(60_000);
  const run = store.latestRun(t.id)!;
  const done = async (): Promise<void> => {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, task: store.getTask(t.id)!, run, jail: run.worktreePath!, done };
}

const GREEN: MainCheck = { ok: true, head: '', cmd: null, tail: '', firstTail: '' };

test('the landed tree is the merge\'s own second parent: a branch moved after the merge (during the main check) changes nothing in the row', async () => {
  const f = await reviewed();
  try {
    const base = git(f.dir, 'rev-parse', 'HEAD');
    const out = await applyApproval(f.store, f.task.id, {
      // What a process a run left behind can do while the merged main is being checked: point the branch elsewhere.
      mainCheck: async (dir) => {
        git(dir, 'update-ref', `refs/heads/${f.run.branch!}`, base);
        return GREEN;
      },
    });
    assert.equal(out.merge.merged, true, out.merge.reason);
    const d = f.store.decisionsForTask(f.task.id)[0]!;
    assert.equal(d.landedTree, git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), 'the tree main received');
    assert.equal(d.landedTree, f.run.reviewedTree);
    assert.notEqual(d.landedTree, git(f.dir, 'rev-parse', `${base}^{tree}`), 'not the tree the moved branch names now');
  } finally {
    await f.done();
  }
});

test('an --as-is landing of another tree stays `corrected` by the trees when the branch is pointed back at the reviewed tree after the merge', async () => {
  const f = await reviewed();
  try {
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'written after the review\n');
    const refused = await applyApproval(f.store, f.task.id, {});
    const now = /--as-is ([0-9a-f]{40})$/.exec(refused.merge.reason)?.[1] ?? '';
    assert.match(now, /^[0-9a-f]{40}$/, refused.merge.reason);
    const base = git(f.dir, 'rev-parse', 'HEAD');
    const out = await applyApproval(f.store, f.task.id, {
      acceptTree: now,
      mainCheck: async (dir) => {
        // A commit that holds exactly the reviewed tree, and the branch pointed at it: the row must not read it.
        const asReviewed = git(dir, 'commit-tree', f.run.reviewedTree!, '-p', base, '-m', 'looks reviewed');
        git(dir, 'update-ref', `refs/heads/${f.run.branch!}`, asReviewed);
        return GREEN;
      },
    });
    assert.equal(out.merge.merged, true, out.merge.reason);
    const d = f.store.decisionsForTask(f.task.id).at(-1)!;
    assert.equal(git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), now, 'precondition: the named tree is what landed');
    assert.equal(d.landedTree, now);
    assert.equal(d.corrected, true, 'an unreviewed tree landed: that is the record, whatever the branch says afterwards');
    assert.equal(d.correctedSource, 'trees');
  } finally {
    await f.done();
  }
});

test('a decision row cannot be replaced: INSERT OR REPLACE on an existing id is refused like an update', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'x', prompt: 'p', runner: 'echo' });
    const row = store.addDecision({ taskId: t.id, action: 'cancel', note: 'the first word' });
    const replace = store.db.prepare("INSERT OR REPLACE INTO decisions (id, task_id, at, action, actor, note) VALUES (?, ?, 1, 'approve', 'human', 'rewritten')");
    assert.throws(() => replace.run(row.id, t.id), /append-only/);
    assert.deepEqual(store.decisionsForTask(t.id), [row], 'the row is exactly as written');
    // Any second insert of an existing id is refused, whatever its conflict clause; a new id is an ordinary insert.
    const ignore = store.db.prepare("INSERT OR IGNORE INTO decisions (id, task_id, at, action, actor, note) VALUES (?, ?, 1, 'approve', 'human', 'ignored')");
    assert.throws(() => ignore.run(row.id, t.id), /append-only/);
    assert.deepEqual(store.decisionsForTask(t.id), [row]);
    assert.equal(store.addDecision({ taskId: t.id, action: 'retry' }).action, 'retry');
    assert.equal(store.decisionsForTask(t.id).length, 2);
  } finally {
    store.close();
  }
});

// ---- paths the first round's mutants showed no test for

test('an approval of a conflict round that cannot land is one row too: not merged, the ticket left at the gate', async () => {
  const f = await reviewed();
  try {
    fs.writeFileSync(path.join(f.dir, 'a.txt'), 'MAIN\n'); git(f.dir, 'commit', '-qam', 'main moved');
    const first = await applyApproval(f.store, f.task.id, { note: 'go' });
    assert.match(first.merge.reason, /^merge conflict/);
    assert.equal(f.store.getTask(f.task.id)!.status, 'queued', 'precondition: requeued as a conflict round');
    const second = await applyApproval(f.store, f.task.id, { note: 'go again' });
    assert.equal(second.merge.merged, false);
    const all = f.store.decisionsForTask(f.task.id);
    assert.deepEqual(
      all.map((d) => [d.action, d.actor, d.merged, d.statusAfter, d.landedTree, d.corrected, d.note]),
      [['approve', 'human', false, 'queued', null, null, 'go'], ['approve', 'human', false, 'awaiting-approval', null, null, 'go again']],
    );
    assert.equal(second.decision?.id, all[1]!.id);
  } finally {
    await f.done();
  }
});

test('a rejection carries the reviewed tree it turned down; a desk ticket that once ran names no run; a cascade row says canceled', async () => {
  const store = new Store(':memory:');
  try {
    const tree = 'ab'.repeat(20);
    const t = store.addTask({ title: 'at the gate', prompt: 'p', runner: 'echo' });
    const run = store.startRun(t.id);
    store.setRunMeta(run.id, { reviewedTree: tree });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(t.id, 'awaiting-approval');
    applyRejection(store, t.id, 'no');
    assert.deepEqual(store.decisionsForTask(t.id).map((d) => [d.action, d.runId, d.reviewedTree]), [['reject', run.id, tree]]);

    // Finished on the operator's own desk after an earlier run: the approval rules on no run.
    const desk = store.addTask({ title: 'by hand', prompt: 'p', runner: 'echo' });
    const earlier = store.startRun(desk.id);
    store.setRunMeta(earlier.id, { reviewedTree: tree });
    store.endRun(earlier.id, 'failed', { exitCode: 1, summary: 'gave up' });
    store.setStatus(desk.id, 'awaiting-human');
    await applyApproval(store, desk.id, { note: 'did it myself' });
    assert.deepEqual(store.decisionsForTask(desk.id).map((d) => [d.runId, d.reviewedTree, d.statusAfter]), [[null, null, 'done']]);

    const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo', isEpic: true });
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', parentId: epic.id });
    store.cancel(epic.id, 'dropped');
    assert.deepEqual(store.decisionsForTask(child.id).map((d) => [d.actor, d.statusAfter, d.extra]), [['system', 'canceled', { statusBefore: 'queued' }]]);

    assert.throws(() => store.setRunFacts(run.id, { endedReason: 'daemon-stop' as never }), /unknown ended reason/);
    assert.equal(store.getRun(run.id)!.endedReason, null);
  } finally {
    store.close();
  }
});

test('a route whose row was not written does not answer with an older row of the SAME action', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  sched.pauseDispatch();
  const server: http.Server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string): Promise<Response> => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  try {
    const t = store.addTask({ title: 'twice', prompt: 'p', runner: 'echo' });
    store.cancel(t.id);
    const first = await (await post(`/api/tasks/${t.id}/retry`)).json() as { decision: Decision | null };
    assert.equal(first.decision?.action, 'retry');
    // Ended again without a decision of its own, so the first retry's row is still the ticket's last.
    store.setStatus(t.id, 'failed', 'the round failed');
    // The clock must have moved past the first retry's row before the second one is asked for.
    await new Promise((r) => setTimeout(r, 5));
    store.db.exec("CREATE TRIGGER refuse_rows BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const second = await (await post(`/api/tasks/${t.id}/retry`)).json() as { status: string; decision: Decision | null };
    store.db.exec('DROP TRIGGER refuse_rows');
    assert.equal(second.status, 'queued', 'the retry took effect');
    assert.equal(second.decision, null, 'not the first retry\'s row');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  }
});

test('cuts in the repair notes and the operator\'s demands are reported under their own names; a resume\'s turns add up', () => {
  const long = 'fix this line\n'.repeat(20_000);
  const repair = collectBriefCuts(() => repairBrief({ repairNotes: long } as never));
  assert.deepEqual(repair.cuts.map((c) => c.section), ['repair-notes']);
  const demands = collectBriefCuts(() => operatorBrief({ operatorDemands: long, repairNotes: null }));
  assert.deepEqual(demands.cuts.map((c) => c.section), ['operator-demands']);

  const facts = newRunFacts();
  noteResult(facts, { ok: true, summary: 's', report: 'first', turns: 7, turnsReported: 12, turnLimit: 30 });
  noteResumed(facts, { ok: false, summary: 's', turns: 2, turnsReported: 3, endedBy: 'turn-ceiling' }, undefined);
  assert.deepEqual([facts.turns, facts.turnsReported, facts.endedBy, facts.workerOk, facts.reportBytes], [9, 15, null, true, 5], 'a failed resume adds its turns and keeps the first ending');
  noteResumed(facts, { ok: false, summary: 's', turns: 1, turnsReported: 1, endedBy: 'turn-ceiling' }, 'joined report');
  assert.deepEqual([facts.turns, facts.turnsReported, facts.endedBy, facts.workerOk, facts.reportBytes], [10, 16, 'turn-ceiling', false, 13]);
});

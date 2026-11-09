import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { applyApproval, type ApprovalResult } from '../src/gate.ts';
import { recordBaseline } from '../src/gitTripwire.ts';
import { pinnedGit } from '../src/isolate.ts';
import { mergeApproved } from '../src/merge.ts';
import { NOTHING_TO_CHANGE_CLOSED } from '../src/verify/gateOutcome.ts';
import type { Task } from '../src/types.ts';

// Every outcome of a landing, and what the approve path does with it: the
// ticket's status afterwards and the note it is parked with. One row per
// outcome; each is a real approval of a real branch.

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-mergecode-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src', 'security'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src', 'security', 'admit.ts'), 'export const admit = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

interface Fixture { store: Store; dir: string; task: Task; runId: string }

/** A ticket parked at the gate whose run left branch `ticket` carrying `change` (none: the branch is HEAD). */
function parked(change: Record<string, string> | null, over: Partial<Parameters<Store['addTask']>[0]> = {}): Fixture {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'ticket');
  if (change) {
    for (const [f, body] of Object.entries(change)) fs.writeFileSync(path.join(dir, f), body);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'ticket');
  }
  git(dir, 'checkout', '-q', '-');
  const store = new Store(':memory:');
  const task = store.addTask({ title: 'ticket', prompt: 'p', kind: 'code', runner: 'echo', repo: dir, ...over });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch: 'ticket', worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return { store, dir, task: store.getTask(task.id)!, runId: run.id };
}

function recordDiff(f: Fixture): void {
  const file = path.join(f.dir, '..', `${f.runId}.diff`);
  fs.writeFileSync(file, 'diff --git a/a.txt b/a.txt\n');
  f.store.addArtifact({ runId: f.runId, taskId: f.task.id, type: 'diff', path: file, summary: 'diff' });
}

/** A ticket finished on the operator's own desk: no run under review. */
function onTheDesk(leftover: boolean): Fixture {
  const dir = repo();
  const store = new Store(':memory:');
  const task = store.addTask({ title: 'desk', prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
  const run = store.startRun(task.id);
  if (leftover) store.setRunMeta(run.id, { branch: 'ticket', worktreePath: scratchDir('foreman-mergecode-wt-') });
  store.endRun(run.id, 'failed', { exitCode: 1, summary: 'interrupted' });
  store.setStatus(task.id, 'awaiting-human');
  return { store, dir, task: store.getTask(task.id)!, runId: run.id };
}

interface Row {
  name: string;
  setup: () => Fixture | Promise<Fixture>;
  approve?: Parameters<typeof applyApproval>[2];
  reason: RegExp;
  status: Task['status'];
  /** The ticket's note afterwards; null: none written. */
  note: RegExp | null;
}

const ROWS: Row[] = [
  {
    name: 'a clean merge lands and the ticket is done',
    setup: () => parked({ 'a.txt': 'TICKET\n' }),
    reason: /^merged 1 commit\(s\) from ticket$/, status: 'done', note: null,
  },
  {
    name: 'an empty branch from a run that recorded no diff closes the ticket',
    setup: () => parked(null),
    reason: new RegExp(`^${NOTHING_TO_CHANGE_CLOSED}$`), status: 'done', note: null,
  },
  {
    name: 'an empty branch from a run that recorded a diff is done, said as it is',
    setup: () => { const f = parked(null); recordDiff(f); return f; },
    reason: /^branch has no commits ahead of HEAD$/, status: 'done', note: null,
  },
  {
    name: 'a conflict with no diff to repair from parks for a person to resolve',
    setup: () => { const f = parked({ 'a.txt': 'TICKET\n' }); fs.writeFileSync(path.join(f.dir, 'a.txt'), 'MAIN\n'); git(f.dir, 'commit', '-qam', 'main'); return f; },
    reason: /^merge conflict, aborted — resolve ticket by hand: /, status: 'awaiting-approval',
    note: /^approved, but not landed: merge conflict, aborted .* — resolve it, then approve again$/s,
  },
  {
    name: 'a conflict on a run with a diff and repair budget becomes a repair round',
    setup: () => { const f = parked({ 'a.txt': 'TICKET\n' }); recordDiff(f); fs.writeFileSync(path.join(f.dir, 'a.txt'), 'MAIN\n'); git(f.dir, 'commit', '-qam', 'main'); return f; },
    reason: /^merge conflict, aborted .*; requeued as repair round 1 to resolve the conflict$/s, status: 'queued', note: null,
  },
  {
    name: 'a dirty checkout parks for a person to clean',
    setup: () => { const f = parked({ 'a.txt': 'TICKET\n' }); fs.writeFileSync(path.join(f.dir, 'stray.txt'), 'x\n'); return f; },
    reason: /^repo has uncommitted changes; merge skipped$/, status: 'awaiting-approval',
    note: /^approved, but not landed: repo has uncommitted changes; merge skipped — resolve it, then approve again$/,
  },
  {
    name: 'a branch that is gone parks for a person',
    setup: () => { const f = parked({ 'a.txt': 'TICKET\n' }); git(f.dir, 'branch', '-qD', 'ticket'); return f; },
    reason: /^branch ticket no longer exists$/, status: 'awaiting-approval',
    note: /^approved, but not landed: branch ticket no longer exists — resolve it, then approve again$/,
  },
  {
    name: 'merge-on-approve off: done, nothing landed',
    setup: () => parked({ 'a.txt': 'TICKET\n' }, { mergeOnApprove: false }),
    reason: /^merge-on-approve disabled for this task$/, status: 'done', note: null,
  },
  {
    name: "a change to Foreman's core is refused and parked with no promise that approving again helps",
    setup: () => parked({ 'src/security/admit.ts': 'export const admit = 2;\n' }),
    approve: { selfRoot: '<dir>' },
    reason: /^core change refused: /, status: 'awaiting-approval',
    note: /^approved, but not landed: core change refused: .* — reject it, or take the core change out of its branch by hand before approving$/s,
  },
  {
    name: "a core change on a branch Foreman does not merge is refused the same way",
    setup: () => parked({ 'src/security/admit.ts': 'export const admit = 2;\n' }, { mergeOnApprove: false }),
    approve: { selfRoot: '<dir>' },
    reason: /^core change refused: /, status: 'awaiting-approval',
    note: /^approved, but not landed: core change refused: .* — reject it, or take the core change out of its branch by hand before approving$/s,
  },
  {
    name: 'no reviewed tree under the owner gate: not landed, parked for a person before anything is decided',
    setup: () => parked({ 'a.txt': 'TICKET\n' }),
    approve: { source: 'owner-gate' },
    reason: /^no reviewed tree was recorded for this run/, status: 'awaiting-approval',
    note: /^not landed: no reviewed tree was recorded for this run/,
  },
  {
    name: "the real repo's .git changed since the run began: not landed, parked for a person",
    setup: async () => {
      const f = parked({ 'a.txt': 'TICKET\n' });
      await recordBaseline(f.dir, f.runId, pinnedGit);
      fs.writeFileSync(path.join(f.dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
      return f;
    },
    reason: /^git tripwire: /, status: 'awaiting-approval', note: /^not landed: git tripwire: /,
  },
  {
    name: 'a ticket finished on the desk approves no run: nothing to land',
    setup: () => onTheDesk(false),
    reason: /^nothing to land: no run was approved$/, status: 'done', note: null,
  },
  {
    name: "an interrupted run's kept worktree is named, not landed",
    setup: () => onTheDesk(true),
    reason: /^not landed: an interrupted run's work is still in .* \(branch ticket\) — commit it there and merge it yourself if you want it$/,
    status: 'done', note: null,
  },
];

for (const row of ROWS) {
  test(`landing outcome: ${row.name}`, async () => {
    process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
    const f = await row.setup();
    try {
      const opts = row.approve?.selfRoot === '<dir>' ? { ...row.approve, selfRoot: f.dir } : row.approve ?? {};
      const out: ApprovalResult = await applyApproval(f.store, f.task.id, opts);
      assert.equal(out.merge.merged, row.reason.source.startsWith('^merged'), out.merge.reason);
      assert.match(out.merge.reason, row.reason);
      const now = f.store.getTask(f.task.id)!;
      assert.equal(now.status, row.status, now.error ?? '');
      if (row.note) assert.match(now.error ?? '', row.note);
      else assert.equal(now.error || null, null);
    } finally {
      delete process.env['FOREMAN_POSTMERGE_CHECK'];
      f.store.close();
    }
  });
}

test('landing outcome: what mergeApproved answers before it looks at the repo', async () => {
  const f = parked({ 'a.txt': 'TICKET\n' });
  try {
    const run = f.store.getRun(f.runId)!;
    const parkedAnswer = await mergeApproved(f.task, run);
    assert.deepEqual(parkedAnswer, { merged: false, reason: 'task is awaiting-approval, not approved', branch: 'ticket' });
    const noBranch = await mergeApproved({ ...f.task, status: 'done' }, { ...run, branch: null });
    assert.deepEqual(noBranch, { merged: false, reason: 'nothing to merge', branch: null });
  } finally {
    f.store.close();
  }
});

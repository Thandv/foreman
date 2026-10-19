import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import { Scheduler, preReviewGaps, type VerifyArgs } from '../src/scheduler.ts';
import { boundSummary } from '../src/runners/cliRunners.ts';
import type { Task } from '../src/types.ts';

const SOLO = `---
${JSON.stringify({
  id: 'solo',
  description: 'One reviewer, one chair.',
  triggers: ['solo'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, null, 2)}
---

## role: planner

You chair the crew.

## role: senior

You review what you did not write.

## role: dev

You implement the ticket.
`;

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

interface Rig {
  store: Store;
  sched: Scheduler;
  calls: () => number;
  callsFile: string;
  done: () => void;
  repo: string;
}

/** A fake claude CLI that counts every call (the reviewer broker) and always passes. */
function rig(opts: { onVerify?: (args: VerifyArgs) => void } = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prereview-'));
  fs.writeFileSync(path.join(dir, 'solo.md'), SOLO);
  const countFile = path.join(dir, 'calls');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho x >> "${countFile}"\nprintf '%s\\n' "$@" >> "${countFile}.args"\ncat <<'EOF'\n${envelope(JSON.stringify({ verdict: 'pass', critique: 'fine', issues: [] }))}\nEOF\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prereview-repo-'));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async (args) => {
      opts.onVerify?.(args);
      return store.addVerdict({ runId: args.runId, taskId: args.task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  return {
    store, sched, repo, callsFile: countFile,
    calls: () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0),
    done: () => {
      delete process.env['FOREMAN_PLAYBOOKS_DIR'];
      delete process.env['FOREMAN_CLAUDE_BIN'];
      delete process.env['FOREMAN_CREW_REVIEW'];
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

async function settle(sched: Scheduler, until: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const add = (r: Rig, over: Partial<Task> & { prompt: string }): Task =>
  r.store.addTask({ title: 'ticket', kind: 'code', runner: 'shell', repo: r.repo, role: 'dev', playbook: 'solo', ...over } as never);

test('a code ticket whose report lacks a map line is requeued naming that item, with zero reviewer calls', async () => {
  const r = rig();
  try {
    // The shell runner's report carries no ACCEPTANCE MAP, so the one item is unmapped.
    const t = add(r, { prompt: "printf 'x\\n' >> README.md", acceptance: '1. the readme says x' });
    await settle(r.sched, () => (r.store.getTask(t.id)!.preReviewRepairs ?? 0) > 0);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'queued');
    assert.match(after.repairNotes ?? '', /^1\. unmapped$/m);
    assert.doesNotMatch(after.repairNotes ?? '', /^2\./m);
    assert.equal(r.calls(), 0, 'no reviewer was called');
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('a forbidden or out-of-ONLY path is requeued naming file and rule, and a writing ticket is not map-checked', async () => {
  const r = rig();
  try {
    const forbidden = add(r, {
      prompt: "printf 'x\\n' >> README.md", acceptance: null, forbiddenPaths: ['README.md'],
    });
    await settle(r.sched, () => (r.store.getTask(forbidden.id)!.preReviewRepairs ?? 0) > 0);
    const f = r.store.getTask(forbidden.id)!;
    assert.match(f.repairNotes ?? '', /README\.md \(Do NOT touch README\.md\)/);
    assert.equal(r.calls(), 0);

    // write ONLY lives in the prompt; the trailing shell comment keeps the command valid.
    const only = add(r, {
      kind: 'writing', playbook: 'solo',
      prompt: "printf 'x\\n' >> notes.txt # write ONLY docs/",
      acceptance: '1. an item no map covers',
    });
    await settle(r.sched, () => (r.store.getTask(only.id)!.preReviewRepairs ?? 0) > 0);
    const o = r.store.getTask(only.id)!;
    assert.match(o.repairNotes ?? '', /notes\.txt \(write ONLY docs\/\)/);
    assert.doesNotMatch(o.repairNotes ?? '', /unmapped/, 'a writing ticket is scope-checked, not map-checked');
    assert.equal(r.calls(), 0);
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('pre-review repairs leave repairs alone, and gaps left after the cap go to the reviewer with the items attached', async () => {
  const r = rig();
  try {
    const t = add(r, { prompt: "printf 'x\\n' >> README.md", acceptance: '1. the readme says x' });
    await settle(r.sched, () => !['queued', 'running', 'verifying'].includes(r.store.getTask(t.id)!.status));
    const after = r.store.getTask(t.id)!;
    assert.equal(after.preReviewRepairs, 2, 'default cap of 2 rounds');
    assert.equal(after.repairs, 0, 'task.repairs is untouched');
    assert.notEqual(after.status, 'failed', `the check alone does not fail the ticket: ${after.error ?? ''}`);
    assert.ok(r.calls() >= 1, 'the reviewer was called once the pre-review rounds were spent');
    const args = fs.readFileSync(`${r.callsFile}.args`, 'utf8');
    assert.match(args, /FOREMAN CHECK: the deterministic pre-review check still reports these gaps/);
    assert.match(args, /^1\. unmapped$/m);
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('under the default escalate mode the council and the crew reviewer both get the FOREMAN CHECK note', async () => {
  const logTails: string[] = [];
  const r = rig({ onVerify: (a) => void logTails.push(a.evidence.logTail ?? '') });
  delete process.env['FOREMAN_CREW_REVIEW']; // escalate: council first, then the crew chain
  try {
    const t = add(r, { prompt: "printf 'x\\n' >> README.md", acceptance: '1. the readme says x' });
    await settle(r.sched, () => !['queued', 'running', 'verifying'].includes(r.store.getTask(t.id)!.status));
    assert.equal(r.store.getTask(t.id)!.preReviewRepairs, 2);
    assert.equal(logTails.length, 1, 'the council ran once, after the pre-review rounds');
    assert.match(logTails[0]!, /FOREMAN CHECK: the deterministic pre-review check still reports these gaps/);
    assert.match(logTails[0]!, /^1\. unmapped$/m);
    assert.ok(r.calls() >= 1, 'the crew chain ran after the council');
    const args = fs.readFileSync(`${r.callsFile}.args`, 'utf8');
    assert.match(args, /FOREMAN CHECK: the deterministic pre-review check still reports these gaps/);
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('a forbidden-path edit still standing after the pre-review cap fails the ticket, never reaching the gate', async () => {
  const r = rig();
  try {
    const t = add(r, { prompt: "printf 'x\\n' >> README.md", acceptance: null, forbiddenPaths: ['README.md'] });
    await settle(r.sched, () => !['queued', 'running', 'verifying'].includes(r.store.getTask(t.id)!.status));
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'failed', `ended ${after.status}`);
    assert.equal(after.preReviewRepairs, 2);
    assert.match(after.error ?? '', /README\.md \(Do NOT touch README\.md\)/);
    assert.equal(r.calls(), 0, 'no reviewer was asked to wave it through');
    assert.ok(!r.store.eventsForTask(t.id).some((e) => e.type === 'status' && e.message.startsWith('awaiting-approval')), 'never parked at the gate');
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('a DB without tasks.pre_review_repairs reads 0; retry resets the count, reopen keeps it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prereview-db-'));
  const file = path.join(dir, 'f.db');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prereview-wt-'));
  try {
    const first = new Store(file);
    const id = first.addTask({ title: 't', prompt: 'p', runner: 'echo' }).id;
    first.close?.();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE tasks DROP COLUMN pre_review_repairs');
    raw.close();
    const store = new Store(file);
    assert.equal(store.getTask(id)!.preReviewRepairs, 0);

    const failedReview = (): void => {
      const run = store.startRun(id).id;
      store.setRunMeta(run, { worktreePath: wt });
      store.addVerdict({ runId: run, taskId: id, verdict: 'fail', disagreement: false, council: [], critique: 'no' });
      store.setStatus(id, 'failed', 'review said no');
    };
    assert.ok(store.schedulePreReviewRepair(id, 'notes', 2));
    assert.equal(store.getTask(id)!.preReviewRepairs, 1);
    assert.equal(store.getTask(id)!.repairs, 0);
    failedReview();
    store.reopen(id, 'again');
    assert.equal(store.getTask(id)!.preReviewRepairs, 1, 'reopen leaves the count alone');
    failedReview();
    store.retry(id);
    assert.equal(store.getTask(id)!.preReviewRepairs, 0, 'retry is a fresh start');
    store.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('a ticket with no numbered acceptance and no scope rules reaches the reviewer unchanged', async () => {
  const r = rig();
  try {
    const t = add(r, { prompt: "printf 'x\\n' >> README.md", acceptance: 'the readme says x' });
    await settle(r.sched, () => r.store.getTask(t.id)!.status === 'awaiting-approval');
    assert.ok(r.calls() >= 1, 'the crew reviewer ran');
    assert.equal(r.store.getTask(t.id)!.preReviewRepairs, 0);
  } finally {
    await r.sched.stop();
    r.store.close();
    r.done();
  }
});

test('crew report map-repairs equals the summed tasks.pre_review_repairs', () => {
  const store = new Store(':memory:');
  const seed = (role: string, rounds: number): void => {
    const t = store.addTask({ title: role, prompt: 'p', runner: 'echo', role, playbook: 'solo' });
    for (let i = 0; i < rounds; i++) store.schedulePreReviewRepair(t.id, 'n', 5);
    store.setStatus(t.id, 'done');
  };
  seed('dev', 2);
  seed('dev', 1);
  seed('senior', 0);
  const rows = store.crewReport();
  assert.equal(rows.find((x) => x.role === 'dev')!.mapRepairs, 3);
  assert.equal(rows.find((x) => x.role === 'senior')!.mapRepairs, 0);
  store.close();
});

const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n base\n+x\n';

test('a 9000-char report ending in a complete map passes the pre-review check', () => {
  const r = rig();
  try {
    const t = add(r, { prompt: 'p', acceptance: '1. README.md says x' });
    const report = `${'work notes. '.repeat(750)}\nACCEPTANCE MAP\n1. (diff) README.md\n`;
    assert.ok(report.length > 9000);
    assert.equal(preReviewGaps(t, DIFF, report), null);
    // The old head-only summary would have cut the map off.
    assert.ok(preReviewGaps(t, DIFF, report.slice(0, 4000)));
  } finally {
    r.store.close();
    r.done();
  }
});

test('the stored summary of a long report still contains its last map line', () => {
  const report = `${'x'.repeat(9000)}\nACCEPTANCE MAP\n1. (diff) README.md\n2. (review)`;
  const summary = boundSummary(report);
  assert.ok(summary.length < 4100);
  assert.ok(summary.endsWith('2. (review)'));
  assert.equal(boundSummary('short'), 'short');
});

test('the pre-review check reads a mapped test file from the work tree: an existing test the diff does not touch covers a no-change item', () => {
  const r = rig();
  try {
    fs.mkdirSync(path.join(r.repo, 'test'));
    fs.writeFileSync(path.join(r.repo, 'test/lock.test.ts'), "test('a stale lock is replaced', () => {});\n");
    const t = add(r, { prompt: 'p', acceptance: '1. README.md says x\n2. Lock replacement is unchanged.' });
    const report = 'ACCEPTANCE MAP\n1. (diff) README.md\n2. test/lock.test.ts :: a stale lock is replaced\n';
    assert.equal(preReviewGaps(t, DIFF, report, r.repo), null);
    assert.deepEqual(preReviewGaps(t, DIFF, report.replace('a stale lock', 'a fresh lock'), r.repo)?.items, ['2. test name not found']);
    assert.deepEqual(preReviewGaps(t, DIFF, report)?.items, ['2. test file not in diff'], 'without a tree only the diff is read');
  } finally {
    r.store.close();
    r.done();
  }
});

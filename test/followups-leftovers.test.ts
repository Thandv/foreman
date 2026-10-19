import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { sweepJails } from '../src/archive.ts';
import { config } from '../src/config.ts';
import { createJail } from '../src/isolate.ts';
import { Store } from '../src/queue.ts';
import { Scheduler, briefFor, previousRound, repairBrief, repairOpening, type PreviousRound } from '../src/scheduler.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { reloadSpecs } from '../src/models.ts';
import { RunClock } from '../src/runClock.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';
import { FakeTime } from './fakeclock.ts';
import { Broker } from '../src/budget.ts';
import { createServer } from '../src/server.ts';
import { applyApproval, applyRejection } from '../src/gate.ts';
import { DEBRIEF_VERSION, classifyGate, collectDebrief, renderMarkdown, waitingOnSplit } from '../src/debrief.ts';
import { testHome } from './env.ts';
import { effectiveGate } from '../src/gate.ts';
import { crewReview } from '../src/verify/crewReview.ts';
import { queueCrewPlan, type CrewPlan } from '../src/assistant/crewPlan.ts';
import { briefPaths, chainIsAcyclic, diffHeaderPaths, sharedPath } from '../src/verify/followUpChain.ts';
import type { Decision, Run, Task, TaskStatus } from '../src/types.ts';

// The last batch of defects from the 2026-10-11 trial log. Every reviewer here is a shell script standing in for
// the claude CLI; no model is called.

// --------------------------------------------------------------- fixtures

const playbook = (id: string, gateDefault: 'human' | 'owner'): string =>
  `---\n${JSON.stringify({
    id,
    description: 'One reviewer, one chair.',
    triggers: [id],
    roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'senior', style: 'code-review' }],
    escalation: { chair: 'planner', afterFailures: 2 },
    checks: [],
    gate: { default: gateDefault, hardHuman: [] },
    constraints: [],
  }, null, 2)}\n---\n\n## role: planner\n\nYou chair the crew.\n\n## role: senior\n\nYou review what you did not write.\n\n## role: dev\n\nYou implement the ticket.\n`;

const made: string[] = [];
const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function withPlaybooks(): void {
  const dir = tmp('foreman-fl-pb-');
  fs.writeFileSync(path.join(dir, 'solo.md'), playbook('solo', 'human'));
  fs.writeFileSync(path.join(dir, 'auto.md'), playbook('auto', 'owner'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
}

type Issue = { title: string; prompt: string; severity?: string; role?: string };

/** A stand-in for the claude CLI: every call answers with a passing review that raises `issues`. */
function stubReviewer(issues: Issue[]): void {
  const dir = tmp('foreman-fl-cli-');
  const reply = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01,
    result: JSON.stringify({ verdict: 'pass', critique: 'fine', issues: issues.map((i) => ({ severity: 'normal', role: 'dev', ...i })) }),
  });
  fs.writeFileSync(path.join(dir, 'body'), reply);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(dir, 'body')}"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
}

function cleanupEnv(): void {
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
  delete process.env['FOREMAN_CLAUDE_BIN'];
}

const diffOf = (file: string, line = 'x'): string => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,2 +1,3 @@',
  ' export function auth(token) {',
  `+  // ${line}`,
  '   return verify(token);',
].join('\n');

/** A crew ticket with a live run: what a review needs. */
function ticket(store: Store, over: Partial<Task> & { title?: string } = {}): { task: Task; runId: string } {
  const task = store.addTask({
    title: over.title ?? 'Implement token auth',
    prompt: over.prompt ?? 'Add bearer-token auth to the API.',
    kind: 'code',
    runner: 'claude-code',
    role: 'dev',
    playbook: over.playbook ?? 'solo',
    acceptance: 'requests without a token get 401',
    parentId: over.parentId ?? null,
    ...(over.gate !== undefined ? { gate: over.gate } : {}),
    ...(over.repo !== undefined ? { repo: over.repo } : {}),
  });
  return { task: store.getTask(task.id)!, runId: store.startRun(task.id).id };
}

/** File `issues` on `t` through the real crew review, and return the follow-ups it filed, in filing order. */
async function review(store: Store, t: { task: Task; runId: string }, issues: Issue[], diff = diffOf('src/auth.ts')): Promise<Task[]> {
  stubReviewer(issues);
  const out = (await crewReview({ ...t, store, diff }))!;
  return out.filed.map((id) => store.getTask(id)!);
}

// --------------------------------------------------------------- 1. F13: a follow-up keeps its parent's hold

test('F13: a follow-up filed on a ticket held for a person is held for a person; an unheld parent\'s follow-up is as before', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    // The playbook's own default is the owner model, so the ticket's `gate` is the only thing holding it.
    const held = ticket(store, { playbook: 'auto', gate: 'human' });
    const [child] = await review(store, held, [{ title: 'cover the empty-token case', prompt: 'add a test' }]);
    assert.equal(child!.gate, 'human', 'the hold is on the follow-up\'s own row');
    assert.equal(effectiveGate(child!, 'owner'), 'human', 'and it is what decides, whatever the house default');

    // A follow-up of that follow-up: the hold travels down the chain.
    const grand = await review(store, { task: child!, runId: store.startRun(child!.id).id }, [{ title: 'reject a blank bearer value', prompt: 'another test' }], diffOf('src/auth.ts', 'second'));
    assert.equal(grand[0]!.gate, 'human');

    const unheld = ticket(store, { playbook: 'auto', title: 'Rotate the signing key' });
    const [plain] = await review(store, unheld, [{ title: 'log the rotation time', prompt: 'add a log line' }], diffOf('src/keys.ts'));
    assert.equal(plain!.gate, null, 'no gate of its own: resolved from the playbook and the house, as before');

    // Only the hold is inherited: a parent opted in to the owner gate does not opt its reviewer's follow-ups in.
    const opted = ticket(store, { playbook: 'solo', gate: 'owner', title: 'Tidy the session store' });
    const [notOpted] = await review(store, opted, [{ title: 'drop the unused session index', prompt: 'remove it' }], diffOf('src/session.ts'));
    assert.equal(notOpted!.gate, null);
    assert.equal(effectiveGate(notOpted!, null), 'human', 'the human-gated playbook still decides');

    // An operator's own ticket is untouched by any of this.
    assert.equal(store.addTask({ title: 'operator ticket', prompt: 'x', runner: 'echo' }).gate, null);
  } finally {
    store.close();
    cleanupEnv();
  }
});

// --------------------------------------------------------------- 2. F20 / F41 / F43: when a follow-up may start

const waits = (store: Store, id: string): string[] =>
  store.eventsForTask(id).map((e) => e.message).filter((m) => m.startsWith('waits for '));

/** An open ticket with a finished run whose recorded diff is `diff`. */
function withRecordedDiff(store: Store, over: Parameters<typeof ticket>[1], diff: string, dir = tmp('foreman-fl-art-')): { task: Task; file: string } {
  const t = ticket(store, over);
  const file = path.join(dir, `${t.runId}.diff`);
  fs.writeFileSync(file, diff);
  store.addArtifact({ runId: t.runId, taskId: t.task.id, type: 'diff', path: file, summary: null });
  return { task: t.task, file };
}

test('F20 (a): follow-ups filed on one ticket run one at a time, in filing order, and each one\'s timeline says what it waits for', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    const parent = ticket(store);
    const [a, b, c] = await review(store, parent, [
      { title: 'cover the empty-token case', prompt: 'add a test for it' },
      { title: 'reject a token with trailing spaces', prompt: 'trim, then compare' },
      { title: 'say which header was missing', prompt: 'name it in the 401 body' },
    ]);
    assert.deepEqual(a!.deps, [parent.task.id]);
    assert.deepEqual(new Set(b!.deps), new Set([parent.task.id, a!.id]));
    assert.deepEqual(new Set(c!.deps), new Set([parent.task.id, a!.id, b!.id]));
    assert.equal(c!.status, 'blocked');
    const said = waits(store, c!.id);
    assert.ok(said.some((m) => m.startsWith(`waits for ${parent.task.id}: `)), said.join(' | '));
    assert.ok(said.some((m) => m.startsWith(`waits for ${a!.id}: an earlier follow-up of ${parent.task.id}`)), said.join(' | '));
    assert.ok(said.some((m) => m.startsWith(`waits for ${b!.id}: `)));
    assert.ok(store.eventsForTask(c!.id).some((e) => e.message.includes('names no file')), 'rule (a) alone, and it says so');

    // One at a time: with the parent landed, only the first is released; the second follows the first.
    store.setStatus(parent.task.id, 'done');
    store.reconcileBlocked();
    assert.deepEqual([a, b, c].map((t) => store.getTask(t!.id)!.status), ['queued', 'blocked', 'blocked']);
    store.setStatus(a!.id, 'done');
    store.reconcileBlocked();
    assert.deepEqual([b, c].map((t) => store.getTask(t!.id)!.status), ['queued', 'blocked']);

    // A later review of the same ticket chains behind what is still OPEN only: `a` is done, `b` and `c` are not.
    const [d] = await review(store, { task: parent.task, runId: store.startRun(parent.task.id).id }, [
      { title: 'document the bearer scheme', prompt: 'two lines in the handbook' },
    ], diffOf('src/auth.ts', 'a later round'));
    assert.deepEqual(new Set(d!.deps), new Set([parent.task.id, b!.id, c!.id]));
    assert.ok(chainIsAcyclic(store, store.listTasks().map((t) => t.id)), 'no edge closed a cycle');
  } finally {
    store.close();
    cleanupEnv();
  }
});

test('F20 (b): a follow-up waits for an open ticket in the same repo that names a file its brief names — by recorded diff, or by another follow-up\'s brief', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    const repo = tmp('foreman-fl-repo-');
    const other = tmp('foreman-fl-repo2-');
    const FILE = 'src/helper/packages.ts';
    // An operator's ticket at the gate whose run changed the file.
    const operator = withRecordedDiff(store, { repo, title: 'Withhold the install button' }, diffOf(FILE));
    store.setStatus(operator.task.id, 'awaiting-approval');
    // The same file, but: another repo; already landed; an open ticket on another file; an EARLIER run's diff.
    const elsewhere = withRecordedDiff(store, { repo: other, title: 'Other repo' }, diffOf(FILE));
    const landed = withRecordedDiff(store, { repo, title: 'Landed already' }, diffOf(FILE));
    store.setStatus(landed.task.id, 'done');
    const unrelated = withRecordedDiff(store, { repo, title: 'Search index' }, diffOf('src/search.ts'));
    const rerun = withRecordedDiff(store, { repo, title: 'Re-run since' }, diffOf(FILE));
    const later = store.startRun(rerun.task.id);
    store.addArtifact({ runId: later.id, taskId: rerun.task.id, type: 'diff', path: unrelated.file, summary: null });
    // A follow-up of ANOTHER ticket, open, whose brief names the file by its bare name.
    const sibling = ticket(store, { repo, title: 'Sibling parent' });
    const [cousin] = await review(store, sibling, [{ title: 'packages.ts: the -r include is not followed', prompt: 'follow includes in `packages.ts`.' }], diffOf('src/other.ts'));

    const parent = ticket(store, { repo, title: 'No one-click install for private indexes' });
    const [filed, plain] = await review(store, parent, [
      { title: 'a name also listed in pyproject is offered', prompt: `In ${FILE}:120 the overlap check runs before the index rule. Fix it there.` },
      { title: 'say why the button is withheld', prompt: 'a tooltip would do' },
    ], diffOf('src/unrelated-to-all.ts'));

    assert.deepEqual(new Set(filed!.deps), new Set([parent.task.id, operator.task.id, cousin!.id]));
    const said = waits(store, filed!.id);
    assert.ok(said.includes(`waits for ${operator.task.id}: both name ${FILE} (in ${operator.task.id}'s recorded diff)`), said.join(' | '));
    assert.ok(said.includes(`waits for ${cousin!.id}: both name ${FILE}`), said.join(' | '));
    for (const not of [elsewhere, landed, unrelated, rerun]) assert.ok(!filed!.deps.includes(not.task.id), `${not.task.title} is not waited for`);
    // No path in the brief: rule (a) alone.
    assert.deepEqual(new Set(plain!.deps), new Set([parent.task.id, filed!.id]));
    assert.ok(chainIsAcyclic(store, store.listTasks().map((t) => t.id)));
  } finally {
    store.close();
    cleanupEnv();
  }
});

const statuses = (store: Store, ...tasks: Array<Task | undefined>): string[] => tasks.map((t) => store.getTask(t!.id)!.status);

/** Three follow-ups of one landed ticket: the first claimable, the other two in line behind it. */
async function threeInLine(store: Store): Promise<{ parent: Task; a: Task; b: Task; c: Task }> {
  const parent = ticket(store);
  const [a, b, c] = await review(store, parent, [
    { title: 'cover the empty-token case', prompt: 'add a test for it' },
    { title: 'reject a token with trailing spaces', prompt: 'trim, then compare' },
    { title: 'say which header was missing', prompt: 'name it in the 401 body' },
  ]);
  store.setStatus(parent.task.id, 'done');
  store.reconcileBlocked();
  assert.deepEqual(statuses(store, a, b, c), ['queued', 'blocked', 'blocked']);
  return { parent: parent.task, a: a!, b: b!, c: c! };
}

for (const how of ['canceled', 'failed', 'rejected'] as const) {
  test(`F20: the chain is an order, not a dependency — the first of three follow-ups ends ${how}: the second starts, the third still waits for the second`, async () => {
    withPlaybooks();
    const store = new Store(':memory:');
    try {
      const { a, b, c } = await threeInLine(store);
      if (how === 'canceled') store.cancel(a.id);
      else store.setStatus(a.id, how, how === 'failed' ? 'ran out of repairs' : 'no');
      store.reconcileBlocked();
      assert.deepEqual(statuses(store, b, c), ['queued', 'blocked'], 'nobody is failed for the one that left the line');
      assert.equal(store.getTask(b.id)!.error, null);
      store.reconcileBlocked();
      assert.deepEqual(statuses(store, b, c), ['queued', 'blocked'], 'the third is still behind the second');
      store.setStatus(b.id, 'done');
      store.reconcileBlocked();
      assert.equal(store.getTask(c.id)!.status, 'queued');
    } finally {
      store.close();
      cleanupEnv();
    }
  });
}

test('F20: the ticket a follow-up was filed on is still a real dependency — it fails, or is canceled, and every follow-up goes with it as on main', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    // Failed before it landed: each follow-up fails naming it, exactly main's words, and a retry revives them.
    const parent = ticket(store);
    const [a, b, c] = await review(store, parent, [
      { title: 'cover the empty-token case', prompt: 'add a test for it' },
      { title: 'reject a token with trailing spaces', prompt: 'trim, then compare' },
      { title: 'say which header was missing', prompt: 'name it in the 401 body' },
    ]);
    store.setStatus(parent.task.id, 'failed', 'rejected for good');
    store.reconcileBlocked();
    assert.deepEqual(statuses(store, a, b, c), ['failed', 'failed', 'failed']);
    for (const t of [a, b, c]) assert.equal(store.getTask(t!.id)!.error, `dependency ${parent.task.id} ended as failed`);
    store.retry(parent.task.id);
    assert.deepEqual(statuses(store, a, b, c), ['blocked', 'blocked', 'blocked'], 'revived to wait again');

    // Canceled by the operator: the cancel takes its children, as on main.
    const other = ticket(store, { title: 'Rotate the signing key' });
    const [x, y] = await review(store, other, [
      { title: 'log the rotation time', prompt: 'add a log line' },
      { title: 'alert on a failed rotation', prompt: 'page someone' },
    ], diffOf('src/keys.ts'));
    store.cancel(other.task.id);
    store.reconcileBlocked();
    assert.deepEqual(statuses(store, x, y), ['canceled', 'canceled']);
  } finally {
    store.close();
    cleanupEnv();
  }
});

test('F20: an operator\'s own --after is a dependency as on main: it ends canceled and the ticket behind it fails, whatever the ticket looks like', () => {
  const store = new Store(':memory:');
  try {
    const add = (title: string, over: Partial<Parameters<Store['addTask']>[0]> = {}): Task => store.addTask({ title, prompt: 'p', runner: 'echo', ...over });
    for (const how of ['canceled', 'failed', 'rejected'] as const) {
      const first = add(`first (${how})`);
      const plain = add('queued with --after', { deps: [first.id] });
      // A planned ticket under an epic, with a dependency on its sibling.
      const epic = add('epic', { isEpic: true });
      const planned = add('planned ticket', { parentId: epic.id, deps: [first.id] });
      // An operator's ticket whose prompt happens to open like a reviewer's follow-up, but which was filed on nothing.
      const lookalike = add('lookalike', { prompt: 'Filed by me, by hand', deps: [first.id] });
      if (how === 'canceled') store.cancel(first.id);
      else store.setStatus(first.id, how, 'no');
      store.reconcileBlocked();
      for (const t of [plain, planned, lookalike]) {
        assert.deepEqual([store.getTask(t.id)!.status, store.getTask(t.id)!.error], ['failed', `dependency ${first.id} ended as ${how}`], `${t.title} (${how})`);
      }
    }
  } finally {
    store.close();
  }
});

test('F20: a follow-up ordered behind another ticket by a shared file is released when that ticket is canceled, once its own parent has landed', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    const repo = tmp('foreman-fl-repo-');
    const operator = withRecordedDiff(store, { repo, title: 'Withhold the install button' }, diffOf('src/helper/packages.ts'));
    store.setStatus(operator.task.id, 'awaiting-approval');
    const parent = ticket(store, { repo, title: 'No one-click install for private indexes' });
    const [filed] = await review(store, parent, [{ title: 'fix the overlap', prompt: 'in src/helper/packages.ts' }], diffOf('src/z.ts'));
    assert.deepEqual(new Set(filed!.deps), new Set([parent.task.id, operator.task.id]));
    store.cancel(operator.task.id);
    store.reconcileBlocked();
    assert.equal(store.getTask(filed!.id)!.status, 'blocked', 'the order is gone; the parent has not landed yet');
    store.setStatus(parent.task.id, 'done');
    store.reconcileBlocked();
    assert.equal(store.getTask(filed!.id)!.status, 'queued');
  } finally {
    store.close();
    cleanupEnv();
  }
});

test('F20: a recorded diff that is not a regular file, or is too large, is not read; the plan says so and files the follow-up', async () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    const repo = tmp('foreman-fl-repo-');
    const dir = tmp('foreman-fl-art-');
    const real = path.join(dir, 'real.diff');
    fs.writeFileSync(real, diffOf('src/helper/packages.ts'));
    const linked = ticket(store, { repo, title: 'Symlinked artifact' });
    fs.symlinkSync(real, path.join(dir, 'link.diff'));
    store.addArtifact({ runId: linked.runId, taskId: linked.task.id, type: 'diff', path: path.join(dir, 'link.diff'), summary: null });
    const huge = ticket(store, { repo, title: 'Huge artifact' });
    fs.writeFileSync(path.join(dir, 'huge.diff'), `${diffOf('src/helper/packages.ts')}\n${'+x\n'.repeat(1_500_000)}`);
    store.addArtifact({ runId: huge.runId, taskId: huge.task.id, type: 'diff', path: path.join(dir, 'huge.diff'), summary: null });

    const parent = ticket(store, { repo, title: 'Parent' });
    const [filed] = await review(store, parent, [{ title: 'fix the overlap', prompt: 'in src/helper/packages.ts' }], diffOf('src/z.ts'));
    assert.deepEqual(filed!.deps, [parent.task.id]);
    const notes = store.eventsForTask(filed!.id).map((e) => e.message).filter((m) => m.startsWith('chain: '));
    assert.ok(notes.some((m) => m.includes(linked.task.id) && m.includes('could not be read')), notes.join(' | '));
    assert.ok(notes.some((m) => m.includes(huge.task.id) && m.includes('could not be read')), notes.join(' | '));
  } finally {
    store.close();
    cleanupEnv();
  }
});

test('F20: the path matcher reads briefs and diffs in one pass, bounded, and takes file names only', () => {
  assert.deepEqual(
    briefPaths('In `src/helper/packages.ts:120` and (test/x.test.mjs), see ./docs/SPEC-EASY.md, README.md. Not e.g. v1.2, node:fs, https://x.dev/a/b.ts, /abs/p.ts, ../up.ts or foo.bar().'),
    ['src/helper/packages.ts', 'test/x.test.mjs', 'docs/SPEC-EASY.md', 'README.md'],
  );
  assert.deepEqual(briefPaths(''), []);
  assert.deepEqual(briefPaths(null), []);
  // Text built to make a backtracking matcher crawl: it must simply come back, with nothing found.
  for (const hostile of ['-'.repeat(200_000), 'a/'.repeat(100_000), `${'a.'.repeat(100_000)}ts`, `${'x/'.repeat(90)}y.ts `.repeat(2_000), '.'.repeat(200_000), `${'\t'.repeat(100_000)}src/a.ts`]) {
    assert.ok(briefPaths(hostile).length <= 40);
  }
  assert.ok(briefPaths(Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`).join(' ')).length <= 40, 'the number of paths is capped');
  assert.deepEqual(diffHeaderPaths(`${diffOf('src/a.ts')}\n+++ b/${'q'.repeat(10_000)}\n--- a/src/b c.ts\t2026\n`), ['src/a.ts', 'src/b c.ts']);
  assert.equal(sharedPath(['src/a.ts'], ['lib/a.ts']), null, 'two full paths must be equal');
  assert.equal(sharedPath(['a.ts'], ['lib/a.ts']), 'a.ts', 'a bare name matches a path that ends in it');
  assert.equal(sharedPath(['lib/a.ts'], ['a.ts']), 'lib/a.ts');
});

test('F20: the cycle check refuses a graph that has one, and a chain that would reach the ticket itself', () => {
  const store = new Store(':memory:');
  try {
    const a = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
    const b = store.addTask({ title: 'b', prompt: 'x', runner: 'echo', deps: [a.id] });
    const c = store.addTask({ title: 'c', prompt: 'x', runner: 'echo', deps: [b.id] });
    assert.equal(chainIsAcyclic(store, [c.id]), true);
    assert.equal(chainIsAcyclic(store, [c.id], a.id), false, 'c already waits on a: a must not wait on c');
    // No Store method can write this edge; forced in, the check sees it.
    store.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?,?)').run(a.id, c.id);
    assert.equal(chainIsAcyclic(store, [c.id]), false);
  } finally {
    store.close();
  }
});

// --------------------------------------------------------------- 7 / 8. the decision routes

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

/** A ticket at the gate with a passing review. */
function parked(store: Store): Task {
  const task = store.addTask({ title: 'Add token auth', prompt: 'Add bearer-token auth.', kind: 'code', runner: 'echo' });
  const started = store.startRun(task.id);
  store.setTestsPassed(started.id, true);
  store.addVerdict({ runId: started.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], critique: 'read' });
  store.endRun(started.id, 'succeeded', { exitCode: 0, summary: 'added the middleware' });
  store.setStatus(task.id, 'awaiting-approval');
  return store.getTask(task.id)!;
}

test('cancel is never refused over its note: an absent, empty, malformed or over-long body cancels, and the answer says when the note was dropped', async () => {
  const h = await harness();
  try {
    type Answer = { status: string; decision: Decision | null; warning?: string };
    const cases: Array<{ name: string; body: string | undefined; warns: RegExp | null }> = [
      { name: 'no body', body: undefined, warns: null },
      { name: 'an empty body', body: '', warns: null },
      { name: 'blank', body: ' \n', warns: null },
      { name: 'cut-off JSON', body: '{"note": "the checks passed", "corrected": tru', warns: /^note not recorded: the request body is not JSON/ },
      { name: 'a bare word', body: 'stop', warns: /^note not recorded: the request body is not JSON/ },
      { name: 'a JSON string', body: '"stop"', warns: /^note not recorded: the request body is not a JSON object/ },
      { name: 'a list', body: '[1]', warns: /^note not recorded: the request body is not a JSON object/ },
      { name: 'a note that is not text', body: '{"note":5}', warns: /^note not recorded: note is not text/ },
      { name: 'over the limit', body: JSON.stringify({ note: 'x'.repeat(1_200_000) }), warns: /^note not recorded: the request body could not be read \(too large/ },
    ];
    for (const c of cases) {
      const task = parked(h.store);
      const res = await postRaw(`${h.base}/api/tasks/${task.id}/cancel`, c.body);
      assert.equal(res.status, 200, c.name);
      const out = await res.json() as Answer;
      assert.equal(out.status, 'canceled', c.name);
      assert.equal(h.store.getTask(task.id)!.status, 'canceled', c.name);
      assert.equal(h.store.getTask(task.id)!.error, 'canceled by operator', `${c.name}: the status note is main's`);
      assert.deepEqual(h.store.decisionsForTask(task.id).map((d) => [d.action, d.actor, d.note]), [['cancel', 'human', null]], c.name);
      if (c.warns) assert.match(out.warning ?? '', c.warns, c.name);
      else assert.equal(out.warning, undefined, c.name);
    }
    // A readable note is recorded, with no warning; a stray `corrected` does not stop the stop button either.
    const noted = parked(h.store);
    const ok = await (await postRaw(`${h.base}/api/tasks/${noted.id}/cancel`, JSON.stringify({ note: 'superseded', corrected: true }))).json() as Answer;
    assert.equal(ok.status, 'canceled');
    assert.equal(ok.warning, undefined);
    assert.equal(ok.decision?.note, 'superseded');
    // What a cancel refuses is unchanged: a ticket that is not there, or already ended.
    assert.equal((await postRaw(`${h.base}/api/tasks/t_nope/cancel`, 'stop')).status, 400);
    assert.equal((await postRaw(`${h.base}/api/tasks/${noted.id}/cancel`)).status, 400);
    // And approve keeps its 400: nothing is approved without what the caller sent.
    const kept = parked(h.store);
    assert.equal((await postRaw(`${h.base}/api/tasks/${kept.id}/approve`, '{"note": "x", "corrected": tru')).status, 400);
    assert.equal(h.store.getTask(kept.id)!.status, 'awaiting-approval');
  } finally {
    await h.close();
  }
});

test('corrected (--corrected / --clean) is refused on the reject, retry and reopen routes, before anything is decided', async () => {
  const h = await harness();
  const work = tmp('foreman-fl-reopen-');
  try {
    for (const corrected of [true, false]) {
      const atGate = parked(h.store);
      let res = await postRaw(`${h.base}/api/tasks/${atGate.id}/reject`, JSON.stringify({ note: 'no', corrected }));
      assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, /only means something on approve.*reject.*nothing was done/);
      assert.equal(h.store.getTask(atGate.id)!.status, 'awaiting-approval');

      const ended = parked(h.store);
      applyRejection(h.store, ended.id, 'no');
      res = await postRaw(`${h.base}/api/tasks/${ended.id}/retry`, JSON.stringify({ note: 'again', corrected }));
      assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, /only means something on approve.*retry/);
      assert.equal(h.store.getTask(ended.id)!.status, 'rejected');
      assert.equal(h.store.decisionsForTask(ended.id).filter((d) => d.action === 'retry').length, 0);

      const failed = h.store.addTask({ title: 'failed review', prompt: 'p', runner: 'echo' });
      const run = h.store.startRun(failed.id);
      h.store.setRunMeta(run.id, { worktreePath: work, branch: 'b' });
      h.store.addVerdict({ runId: run.id, taskId: failed.id, verdict: 'fail', disagreement: false, council: [], critique: 'c' });
      h.store.endRun(run.id, 'failed', { exitCode: 1, summary: 's' });
      h.store.setStatus(failed.id, 'failed', 'c');
      res = await postRaw(`${h.base}/api/tasks/${failed.id}/reopen`, JSON.stringify({ note: 'checked', corrected }));
      assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, /only means something on approve.*reopen/);
      assert.equal(h.store.getTask(failed.id)!.status, 'failed');

      // Without it (or with an explicit null, which is "not stated") all three go through as before.
      assert.equal((await postRaw(`${h.base}/api/tasks/${atGate.id}/reject`, JSON.stringify({ note: 'no', corrected: null }))).status, 200);
      assert.equal((await postRaw(`${h.base}/api/tasks/${ended.id}/retry`, JSON.stringify({ note: 'again' }))).status, 200);
      assert.equal((await postRaw(`${h.base}/api/tasks/${failed.id}/reopen`, JSON.stringify({ note: 'checked' }))).status, 200);
    }
    // On approve it is still what it was: recorded.
    const approved = parked(h.store);
    const out = await (await postRaw(`${h.base}/api/tasks/${approved.id}/approve`, JSON.stringify({ corrected: true }))).json() as { decision: Decision };
    assert.equal(out.decision.corrected, true);
  } finally {
    await h.close();
  }
});

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Run the CLI against a stub daemon that answers every request with `answer`; what it was sent is kept. */
async function cli(argv: string[], answer: unknown): Promise<{ stdout: string; stderr: string; code: number | null; sent: string[] }> {
  const sent: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      sent.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
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

test('CLI: --corrected / --clean on reject, retry and reopen are refused before anything is sent; cancel prints the daemon\'s "note not recorded"', async () => {
  const answer = { id: 't_x', status: 'queued', decision: null };
  for (const cmd of ['reject', 'retry', 'reopen']) {
    for (const flag of ['--corrected', '--clean']) {
      const r = await cli([cmd, 't_x', '--note', 'n', flag], answer);
      assert.notEqual(r.code, 0, `${cmd} ${flag}`);
      assert.deepEqual(r.sent, [], `${cmd} ${flag}: nothing reached the daemon`);
      assert.match(r.stderr + r.stdout, new RegExp(`${flag} goes with approve.*means nothing on a ${cmd}`), `${cmd} ${flag}`);
    }
    const plain = await cli([cmd, 't_x', '--note', 'n'], answer);
    assert.equal(plain.code, 0, `${cmd} without the flag goes through`);
    assert.deepEqual(plain.sent, [`POST /api/tasks/t_x/${cmd}`]);
  }
  const canceled = await cli(['cancel', 't_x', '--note', 'n'], { id: 't_x', status: 'canceled', decision: null, warning: 'note not recorded: note is not text' });
  assert.equal(canceled.code, 0);
  assert.match(canceled.stdout, /^note not recorded: note is not text$/m);
});

// --------------------------------------------------------------- 4. the idle re-check and runs parked for a person

type ParkKind = 'timed-out-twice' | 'behind-main' | 'nothing-to-change' | 'ordinary';

/**
 * A ticket at the gate as each park leaves it ON THE RECORD (test/gate-env*.test.ts pin that the real parks write
 * exactly these fields): the latest run ended 'succeeded'; its checks did not pass (a double timeout, a red gate on
 * a jail behind main), or it recorded no diff (nothing to change). `verdictOn` says where the provisional verdict
 * sits: on an EARLIER run of the ticket, or on the parked run itself (a person's re-review on stepped-down models).
 */
async function recheckRig(kind: ParkKind, verdictOn: 'earlier-run' | 'parked-run', fn: (ctx: {
  store: Store; sched: Scheduler; taskId: string; reviews: () => number; idle: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const dir = tmp('foreman-fl-recheck-');
  const store = new Store(':memory:');
  let reviews = 0;
  // The echo runner: were a repair round ever queued and claimed here, no model would be called.
  const task = store.addTask({ title: 'fix the parser', prompt: 'fix it', kind: 'code', runner: 'echo', repo: dir, maxRepairs: 2 });
  const sched = new Scheduler(store, {
    verifyEnabled: false,
    broker: new Broker(store, { guardResidency: false, fitsFn: async () => true }),
    // The full council, once it "fits": it fails whatever it is shown.
    verify: async ({ runId }) => {
      reviews++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'fail', disagreement: false, council: [], critique: 'TEST RESULT: FAILED' });
    },
  });
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, diffOf('src/parser.ts'));
  const earlier = store.startRun(task.id);
  store.addArtifact({ runId: earlier.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
  store.endRun(earlier.id, 'failed', { summary: 'first attempt' });
  if (verdictOn === 'earlier-run') store.addVerdict({ runId: earlier.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
  // rowid breaks a same-millisecond tie, so this one is the latest run.
  const parkedRun = store.startRun(task.id);
  if (kind !== 'nothing-to-change') store.addArtifact({ runId: parkedRun.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
  if (kind === 'timed-out-twice' || kind === 'behind-main') store.setTestsPassed(parkedRun.id, false);
  if (kind === 'ordinary') store.setTestsPassed(parkedRun.id, true);
  store.endRun(parkedRun.id, 'succeeded', { summary: 'the worker reported its work' });
  if (verdictOn === 'parked-run') store.addVerdict({ runId: parkedRun.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
  const note = kind === 'timed-out-twice' ? 'gate timed out twice (7 s each); not charged to the worker — nothing had finished. No failing test was named and no reviewer was called: a person decides.'
    : kind === 'behind-main' ? 'jail is 3 commits behind main; 2 of them change test files: test/a.test.js'
    : kind === 'nothing-to-change' ? 'no change produced — approve to close as "nothing to change", or reject with what is missing. Worker said: (nothing)'
    : 'provisional pass from stepped-down models — re-checked by the full council once it fits';
  store.setStatus(task.id, 'awaiting-approval', note);
  process.env['FOREMAN_RECHECK_MS'] = '0';
  const idle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await sched.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    await fn({ store, sched, taskId: task.id, reviews: () => reviews, idle });
  } finally {
    delete process.env['FOREMAN_RECHECK_MS'];
    await sched.stop();
    store.close();
  }
}

for (const kind of ['timed-out-twice', 'behind-main', 'nothing-to-change'] as const) {
  test(`idle re-check: a '${kind}' park whose only provisional verdict is an EARLIER run's is not listed and not reviewed`, async () => {
    await recheckRig(kind, 'earlier-run', async ({ store, taskId, reviews, idle }) => {
      assert.deepEqual(store.provisionalAwaiting(200).map((t) => t.id), [], 'listed by the run it would review, not by the ticket\'s newest verdict');
      await idle();
      assert.equal(reviews(), 0, 'no reviewer was called');
      const after = store.getTask(taskId)!;
      assert.deepEqual([after.status, after.repairs], ['awaiting-approval', 0], 'no repair round spent');
    });
  });

  test(`idle re-check: a '${kind}' park is left alone by what its run recorded — with a provisional verdict on that very run, and with its note cleared`, async () => {
    await recheckRig(kind, 'parked-run', async ({ store, taskId, reviews, idle }) => {
      await idle();
      assert.equal(reviews(), 0, 'not re-checked with its park note in place');
      // The note is Foreman's to rewrite (a re-review that passes clears it): nothing here may rest on it.
      store.setStatus(taskId, 'awaiting-approval', null);
      await idle();
      store.setStatus(taskId, 'awaiting-approval', 'council split — needs your call');
      await idle();
      assert.equal(reviews(), 0, 'still not re-checked once the note is gone or rewritten');
      const after = store.getTask(taskId)!;
      assert.deepEqual([after.status, after.repairs, after.repairNotes], ['awaiting-approval', 0, null], 'no repair round spent');
    });
  });
}

test('idle re-check: an ordinary provisional review of the latest run is still re-checked, and a confirmed fail still gets its repair round', async () => {
  await recheckRig('ordinary', 'parked-run', async ({ store, taskId, reviews, idle }) => {
    assert.deepEqual(store.provisionalAwaiting(200).map((t) => t.id), [taskId]);
    await idle();
    assert.equal(reviews(), 1);
    assert.equal(store.getTask(taskId)!.repairs, 1);
  });
});

test('idle re-check: an ordinary park whose provisional verdict belongs to an earlier run is not re-checked on that verdict', async () => {
  await recheckRig('ordinary', 'earlier-run', async ({ store, reviews, idle }) => {
    assert.deepEqual(store.provisionalAwaiting(200), []);
    await idle();
    assert.equal(reviews(), 0);
  });
});

// --------------------------------------------------------------- 3. the repair brief says what happened

/** The two opening lines as they are on main (159e152), to the byte. */
const MAIN_RESUMED = 'Your previous attempt in this session was REJECTED by the verification council. Fix exactly this and nothing else:';
const MAIN_COLD = 'A previous attempt was REJECTED by the verification council. Fix exactly this and nothing else:';

const round = (over: Partial<Run>, reviewerFailed = false): PreviousRound => ({
  run: { id: 'r_prev', status: 'failed', stage: 'work', verdict: null, testsPassed: null, endedReason: 'ok', turnLimit: null, ...over },
  reviewerFailed,
});

test('repair brief: after a council or crew rejection every byte is main\'s, resumed and cold, whatever else the run recorded', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'Add token auth', prompt: 'Add bearer-token auth.', kind: 'code', runner: 'claude-code', acceptance: '1. 401 without a token' });
    store.db.prepare('UPDATE tasks SET repair_notes = ?, operator_demands = ? WHERE id = ?').run('reviewer: add the missing test', 'A HUMAN said: keep the header name', t.id);
    const task = store.getTask(t.id)!;
    // Callers that know nothing of the run before (and every caller on main) get main's line.
    const mainWarm = repairBrief(task);
    const mainCold = briefFor(store, task);
    assert.ok(mainWarm.startsWith(`${MAIN_RESUMED}\nreviewer: add the missing test`), mainWarm.slice(0, 200));
    assert.ok(mainCold.includes(`\n---\n${MAIN_COLD}\nreviewer: add the missing test`), mainCold);
    for (const prev of [
      round({ verdict: 'fail' }, true),
      // A reviewer's fail is a rejection even when the run then ran out of time before the repair was queued.
      round({ verdict: 'fail', endedReason: 'deadline' }, true),
      round({ verdict: 'fail', status: 'succeeded', stage: 'gate', testsPassed: true }, true),
      // A fail on record with nothing to say it was the test stage (a run from before the result was kept): main's line.
      round({ verdict: 'fail', testsPassed: null }, false),
      // Nothing recorded about how it ended (a run from before the column, a daemon stop): main's line.
      round({ endedReason: null }),
      null,
    ]) {
      assert.equal(repairBrief(task, prev), mainWarm);
      assert.equal(briefFor(store, task, undefined, undefined, prev), mainCold);
    }
    // And the store's own reading of a real rejection: a verdict row with reviewers on it, on the run before.
    const rejectedRun = store.startRun(t.id);
    store.addVerdict({
      runId: rejectedRun.id, taskId: t.id, verdict: 'fail', disagreement: false, critique: 'no',
      council: [{ model: 'm', provider: 'ollama', local: true, verdict: 'fail', confidence: 0.9, critique: 'no', costUsd: 0, latencyMs: 1 }],
    });
    store.endRun(rejectedRun.id, 'failed', { summary: 's' });
    const next = store.startRun(t.id);
    const seen = previousRound(store, t.id, next.id)!;
    assert.deepEqual([seen.run.id, seen.reviewerFailed], [rejectedRun.id, true]);
    assert.equal(repairBrief(task, seen), mainWarm);
  } finally {
    store.close();
  }
});

// One test per cause. Each line comes from the previous run's recorded fields alone.
const CAUSES: Array<{ cause: string; run: Partial<Run>; reviewerFailed?: boolean; testCmd?: string | null; warm: string; cold: string }> = [
  {
    cause: 'a council or crew review failed it', run: { verdict: 'fail', stage: 'verify', testsPassed: true }, reviewerFailed: true,
    warm: MAIN_RESUMED, cold: MAIN_COLD,
  },
  {
    cause: 'the project\'s tests failed at the gate', run: { verdict: 'fail', stage: 'test', testsPassed: false }, testCmd: 'npm run verify --silent',
    warm: 'The project\'s tests failed at the gate (npm run verify --silent); nothing was reviewed yet. Your work is in place: continue from it. Fix exactly this and nothing else:',
    cold: 'The project\'s tests failed at the gate (npm run verify --silent); nothing was reviewed yet. Fix exactly this and nothing else:',
  },
  {
    cause: 'the tests failed at the gate and the ticket names no command', run: { verdict: 'fail', stage: 'test', testsPassed: false }, testCmd: null,
    warm: 'The project\'s tests failed at the gate; nothing was reviewed yet. Your work is in place: continue from it. Fix exactly this and nothing else:',
    cold: 'The project\'s tests failed at the gate; nothing was reviewed yet. Fix exactly this and nothing else:',
  },
  {
    cause: 'the pre-review check sent it back', run: { status: 'failed', verdict: null, endedReason: 'ok', stage: 'verify' },
    warm: 'Your previous run was sent back by Foreman\'s own pre-review checks; no reviewer was called and nothing was rejected. Your work is in place: continue from it. Do exactly this and nothing else:',
    cold: 'The previous run was sent back by Foreman\'s own pre-review checks; no reviewer was called and nothing was rejected. Do exactly this and nothing else:',
  },
  {
    cause: 'the run deadline', run: { endedReason: 'deadline', stage: 'test' },
    warm: 'Your previous run reached its time limit during its test stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    // Cold: a new tree may be under it, so nothing is said about the work being in place.
    cold: 'The previous run reached its time limit during its test stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'the turn ceiling', run: { endedReason: 'turn-ceiling', turnLimit: 9 },
    warm: 'Your previous run stopped at its turn limit (9 turns) during its work stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    cold: 'The previous run stopped at its turn limit (9 turns) during its work stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'the provider limit', run: { endedReason: 'provider-limit' },
    warm: 'Your previous run was stopped by the provider\'s usage limit during its work stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    cold: 'The previous run was stopped by the provider\'s usage limit during its work stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'the tripwire', run: { endedReason: 'tripwire' },
    warm: 'Your previous run was stopped by Foreman for writing outside its working directory during its work stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    cold: 'The previous run was stopped by Foreman for writing outside its working directory during its work stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'an operator retry of a canceled run', run: { endedReason: 'canceled', status: 'canceled' },
    warm: 'Your previous run was canceled during its work stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    cold: 'The previous run was canceled during its work stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'an operator retry of a run that ended on an error', run: { endedReason: 'error' },
    warm: 'Your previous run ended on an error during its work stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:',
    cold: 'The previous run ended on an error during its work stage; nothing was rejected. The notes below still stand; do exactly this and nothing else:',
  },
  {
    cause: 'an operator sent back a gate-timeout (or behind-main) park', run: { status: 'succeeded', stage: 'gate', testsPassed: false, verdict: null, endedReason: 'ok' },
    warm: 'Your previous run was parked for a person because its checks did not finish or pass (a gate that timed out twice, or tests main has since changed), and the operator sent it back; no reviewer rejected it. Your work is in place: continue from it. Do exactly this and nothing else:',
    cold: 'The previous run was parked for a person because its checks did not finish or pass (a gate that timed out twice, or tests main has since changed), and the operator sent it back; no reviewer rejected it. Do exactly this and nothing else:',
  },
  {
    cause: 'an operator sent back work that had reached the gate', run: { status: 'succeeded', stage: 'gate', testsPassed: true, verdict: 'pass', endedReason: 'ok' },
    warm: 'Your previous run reached the gate and the operator sent it back; the verification council did not reject it. Your work is in place: continue from it. Do exactly this and nothing else:',
    cold: 'The previous run reached the gate and the operator sent it back; the verification council did not reject it. Do exactly this and nothing else:',
  },
];

for (const c of CAUSES) {
  test(`repair brief, by cause — ${c.cause}`, () => {
    const prev = round(c.run, c.reviewerFailed ?? false);
    assert.equal(repairOpening(prev, true, c.testCmd), c.warm);
    assert.equal(repairOpening(prev, false, c.testCmd), c.cold);
    // And in the briefs themselves, resumed and cold, ahead of the notes.
    const store = new Store(':memory:');
    try {
      const t = store.addTask({ title: 'Add token auth', prompt: 'Add bearer-token auth.', kind: 'code', runner: 'claude-code', testCmd: c.testCmd ?? null });
      store.db.prepare('UPDATE tasks SET repair_notes = ? WHERE id = ?').run('NOTES-GO-HERE', t.id);
      const task = store.getTask(t.id)!;
      assert.ok(repairBrief(task, prev).startsWith(`${c.warm}\nNOTES-GO-HERE`));
      assert.ok(briefFor(store, task, undefined, undefined, prev).includes(`\n---\n${c.cold}\nNOTES-GO-HERE`));
    } finally {
      store.close();
    }
    if (!c.reviewerFailed) assert.doesNotMatch(c.warm + c.cold, /REJECTED/);
  });
}

/** A stand-in `claude` that records each `-p` prompt, says one line and then blocks until released. */
function blockingClaude(): { dir: string; bin: string; prompt: () => string | null; forget: () => void; release: () => void } {
  const dir = tmp('foreman-fl-claude-');
  const bin = path.join(dir, 'claude');
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });
  const said = JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'still working' }] } });
  fs.writeFileSync(path.join(dir, 'transcript'), `${init}\n${said}\n`);
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'case "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac',
    `while [ $# -gt 0 ]; do if [ "$1" = "-p" ]; then printf '%s' "$2" > "${path.join(dir, 'prompt.tmp')}"; mv "${path.join(dir, 'prompt.tmp')}" "${path.join(dir, 'prompt')}"; fi; shift; done`,
    `cat "${path.join(dir, 'transcript')}"`,
    `while [ ! -f "${path.join(dir, 'release')}" ]; do sleep 0.1; done`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  const file = path.join(dir, 'prompt');
  return {
    dir, bin,
    prompt: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
    forget: () => fs.rmSync(file, { force: true }),
    release: () => fs.writeFileSync(path.join(dir, 'release'), ''),
  };
}

async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('repair brief: a repair round whose run reached its DEADLINE is resumed with a brief that says so, not "REJECTED by the verification council"', { timeout: 180_000 }, async () => {
  const cli = blockingClaude();
  const keys = ['FOREMAN_CLAUDE_BIN', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_CLAUDE_ARGS'] as const;
  const prev = keys.map((k) => process.env[k]);
  process.env['FOREMAN_CLAUDE_BIN'] = cli.bin;
  process.env['FOREMAN_LOCAL_ONLY'] = 'off';
  delete process.env['FOREMAN_CLAUDE_ARGS'];
  setCloudDown(null);
  reloadSpecs();
  resetPreflightCache();
  const time = new FakeTime();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, verifyEnabled: false, maxWorkers: 1, taskTimeoutMs: 60 * 60_000,
    runClock: (budgetMs, onExpire) => new RunClock(budgetMs, onExpire, time.now, time),
  });
  try {
    const t = store.addTask({ title: 'slow repair', prompt: 'x', runner: 'claude-code', maxAttempts: 3 });
    // A repair round is under way: the notes hold the critique of an earlier review.
    store.db.prepare('UPDATE tasks SET repair_notes = ?, repairs = 1 WHERE id = ?').run('reviewer: cover the empty-token case', t.id);
    const working = (n: number) => (): boolean =>
      store.eventsForTask(t.id, 10_000).filter((e) => e.type === 'log' && e.message === 'still working').length >= n;
    void sched.tick();
    await until(working(1), 'the first round to be mid-turn');
    cli.forget();
    time.advance(61 * 60_000);
    await until(() => store.runsForTask(t.id).some((r) => r.endedReason === 'deadline'), 'the run to end on its deadline');
    await until(() => { void sched.tick(); return working(2)(); }, 'the requeued round to be mid-turn');
    const sent = cli.prompt()!;
    // The stage is the one the timed-out run's own row holds.
    const stage = store.runsForTask(t.id).find((r) => r.endedReason === 'deadline')!.stage;
    assert.ok(
      sent.startsWith(`Your previous run reached its time limit during its ${stage} stage; nothing was rejected. Your work is in place: continue from it. The notes below still stand; do exactly this and nothing else:\nreviewer: cover the empty-token case`),
      sent.slice(0, 300),
    );
    assert.doesNotMatch(sent, /REJECTED by the verification council/);
    assert.ok(store.eventsForTask(t.id, 10_000).some((e) => /^resuming claude session s-1/.test(e.message)), 'it was the resumed brief, in the kept jail');
  } finally {
    cli.release();
    await sched.stop();
    store.close();
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
    setCloudDown(null);
    reloadSpecs();
    resetPreflightCache();
  }
});

// --------------------------------------------------------------- 5. kept jails of failed tasks are swept

const DAY = 86_400_000;
const gitIn = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function sweepRepo(): string {
  const dir = fs.realpathSync(tmp('foreman-fl-sweep-'));
  gitIn(dir, 'init', '-q'); gitIn(dir, 'config', 'user.email', 't@e.x'); gitIn(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A task with one run in a real worktree, last moved `agoDays` ago with `status`; `work` leaves an uncommitted change, `diff` records the run's diff artifact. */
async function jailed(store: Store, repo: string, status: TaskStatus, agoDays: number, opts: { work?: boolean; diff?: boolean | 'empty' | 'symlink' } = {}) {
  const task = store.addTask({ title: `${status} ${agoDays}d`, prompt: 'p', kind: 'code', runner: 'echo', repo });
  const run = store.startRun(task.id);
  const jail = await createJail(task, run.id);
  store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch, baseCommit: jail.baseCommit ?? null });
  if (opts.work !== false) fs.writeFileSync(path.join(jail.dir, 'work.txt'), 'half done\n');
  if (opts.diff) {
    const file = path.join(tmp('foreman-fl-sweep-art-'), `${run.id}.diff`);
    if (opts.diff === 'symlink') {
      fs.writeFileSync(`${file}.real`, diffOf('work.txt'));
      fs.symlinkSync(`${file}.real`, file);
    } else {
      fs.writeFileSync(file, opts.diff === 'empty' ? '' : diffOf('work.txt'));
    }
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: file, summary: null });
  }
  store.endRun(run.id, 'failed', { exitCode: 1, summary: 'ran out of time' });
  store.setStatus(task.id, status);
  store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - agoDays * DAY, task.id);
  return { task, run, jail };
}

test('jail sweep: a failed task\'s worktree goes after FOREMAN_FAILED_JAIL_RETAIN_DAYS once its diff artifact is on disk — and only a failed task\'s', async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  try {
    assert.equal(config.failedJailRetainDays, 14, 'the default bound');
    const old = await jailed(store, repo, 'failed', 20, { diff: true });
    const young = await jailed(store, repo, 'failed', 10, { diff: true });
    // The same age and the same recorded diff, but not failed: at the gate, queued again (a repair round, a retry), waiting, running.
    const others = [];
    for (const status of ['awaiting-approval', 'queued', 'blocked', 'running', 'verifying', 'awaiting-human'] as const) others.push(await jailed(store, repo, status, 20, { diff: true }));
    // Failed on the books, with a run that is still going (a round re-queued and claimed while the row was read).
    const live = await jailed(store, repo, 'failed', 20, { diff: true });
    store.startRun(live.task.id);
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 20 * DAY, live.task.id);

    const out = await sweepJails(store, { retainDays: 3 });
    assert.deepEqual(out.removed, [old.jail.dir]);
    assert.equal(fs.existsSync(old.jail.dir), false);
    assert.ok(!gitIn(repo, 'worktree', 'list', '--porcelain').includes(path.basename(old.jail.dir)), 'its registration went with it');
    for (const kept of [young, live, ...others]) assert.ok(fs.existsSync(path.join(kept.jail.dir, 'work.txt')), `${kept.task.title} keeps its work`);
    assert.deepEqual([out.keptNoDiff, out.keptUnreadable], [[], []]);

    // The bound is at least a day, and a negative one turns this half off without touching the other.
    const fresh = await jailed(store, repo, 'failed', 0.1, { diff: true });
    assert.deepEqual((await sweepJails(store, { failedRetainDays: 0 })).removed, [young.jail.dir], 'ten days old goes under a 1-day floor; two hours old does not');
    assert.ok(fs.existsSync(fresh.jail.dir));
    const later = await jailed(store, repo, 'failed', 40, { diff: true });
    assert.deepEqual((await sweepJails(store, { failedRetainDays: -1 })).removed, []);
    assert.ok(fs.existsSync(later.jail.dir));
    // And the landed half being off does not turn the failed half off.
    assert.deepEqual((await sweepJails(store, { retainDays: -1 })).removed, [later.jail.dir]);
  } finally {
    store.close();
  }
});

test('jail sweep: a failed task\'s worktree whose work is not recoverable is kept and reported; an unchanged one goes', async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  try {
    const noDiff = await jailed(store, repo, 'failed', 20, {});
    const emptyDiff = await jailed(store, repo, 'failed', 20, { diff: 'empty' });
    const linkedDiff = await jailed(store, repo, 'failed', 20, { diff: 'symlink' });
    const goneDiff = await jailed(store, repo, 'failed', 20, { diff: true });
    fs.rmSync(store.artifactsForTask(goneDiff.task.id)[0]!.path);
    const committed = await jailed(store, repo, 'failed', 20, { work: false });
    fs.writeFileSync(path.join(committed.jail.dir, 'c.txt'), 'committed in the jail\n');
    gitIn(committed.jail.dir, 'add', '-A'); gitIn(committed.jail.dir, 'commit', '-qm', 'the worker committed');
    const unchanged = await jailed(store, repo, 'failed', 20, { work: false });
    const unreadable = await jailed(store, repo, 'failed', 20, {});
    fs.writeFileSync(path.join(unreadable.jail.dir, '.git'), 'gitdir: /nowhere\n');
    // A resumed round: the tree is the first run's, the LAST run to use it recorded no diff.
    const resumed = await jailed(store, repo, 'failed', 20, { diff: true });
    const again = store.startRun(resumed.task.id);
    store.setRunMeta(again.id, { worktreePath: resumed.jail.dir, branch: resumed.jail.branch });
    store.endRun(again.id, 'failed', { summary: 'timed out' });
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 20 * DAY, resumed.task.id);
    // A scratch directory of a failed task with no repo: nothing to recover it from.
    const scratchTask = store.addTask({ title: 'scratch', prompt: 'p', runner: 'echo' });
    const scratchRun = store.startRun(scratchTask.id);
    const scratch = await createJail(scratchTask, scratchRun.id);
    fs.writeFileSync(path.join(scratch.dir, 'out.md'), 'a draft\n');
    store.setRunMeta(scratchRun.id, { worktreePath: scratch.dir, branch: null });
    store.endRun(scratchRun.id, 'failed', { summary: 's' });
    store.setStatus(scratchTask.id, 'failed');
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 20 * DAY, scratchTask.id);

    const out = await sweepJails(store, {});
    assert.deepEqual(out.removed, [unchanged.jail.dir], 'only the tree with nothing in it');
    assert.deepEqual(new Set(out.keptNoDiff), new Set([noDiff, emptyDiff, linkedDiff, goneDiff, committed, resumed].map((j) => j.jail.dir).concat(scratch.dir)));
    assert.deepEqual(out.keptUnreadable, [unreadable.jail.dir]);
    for (const kept of [noDiff, emptyDiff, linkedDiff, goneDiff, resumed]) assert.ok(fs.existsSync(path.join(kept.jail.dir, 'work.txt')), kept.task.title);
    assert.ok(fs.existsSync(path.join(committed.jail.dir, 'c.txt')));
    assert.ok(fs.existsSync(path.join(scratch.dir, 'out.md')));
  } finally {
    store.close();
  }
});

test('jail sweep: a failed task\'s unchanged-tree check that errors, or does not answer in time, keeps the tree', async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  try {
    // Unchanged trees with no diff artifact: the only thing between them and removal is the check's answer.
    const a = await jailed(store, repo, 'failed', 20, { work: false });
    const asked: string[] = [];
    const errors = await sweepJails(store, { jailChanged: async (jail) => { asked.push(jail.dir); throw new Error('git: index file corrupt'); } });
    assert.deepEqual([errors.removed, errors.keptUnreadable], [[], [a.jail.dir]]);
    assert.deepEqual(asked, [a.jail.dir], 'the check was given this jail, with the real repo and the recorded base');
    // A check that never answers (a hung git): the sweep gives up on it after its bound and keeps the tree.
    const hangs = await sweepJails(store, { jailChanged: () => new Promise<boolean>(() => {}), changeCheckMs: 30 });
    assert.deepEqual([hangs.removed, hangs.keptUnreadable], [[], [a.jail.dir]]);
    // An answer that comes after the bound is not acted on.
    const late = await sweepJails(store, { jailChanged: () => new Promise<boolean>((r) => setTimeout(() => r(false), 400)), changeCheckMs: 30 });
    assert.deepEqual([late.removed, late.keptUnreadable], [[], [a.jail.dir]]);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(fs.existsSync(a.jail.dir), 'still there after the late answer arrived');
    // "Changed" keeps it too; only a timely "unchanged" lets it go.
    assert.deepEqual((await sweepJails(store, { jailChanged: async () => true })).keptNoDiff, [a.jail.dir]);
    assert.deepEqual((await sweepJails(store, { jailChanged: async () => false })).removed, [a.jail.dir]);
    // With a diff artifact on disk the check is not asked at all.
    const b = await jailed(store, repo, 'failed', 20, { diff: true });
    let calls = 0;
    assert.deepEqual((await sweepJails(store, { jailChanged: async () => { calls++; return true; } })).removed, [b.jail.dir]);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('jail sweep: a .deps-tmp staging directory goes only when its jail is gone', async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  try {
    const kept = await jailed(store, repo, 'failed', 1, { diff: true });
    const swept = await jailed(store, repo, 'failed', 20, { diff: true });
    const staging = (dir: string): string => path.join(path.dirname(dir), `.${path.basename(dir)}.deps-tmp`);
    const orphan = path.join(path.dirname(kept.jail.dir), '.r_longgone.deps-tmp');
    for (const dir of [staging(kept.jail.dir), staging(swept.jail.dir), orphan]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'half'), 'x');
    }
    const other = path.join(path.dirname(kept.jail.dir), '.not-a-staging-dir');
    fs.mkdirSync(other, { recursive: true });
    const out = await sweepJails(store, {});
    assert.deepEqual(out.removed, [swept.jail.dir]);
    assert.deepEqual(new Set(out.staging), new Set([orphan, staging(swept.jail.dir)]));
    assert.ok(fs.existsSync(staging(kept.jail.dir)), 'a live jail\'s staging directory is left alone');
    assert.ok(fs.existsSync(other));
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    store.close();
  }
});

// --------------------------------------------------------------- 9. debrief

/** A ticket parked on a crew split: the reviewer could not verify items 2 and 3. */
function parkedOnSplit(store: Store, title: string): Task {
  const task = store.addTask({ title, prompt: 'p', kind: 'general', runner: 'echo', acceptance: '1. a\n2. b\n3. c' });
  const run = store.startRun(task.id);
  store.addVerdict({
    runId: run.id, taskId: task.id, verdict: 'split', disagreement: false, source: 'crew', critique: 'could not see the fixture',
    council: [{
      model: 'opus', provider: 'claude-cli', local: false, verdict: 'pass', confidence: 0.8, critique: 'could not see the fixture', costUsd: 0, latencyMs: 1,
      acceptance: [{ item: 1, status: 'met', note: '' }, { item: 2, status: 'not-verifiable', note: 'the fixture is not in the diff' }, { item: 3, status: 'unreported', note: '' }],
    }],
  });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'did it' });
  store.setStatus(task.id, 'awaiting-approval', 'the reviewer could not verify acceptance item 2 — a person decides');
  return store.getTask(task.id)!;
}

const md = (collect: ReturnType<typeof collectDebrief>): string => renderMarkdown({
  version: DEBRIEF_VERSION, collect, notes: [], noteProblems: [],
  diagnosis: { state: 'skipped', reason: '', alias: null, local: null, costUsd: 0, estimatedUsd: 0, findings: [], proposalsRanked: [], dropped: [], promptCuts: [], rawReply: '' },
});

test('debrief: a person approving a ticket whose latest verdict is split is approved-unverified on the ledger\'s record, and counted as a signal', async () => {
  const store = new Store(':memory:');
  try {
    const t = parkedOnSplit(store, 'Approved on a split');
    await applyApproval(store, t.id, { source: 'human', note: 'looked at it myself' });
    assert.equal(store.getTask(t.id)!.status, 'done');
    const doc = collectDebrief(store, t.id, { home: testHome });
    const g = doc.tickets[0]!.gateDisagreement;
    assert.deepEqual([g.class, g.how], ['approved-unverified', 'ledger']);
    assert.match(g.signals.join(' | '), /operator approved after a crew split: no review verdict stood behind the approval/);
    assert.deepEqual(doc.gate['approved-unverified'], [t.id]);
    assert.deepEqual(doc.gate.agreed, []);
    assert.equal(doc.signals.find((x) => x.kind === 'gate:approved-unverified')?.count, 1);
    assert.match(md(doc), /\*\*approved-unverified\*\* \(1\)/);

    // The class by itself, against its neighbours.
    const split = [{ at: 10, source: 'crew', verdict: 'split' }];
    const land = { asIs: '', changedAfterReview: 0 };
    const act = (action: 'approve' | 'reject', note = '', by: 'human' | 'owner-gate' = 'human') => [{ at: 20, action, by, note, noteSource: '' as const }];
    assert.equal(classifyGate(act('approve'), split, land, 'done').class, 'approved-unverified');
    assert.equal(classifyGate(act('approve'), split, land, 'done', { corrected: false, source: 'operator' }).class, 'approved-unverified', '--clean does not make a split a review');
    assert.equal(classifyGate(act('approve', 'approve + on-top'), split, land, 'done').class, 'corrected-at-gate', 'a correction still outranks it');
    assert.equal(classifyGate(act('approve'), split, land, 'done', { corrected: true, source: 'operator' }).class, 'corrected-at-gate');
    assert.equal(classifyGate(act('reject', 'no'), split, land, 'rejected').class, 'rejected-at-gate');
    assert.equal(classifyGate(act('approve', '', 'owner-gate'), split, land, 'done').class, 'unknown', 'a model\'s approval is not a person\'s');
    // A split that a later pass replaced before the approval is an ordinary agreement, as before.
    assert.equal(classifyGate(act('approve'), [...split, { at: 15, source: 'crew', verdict: 'pass' }], land, 'done').class, 'agreed');
    assert.equal(classifyGate(act('approve'), [{ at: 10, source: 'crew', verdict: 'pass' }], land, 'done').class, 'agreed');
  } finally {
    store.close();
  }
});

test('debrief: a ticket parked on a split with no decision yet is listed as waiting for a person, with the items the reviewer could not verify', async () => {
  const store = new Store(':memory:');
  try {
    const t = parkedOnSplit(store, 'Parked on a split');
    const doc = collectDebrief(store, t.id, { home: testHome });
    const g = doc.tickets[0]!.gateDisagreement;
    assert.deepEqual([g.class, g.how, g.basis], ['unknown', 'ledger', 'waiting for a person: reviewer could not verify acceptance items 2, 3']);
    assert.equal(doc.signals.find((x) => x.kind === 'gate:waiting-for-a-person-on-a-split')?.count, 1);
    assert.match(md(doc), new RegExp(`\`${t.id}\` unknown: waiting for a person: reviewer could not verify acceptance items 2, 3`));
    // From the recorded statuses, not the park note: with the note gone the line is the same.
    store.setStatus(t.id, 'awaiting-approval', null);
    assert.equal(collectDebrief(store, t.id, { home: testHome }).tickets[0]!.gateDisagreement.basis, g.basis);
    // A split with no per-item status (reviewers disagreed, nobody ruled), and what is not a split at all.
    assert.equal(waitingOnSplit({ verdict: 'split', council: [{}, {}] }), 'waiting for a person: the review ended split and nobody ruled');
    assert.equal(waitingOnSplit({ verdict: 'pass', council: [] }), null);
    assert.equal(waitingOnSplit(null), null);
    // Once a person has decided, it is no longer waiting.
    applyRejection(store, t.id, 'no');
    assert.equal(collectDebrief(store, t.id, { home: testHome }).tickets[0]!.gateDisagreement.class, 'rejected-at-gate');
  } finally {
    store.close();
  }
});

test('debrief: follow-ups of a dependent and tickets queued behind those are debriefed as tickets, two steps out, and the cut is stated', () => {
  const store = new Store(':memory:');
  try {
    const add = (title: string, over: { parentId?: string; deps?: string[] } = {}): Task =>
      store.addTask({ title, prompt: 'p', kind: 'general', runner: 'echo', ...over });
    const subject = add('subject');
    const f1 = add('follow-up of the subject', { parentId: subject.id, deps: [subject.id] });
    const f2 = add('follow-up of the follow-up', { parentId: f1.id, deps: [f1.id] });
    const d1 = add('operator ticket queued behind the follow-up', { deps: [f1.id] });
    const d1f = add('follow-up filed on the operator ticket', { parentId: d1.id, deps: [d1.id] });
    const d2 = add('operator ticket queued behind that follow-up', { deps: [d1f.id] });
    const d2f = add('its own follow-up', { parentId: d2.id });
    const d3 = add('a third step out', { deps: [d2.id] });
    const unrelated = add('unrelated');

    const doc = collectDebrief(store, subject.id, { home: testHome });
    const relation = new Map(doc.tickets.map((t) => [t.id, t.relation]));
    assert.deepEqual(
      [subject, f1, f2, d1, d1f, d2, d2f].map((t) => relation.get(t.id)),
      ['subject', 'follow-up', 'follow-up', 'dependent', 'follow-up', 'dependent', 'follow-up'],
    );
    assert.ok(!relation.has(d3.id) && !relation.has(unrelated.id));
    const cut = doc.cuts.find((c) => c.startsWith('family: '));
    assert.ok(cut?.includes('1 ticket(s) further from the subject') && cut.includes(d3.id), doc.cuts.join(' | '));
    // Nothing is cut when nothing is beyond the walk.
    assert.ok(!collectDebrief(store, d3.id, { home: testHome }).cuts.some((c) => c.startsWith('family: ')));
  } finally {
    store.close();
  }
});

test('repair brief: a real red test stage leaves exactly the record the tests-failed line is read from', { timeout: 180_000 }, async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => { reviews++; return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }); },
  });
  try {
    const t = store.addTask({ title: 'red gate', prompt: 'echo changed >> a.txt', kind: 'code', runner: 'shell', repo, testCmd: 'echo "not ok 1 - broken"; exit 1', maxRepairs: 0 });
    await sched.drain(120_000);
    assert.equal(store.getTask(t.id)!.status, 'failed');
    assert.equal(reviews, 0, 'no reviewer was called');
    const prev = previousRound(store, t.id, null)!;
    assert.deepEqual([prev.run.verdict, prev.run.testsPassed, prev.reviewerFailed], ['fail', false, false]);
    assert.equal(
      repairOpening(prev, false, store.getTask(t.id)!.testCmd),
      'The project\'s tests failed at the gate (echo "not ok 1 - broken"; exit 1); nothing was reviewed yet. Fix exactly this and nothing else:',
    );
  } finally {
    await sched.stop();
    store.close();
  }
});

// --------------------------------------------------------------- review on-top (followups-r1)

test('F20: a planned ticket whose prompt opens "Filed by " keeps its plan\'s dependencies — the prefix alone does not make an edge an order', () => {
  withPlaybooks();
  const store = new Store(':memory:');
  try {
    for (const how of ['canceled', 'failed', 'rejected'] as const) {
      // Through the real planner path: the epic is the parent, the prompt is the plan's own text.
      const plan = {
        ask: 'ask', repo: null, playbook: 'solo', epic: { title: `epic (${how})`, summary: 's' },
        tickets: [
          { ref: 't1', title: 'one', prompt: 'Do the first thing.', role: 'dev', kind: 'general', after: [], acceptance: null, testCmd: null, points: null },
          { ref: 't2', title: 'two', prompt: 'Filed by the architect: do the second thing.', role: 'dev', kind: 'general', after: ['t1'], acceptance: null, testCmd: null, points: null },
        ],
      } as unknown as CrewPlan;
      const { epic, tickets } = queueCrewPlan(store, plan);
      const [one, two] = tickets;
      assert.equal(store.getTask(two!.id)!.parentId, epic.id);
      // A ticket under a WORK ticket with the prefix, but no edge to that ticket: nothing a reviewer's filing writes.
      const work = store.addTask({ title: `work (${how})`, prompt: 'p', runner: 'echo' });
      const odd = store.addTask({ title: 'odd', prompt: 'Filed by nobody', runner: 'echo', parentId: work.id, deps: [one!.id] });
      // The recorded shape without the prefix, and each part of the shape alone: an epic container as the parent
      // (with an edge to it), and an epic container as the ticket.
      const plain = store.addTask({ title: 'no prefix', prompt: 'p', runner: 'echo', parentId: work.id, deps: [work.id, one!.id] });
      const underEpic = store.addTask({ title: 'under an epic', prompt: 'Filed by nobody', runner: 'echo', parentId: epic.id, deps: [epic.id, one!.id] });
      const container = store.addTask({ title: 'a container', prompt: 'Filed by nobody', runner: 'echo', isEpic: true, parentId: work.id, deps: [work.id, one!.id] });
      store.addTask({ title: 'its ticket', prompt: 'p', runner: 'echo', parentId: container.id });
      if (how === 'canceled') store.cancel(one!.id);
      else store.setStatus(one!.id, how, 'no');
      store.reconcileBlocked();
      for (const t of [two!, odd, plain, underEpic, container]) {
        assert.deepEqual([store.getTask(t.id)!.status, store.getTask(t.id)!.error], ['failed', `dependency ${one!.id} ended as ${how}`], `${t.title} (${how})`);
      }
    }
  } finally {
    store.close();
    cleanupEnv();
  }
});

test('jail sweep: a link at a failed run\'s place is neither followed nor removed — another ticket\'s live jail and the real repo are untouched', async () => {
  const repo = sweepRepo();
  const store = new Store(':memory:');
  try {
    const live = await jailed(store, repo, 'awaiting-approval', 20, { diff: true });
    const toJail = await jailed(store, repo, 'failed', 20, { diff: true });
    const toRepo = await jailed(store, repo, 'failed', 20, { work: false });
    for (const [j, target] of [[toJail, live.jail.dir], [toRepo, repo]] as const) {
      gitIn(repo, 'worktree', 'remove', '--force', j.jail.dir);
      fs.symlinkSync(target, j.jail.dir);
    }
    fs.writeFileSync(path.join(repo, 'operator.txt'), 'untracked in the real checkout\n');
    const index = gitIn(repo, 'ls-files', '--stage');
    const out = await sweepJails(store, { retainDays: -1 });
    assert.deepEqual(out.removed, []);
    assert.deepEqual(new Set(out.keptUnreadable), new Set([toJail.jail.dir, toRepo.jail.dir]));
    assert.ok(fs.existsSync(path.join(live.jail.dir, 'work.txt')), 'the jail at the gate keeps its unsaved work');
    assert.ok(gitIn(repo, 'worktree', 'list', '--porcelain').includes(path.basename(live.jail.dir)), 'and its registration');
    assert.equal(gitIn(repo, 'ls-files', '--stage'), index, 'no git ran in the real checkout through the link');
    assert.ok(fs.lstatSync(toJail.jail.dir).isSymbolicLink() && fs.lstatSync(toRepo.jail.dir).isSymbolicLink());
  } finally {
    store.close();
  }
});

test('jail sweep: a failed run\'s tree that has lost its .git is kept — git would answer for the repo above it (the daemon\'s home is inside one)', async () => {
  // The live layout: FOREMAN_HOME is a directory inside the repo its tickets work on, ignored and clean.
  const home = fs.realpathSync(testHome);
  assert.ok(!fs.existsSync(path.join(home, '.git')), 'the test home starts outside any repo of its own');
  const store = new Store(':memory:');
  try {
    gitIn(home, 'init', '-q'); gitIn(home, 'config', 'user.email', 't@e.x'); gitIn(home, 'config', 'user.name', 'T');
    // Ignored by name at the top of the home only: an untracked file at the top of a jail must still count as work.
    fs.writeFileSync(path.join(home, '.git', 'info', 'exclude'), ['work', ...fs.readdirSync(home)].filter((n) => n !== '.git').map((n) => `/${n}\n`).join(''));
    gitIn(home, 'commit', '-q', '--allow-empty', '-m', 'base');
    const intact = await jailed(store, home, 'failed', 20);
    const lost = await jailed(store, home, 'failed', 20);
    fs.rmSync(path.join(lost.jail.dir, '.git'), { force: true });
    gitIn(home, 'commit', '-q', '--allow-empty', '-m', 'main moved on');
    assert.equal(fs.realpathSync(gitIn(lost.jail.dir, 'rev-parse', '--show-toplevel')), home, 'the rig: git in that tree answers for the repo above');
    assert.equal(gitIn(home, 'status', '--porcelain'), '', 'the rig: which is clean');
    const out = await sweepJails(store, { retainDays: -1 });
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.keptUnreadable, [lost.jail.dir]);
    assert.deepEqual(out.keptNoDiff, [intact.jail.dir]);
    assert.ok(fs.existsSync(path.join(lost.jail.dir, 'work.txt')), 'unsaved work with no diff artifact is still there');
  } finally {
    store.close();
    fs.rmSync(path.join(home, '.git'), { recursive: true, force: true });
  }
});

test('idle re-check: a provisional review of work that is not a code change in a repo is still re-checked, diff artifact or not', async () => {
  // What "nothing to change" means is a CODE ticket in a REPO with no diff; a writing ticket, or one with no repo, never records one.
  for (const over of [{ kind: 'writing' as const, repo: tmp('foreman-fl-recheck-w-') }, { kind: 'code' as const, repo: null }]) {
    const store = new Store(':memory:');
    let reviews = 0;
    const task = store.addTask({ title: 'draft the note', prompt: 'p', runner: 'echo', ...over });
    const sched = new Scheduler(store, {
      verifyEnabled: false,
      broker: new Broker(store, { guardResidency: false, fitsFn: async () => true }),
      verify: async ({ runId }) => {
        reviews++;
        return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
      },
    });
    const run = store.startRun(task.id);
    store.setTestsPassed(run.id, true);
    store.endRun(run.id, 'succeeded', { summary: 'the note, in full' });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
    store.setStatus(task.id, 'awaiting-approval', 'provisional pass from stepped-down models — re-checked by the full council once it fits');
    process.env['FOREMAN_RECHECK_MS'] = '0';
    try {
      for (let i = 0; i < 6; i++) {
        await sched.tick();
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(reviews, 1, `${over.kind}, repo ${over.repo ? 'set' : 'none'}: re-checked as on main`);
    } finally {
      delete process.env['FOREMAN_RECHECK_MS'];
      await sched.stop();
      store.close();
    }
  }
});

test('repair brief: the round before is the newest OTHER run, and "a reviewer failed it" is a fail on that very run with a reviewer on it', () => {
  const store = new Store(':memory:');
  try {
    const seat = { model: 'opus', provider: 'claude-cli', local: false, verdict: 'fail' as const, confidence: 0.9, critique: 'no', costUsd: 0, latencyMs: 1 };
    const task = store.addTask({ title: 't', prompt: 'p', runner: 'echo' });
    const first = store.startRun(task.id);
    store.addVerdict({ runId: first.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [seat], critique: 'no' });
    store.endRun(first.id, 'failed', { summary: 'rejected' });
    const second = store.startRun(task.id);
    store.endRun(second.id, 'failed', { summary: 'ran out of time' });
    const current = store.startRun(task.id);
    // Rounds are minutes apart; here they were started within one millisecond, and runsForTask orders by start time alone.
    [first, second, current].forEach((r, i) => store.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1_700_000_000_000 + i * 60_000, r.id));
    // The council failed the FIRST run; the one before this round is the second, which nobody reviewed.
    assert.deepEqual([previousRound(store, task.id, current.id)!.run.id, previousRound(store, task.id, current.id)!.reviewerFailed], [second.id, false]);
    // A pass on that run is not a rejection; the scheduler's own fail (no reviewer on the row) is not one either.
    store.addVerdict({ runId: second.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [{ ...seat, verdict: 'pass' }] });
    store.addVerdict({ runId: second.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [], critique: 'TEST RESULT: FAILED' });
    assert.equal(previousRound(store, task.id, current.id)!.reviewerFailed, false);
    // A crew review's fail is one, whatever its row lists.
    store.addVerdict({ runId: second.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [], source: 'crew', critique: 'no' });
    assert.equal(previousRound(store, task.id, current.id)!.reviewerFailed, true);
    assert.equal(previousRound(store, task.id, null)!.run.id, current.id, 'with no current run named, the newest');
  } finally {
    store.close();
  }
});

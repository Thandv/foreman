// Who acted, on every decision row: the pinned rows each writer writes, and a grep that finds every writer in src/.
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { applyApproval, applyRejection } from '../src/gate.ts';
import type { Approver } from '../src/merge.ts';
import { Store, type NewDecision } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { traceTask } from '../src/trace.ts';
import type { Run, Task } from '../src/types.ts';
import { FILED_PREFIX } from '../src/verify/followUpChain.ts';
import { hermeticGitEnv } from './helpers/git.ts';

/** Today's columns of a decisions row, less id and at: what every writer must keep writing unchanged. */
const PINNED = [
  'task_id', 'run_id', 'action', 'actor', 'note', 'note_cut_bytes', 'status_after', 'reviewed_tree', 'landed_tree',
  'as_is', 'merged', 'merge_reason', 'corrected', 'corrected_source', 'review_source', 'extra',
] as const;

type Pinned = Record<(typeof PINNED)[number], unknown>;

/** The task's raw decisions rows, oldest first, cut to the pinned columns. */
function pinned(store: Store, taskId: string): Pinned[] {
  return (store.db.prepare('SELECT * FROM decisions WHERE task_id = ? ORDER BY at, rowid').all(taskId) as Record<string, unknown>[])
    .map((r) => Object.fromEntries(PINNED.map((c) => [c, r[c]])) as Pinned);
}

/** A row with every pinned column null or zero except the ones given. */
function row(over: Partial<Pinned>): Pinned {
  const base = Object.fromEntries(PINNED.map((c) => [c, null])) as Pinned;
  return { ...base, note_cut_bytes: 0, ...over };
}

/** A ticket parked at the gate with no repo: enough for every path that does not merge. */
function parked(store: Store): { task: Task; run: Run } {
  const task = store.addTask({ title: 'Add token auth', prompt: 'Add bearer-token auth.', kind: 'code', runner: 'echo' });
  const started = store.startRun(task.id);
  store.setTestsPassed(started.id, true);
  store.addVerdict({ runId: started.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], critique: 'read' });
  store.endRun(started.id, 'succeeded', { exitCode: 0, summary: 'added the middleware' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, run: store.getRun(started.id)! };
}

/** A ticket that failed review with its worktree still on disk: what reopen accepts. */
function failedReview(store: Store, work: string): { task: Task; run: Run } {
  const task = store.addTask({ title: 'failed review', prompt: 'p', runner: 'echo' });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { worktreePath: work, branch: 'b' });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [], critique: 'no live check' });
  store.endRun(run.id, 'failed', { exitCode: 1, summary: 's' });
  store.setStatus(task.id, 'failed', 'no live check');
  return { task: store.getTask(task.id)!, run: store.getRun(run.id)! };
}

/** Reviewer-filed follow-ups of a done ticket: `f2` is ordered behind `f1`, so deleting `f1` drops that edge. */
function orderedFollowUps(store: Store): { f1: Task; f2: Task } {
  const w = store.addTask({ title: 'work', prompt: 'p', runner: 'echo' });
  const f1 = store.addTask({ title: 'f1', prompt: `${FILED_PREFIX}reviewer: one`, runner: 'echo', parentId: w.id, deps: [w.id] });
  const f2 = store.addTask({ title: 'f2', prompt: `${FILED_PREFIX}reviewer: two`, runner: 'echo', parentId: w.id, deps: [w.id, f1.id] });
  store.setStatus(w.id, 'done');
  return { f1, f2 };
}

/** A git repo whose HEAD on main is a commit on top of a first one: HEAD's sha and tree. */
function repoWithCommit(t: test.TestContext): { repo: string; sha: string; tree: string } {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-decision-actor-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'by hand');
  return { repo, sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

test('pin: a human approval of a parked ticket with no repo writes this row', async () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    await applyApproval(store, task.id, { principal: 'operator', note: 'looks right' });
    assert.deepEqual(pinned(store, task.id), [row({
      task_id: task.id, run_id: run.id, action: 'approve', actor: 'human', note: 'looks right', status_after: 'done',
      as_is: 0, merged: 0, merge_reason: 'nothing to merge',
    })]);
  } finally {
    store.close();
  }
});

test('pin: an owner-gate approval writes this row', async () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    await applyApproval(store, task.id, { principal: 'owner-model', note: 'owner-gate: fine' });
    assert.deepEqual(pinned(store, task.id), [row({
      task_id: task.id, run_id: run.id, action: 'approve', actor: 'owner-model', note: 'owner-gate: fine', status_after: 'done',
      as_is: 0, merged: 0, merge_reason: 'nothing to merge',
    })]);
  } finally {
    store.close();
  }
});

test('pin: a human rejection and an owner-gate rejection write these rows', () => {
  const store = new Store(':memory:');
  try {
    const human = parked(store);
    applyRejection(store, human.task.id, 'too long', 'operator');
    assert.deepEqual(pinned(store, human.task.id), [row({
      task_id: human.task.id, run_id: human.run.id, action: 'reject', actor: 'human', note: 'too long', status_after: 'rejected',
    })]);
    const owner = parked(store);
    applyRejection(store, owner.task.id, 'owner-gate: off ticket', 'owner-model');
    assert.deepEqual(pinned(store, owner.task.id), [row({
      task_id: owner.task.id, run_id: owner.run.id, action: 'reject', actor: 'owner-model', note: 'owner-gate: off ticket',
      status_after: 'rejected',
    })]);
  } finally {
    store.close();
  }
});

test('pin: a retry writes this row', () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    applyRejection(store, task.id, 'no', 'operator');
    store.retry(task.id, 'checked it myself', { skills: ['test-first'] });
    assert.deepEqual(pinned(store, task.id).filter((r) => r.action === 'retry'), [row({
      task_id: task.id, run_id: run.id, action: 'retry', actor: 'human', note: 'checked it myself', status_after: 'queued',
      extra: JSON.stringify({ skills: ['test-first'] }),
    })]);
  } finally {
    store.close();
  }
});

test('pin: a reopen writes this row', (t) => {
  const store = new Store(':memory:');
  const work = scratchDir('foreman-decision-actor-reopen-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  try {
    const { task, run } = failedReview(store, work);
    store.reopen(task.id, 'ran the live checks');
    assert.deepEqual(pinned(store, task.id), [row({
      task_id: task.id, run_id: run.id, action: 'reopen', actor: 'human', note: 'ran the live checks', status_after: 'awaiting-approval',
    })]);
  } finally {
    store.close();
  }
});

test('pin: a cancel writes this row, and the cascade a system row on each ticket under it', () => {
  const store = new Store(':memory:');
  try {
    const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo', isEpic: true });
    const child = store.addTask({ title: 'a', prompt: 'p', runner: 'echo', parentId: epic.id });
    store.cancel(epic.id, 'the ask changed', { cascade: true });
    assert.deepEqual(pinned(store, epic.id), [row({
      task_id: epic.id, action: 'cancel', actor: 'human', note: 'the ask changed', status_after: 'canceled',
      extra: JSON.stringify({ statusBefore: 'blocked', cascade: true }),
    })]);
    assert.deepEqual(pinned(store, child.id), [row({
      task_id: child.id, action: 'cancel', actor: 'system', note: `parent ${epic.id} was canceled`, status_after: 'canceled',
      extra: JSON.stringify({ statusBefore: 'queued' }),
    })]);
  } finally {
    store.close();
  }
});

test('pin: dropping a dependency, by hand or by deleting the ticket a follow-up is ordered behind, writes this row', () => {
  const store = new Store(':memory:');
  try {
    const a = store.addTask({ title: 'a', prompt: 'p', runner: 'echo' });
    const b = store.addTask({ title: 'b', prompt: 'p', runner: 'echo', deps: [a.id] });
    store.dropDependency(b.id, a.id, 'human');
    assert.deepEqual(pinned(store, b.id), [row({
      task_id: b.id, action: 'deps-drop', actor: 'human', note: `dropped dependency ${a.id}`,
      extra: JSON.stringify({ dep: a.id, statusBefore: 'blocked' }),
    })]);
    const { f1, f2 } = orderedFollowUps(store);
    store.deleteTask(f1.id);
    assert.deepEqual(pinned(store, f2.id), [row({
      task_id: f2.id, action: 'deps-drop', actor: 'human', note: `dropped dependency ${f1.id}`,
      extra: JSON.stringify({ dep: f1.id, statusBefore: 'blocked' }),
    })]);
  } finally {
    store.close();
  }
});

test('pin: a hand landing writes this row', async (t) => {
  const store = new Store(':memory:');
  try {
    const { repo, sha, tree } = repoWithCommit(t);
    const task = store.addTask({ title: 't', prompt: 'p', repo });
    store.setStatus(task.id, 'awaiting-approval');
    await store.markLanded(task.id, { commit: sha, note: 'by hand', actor: 'human' });
    assert.deepEqual(pinned(store, task.id), [row({
      task_id: task.id, action: 'landed', actor: 'human',
      note: `landed by hand: commit ${sha}; no run base_commit, so the jail-base ancestor check was skipped; by hand`,
      status_after: 'done', landed_tree: tree, extra: JSON.stringify({ statusBefore: 'awaiting-approval', commit: sha }),
    })]);
  } finally {
    store.close();
  }
});

/** The task's preference fact (assistant/memory.ts) and the label its ruled run carries (runs.decision). */
function remembered(store: Store, taskId: string, runId: string): { value: string; confidence: number; source: string | null; label: unknown } {
  const fact = store.recallFacts('global', 50).find((f) => f.key === `preference:${taskId}`)!;
  const label = (store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(runId) as { decision: unknown }).decision;
  return { value: fact.value, confidence: fact.confidence, source: fact.source, label };
}

test('pin: the preference fact and run label a human and an owner-gate approval and rejection leave', async () => {
  const store = new Store(':memory:');
  try {
    const approved = parked(store);
    await applyApproval(store, approved.task.id, { principal: 'operator', note: 'looks right' });
    const ownerApproved = parked(store);
    await applyApproval(store, ownerApproved.task.id, { principal: 'owner-model', note: 'owner-gate: fine' });
    const rejected = parked(store);
    applyRejection(store, rejected.task.id, 'too long', 'operator');
    const ownerRejected = parked(store);
    applyRejection(store, ownerRejected.task.id, 'owner-gate: off ticket', 'owner-model');
    assert.deepEqual([approved, ownerApproved, rejected, ownerRejected].map((x) => remembered(store, x.task.id, x.run.id)), [
      { value: 'approved "Add token auth" — looks right', confidence: 0.6, source: approved.task.id, label: 'approved' },
      {
        value: 'the owner gate (not the operator) approved "Add token auth" — owner-gate: fine', confidence: 0.6 - 0.2,
        source: `owner-gate:${ownerApproved.task.id}`, label: 'owner-approved',
      },
      { value: 'rejected "Add token auth" — too long. Do not repeat this.', confidence: 0.75, source: rejected.task.id, label: 'rejected' },
      {
        value: 'the owner gate (not the operator) rejected "Add token auth" — owner-gate: off ticket. Do not repeat this.',
        confidence: 0.75 - 0.2, source: `owner-gate:${ownerRejected.task.id}`, label: 'owner-rejected',
      },
    ]);
  } finally {
    store.close();
  }
});

/**
 * Every call of addDecision or noteDecision in src/, by file and enclosing function, with the pin above that covers
 * it. A new writer fails here until it has a pin; a writer that is gone fails until its entry goes.
 */
const WRITERS: Record<string, string> = {
  'src/gate.ts recordApproval': 'a human approval / an owner-gate approval',
  'src/gate.ts applyRejection': 'a human rejection and an owner-gate rejection',
  'src/queue.ts noteDecision': 'every noteDecision writer below',
  'src/queue.ts retry': 'a retry',
  'src/queue.ts reopen': 'a reopen',
  'src/queue.ts dropDependency': 'dropping a dependency',
  'src/queue.ts cancel': 'a cancel',
  'src/queue.ts markLanded': 'a hand landing',
  'src/queue.ts cancelDescendants': 'the cascade',
};

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? srcFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/** The name of the function, method or variable-bound arrow `node` sits in, or '<top>'. */
function enclosing(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
  }
  return '<top>';
}

test('every decision writer in src/ has a pin', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const found = new Set<string>();
  for (const file of srcFiles(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/(addDecision|noteDecision)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['addDecision', 'noteDecision'].includes(node.expression.name.text)) {
        found.add(`${path.relative(root, file).split(path.sep).join('/')} ${enclosing(node)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual([...found].sort(), Object.keys(WRITERS).sort());
});

// ------------------------------------------------------------ who acted

/** The actor_id of the task's decisions rows, oldest first. */
function actorIds(store: Store, taskId: string): unknown[] {
  return (store.db.prepare('SELECT actor_id FROM decisions WHERE task_id = ? ORDER BY at, rowid').all(taskId) as Array<{ actor_id: unknown }>)
    .map((r) => r.actor_id);
}

test('the reserved actor ids: the operator approving, the owner gate rejecting, a Store writer naming nobody, the cascade', async () => {
  const store = new Store(':memory:');
  try {
    const person = parked(store);
    await applyApproval(store, person.task.id, { principal: 'operator', note: 'fine' });
    const owner = parked(store);
    applyRejection(store, owner.task.id, 'owner-gate: no', 'owner-model');
    const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo', isEpic: true });
    const child = store.addTask({ title: 'a', prompt: 'p', runner: 'echo', parentId: epic.id });
    store.cancel(epic.id);
    assert.deepEqual(
      [actorIds(store, person.task.id), actorIds(store, owner.task.id), actorIds(store, epic.id), actorIds(store, child.id)],
      [['operator'], ['owner-model'], ['operator'], ['system']],
    );
    assert.equal(store.decisionsForTask(person.task.id)[0]!.actorId, 'operator');
    const traced = traceTask(store, child.id) as { decisions: Array<{ actor: string; actorId: string }> };
    assert.deepEqual(traced.decisions.map((d) => [d.actor, d.actorId]), [['system', 'system']], 'foreman trace carries who acted');
  } finally {
    store.close();
  }
});

test('every Store writer records the actor id it is given; the cascade under a cancel stays system', async (t) => {
  const store = new Store(':memory:');
  const work = scratchDir('foreman-decision-actor-reopen-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  try {
    const by = 'p_alice';
    const retried = parked(store);
    applyRejection(store, retried.task.id, 'no', 'operator');
    store.retry(retried.task.id, null, null, by);
    const reopened = failedReview(store, work);
    store.reopen(reopened.task.id, null, by);
    const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo', isEpic: true });
    const child = store.addTask({ title: 'a', prompt: 'p', runner: 'echo', parentId: epic.id });
    store.cancel(epic.id, null, { actorId: by });
    const a = store.addTask({ title: 'a', prompt: 'p', runner: 'echo' });
    const b = store.addTask({ title: 'b', prompt: 'p', runner: 'echo', deps: [a.id] });
    store.dropDependency(b.id, a.id, 'human', by);
    const { f1, f2 } = orderedFollowUps(store);
    store.deleteTask(f1.id, by);
    const { repo, sha } = repoWithCommit(t);
    const landed = store.addTask({ title: 't', prompt: 'p', repo });
    store.setStatus(landed.id, 'awaiting-approval');
    await store.markLanded(landed.id, { commit: sha, actor: 'human', actorId: by });
    assert.deepEqual(
      [retried, reopened].map((x) => actorIds(store, x.task.id)).concat([epic, child, b, f2, landed].map((x) => actorIds(store, x.id))),
      [['operator', by], [by], [by], ['system'], [by], [by], [by]],
    );
  } finally {
    store.close();
  }
});

interface Rig {
  store: Store;
  call: (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
}

/** A daemon on an ephemeral loopback port; `headers` go on every call. */
async function rig(t: test.TestContext, headers: () => Record<string, string>): Promise<Rig> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const call: Rig['call'] = async (method, urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { ...headers(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return { store, call };
}

/** Cancel, retry, reopen, deps-drop, delete, landed, approve and reject through their routes: each one's newest actor_id. */
async function throughRoutes(t: test.TestContext, r: Rig): Promise<unknown[]> {
  const { store, call } = r;
  const work = scratchDir('foreman-decision-actor-reopen-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // On a person's desk, so the ticks the routes start dispatch none of them under the test.
  const canceled = store.addTask({ title: 'c', prompt: 'p', runner: 'echo', assignee: 'human' });
  const retried = parked(store);
  applyRejection(store, retried.task.id, 'no', 'operator');
  const reopened = failedReview(store, work);
  const a = store.addTask({ title: 'a', prompt: 'p', runner: 'echo', assignee: 'human' });
  const b = store.addTask({ title: 'b', prompt: 'p', runner: 'echo', assignee: 'human', deps: [a.id] });
  const { f1, f2 } = orderedFollowUps(store);
  const { repo, sha } = repoWithCommit(t);
  const landed = store.addTask({ title: 't', prompt: 'p', repo, assignee: 'human' });
  store.setStatus(landed.id, 'awaiting-approval');
  const approved = parked(store);
  const rejected = parked(store);
  const calls: Array<[string, string, unknown?]> = [
    ['POST', `/api/tasks/${canceled.id}/cancel`, {}],
    ['POST', `/api/tasks/${retried.task.id}/retry`, {}],
    ['POST', `/api/tasks/${reopened.task.id}/reopen`, {}],
    ['POST', `/api/tasks/${b.id}/deps-drop`, { dep: a.id }],
    ['DELETE', `/api/tasks/${f1.id}`],
    ['POST', `/api/tasks/${landed.id}/landed`, { commit: sha }],
    ['POST', `/api/tasks/${approved.task.id}/approve`, {}],
    ['POST', `/api/tasks/${rejected.task.id}/reject`, { note: 'no' }],
  ];
  for (const [method, url, body] of calls) {
    const res = await call(method, url, body);
    assert.equal(res.status, 200, `${method} ${url}: ${JSON.stringify(res.json)}`);
  }
  return [canceled.id, retried.task.id, reopened.task.id, b.id, f2.id, landed.id, approved.task.id, rejected.task.id]
    .map((id) => actorIds(store, id).at(-1));
}

test('with auth off, every decision route records the operator', async (t) => {
  const r = await rig(t, () => ({}));
  assert.deepEqual(await throughRoutes(t, r), Array(8).fill('operator'));
});

test('with auth on, every decision route records the request principal', async (t) => {
  let secret = '';
  const r = await rig(t, () => ({ authorization: `Bearer ${secret}` }));
  const alice = r.store.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' });
  secret = randomBytes(32).toString('base64url');
  r.store.addToken({ principalId: alice.id, tokenHash: createHash('sha256').update(secret).digest('hex'), expiresAt: null, createdBy: 'operator' });
  assert.deepEqual(await throughRoutes(t, r), Array(8).fill(alice.id));
});

/** The parameter list of each exported function `names` in src/gate.ts, as written. */
function gateSignatures(names: string[]): Record<string, string> {
  const file = path.resolve(import.meta.dirname, '..', 'src', 'gate.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Record<string, string> = {};
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      out[node.name.text] = node.parameters.map((p) => p.getText()).join(', ');
    }
  });
  return out;
}

test('the approve and reject path takes a principal, never a source', () => {
  const signatures = gateSignatures(['applyApproval', 'applyRejection']);
  assert.deepEqual(Object.keys(signatures).sort(), ['applyApproval', 'applyRejection']);
  for (const [name, params] of Object.entries(signatures)) {
    assert.doesNotMatch(params, /\bsource\??:/, `${name} has a source parameter`);
    assert.match(params, /\bprincipal\b/, `${name} takes no principal`);
  }
});

/** true when `K` must be given on `T`. */
type Named<T, K extends keyof T> = undefined extends T[K] ? false : true;

test('the type checker refuses a decision row, an approval or a landing that names nobody', () => {
  // Checked by the typecheck in npm run verify: each `true` stops compiling when its field becomes optional again.
  const required: [Named<NewDecision, 'actorId'>, Named<Parameters<typeof applyApproval>[2], 'principal'>, Named<Approver, 'source'>] =
    [true, true, true];
  const rejectArity: Parameters<typeof applyRejection>['length'] = 4;
  assert.deepEqual([...required, rejectArity], [true, true, true, 4]);
});

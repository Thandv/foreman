// Four-eyes (D3) at the human-facing approve path: approve, --as-is and /landed.
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { applyApproval, FourEyesRefused } from '../src/gate.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { fourEyes } from '../src/security/fourEyes.ts';
import { createServer } from '../src/server.ts';
import type { Principal, Task } from '../src/types.ts';
import { hermeticGitEnv } from './helpers/git.ts';

interface Rig {
  store: Store;
  /** A call as `as` (a bearer token), or with no Authorization header. */
  call: (method: string, urlPath: string, body?: unknown, as?: string) => Promise<{ status: number; json: Record<string, unknown> }>;
}

/** A daemon on an ephemeral loopback port. */
async function rig(t: test.TestContext): Promise<Rig> {
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
  const call: Rig['call'] = async (method, urlPath, body, as) => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { ...(as ? { authorization: `Bearer ${as}` } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return { store, call };
}

/** A principal and a bearer token for it. */
function mint(store: Store, name: string, kind: 'human' | 'service' = 'human'): { principal: Principal; token: string } {
  const principal = store.addPrincipal({ kind, name, createdBy: 'operator' });
  const token = randomBytes(32).toString('base64url');
  store.addToken({ principalId: principal.id, tokenHash: createHash('sha256').update(token).digest('hex'), createdBy: 'operator' });
  return { principal, token };
}

/** A ticket with no repo parked at the gate on a green run, created by `createdBy`. Kept on a person's desk. */
function parked(store: Store, createdBy: string | null): Task {
  const task = store.addTask({ title: 'Add token auth', prompt: 'p', kind: 'code', runner: 'echo', assignee: 'human', createdBy });
  const run = store.startRun(task.id);
  store.setTestsPassed(run.id, true);
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], critique: 'read' });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(task.id, 'awaiting-approval');
  return store.getTask(task.id)!;
}

/** A git repo whose HEAD commit changes `file` on top of a first commit: HEAD's sha. */
function repoWithChange(t: test.TestContext, file = 'lib/a.txt'): { repo: string; sha: string } {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-four-eyes-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README'), 'r\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'by hand');
  return { repo, sha: git('rev-parse', 'HEAD') };
}

/** A ticket in `repo` parked at the gate with no run, created by `createdBy`: what a person hand-lands. */
function handWork(store: Store, repo: string, createdBy: string | null): Task {
  const task = store.addTask({ title: 't', prompt: 'p', repo, assignee: 'human', createdBy });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
}

function decisions(store: Store, taskId: string): Array<{ action: string; actor_id: string }> {
  return (store.db.prepare('SELECT action, actor_id FROM decisions WHERE task_id = ? ORDER BY at, rowid').all(taskId) as Array<{ action: string; actor_id: string }>)
    .map((d) => ({ action: d.action, actor_id: d.actor_id }));
}

test('pin: with no principal, the creator approves their own ticket and hand-lands another', async (t) => {
  const r = await rig(t);
  const approved = parked(r.store, 'operator');
  const res = await r.call('POST', `/api/tasks/${approved.id}/approve`, {});
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(decisions(r.store, approved.id), [{ action: 'approve', actor_id: 'operator' }]);
  const { repo, sha } = repoWithChange(t);
  const landed = handWork(r.store, repo, 'operator');
  const res2 = await r.call('POST', `/api/tasks/${landed.id}/landed`, { commit: sha });
  assert.equal(res2.status, 200, JSON.stringify(res2.json));
  assert.deepEqual(decisions(r.store, landed.id), [{ action: 'landed', actor_id: 'operator' }]);
});

test('with two humans, the creator cannot approve their own ticket, --as-is or not', async (t) => {
  const r = await rig(t);
  const alice = mint(r.store, 'alice');
  mint(r.store, 'bob');
  const task = parked(r.store, alice.principal.id);
  for (const body of [{}, { acceptTree: 'a'.repeat(40) }]) {
    const res = await r.call('POST', `/api/tasks/${task.id}/approve`, body, alice.token);
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.match(String(res.json['error']), /four-eyes/);
  }
  assert.deepEqual(decisions(r.store, task.id), []);
  assert.equal(r.store.getTask(task.id)!.status, 'awaiting-approval');
});

test('with two humans, the creator cannot mark their own ticket landed', async (t) => {
  const r = await rig(t);
  const alice = mint(r.store, 'alice');
  mint(r.store, 'bob');
  const { repo, sha } = repoWithChange(t);
  const task = handWork(r.store, repo, alice.principal.id);
  const res = await r.call('POST', `/api/tasks/${task.id}/landed`, { commit: sha }, alice.token);
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.deepEqual(decisions(r.store, task.id), []);
  assert.equal(r.store.getTask(task.id)!.status, 'awaiting-approval');
});

test('the rule: only a live human approves; with two, never the author; protected paths always need two', () => {
  const human = (id: string): Principal => ({ id, kind: 'human', name: id.slice(2), createdBy: 'operator', createdAt: 0, disabledAt: null });
  const alice = human('p_alice');
  const service: Principal = { ...human('p_ci'), kind: 'service' };
  assert.match(fourEyes(null, { createdBy: null }, null, 2)!, /not one/);
  assert.match(fourEyes(service, { createdBy: 'p_bob' }, null, 2)!, /not one/);
  assert.match(fourEyes(alice, { createdBy: 'p_alice' }, null, 2)!, /alice created this ticket/);
  assert.match(fourEyes(alice, { createdBy: null }, null, 2)!, /author of this ticket is unknown/);
  assert.equal(fourEyes(alice, { createdBy: 'p_bob' }, 'src/gate.ts', 2), null);
  assert.equal(fourEyes(alice, { createdBy: 'p_alice' }, null, 1), null);
  assert.match(fourEyes(alice, { createdBy: 'p_alice' }, 'src/gate.ts', 1)!, /touches src\/gate\.ts.*mint a principal/);
});

test('with two humans, the other person approves and hand-lands, and is the actor of record', async (t) => {
  const r = await rig(t);
  const alice = mint(r.store, 'alice');
  const bob = mint(r.store, 'bob');
  const task = parked(r.store, alice.principal.id);
  const res = await r.call('POST', `/api/tasks/${task.id}/approve`, {}, bob.token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(decisions(r.store, task.id), [{ action: 'approve', actor_id: bob.principal.id }]);
  const { repo, sha } = repoWithChange(t);
  const landed = handWork(r.store, repo, alice.principal.id);
  const res2 = await r.call('POST', `/api/tasks/${landed.id}/landed`, { commit: sha }, bob.token);
  assert.equal(res2.status, 200, JSON.stringify(res2.json));
  assert.deepEqual(decisions(r.store, landed.id), [{ action: 'landed', actor_id: bob.principal.id }]);
});

test('with two humans, a ticket whose author is unknown is refused, with the reason on its timeline', async (t) => {
  const r = await rig(t);
  const alice = mint(r.store, 'alice');
  mint(r.store, 'bob');
  const task = parked(r.store, null);
  const res = await r.call('POST', `/api/tasks/${task.id}/approve`, {}, alice.token);
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.match(String(res.json['error']), /author of this ticket is unknown/);
  assert.deepEqual(decisions(r.store, task.id), []);
  assert.ok(r.store.eventsForTask(task.id).some((e) => /^four-eyes: the author/.test(e.message)));
});

test('a service principal and the owner model cannot approve once auth is on', async (t) => {
  const r = await rig(t);
  const bot = mint(r.store, 'ci-bot', 'service');
  const alice = mint(r.store, 'alice');
  const task = parked(r.store, alice.principal.id);
  const res = await r.call('POST', `/api/tasks/${task.id}/approve`, {}, bot.token);
  assert.equal(res.status, 403, JSON.stringify(res.json));
  await assert.rejects(applyApproval(r.store, task.id, { principal: 'owner-model' }), FourEyesRefused);
  assert.deepEqual(decisions(r.store, task.id), []);
  assert.equal(r.store.getTask(task.id)!.status, 'awaiting-approval');
});

/** A ticket in a fresh repo parked on a run whose reviewed tree changes `file` from the run's base commit. */
function parkedChange(t: test.TestContext, store: Store, file: string, createdBy: string | null): { task: Task; repo: string } {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-four-eyes-run-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README'), 'r\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const base = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), 'x\n');
  git('add', '-A');
  const tree = git('write-tree');
  git('reset', '-q', '--hard', base);
  const task = store.addTask({ title: 't', prompt: 'p', kind: 'code', repo, runner: 'echo', assignee: 'human', mergeOnApprove: false, createdBy });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { baseCommit: base, reviewedTree: tree });
  store.setTestsPassed(run.id, true);
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, repo };
}

test('with one human, an unprotected change is approved and a protected one is refused', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alice = mint(store, 'alice').principal;
  // A disabled second person does not count.
  store.disablePrincipal(mint(store, 'bob').principal.id);
  const plain = parkedChange(t, store, 'lib/a.txt', alice.id);
  await applyApproval(store, plain.task.id, { principal: alice.id });
  assert.deepEqual(decisions(store, plain.task.id), [{ action: 'approve', actor_id: alice.id }]);

  // An --as-is tree that is not a hex id is never handed to git, and counts as a change that cannot be listed.
  const named = parkedChange(t, store, 'lib/b.txt', alice.id);
  const out = path.join(named.repo, 'written-by-git');
  await assert.rejects(applyApproval(store, named.task.id, { principal: alice.id, acceptTree: `--output=${out}` }), /changed paths are not recorded/);
  assert.equal(fs.existsSync(out), false);

  const security = parkedChange(t, store, 'src/security/x.ts', alice.id);
  await assert.rejects(applyApproval(store, security.task.id, { principal: alice.id }), /touches src\/security\/x\.ts/);
  const listed = parkedChange(t, store, 'vendor/keys.txt', alice.id);
  store.setSetting('gate.humanPaths', JSON.stringify({ [listed.repo]: ['vendor/'] }));
  await assert.rejects(applyApproval(store, listed.task.id, { principal: alice.id }), /touches vendor\/keys\.txt/);
  // Foreman's own repo: a PROTECTED_PATHS entry that is not a human-only path elsewhere.
  const self = parkedChange(t, store, 'src/gate.ts', alice.id);
  await assert.rejects(applyApproval(store, self.task.id, { principal: alice.id, selfRoot: self.repo }), /touches src\/gate\.ts/);
  for (const refused of [named, security, listed, self]) {
    assert.deepEqual(decisions(store, refused.task.id), []);
    assert.equal(store.getTask(refused.task.id)!.status, 'awaiting-approval');
  }
  // The same change in any other repo is not Foreman's core.
  await applyApproval(store, self.task.id, { principal: alice.id, selfRoot: plain.repo });
  assert.deepEqual(decisions(store, self.task.id), [{ action: 'approve', actor_id: alice.id }]);
});

test('an approval whose approver is disabled before its turn in the merge section is refused with nothing decided', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alice = mint(store, 'alice').principal;
  const bob = mint(store, 'bob').principal;
  const { task } = parkedChange(t, store, 'lib/a.txt', alice.id);
  // `stale` is asked when the approval's turn comes, after the first check passed: bob is disabled while it waited.
  const stale = (): null => { store.disablePrincipal(bob.id); return null; };
  await assert.rejects(applyApproval(store, task.id, { principal: bob.id, stale }), FourEyesRefused);
  assert.deepEqual(decisions(store, task.id), []);
  assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
});

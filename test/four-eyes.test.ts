// Four-eyes (D3) at the human-facing approve path: approve, --as-is and /landed.
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
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

// D6 at POST /landed: a repo that lands by merge request, and every repo once auth is on, is not hand-landed. The one
// exception is the ticket's own MR, merged on the forge with the named commit as its head at the reviewed tree.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Landing } from '../src/landing/config.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { approve, fixture, git, parked, type Fixture } from './helpers/landingMr.ts';

process.env['FOREMAN_PREWARM'] = 'off';

interface Rig {
  store: Store;
  landed: (taskId: string, commit: string, token?: string) => Promise<{ status: number; json: Record<string, unknown> }>;
}

/** A daemon on an ephemeral loopback port over an in-memory store. */
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
  const landed: Rig['landed'] = async (taskId, commit, token) => {
    const res = await fetch(`${base}/api/tasks/${taskId}/landed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ commit }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { store, landed };
}

function mint(store: Store, name: string): { id: string; token: string } {
  const principal = store.addPrincipal({ kind: 'human', name, createdBy: 'operator' });
  const token = randomBytes(32).toString('base64url');
  store.addToken({ principalId: principal.id, tokenHash: createHash('sha256').update(token).digest('hex'), createdBy: 'operator' });
  return { id: principal.id, token };
}

const landedRows = (store: Store, taskId: string): number =>
  store.decisionsForTask(taskId).filter((d) => d.action === 'landed').length;

/**
 * A mapped ticket approved into an open MR, then given back to the gate (its MR no longer followed): the state a
 * person who merges the MR on the forge by hand leaves behind. Returns the MR's head, the reviewed commit.
 */
async function approvedThenBackAtGate(f: Fixture, store: Store, branch: string): Promise<{ taskId: string; tip: string }> {
  const task = parked(store, f.repo, branch);
  const out = await approve(store, task.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  store.setStatus(task.id, 'awaiting-approval', 'given back');
  await pollMergeRequests(store, Date.now(), (err) => { throw err; });
  return { taskId: task.id, tip: git(f.repo, 'rev-parse', branch) };
}

/** Merges MR !1 on the fake at `tip` and brings the operator's checkout up to the forge's main. */
async function mergeOnForge(f: Fixture, tip: string): Promise<string> {
  await fetch(`${f.fake.url}/__fake/pipelines/${tip}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'success' }) });
  const out = await new GitlabForge({ baseUrl: f.fake.url }).merge('group/app', 1, tip);
  assert.equal(out.merged, true, JSON.stringify(out));
  git(f.repo, 'fetch', '-q', f.forge, 'main');
  git(f.repo, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  return git(f.repo, 'rev-parse', 'HEAD');
}

test('a mapped repo refuses /landed while its MR is not merged, and when no MR was opened, recording nothing', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const r = await rig(t);
  const { taskId, tip } = await approvedThenBackAtGate(f, r.store, 'open');
  // The person merges the reviewed commit into their own checkout and names it.
  git(f.repo, 'merge', '-q', '--no-ff', '-m', 'by hand', 'open');
  const res = await r.landed(taskId, tip);
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.match(String(res.json['error']), /this repo lands through its merge request.*!1 is opened/);
  assert.equal(landedRows(r.store, taskId), 0);
  assert.equal(r.store.getTask(taskId)!.status, 'awaiting-approval');

  const never = parked(r.store, f.repo, 'never');
  git(f.repo, 'merge', '-q', '--no-ff', '-m', 'by hand', 'never');
  const res2 = await r.landed(never.id, git(f.repo, 'rev-parse', 'never'));
  assert.equal(res2.status, 409, JSON.stringify(res2.json));
  assert.match(String(res2.json['error']), /this repo lands through its merge request.*no merge request was opened/);
  assert.equal(landedRows(r.store, never.id), 0);
});

test('with auth on, a repo with no forge is not hand-landed, even by the second person', async (t) => {
  const f = await fixture(t);
  const r = await rig(t);
  const alice = mint(r.store, 'alice');
  const bob = mint(r.store, 'bob');
  const task = parked(r.store, f.repo, 'hand', { createdBy: alice.id });
  git(f.repo, 'merge', '-q', '--no-ff', '-m', 'by hand', 'hand');
  const res = await r.landed(task.id, git(f.repo, 'rev-parse', 'hand'), bob.token);
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.match(String(res.json['error']), /this repo lands through its merge request.*no forge is configured/);
  assert.equal(landedRows(r.store, task.id), 0);
  assert.equal(r.store.getTask(task.id)!.status, 'awaiting-approval');
});

test('an MR merged at the reviewed tree is recorded once, and a commit other than its head is refused', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const r = await rig(t);
  const { taskId, tip } = await approvedThenBackAtGate(f, r.store, 'merged');
  const mergeCommit = await mergeOnForge(f, tip);

  const wrong = await r.landed(taskId, mergeCommit);
  assert.equal(wrong.status, 409, JSON.stringify(wrong.json));
  assert.match(String(wrong.json['error']), /this repo lands through its merge request.*head of !1 is [0-9a-f]{40}, not/);
  assert.equal(landedRows(r.store, taskId), 0);

  const res = await r.landed(taskId, tip.slice(0, 12));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(r.store.getTask(taskId)!.status, 'done');
  assert.equal(r.store.decisionsForTask(taskId).find((d) => d.action === 'landed')!.landedTree, r.store.latestRun(taskId)!.reviewedTree);

  const again = await r.landed(taskId, tip);
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(landedRows(r.store, taskId), 1);
});

test('an MR merged with one more commit pushed onto its branch is refused: the head is not the reviewed tree', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const r = await rig(t);
  const { taskId, tip } = await approvedThenBackAtGate(f, r.store, 'pushed');
  // Someone pushes an unreviewed commit onto the MR's source branch on the forge; the MR merges with it as its head.
  const source = git(f.forge, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/foreman/');
  assert.match(source, /^foreman\/\S+$/);
  git(f.repo, 'checkout', '-q', '--detach', tip);
  fs.writeFileSync(path.join(f.repo, 'unreviewed.txt'), 'y\n');
  git(f.repo, 'add', 'unreviewed.txt');
  git(f.repo, 'commit', '-qm', 'unreviewed');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'push', '-q', f.forge, `HEAD:refs/heads/${source}`);
  git(f.repo, 'checkout', '-q', 'main');
  await mergeOnForge(f, head);

  const res = await r.landed(taskId, head);
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.match(String(res.json['error']), /this repo lands through its merge request.*not the reviewed tree/);
  assert.equal(landedRows(r.store, taskId), 0);
  assert.equal(r.store.getTask(taskId)!.status, 'awaiting-approval');
});

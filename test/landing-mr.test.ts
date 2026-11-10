import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeGitlab, type FakeGitlab } from '../scripts/forge/fakeGitlab.ts';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval } from '../src/gate.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { pendingMrs, useLanding } from '../src/landing/mr.ts';
import type { Task } from '../src/types.ts';

// Approving a ticket whose repo lands by merge request (src/landing/mr.ts) pushes the reviewed commit to
// foreman/<task id> through the Foreman-owned mirror and opens a GitLab MR on the local fake; nothing merges into the
// checkout, and the ticket's landing hold stays on until the MR merges (LD-MR7a/7b).

const TOKEN = 'glpat-mr-test-Hk27';

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...a], { cwd, encoding: 'utf8' }).trim();

interface Fixture {
  home: string;
  /** The forge's bare repo: the fake GitLab's project and the pushUrl. */
  forge: string;
  /** The operator's checkout: main as the forge has it. */
  repo: string;
  fake: FakeGitlab;
  map: LandingMapping;
}

async function fixture(t: TestContext, opts: { token?: string } = {}): Promise<Fixture> {
  const home = scratchDir('landing-mr-home-');
  const forge = path.join(scratchDir('landing-mr-forge-'), 'app.git');
  git(path.dirname(forge), 'init', '-q', '--bare', '-b', 'main', forge);
  const repo = fs.realpathSync(scratchDir('landing-mr-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', forge, 'main:refs/heads/main');
  const fake = await startFakeGitlab({ projects: { 'group/app': forge }, pipeline: 'manual', ...(opts.token ? { token: opts.token } : {}) });
  t.after(() => fake.close());
  t.after(() => useLanding(null, home));
  const map: LandingMapping = {
    repo, mode: 'mr', forge: 'gitlab', baseUrl: fake.url, project: 'group/app', pushUrl: forge, targetBranch: 'main', requirePipeline: true,
  };
  return { home, forge, repo, fake, map };
}

/** A ticket parked at the gate whose run left `branch` carrying a file of its own, reviewed at that commit's tree. */
function parked(store: Store, repo: string, branch: string, extra: { parentId?: string } = {}): Task {
  git(repo, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(repo, `${branch}.txt`), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', branch);
  git(repo, 'checkout', '-q', 'main');
  const task = store.addTask({ title: branch, prompt: 'p', kind: 'code', runner: 'echo', repo, ...extra });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch, worktreePath: null, reviewedTree: git(repo, 'rev-parse', `${branch}^{tree}`) });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
}

const approve = (store: Store, taskId: string, selfRoot?: string) =>
  applyApproval(store, taskId, { principal: 'operator', tracker: new ApprovalTracker(), ...(selfRoot ? { selfRoot } : {}) });

const landingRows = (store: Store): number =>
  Number((store.db.prepare('SELECT count(*) AS n FROM landings').get() as { n: number }).n);

const decisions = (store: Store, taskId: string): Array<{ action: string; merged: number }> =>
  store.db.prepare("SELECT action, merged FROM decisions WHERE task_id = ? AND action = 'approve' ORDER BY rowid").all(taskId) as Array<{ action: string; merged: number }>;

const mrPosts = (fake: FakeGitlab): number =>
  fake.requests.filter((r) => r.method === 'POST' && /\/merge_requests$/.test(r.path)).length;

test('pin: a repo that is not mapped lands locally, as today', async (t) => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  t.after(() => { delete process.env['FOREMAN_POSTMERGE_CHECK']; });
  const f = await fixture(t);
  useLanding(new Landing([{ ...f.map, repo: path.join(f.repo, 'elsewhere') }], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'parent');
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'merged');
  assert.equal(f.fake.requests.length, 0, 'the forge was never asked');
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
  assert.equal(landingRows(store), 0);
});

test('pin: a change to Foreman itself lands locally even when its repo is mapped', async (t) => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  t.after(() => { delete process.env['FOREMAN_POSTMERGE_CHECK']; });
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'selfwork');
  const out = await approve(store, a.id, f.repo);
  assert.equal(out.merge.code, 'merged');
  assert.equal(f.fake.requests.length, 0, 'the forge was never asked');
});

test('a mapped approval opens one MR at the reviewed commit and keeps the dependent and the epic held', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const epic = store.addTask({ title: 'e', prompt: 'p', isEpic: true });
  const a = parked(store, f.repo, 'parent', { parentId: epic.id });
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const tip = git(f.repo, 'rev-parse', 'parent');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  assert.match(out.merge.reason, /^opened !1 http:\/\/127\.0\.0\.1:\d+\/group\/app\/-\/merge_requests\/1$/);
  assert.equal(git(f.forge, 'rev-parse', `refs/heads/foreman/${a.id}`), tip, 'the MR head is the reviewed commit');
  assert.equal(git(f.forge, 'rev-parse', `refs/heads/foreman/${a.id}^{tree}`), store.latestRun(a.id)!.reviewedTree);
  assert.equal(mrPosts(f.fake), 1);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head, 'nothing merged into the checkout');
  assert.equal(store.getTask(a.id)!.status, 'done');
  assert.equal(store.isLanding(a.id), true, 'the landing hold stays on');
  assert.equal(landingRows(store), 1, 'the durable marker stays open');
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'blocked', 'the dependent is not claimable before the MR merges');
  assert.equal(store.getTask(epic.id)!.status, 'blocked', 'the epic does not close over a pending MR');
  assert.deepEqual(pendingMrs().filter((p) => p.taskId === a.id).map((p) => ({ iid: p.iid, tip: p.tip, repo: p.repo })), [{ iid: 1, tip, repo: f.repo }]);
});

test('a forge refusal returns the ticket to the gate; approving again writes a second decision and reuses the open MR', async (t) => {
  const f = await fixture(t, { token: TOKEN });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'retry');
  // An MR left open on foreman/<id> by an earlier attempt.
  git(f.repo, 'push', '-q', f.forge, `retry:refs/heads/foreman/${a.id}`);
  await new GitlabForge({ baseUrl: f.fake.url, token: TOKEN }).openMr('group/app', { sourceBranch: `foreman/${a.id}`, targetBranch: 'main', title: 't', description: 'd' });
  const posts = mrPosts(f.fake);

  useLanding(new Landing([f.map], null), f.home);
  const first = await approve(store, a.id);
  assert.equal(first.merge.code, 'mr-refused', first.merge.reason);
  assert.doesNotMatch(first.merge.reason, new RegExp(TOKEN));
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(a.id)!.error ?? '', /approved, but not landed: .*401/);
  assert.equal(store.isLanding(a.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0, 'the marker closed');
  assert.ok(pendingMrs().every((p) => p.taskId !== a.id));

  useLanding(new Landing([f.map], TOKEN), f.home);
  const second = await approve(store, a.id);
  assert.equal(second.merge.code, 'mr-opened', second.merge.reason);
  assert.match(second.merge.reason, /^opened !1 /);
  assert.equal(mrPosts(f.fake), posts, 'the open MR was reused, not a second one opened');
  assert.deepEqual(decisions(store, a.id), [{ action: 'approve', merged: 0 }, { action: 'approve', merged: 0 }]);
  assert.equal(store.getTask(a.id)!.status, 'done');
});

test('an unreachable forge returns the ticket to the gate with the reason', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([{ ...f.map, baseUrl: 'http://127.0.0.1:9' }], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'down');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-refused');
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(a.id)!.error ?? '', /approved, but not landed: /);
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 0);
});

test('work changed after review is refused before anything is pushed', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'changed');
  // The branch gains a commit nobody reviewed.
  git(f.repo, 'checkout', '-q', 'changed');
  fs.writeFileSync(path.join(f.repo, 'late.txt'), 'late\n');
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-qm', 'late');
  git(f.repo, 'checkout', '-q', 'main');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'not-reviewed', out.merge.reason);
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.equal(f.fake.requests.length, 0, 'the forge recorded no request');
  assert.equal(git(f.forge, 'for-each-ref', 'refs/heads/foreman/'), '', 'nothing was pushed');
});

test('two approvals in one repo open two MRs without waiting for CI', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'one');
  const b = parked(store, f.repo, 'two');
  const [ra, rb] = await Promise.all([approve(store, a.id), approve(store, b.id)]);
  assert.equal(ra.merge.code, 'mr-opened', ra.merge.reason);
  assert.equal(rb.merge.code, 'mr-opened', rb.merge.reason);
  assert.equal(mrPosts(f.fake), 2);
  assert.equal(landingRows(store), 2);
  assert.equal(store.isLanding(a.id) && store.isLanding(b.id), true);
});

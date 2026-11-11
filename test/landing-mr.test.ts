import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeGitlab } from '../scripts/forge/fakeGitlab.ts';
import { Store } from '../src/queue.ts';
import { ApprovalTracker, applyApproval, FourEyesRefused } from '../src/gate.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import { ForgeError, type Forge, type NewMr } from '../src/landing/forge.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { pendingMrs, useLanding } from '../src/landing/mr.ts';
import type { Principal } from '../src/types.ts';
import { approve, fixture, git, landingRows, parked } from './helpers/landingMr.ts';

// Approving a ticket whose repo lands by merge request (src/landing/mr.ts) pushes the reviewed commit to
// foreman/<task id> through the Foreman-owned mirror and opens a GitLab MR on the local fake; nothing merges into the
// checkout, and the ticket's landing hold stays on until the MR merges (LD-MR7a/7b).

const TOKEN = 'glpat-mr-test-Hk27';

const decisions = (store: Store, taskId: string): Array<{ action: string; merged: number }> =>
  (store.db.prepare("SELECT action, merged FROM decisions WHERE task_id = ? AND action = 'approve' ORDER BY rowid").all(taskId) as Array<{ action: string; merged: number }>)
    .map((r) => ({ action: r.action, merged: r.merged }));

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

test('approving again after new commits waits for GitLab to refresh the reused MR\'s head', async (t) => {
  // GitLab takes a pushed commit into an open MR's head in a background job: a read right after the push can show the old one.
  const f = await fixture(t, { refreshDelayMs: 1500 });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'reworked');
  // The MR an earlier approval left open, at the commit before the rework.
  git(f.repo, 'push', '-q', f.forge, `main:refs/heads/foreman/${a.id}`);
  const old = await new GitlabForge({ baseUrl: f.fake.url }).openMr('group/app', { sourceBranch: `foreman/${a.id}`, targetBranch: 'main', title: 't', description: 'd' });
  assert.equal(old.headSha, git(f.repo, 'rev-parse', 'main'));
  const posts = mrPosts(f.fake);
  useLanding(new Landing([f.map], null), f.home);
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  assert.match(out.merge.reason, /^opened !1 /);
  assert.equal(mrPosts(f.fake), posts, 'the open MR was reused');
  assert.deepEqual(pendingMrs().filter((p) => p.taskId === a.id).map((p) => p.tip), [git(f.repo, 'rev-parse', 'reworked')]);
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

test('an MR whose head is not the reviewed commit is refused and the ticket returns to the gate', async (t) => {
  const f = await fixture(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'moved');
  // Something else moves foreman/<id> on the forge after Foreman's push was confirmed, before the MR is opened.
  class MovingLanding extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      const openMr = real.openMr.bind(real);
      real.openMr = (project: string, mr: NewMr) => {
        git(f.forge, 'update-ref', `refs/heads/${mr.sourceBranch}`, 'refs/heads/main');
        return openMr(project, mr);
      };
      return real;
    }
  }
  useLanding(new MovingLanding([f.map], null), f.home);
  const tip = git(f.repo, 'rev-parse', 'moved');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-refused', out.merge.reason);
  assert.match(out.merge.reason, new RegExp(`is ${git(f.repo, 'rev-parse', 'main')}, not the reviewed commit ${tip}`));
  // Only a reused MR's head is read again (GitLab refreshes it in the background); a new one is refused on the first read.
  assert.equal(f.fake.requests.filter((r) => r.method === 'GET' && /\/merge_requests\/\d+$/.test(r.path)).length, 1, 'one read of the new MR');
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.equal(store.isLanding(a.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0, 'the marker closed');
  assert.ok(pendingMrs().every((p) => p.taskId !== a.id));
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

const notePosts = (fake: FakeGitlab): Array<{ path: string; body: string }> =>
  fake.requests.filter((r) => r.method === 'POST' && /\/notes$/.test(r.path)).map((r) => ({ path: r.path, body: (JSON.parse(r.body!) as { body: string }).body }));

test('the MR an approval opens names the task in its description and points to the approval note for the tree', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'described');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  const open = f.fake.requests.find((r) => r.method === 'POST' && /\/merge_requests$/.test(r.path))!;
  assert.deepEqual(JSON.parse(open.body!), {
    source_branch: `foreman/${a.id}`, target_branch: 'main', title: `Foreman ${a.id}: described`,
    // A reused MR keeps its description, so it names no tree that a later approval would make stale.
    description: `Foreman task ${a.id}\n\nThe reviewed tree is in the latest Foreman approval note.`,
    remove_source_branch: true, squash: false,
  });
});

/** Alice and Bob as human principals, which turns auth on; each has a token the note must never carry. */
function team(store: Store): { alice: Principal; bob: Principal; secrets: string[] } {
  const minted = ['alice', 'bob'].map((name) => {
    const principal = store.addPrincipal({ kind: 'human', name, createdBy: 'operator' });
    const token = randomBytes(32).toString('base64url');
    store.addToken({ principalId: principal.id, tokenHash: createHash('sha256').update(token).digest('hex'), createdBy: 'operator' });
    return { principal, token };
  });
  return { alice: minted[0]!.principal, bob: minted[1]!.principal, secrets: minted.map((m) => m.token) };
}

test('a four-eyes approval names its approver of record in one MR note, and its decision keeps the MR iid', async (t) => {
  const f = await fixture(t, { token: TOKEN });
  useLanding(new Landing([f.map], TOKEN), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { alice, bob, secrets } = team(store);
  const a = parked(store, f.repo, 'attributed', { createdBy: alice.id });
  const out = await applyApproval(store, a.id, { principal: bob.id, tracker: new ApprovalTracker() });
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  const decision = out.decision!;
  assert.equal(decision.actorId, bob.id);
  assert.deepEqual(decision.extra, { mrIid: 1 });
  const notes = notePosts(f.fake);
  assert.equal(notes.length, 1, 'exactly one note');
  assert.equal(notes[0]!.path, '/api/v4/projects/group%2Fapp/merge_requests/1/notes');
  assert.equal(notes[0]!.body, [
    `Approved in Foreman at reviewed tree ${store.latestRun(a.id)!.reviewedTree}. This replaces any earlier Foreman approval on this request.`,
    '',
    `Foreman-Approved-By: bob (${bob.id})`,
    'Foreman-Author: alice',
    `Foreman-Decision: ${decision.id}`,
  ].join('\n'));
  for (const secret of [TOKEN, ...secrets]) assert.ok(!notes[0]!.body.includes(secret), 'no token in the note');
});

test('an approval refused by four-eyes makes no forge call', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const { alice } = team(store);
  const a = parked(store, f.repo, 'own', { createdBy: alice.id });
  await assert.rejects(applyApproval(store, a.id, { principal: alice.id, tracker: new ApprovalTracker() }), FourEyesRefused);
  assert.equal(f.fake.requests.length, 0, 'the forge recorded no request');
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
});

test('a note the forge refuses is a warning on the ticket; the MR stays open and pending', async (t) => {
  const f = await fixture(t);
  class NoNotes extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      real.addNote = () => Promise.reject(new ForgeError('GitLab POST notes: 500 down'));
      return real;
    }
  }
  useLanding(new NoNotes([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'unnoted');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  assert.equal(store.getTask(a.id)!.status, 'done');
  assert.ok(pendingMrs().some((p) => p.taskId === a.id));
  assert.ok(store.eventsForTask(a.id).some((e) => e.type === 'warning' && e.message === 'merge request note naming the approver not posted: GitLab POST notes: 500 down'));
});

test('with auth off the note names the reserved actor and the recorded author', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'solo', { createdBy: 'operator' });
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  assert.deepEqual(notePosts(f.fake).map((n) => n.body.split('\n').slice(2)), [
    ['Foreman-Approved-By: operator', 'Foreman-Author: operator', `Foreman-Decision: ${out.decision!.id}`],
  ]);
});

test('the MR title names the task first, so a ticket title GitLab reads as a draft or one too long still opens a ready MR', async (t) => {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const [branch, title] of [['drafted', 'Draft: add page'], ['bracketed', '[draft] add page'], ['long', `x${'y'.repeat(300)}\nsecond line`], ['lines', 'add page\n\n  and its test\t']] as const) {
    const a = parked(store, f.repo, branch);
    store.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, a.id);
    const out = await approve(store, a.id);
    assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
    const open = f.fake.requests.filter((r) => r.method === 'POST' && /\/merge_requests$/.test(r.path)).at(-1)!;
    const sent = (JSON.parse(open.body!) as { title: string }).title;
    assert.ok(sent.startsWith(`Foreman ${a.id}: `), sent);
    assert.doesNotMatch(sent, /^\s*(draft:|\[draft\]|\(draft\))/i);
    assert.ok([...sent].length <= 255, `${[...sent].length} characters`);
    assert.doesNotMatch(sent, /\n/);
    if (branch === 'lines') assert.equal(sent, `Foreman ${a.id}: add page and its test`);
  }
});

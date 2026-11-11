import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FakeGitlab } from '../scripts/forge/fakeGitlab.ts';
import { config } from '../src/config.ts';
import { ApprovalTracker, applyApproval } from '../src/gate.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import { ForgeError, type Forge } from '../src/landing/forge.ts';
import { pendingMr, pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import type { ForgeMirror } from '../src/landing/push.ts';
import { Store } from '../src/queue.ts';
import type { Principal } from '../src/types.ts';
import { approve, fixture, git, landingRows, parked, postMerge, type Fixture } from './helpers/landingMr.ts';

// Four-eyes is asked again right before the forge merge call (src/landing/mr.ts), which can come minutes after the
// approval: the MR waits for its pipeline. An approver disabled meanwhile gets no merge.

process.env['FOREMAN_PREWARM'] = 'off';

const merges = (fake: FakeGitlab): number => fake.requests.filter((r) => r.method === 'PUT' && /\/merge$/.test(r.path)).length;
const notes = (fake: FakeGitlab): string[] =>
  fake.requests.filter((r) => r.method === 'POST' && /\/notes$/.test(r.path)).map((r) => (JSON.parse(r.body!) as { body: string }).body);

function human(store: Store, name: string): Principal {
  const principal = store.addPrincipal({ kind: 'human', name, createdBy: 'operator' });
  store.addToken({ principalId: principal.id, tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'), createdBy: 'operator' });
  return principal;
}

/** The fake's pipeline for `sha` passes. */
async function pipelinePasses(f: Fixture, sha: string): Promise<void> {
  const res = await fetch(`${f.fake.url}/__fake/pipelines/${sha}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'success' }),
  });
  assert.equal(res.status, 200);
}

/** A ticket alice created, approved by bob (auth on) or by the operator (auth off), its MR open with a running pipeline. */
async function opened(t: test.TestContext, authOn: boolean) {
  const f = await fixture(t);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alice = authOn ? human(store, 'alice') : null;
  const bob = authOn ? human(store, 'bob') : null;
  const a = parked(store, f.repo, 'work', alice ? { createdBy: alice.id } : {});
  const out = bob ? await applyApproval(store, a.id, { principal: bob.id, tracker: new ApprovalTracker() }) : await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  const tip = git(f.repo, 'rev-parse', 'work');
  let now = Date.now();
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; }, postMerge());
  await poll();
  assert.equal(merges(f.fake), 0, 'the pipeline is still running');
  return { f, store, a, bob, tip, poll, notesBefore: notes(f.fake).length };
}

test('pin: with nothing changed, a green pipeline leads to exactly one merge call and no further note', async (t) => {
  const { f, store, a, tip, poll, notesBefore } = await opened(t, true);
  await pipelinePasses(f, tip);
  await poll();
  await poll();
  assert.equal(merges(f.fake), 1);
  assert.equal(notes(f.fake).length, notesBefore);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'), 'merged and synced');
  assert.equal(store.getTask(a.id)!.status, 'done');
});

test('pin: with auth off, a green pipeline leads to exactly one merge call and no further note', async (t) => {
  const { f, tip, poll, notesBefore } = await opened(t, false);
  await pipelinePasses(f, tip);
  await poll();
  assert.equal(merges(f.fake), 1);
  assert.equal(notes(f.fake).length, notesBefore);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'), 'merged and synced');
});

test('an approver disabled while the pipeline ran gets no merge call: one MR note, and the ticket is back at the gate', async (t) => {
  const { f, store, a, bob, tip, poll, notesBefore } = await opened(t, true);
  const main = git(f.forge, 'rev-parse', 'main');
  store.disablePrincipal(bob!.id);
  await pipelinePasses(f, tip);
  await poll();
  await poll();
  assert.equal(merges(f.fake), 0, 'no merge call');
  assert.equal(git(f.forge, 'rev-parse', 'main'), main);
  const posted = notes(f.fake).slice(notesBefore);
  assert.equal(posted.length, 1, 'one note');
  assert.match(posted[0]!, /^Not merged by Foreman: four-eyes: only a signed-in person can approve or land work/);
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(a.id)!.error ?? '', /approved, but not landed: four-eyes: only a signed-in person can approve or land work/);
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 0);
  assert.equal(pendingMr(a.id), undefined);
});

test('a refusal note the forge does not take is a warning; still no merge call, and the ticket is back at the gate', async (t) => {
  const { f, store, a, bob, tip, poll } = await opened(t, true);
  useLanding(new (class extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      real.addNote = () => Promise.reject(new ForgeError('GitLab POST notes: 500 down'));
      return real;
    }
  })([f.map], null), f.home);
  store.disablePrincipal(bob!.id);
  await pipelinePasses(f, tip);
  await poll();
  assert.equal(merges(f.fake), 0, 'no merge call');
  assert.ok(store.eventsForTask(a.id).some((e) => e.type === 'warning' && e.message === 'merge request note giving why !1 was not merged not posted: GitLab POST notes: 500 down'));
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.equal(pendingMr(a.id), undefined);
});

test('a ticket that leaves done while four-eyes is asked again gets no merge call', async (t) => {
  const { f, store, a, tip, poll } = await opened(t, true);
  const live = store.livePrincipal.bind(store);
  store.livePrincipal = (id) => {
    store.setStatus(a.id, 'queued');
    return live(id);
  };
  await pipelinePasses(f, tip);
  await poll();
  assert.equal(merges(f.fake), 0, 'no merge call');
  assert.equal(pendingMr(a.id), undefined, 'the entry is dropped');
  assert.equal(store.getTask(a.id)!.status, 'queued');
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 0);
});

test('four-eyes is asked in the merge\'s turn: an approver disabled while another merge into the target runs gets no merge call', async (t) => {
  const f = await fixture(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alice = human(store, 'alice');
  const bob = human(store, 'bob');
  const first = parked(store, f.repo, 'first', { createdBy: alice.id });
  const second = parked(store, f.repo, 'second', { createdBy: alice.id });
  useLanding(new Landing([f.map], null), f.home);
  for (const task of [first, second]) {
    const out = await applyApproval(store, task.id, { principal: bob.id, tracker: new ApprovalTracker() });
    assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  }
  // The first MR's merge call runs until `finish`; the second MR waits its turn behind it.
  let finish!: () => void;
  const running = new Promise<void>((r) => { finish = r; });
  let called!: () => void;
  const firstCalled = new Promise<void>((r) => { called = r; });
  useLanding(new (class extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      const merge = real.merge.bind(real);
      real.merge = async (project, iid, sha) => {
        if (iid === 1) { called(); await running; }
        return merge(project, iid, sha);
      };
      return real;
    }
  })([f.map], null), f.home);
  let now = Date.now();
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; }, postMerge());
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'first'));
  const polls = [poll()];
  await firstCalled;
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'second'));
  polls.push(poll());
  // Long enough for the second poll to read its MR and reach the queue.
  await new Promise((r) => setTimeout(r, 1000));
  store.disablePrincipal(bob.id);
  finish();
  await Promise.all(polls);
  assert.equal(merges(f.fake), 1, 'only the first MR got a merge call');
  assert.equal(store.getTask(second.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(second.id)!.error ?? '', /approved, but not landed: four-eyes: only a signed-in person can approve or land work/);
  assert.equal(pendingMr(second.id), undefined);
});

test('the repo hold is read in the merge\'s turn: a repo held while another merge into the target runs gets no merge call', async (t) => {
  const f = await fixture(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = parked(store, f.repo, 'first');
  const second = parked(store, f.repo, 'second');
  useLanding(new Landing([f.map], null), f.home);
  for (const task of [first, second]) {
    const out = await approve(store, task.id);
    assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  }
  // The first MR's merge call runs until `finish`; the second MR waits its turn behind it.
  let finish!: () => void;
  const running = new Promise<void>((r) => { finish = r; });
  let called!: () => void;
  const firstCalled = new Promise<void>((r) => { called = r; });
  useLanding(new (class extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      const merge = real.merge.bind(real);
      real.merge = async (project, iid, sha) => {
        if (iid === 1) { called(); await running; }
        return merge(project, iid, sha);
      };
      return real;
    }
  })([f.map], null), f.home);
  let now = Date.now();
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; }, postMerge());
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'first'));
  const polls = [poll()];
  await firstCalled;
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'second'));
  polls.push(poll());
  // Long enough for the second poll to read its MR and reach the queue.
  await new Promise((r) => setTimeout(r, 1000));
  // As a merge that cannot be confirmed, or a checkout not synced, holds the repo.
  store.holdLanding(f.repo, first.id, 'held for the test', 0);
  finish();
  await Promise.all(polls);
  assert.equal(merges(f.fake), 1, 'only the first MR got a merge call');
  assert.equal(store.getTask(second.id)!.status, 'done', 'the second MR waits for land-clear');
  assert.ok(pendingMr(second.id), 'the second MR is still followed');
});

test('the turn lasts until the merge is confirmed and synced: a merge that cannot be confirmed holds the repo before the next merge call', async (t) => {
  const f = await fixture(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const first = parked(store, f.repo, 'first');
  const second = parked(store, f.repo, 'second');
  useLanding(new Landing([f.map], null), f.home);
  for (const task of [first, second]) {
    const out = await approve(store, task.id);
    assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  }
  // Whichever MR merges first, the mirror cannot confirm its merge commit, so the repo is held.
  useLanding(new (class extends Landing {
    override mirror(m: LandingMapping, home: string): ForgeMirror {
      const real = super.mirror(m, home);
      real.confirmMerge = async () => { await new Promise((r) => setTimeout(r, 300)); return false; };
      return real;
    }
  })([f.map], null), f.home);
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'first'));
  await pipelinePasses(f, git(f.repo, 'rev-parse', 'second'));
  // Both MRs are due in one poll, so the second waits its turn behind the first's merge.
  await pollMergeRequests(store, Date.now() + config.mrPollMs, (err) => { throw err; }, postMerge());
  assert.equal(merges(f.fake), 1, 'no merge call on top of a merge that is not confirmed');
  assert.ok(store.landInterrupted(f.repo), 'the repo is held');
  const waiting = [first, second].filter((task) => pendingMr(task.id));
  assert.equal(waiting.length, 1, 'the other MR is still followed');
  assert.equal(store.getTask(waiting[0]!.id)!.status, 'done', 'and waits for land-clear');
});

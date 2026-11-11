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
import { Store } from '../src/queue.ts';
import type { Principal } from '../src/types.ts';
import { approve, fixture, git, landingRows, parked, type Fixture } from './helpers/landingMr.ts';

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
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; });
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
  assert.equal(pendingMr(a.id)!.phase, 'merged');
  assert.equal(store.getTask(a.id)!.status, 'done');
});

test('pin: with auth off, a green pipeline leads to exactly one merge call and no further note', async (t) => {
  const { f, a, tip, poll, notesBefore } = await opened(t, false);
  await pipelinePasses(f, tip);
  await poll();
  assert.equal(merges(f.fake), 1);
  assert.equal(notes(f.fake).length, notesBefore);
  assert.equal(pendingMr(a.id)!.phase, 'merged');
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

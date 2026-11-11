import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { Landing } from '../src/landing/config.ts';
import { pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import { Store } from '../src/queue.ts';
import { approve, fixture, git, landingRows, parked, type Fixture } from './helpers/landingMr.ts';

// Once a merge request's merge M is confirmed (src/landing/mr.ts), the operator's checkout is fast-forwarded to M
// inside the repo's merge section, and M is handed to the post-merge check (src/landing/verify.ts), which releases the
// dependents on green.

process.env['FOREMAN_PREWARM'] = 'off';

/** An approved ticket with its MR open (the fake's pipeline passes), a dependent, and a poller. */
async function opened(t: test.TestContext, f: Fixture) {
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'work');
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  assert.equal((await approve(store, a.id)).merge.code, 'mr-opened');
  let now = Date.now();
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; });
  return { store, a, child, poll };
}

test('a confirmed merge fast-forwards the checkout to it, and the dependent is released', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, child, poll } = await opened(t, f);
  await poll();
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), m, 'the checkout is at the merge commit');
  assert.equal(store.isLanding(a.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
});

test('a merge the mirror cannot confirm holds the repo until land-clear', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, poll } = await opened(t, f);
  const main = git(f.forge, 'rev-parse', 'main');
  useLanding(new (class extends Landing {
    override forge(m: Fixture['map']) {
      const real = super.forge(m);
      const getMr = real.getMr.bind(real);
      real.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), state: 'merged', mergeCommitSha: main });
      return real;
    }
  })([f.map], null), f.home);
  await poll();
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id, 'the repo is held');
  assert.equal(store.clearLandInterrupted(f.repo), true);
  assert.equal(store.isLanding(a.id), false, 'land-clear ends the hold');
  assert.equal(landingRows(store), 0, 'and drops the marker');
});

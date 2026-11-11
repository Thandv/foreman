import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Landing } from '../src/landing/config.ts';
import { useLanding } from '../src/landing/mr.ts';
import { approve, fixture, git, parked } from './helpers/landingMr.ts';

// An open merge request (src/landing/mr.ts) is polled by a tick stage and merged on the forge at the reviewed sha once
// its pipeline passes; the merge is then confirmed in the Foreman-owned mirror.

process.env['FOREMAN_PREWARM'] = 'off';

/** Resolves with the first event on `taskId` whose message matches `re`. */
function eventOn(store: Store, taskId: string, re: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const seen = (ev: { taskId: string | null; message: string }): void => {
      if (ev.taskId !== taskId || !re.test(ev.message)) return;
      store.off('event', seen);
      resolve(ev.message);
    };
    store.on('event', seen);
  });
}

const merges = (f: { fake: { requests: Array<{ method: string; path: string; query: Record<string, string> }> } }) =>
  f.fake.requests.filter((r) => r.method === 'PUT' && /\/merge$/.test(r.path));

test('the scheduler merges an approved ticket\'s MR at the reviewed sha once its pipeline passes', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  t.after(async () => { await sched.stop(); store.close(); });
  const a = parked(store, f.repo, 'polled');
  const tip = git(f.repo, 'rev-parse', 'polled');
  assert.equal((await approve(store, a.id)).merge.code, 'mr-opened');
  const merged = eventOn(store, a.id, /^merged !1 at /);
  await sched.pulse();
  assert.match(await merged, /checkout sync pending$/);
  assert.deepEqual(merges(f).map((r) => r.query), [{ sha: tip }], 'one merge call, at the reviewed sha');
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip);
});

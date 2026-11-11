import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { config } from '../src/config.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import type { Forge } from '../src/landing/forge.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { pendingMr, pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import type { Task } from '../src/types.ts';
import { approve, fixture, git, landingRows, parked, type Fixture } from './helpers/landingMr.ts';

// An open merge request (src/landing/mr.ts) is polled by a tick stage and merged on the forge at the reviewed sha once
// its pipeline passes; the merge is then confirmed in the Foreman-owned mirror.

process.env['FOREMAN_PREWARM'] = 'off';

/** Resolves with the first event on `taskId` whose message matches `re`. */
function eventOn(store: Store, taskId: string | null, re: RegExp): Promise<string> {
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

/** From now on (the MR is open), the fake's forge with `patch` applied to each forge handed out. */
function patch(f: Fixture, patch: (forge: Forge) => void): void {
  useLanding(new (class extends Landing {
    override forge(m: LandingMapping): Forge {
      const real = super.forge(m);
      patch(real);
      return real;
    }
  })([f.map], null), f.home);
}

/** Polls the way the tick stage does, each call one poll interval after the last; a thrown poll fails the test. */
function poller(store: Store, start = Date.now()): (at?: number) => Promise<void> {
  let now = start;
  return (at?: number) => {
    now = at ?? now + config.mrPollMs;
    return pollMergeRequests(store, now, (err) => { throw err; });
  };
}

/** An approved ticket with its MR open, a dependent and a fresh store. */
async function opened(t: { after: (fn: () => void) => void }, f: Fixture) {
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'work');
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  return { store, a, child, tip: git(f.repo, 'rev-parse', 'work'), main: git(f.forge, 'rev-parse', 'main') };
}

const messages = (store: Store, task: Task): string[] => store.eventsForTask(task.id).map((e) => e.message);

/** The ticket is back at the gate with `reason`, its hold ended, its marker closed and its MR no longer pending. */
function atGate(store: Store, task: Task, reason: RegExp): void {
  assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(task.id)!.error ?? '', reason);
  assert.equal(store.isLanding(task.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0, 'the marker closed');
  assert.equal(pendingMr(task.id), undefined);
}

test('a passing pipeline: one merge call at the reviewed sha, confirmed in the mirror; the dependent stays held for the sync', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, child, tip } = await opened(t, f);
  const poll = poller(store);
  await poll();
  assert.deepEqual(merges(f).map((r) => r.query), [{ sha: tip }]);
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip);
  assert.deepEqual({ phase: pendingMr(a.id)!.phase, merged: pendingMr(a.id)!.merged }, { phase: 'merged', merged: m });
  assert.ok(messages(store, a).includes(`merged !1 at ${m}; checkout sync pending`));
  assert.equal(landingRows(store), 0, 'the marker closed');
  assert.equal(store.isLanding(a.id), true, 'the hold stays until the checkout is synced');
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'blocked');
  await poll();
  assert.equal(merges(f).length, 1, 'a merged MR is not polled again');
});

test('a "checking" window of three polls is waited out, then the MR merges', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  let reads = 0;
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => {
      const mr = await getMr(project, iid);
      return ++reads <= 3 ? { ...mr, mergeStatus: 'checking' } : mr;
    };
  });
  const poll = poller(store);
  for (let i = 0; i < 3; i++) await poll();
  assert.equal(merges(f).length, 0);
  assert.equal(store.getTask(a.id)!.status, 'done', 'not bounced');
  assert.equal(messages(store, a).filter((m) => m === 'merge request !1 waiting: GitLab reports checking').length, 1, 'one event for the wait');
  await poll();
  assert.equal(merges(f).length, 1);
  assert.equal(pendingMr(a.id)!.phase, 'merged');
});

test('a commit pushed to the source branch after review sends the ticket back to the gate; the target is unchanged', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, main } = await opened(t, f);
  git(f.forge, 'update-ref', `refs/heads/foreman/${a.id}`, 'main');
  await poller(store)();
  assert.equal(merges(f).length, 0);
  atGate(store, a, /approved, but not landed: MR head moved after review/);
  assert.equal(git(f.forge, 'rev-parse', 'main'), main);
});

test('a failed pipeline sends the ticket back to the gate with its status and URL', async (t) => {
  const f = await fixture(t, { pipeline: 'failed' });
  const { store, a } = await opened(t, f);
  await poller(store)();
  assert.equal(merges(f).length, 0);
  atGate(store, a, /the pipeline of !1 failed: http:\/\/127\.0\.0\.1:\d+\/group\/app\/-\/pipelines\/\d+/);
});

test('an MR merged by a person on the forge is confirmed the same way', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip } = await opened(t, f);
  assert.equal((await new GitlabForge({ baseUrl: f.fake.url }).merge('group/app', 1, tip)).merged, true);
  await poller(store)();
  assert.equal(merges(f).length, 1, 'only the person\'s merge');
  assert.equal(pendingMr(a.id)!.phase, 'merged');
  assert.equal(pendingMr(a.id)!.merged, git(f.forge, 'rev-parse', 'main'));
  assert.equal(landingRows(store), 0);
});

test('a merge commit that is not the reviewed commit keeps the hold and the marker', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, main } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), state: 'merged', mergeCommitSha: main });
  });
  await poller(store)();
  assert.equal(merges(f).length, 0);
  assert.equal(pendingMr(a.id)!.phase, 'held');
  assert.ok(messages(store, a).some((m) => /^merge request !1 merged, but the merged commit is not the reviewed commit /.test(m)));
  assert.equal(store.isLanding(a.id), true);
  assert.equal(landingRows(store), 1, 'the marker stays, so the next start holds the repo');
});

test('a ticket reopened while its MR is read is dropped with no merge call', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a: task } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => {
      const mr = await getMr(project, iid);
      store.setStatus(task.id, 'queued');
      return mr;
    };
  });
  await poller(store)();
  assert.equal(merges(f).length, 0, 'no merge call');
  assert.equal(pendingMr(task.id), undefined, 'the entry is dropped');
  assert.equal(store.isLanding(task.id), false);
  assert.equal(landingRows(store), 0);
  assert.ok(messages(store, task).includes('merge request !1 no longer followed: the ticket is queued; nothing merged'));
});

test('an MR not merged within FOREMAN_MR_TIMEOUT_MIN sends the ticket back to the gate', async (t) => {
  const f = await fixture(t);
  const { store, a } = await opened(t, f);
  const poll = poller(store);
  await poll();
  assert.equal(store.getTask(a.id)!.status, 'done', 'a running pipeline is waited for');
  await poll(Date.now() + config.mrTimeoutMin * 60_000 + 1);
  assert.equal(merges(f).length, 0);
  atGate(store, a, /not merged within FOREMAN_MR_TIMEOUT_MIN \(120 min\); last: pipeline running/);
});

test('a merge GitLab refuses for a lasting reason sends the ticket back to the gate with its message', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  let reads = 0;
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => {
      const mr = await getMr(project, iid);
      return ++reads > 1 ? { ...mr, mergeStatus: 'not_approved' } : mr;
    };
    forge.merge = () => Promise.resolve({ merged: false, reason: 'not-mergeable', detail: '405 approvals are required' });
  });
  await poller(store)();
  atGate(store, a, /GitLab did not merge !1: 405 approvals are required/);
});

test('a throwing forge adapter is recorded against the stage, and the tick still dispatches', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const { store, a } = await opened(t, f);
  useLanding(new (class extends Landing {
    override forge(): Forge { throw new Error('adapter boom'); }
  })([f.map], null), f.home);
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const queued = store.addTask({ title: 'claimed past the throw', prompt: 'x', runner: 'echo' });
    const failed = eventOn(store, null, /^scheduler tick failed in pollMergeRequests: /);
    await sched.pulse();
    assert.notEqual(store.getTask(queued.id)!.status, 'queued', 'claimed in the same tick');
    assert.equal(await failed, 'scheduler tick failed in pollMergeRequests: adapter boom');
    assert.equal(pendingMr(a.id)!.phase, 'open', 'still pending, polled again next time');
  } finally {
    await sched.stop();
  }
});

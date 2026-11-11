import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { config } from '../src/config.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import { ForgeError, type Forge } from '../src/landing/forge.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { ForgeMirror, MirrorError } from '../src/landing/push.ts';
import { pendingMr, pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import type { Task } from '../src/types.ts';
import { approve, fixture, git, landingRows, parked, postMerge, type Fixture } from './helpers/landingMr.ts';

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
  const synced = eventOn(store, a.id, /^checkout synced to /);
  await sched.pulse();
  assert.equal(await synced, `checkout synced to ${git(f.forge, 'rev-parse', 'main')}`);
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
    return pollMergeRequests(store, now, (err) => { throw err; }, postMerge());
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

/** The merge is synced: the checkout is at the forge's main, the hold ended, the marker closed, the MR let go. */
function synced(store: Store, f: Fixture, task: Task): void {
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'), 'the checkout is at the merge commit');
  assert.equal(store.isLanding(task.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0, 'the marker closed');
  assert.equal(pendingMr(task.id), undefined);
}

/** The repo is held for the operator with `reason`: the hold and the marker stay, and the MR is let go. */
function held(store: Store, f: Fixture, task: Task, reason: RegExp): void {
  assert.equal(store.landInterrupted(f.repo)?.taskId, task.id);
  assert.ok(messages(store, task).some((m) => reason.test(m)), 'the reason is on the timeline');
  assert.equal(store.isLanding(task.id), true);
  assert.equal(landingRows(store), 1, 'the marker stays, so the next start holds the repo too');
  assert.equal(pendingMr(task.id), undefined);
}

test('a passing pipeline: one merge call at the reviewed sha, confirmed in the mirror, synced and checked; the dependent is released', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, child, tip } = await opened(t, f);
  const poll = poller(store);
  await poll();
  assert.deepEqual(merges(f).map((r) => r.query), [{ sha: tip }]);
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip);
  assert.ok(messages(store, a).includes(`merged !1 at ${m}`));
  synced(store, f, a);
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
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
  synced(store, f, a);
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
  synced(store, f, a);
});

test('a merge commit that is not the reviewed commit holds the repo with the hold and the marker', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, main } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), state: 'merged', mergeCommitSha: main });
  });
  await poller(store)();
  assert.equal(merges(f).length, 0);
  held(store, f, a, /^land-held\(.*\): merge request !1 merged, but the merged commit is not the reviewed commit /);
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
  assert.ok(messages(store, task).includes('merge request !1 no longer followed: the ticket is queued; no merge made by Foreman'));
});

test('a ticket reopened while Foreman\'s merge call is in flight still has the merge confirmed, with a warning', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip } = await opened(t, f);
  patch(f, (forge) => {
    const merge = forge.merge.bind(forge);
    forge.merge = async (project, iid, sha) => {
      const out = await merge(project, iid, sha);
      store.setStatus(a.id, 'queued');
      return out;
    };
  });
  await poller(store)();
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip, 'the forge merged the reviewed commit');
  assert.ok(messages(store, a).includes(`merged !1 at ${m}`));
  synced(store, f, a);
  assert.ok(messages(store, a).includes('merge request !1 merged on the forge while the ticket is queued'));
  assert.ok(!messages(store, a).some((msg) => /no longer followed/.test(msg)));
});

test('a merge Foreman made whose answer was lost is confirmed after the ticket is reopened, not dropped', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip } = await opened(t, f);
  patch(f, (forge) => {
    const merge = forge.merge.bind(forge);
    forge.merge = async (project, iid, sha) => {
      await merge(project, iid, sha);
      throw new ForgeError('no answer within 15000 ms');
    };
  });
  const poll = poller(store);
  await poll();
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip, 'the forge merged the reviewed commit');
  assert.ok(messages(store, a).includes('merge request !1 waiting: no answer within 15000 ms'));
  store.setStatus(a.id, 'queued');
  await poll();
  synced(store, f, a);
  assert.ok(messages(store, a).includes('merge request !1 merged on the forge while the ticket is queued'));
  assert.ok(!messages(store, a).some((msg) => /no longer followed/.test(msg)));
});

test('a merge call whose answer was lost and that did not merge is dropped once the MR reads open after a reopen', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    forge.merge = async () => { throw new ForgeError('no answer within 15000 ms'); };
  });
  const poll = poller(store);
  await poll();
  store.setStatus(a.id, 'queued');
  await poll();
  assert.equal(pendingMr(a.id), undefined, 'the entry is dropped');
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 0);
  assert.ok(messages(store, a).includes('merge request !1 no longer followed: the ticket is queued; no merge made by Foreman'));
});

test('a merge call whose answer was lost is dropped, not sent to the gate, when the MR then reads closed after a reopen', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    forge.merge = async () => { throw new ForgeError('no answer within 15000 ms'); };
  });
  const poll = poller(store);
  await poll();
  store.setStatus(a.id, 'queued');
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), state: 'closed' });
  });
  await poll();
  assert.equal(store.getTask(a.id)?.status, 'queued', 'the person\'s status stands');
  assert.equal(pendingMr(a.id), undefined, 'the entry is dropped');
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 0);
  assert.ok(messages(store, a).includes('merge request !1 no longer followed: the ticket is queued; no merge made by Foreman'));
});

test('a merge refused while the ticket was reopened leaves the person\'s status and drops the entry', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    forge.merge = async () => {
      store.setStatus(a.id, 'queued');
      return { merged: false, reason: 'head-moved', detail: 'sha mismatch' };
    };
  });
  await poller(store)();
  assert.equal(store.getTask(a.id)?.status, 'queued', 'the person\'s status stands');
  assert.equal(pendingMr(a.id), undefined, 'the entry is dropped');
  assert.equal(store.isLanding(a.id), false, 'the hold has ended');
  assert.equal(landingRows(store), 0);
  assert.ok(messages(store, a).includes('merge request !1 no longer followed: the ticket is queued; no merge made by Foreman'));
});

test('a forge merge whose confirm fails after the ticket is reopened keeps the hold and the marker until it is confirmed', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip } = await opened(t, f);
  let failures = 1;
  useLanding(new (class extends Landing {
    override mirror(m: LandingMapping, home: string): ForgeMirror {
      const real = super.mirror(m, home);
      const confirm = real.confirmMerge.bind(real);
      real.confirmMerge = async (merge, reviewed) => {
        if (failures-- <= 0) return confirm(merge, reviewed);
        store.setStatus(a.id, 'queued');
        throw new MirrorError('fetch failed');
      };
      return real;
    }
  })([f.map], null), f.home);
  const poll = poller(store);
  await poll();
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip, 'the forge merged the reviewed commit');
  assert.notEqual(pendingMr(a.id), undefined, 'still followed');
  assert.equal(store.isLanding(a.id), true, 'the hold stays');
  assert.equal(landingRows(store), 1, 'the marker stays');
  await poll();
  synced(store, f, a);
  assert.ok(messages(store, a).includes('merge request !1 merged on the forge while the ticket is queued'));
  assert.ok(!messages(store, a).some((msg) => /no longer followed/.test(msg)));
  assert.equal(merges(f).length, 1);
});

test('stop() waits for a merge call still in flight, so its merge is confirmed before the store closes', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inMerge = new Promise<void>((r) => { entered = r; });
  patch(f, (forge) => {
    const merge = forge.merge.bind(forge);
    forge.merge = async (project, iid, sha) => {
      entered();
      await gate;
      return merge(project, iid, sha);
    };
  });
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  await sched.pulse();
  await inMerge;
  const stopped = sched.stop();
  release();
  await stopped;
  assert.ok(messages(store, a).includes(`checkout synced to ${git(f.forge, 'rev-parse', 'main')}`), 'merged and synced before stop() returned');
  assert.equal(landingRows(store), 0, 'the marker closed');
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

test('a merge call whose answer was lost at FOREMAN_MR_TIMEOUT_MIN is read back, not sent to the gate', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip } = await opened(t, f);
  patch(f, (forge) => {
    const merge = forge.merge.bind(forge);
    forge.merge = async (project, iid, sha) => {
      await merge(project, iid, sha);
      throw new ForgeError('no answer within 15000 ms');
    };
  });
  const poll = poller(store);
  await poll(Date.now() + config.mrTimeoutMin * 60_000 + 1);
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip, 'the forge merged the reviewed commit');
  assert.equal(store.getTask(a.id)!.status, 'done');
  assert.equal(landingRows(store), 1, 'the marker stays open');
  assert.equal(store.isLanding(a.id), true);
  await poll();
  assert.equal(store.getTask(a.id)!.status, 'done');
  synced(store, f, a);
});

test('a merge call GitLab answers with an HTTP error (401) is not taken for a lost answer: the timeout still sends the ticket back', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    forge.merge = async () => { throw new ForgeError('GitLab PUT /merge_requests/1/merge: 401 401 Unauthorized', 401); };
  });
  const poll = poller(store);
  await poll();
  assert.equal(store.getTask(a.id)!.status, 'done', 'waited, not bounced, before the timeout');
  await poll(Date.now() + config.mrTimeoutMin * 60_000 + 1);
  assert.equal(merges(f).length, 0);
  atGate(store, a, /not merged within FOREMAN_MR_TIMEOUT_MIN \(120 min\); last: GitLab PUT \/merge_requests\/1\/merge: 401/);
});

test('an MR GitLab reads as not_approved from the first read is waited out, with no merge call, until FOREMAN_MR_TIMEOUT_MIN', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), mergeStatus: 'not_approved' });
  });
  const poll = poller(store);
  await poll();
  assert.equal(store.getTask(a.id)!.status, 'done', 'waited, not bounced');
  assert.ok(messages(store, a).includes('merge request !1 waiting: GitLab reports not_approved'));
  await poll(Date.now() + config.mrTimeoutMin * 60_000 + 1);
  assert.equal(merges(f).length, 0, 'no merge call');
  atGate(store, a, /not merged within FOREMAN_MR_TIMEOUT_MIN \(120 min\); last: GitLab reports not_approved/);
});

test('a merge GitLab refuses while its status reads a lasting word sends the ticket back to the gate with GitLab\'s message', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  let reads = 0;
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => {
      const mr = await getMr(project, iid);
      return ++reads > 1 ? { ...mr, mergeStatus: 'conflict' } : mr;
    };
    forge.merge = () => Promise.resolve({ merged: false, reason: 'not-mergeable', detail: '405 Method Not Allowed' });
  });
  await poller(store)();
  atGate(store, a, /GitLab did not merge !1: 405 Method Not Allowed/);
});

/** Opens an MR on the fake as another GitLab user could: from foreman/<task id> into `target`, with `squash`. */
async function strayMr(f: Fixture, taskId: string, target: string, squash: boolean): Promise<void> {
  if (target !== 'main') git(f.forge, 'branch', target, 'main');
  git(f.forge, 'branch', `foreman/${taskId}`, 'main');
  const res = await fetch(`${f.fake.url}/api/v4/projects/group%2Fapp/merge_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_branch: `foreman/${taskId}`, target_branch: target, title: 'stray', squash }),
  });
  assert.equal(res.status, 200, await res.text());
}

test('an open MR from foreman/<id> into another branch is not reused: the approval lands into the mapped target only', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'work');
  const tip = git(f.repo, 'rev-parse', 'work');
  await strayMr(f, a.id, 'release', true);
  const release = git(f.forge, 'rev-parse', 'release');
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-opened', out.merge.reason);
  assert.equal(pendingMr(a.id)?.iid, 2, 'its own MR, not the stray one');
  await poller(store)();
  assert.equal(git(f.forge, 'rev-parse', 'release'), release, 'the other branch is untouched');
  assert.equal(git(f.forge, 'rev-parse', 'main^2'), tip);
  synced(store, f, a);
});

test('an open MR from foreman/<id> into the target that is set to squash is refused at approval', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'work');
  await strayMr(f, a.id, 'main', true);
  const out = await approve(store, a.id);
  assert.equal(out.merge.code, 'mr-refused');
  assert.match(out.merge.reason, /!1 is set to squash/);
  assert.equal(merges(f).length, 0);
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
});

test('an MR whose target branch is changed on GitLab after approval goes back to the gate with no merge call', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), targetBranch: 'release' });
  });
  await poller(store)();
  assert.equal(merges(f).length, 0);
  atGate(store, a, /!1 targets release, not main/);
});

test('an approval in a project that requires squash or runs merge trains is refused before anything is pushed', async (t) => {
  for (const [projectExtra, why] of [
    [{ squash_option: 'always' }, /squash_option always/],
    [{ merge_trains_enabled: true }, /merge trains are on/],
    [{ merge_pipelines_enabled: true }, /merged results pipelines are on/],
  ] as const) {
    const f = await fixture(t, { pipeline: 'success', projectExtra });
    useLanding(new Landing([f.map], null), f.home);
    const store = new Store(':memory:');
    t.after(() => store.close());
    const a = parked(store, f.repo, 'work');
    const out = await approve(store, a.id);
    assert.equal(out.merge.code, 'mr-refused');
    assert.match(out.merge.reason, why);
    assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
    assert.throws(() => git(f.forge, 'rev-parse', '--verify', `refs/heads/foreman/${a.id}`), 'nothing pushed');
  }
});

test('a daemon restart with an MR open sends the ticket back to the gate; land-clear does not release its dependent', async (t) => {
  const f = await fixture(t, { pipeline: 'manual' });
  useLanding(new Landing([f.map], null), f.home);
  const dbPath = `${f.home}/foreman.db`;
  const before = new Store(dbPath);
  const a = parked(before, f.repo, 'work');
  const child = before.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  assert.equal((await approve(before, a.id)).merge.code, 'mr-opened');
  // The daemon stops with the MR open: its pending table goes with it.
  before.close();
  useLanding(null, f.home);
  useLanding(new Landing([f.map], null), f.home);
  assert.equal(pendingMr(a.id), undefined);
  const store = new Store(dbPath);
  t.after(() => store.close());
  store.adoptInterruptedLandings();
  assert.equal(store.getTask(a.id)!.status, 'awaiting-approval');
  assert.match(store.getTask(a.id)!.error ?? '', /daemon restarted while its merge request !1 was open/);
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id, 'the repo is still held for a look');
  assert.ok(store.clearLandInterrupted(f.repo));
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'blocked', 'not released onto a main without the change');
});

test('a daemon restart after GitLab merged the MR but the checkout was held keeps the ticket done', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  useLanding(new Landing([f.map], null), f.home);
  const dbPath = `${f.home}/foreman.db`;
  const before = new Store(dbPath);
  const a = parked(before, f.repo, 'work');
  const child = before.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  assert.equal((await approve(before, a.id)).merge.code, 'mr-opened');
  git(f.repo, 'checkout', '-q', '-b', 'elsewhere');
  await poller(before)();
  const m = git(f.forge, 'rev-parse', 'main');
  held(before, f, a, /^land-held\(.*\): merge request !1 merged at [0-9a-f]+, but checkout not on main/);
  before.close();
  useLanding(null, f.home);
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(dbPath);
  t.after(() => store.close());
  store.adoptInterruptedLandings();
  assert.equal(store.getTask(a.id)!.status, 'done', 'merged on GitLab: not sent back to the gate');
  assert.ok(!messages(store, a).some((msg) => /back to the gate: the daemon restarted/.test(msg)));
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id, 'the repo is still held for a look');
  // The operator syncs the checkout by hand and clears the hold, as the land-held warning says.
  git(f.repo, 'checkout', '-q', 'main');
  git(f.repo, 'merge', '--ff-only', '--quiet', m);
  assert.ok(store.clearLandInterrupted(f.repo));
  store.reconcileBlocked();
  assert.equal(store.getTask(child.id)!.status, 'queued');
});

test('an MR that reads as from another project (a fork) goes back to the gate with no merge call', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), sourceProjectId: 99 });
  });
  await poller(store)();
  assert.equal(merges(f).length, 0);
  atGate(store, a, /!1 is from another project \(a fork\)/);
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
    assert.equal(sched.tickStageErrors().get('pollMergeRequests'), 1, 'counted against the stage');
    assert.notEqual(pendingMr(a.id), undefined, 'still pending, polled again next time');
  } finally {
    await sched.stop();
  }
});

test('a merge commit the target no longer reaches holds the repo with the hold and the marker', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, tip, main } = await opened(t, f);
  assert.equal((await new GitlabForge({ baseUrl: f.fake.url }).merge('group/app', 1, tip)).merged, true);
  await new Landing([f.map], null).mirror(f.map, f.home).fetchTarget();
  git(f.forge, 'update-ref', 'refs/heads/main', main);
  await poller(store)();
  // The merge commit is in the mirror and its ^2 is the tip, but it is not on the target.
  held(store, f, a, /^land-held\(.*\): merge request !1 merged, but the merged commit is not the reviewed commit /);
});

test('an MR closed on the forge sends the ticket back to the gate', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), state: 'closed' });
  });
  await poller(store)();
  assert.equal(merges(f).length, 0);
  atGate(store, a, /merge request !1 was closed on the forge/);
});

test('a mapping that does not require a pipeline merges an MR with none', async (t) => {
  const f = await fixture(t, { requirePipeline: false });
  f.map = { ...f.map, requirePipeline: false };
  const { store, a, tip } = await opened(t, f);
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => ({ ...(await getMr(project, iid)), pipeline: null });
  });
  await poller(store)();
  assert.deepEqual(merges(f).map((r) => r.query), [{ sha: tip }]);
  synced(store, f, a);
});

test('a merge GitLab refuses while its status is still settling is waited for, not bounced', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a } = await opened(t, f);
  let reads = 0;
  patch(f, (forge) => {
    const getMr = forge.getMr.bind(forge);
    forge.getMr = async (project, iid) => {
      const mr = await getMr(project, iid);
      return ++reads > 1 ? { ...mr, mergeStatus: 'checking' } : mr;
    };
    forge.merge = () => Promise.resolve({ merged: false, reason: 'not-mergeable', detail: '405 checking' });
  });
  await poller(store)();
  assert.equal(store.getTask(a.id)!.status, 'done', 'not bounced');
  assert.notEqual(pendingMr(a.id), undefined);
  assert.ok(messages(store, a).includes('merge request !1 waiting: GitLab reports checking'));
});

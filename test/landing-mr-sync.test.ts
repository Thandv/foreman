import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { ApprovalTracker } from '../src/gate.ts';
import { Landing } from '../src/landing/config.ts';
import { pendingMr, pollMergeRequests, useLanding } from '../src/landing/mr.ts';
import { mirrorPath } from '../src/landing/push.ts';
import { mergeSectionsPending } from '../src/landing/queue.ts';
import type { MainChecker, PostMergeRun } from '../src/landing/verify.ts';
import { Store } from '../src/queue.ts';
import { scratchDir } from './env.ts';
import { approve, fixture, git, landingRows, parked, passes, postMerge, type Fixture } from './helpers/landingMr.ts';

// Once a merge request's merge M is confirmed (src/landing/mr.ts), the operator's checkout is fast-forwarded to M
// inside the repo's merge section, and M is handed to the post-merge check (src/landing/verify.ts), which releases the
// dependents on green. A checkout that cannot take M holds the repo until `foreman land-clear`.

process.env['FOREMAN_PREWARM'] = 'off';

/** A checker that passes and remembers each HEAD it was asked about. */
function recording(): { heads: string[]; check: MainChecker } {
  const heads: string[] = [];
  return { heads, check: async (repo, cmd, signal, head) => { heads.push(head); return passes(repo, cmd, signal, head); } };
}

/** An approved ticket with its MR open (the fake's pipeline passes), a dependent, and a poller running `check`. */
async function opened(t: test.TestContext, f: Fixture, check: PostMergeRun = postMerge()) {
  useLanding(new Landing([f.map], null), f.home);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = parked(store, f.repo, 'work');
  const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', repo: f.repo, deps: [a.id] });
  assert.equal((await approve(store, a.id)).merge.code, 'mr-opened');
  let now = Date.now();
  const poll = (): Promise<void> => pollMergeRequests(store, now += config.mrPollMs, (err) => { throw err; }, check);
  return { store, a, child, poll };
}

/** Resolves once `cond` holds, checked once per turn of the event loop. */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setImmediate(r));
}

const messages = (store: Store, taskId: string): string[] => store.eventsForTask(taskId).map((e) => e.message);
const released = (store: Store, taskId: string): string => {
  store.reconcileBlocked();
  return store.getTask(taskId)!.status;
};

test('a confirmed merge fast-forwards the checkout to it, and the dependent is released', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { heads, check } = recording();
  const { store, a, child, poll } = await opened(t, f, postMerge(check));
  await poll();
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), m, 'the checkout is at the merge commit');
  assert.deepEqual(heads, [m], 'the post-merge check ran at M');
  assert.equal(store.isLanding(a.id), false, 'the hold ended');
  assert.equal(landingRows(store), 0);
  assert.equal(pendingMr(a.id), undefined);
  assert.ok(messages(store, a.id).includes(`checkout synced to ${m}`));
  assert.equal(released(store, child.id), 'queued');
});

test('a red post-merge check at M marks the repo red at M, and the dependent stays held', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const red: MainChecker = async (_repo, _cmd, _signal, head) => ({ ok: false, head, cmd: 'npm test', tail: 'boom', firstTail: 'boom' });
  const { store, a, child, poll } = await opened(t, f, postMerge(red));
  await poll();
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(store.repoRed(f.repo)?.head, m);
  assert.equal(store.repoRed(f.repo)?.taskId, a.id);
  assert.ok(messages(store, a.id).some((msg) => msg.startsWith(`MAIN IS RED after merging ${a.id} (npm test)`)));
  assert.equal(store.isLanding(a.id), false, 'the check ended the hold');
  assert.equal(released(store, child.id), 'blocked', 'a red main releases nothing');
});

test('a dirty checkout holds the repo with the reason; other MRs wait, and land-clear releases it', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, child, poll } = await opened(t, f);
  const before = git(f.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'edited by hand\n');
  await poll();
  const m = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, 'the checkout is left as it was');
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id);
  assert.ok(messages(store, a.id).some((msg) => msg.startsWith(`land-held(${f.repo}): merge request !1 merged at ${m}, but checkout dirty;`)));
  assert.equal(store.isLanding(a.id), true);
  assert.equal(landingRows(store), 1, 'the marker passes to the hold');
  assert.equal(released(store, child.id), 'blocked');
  // Another approval in the repo opens its MR, but it is not merged while the repo is held.
  const b = parked(store, f.repo, 'other');
  assert.equal((await approve(store, b.id)).merge.code, 'mr-opened');
  await poll();
  assert.equal(git(f.forge, 'rev-parse', 'main'), m, 'no merge while held');
  assert.ok(messages(store, b.id).includes('merge request !2 waiting: the repo is held until foreman land-clear'));
  // The operator syncs by hand and clears the hold.
  git(f.repo, 'checkout', '-q', '--', 'a.txt');
  git(f.repo, 'merge', '-q', '--ff-only', m);
  assert.equal(store.clearLandInterrupted(f.repo), true);
  assert.equal(store.isLanding(a.id), false);
  assert.equal(landingRows(store), 1, 'only the open MR\'s marker is left');
  assert.equal(released(store, child.id), 'queued');
  await poll();
  assert.equal(git(f.forge, 'rev-parse', 'main^1'), m, 'the other MR merged');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'));
});

test('a checkout on another branch holds the repo, and nothing is merged into that branch', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, poll } = await opened(t, f);
  git(f.repo, 'checkout', '-q', 'work');
  await poll();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.repo, 'rev-parse', 'work'));
  assert.ok(messages(store, a.id).some((msg) => msg.includes(', but checkout not on main;')));
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id);
});

test('two MRs merged in one tick sync one after the other and are covered by coalesced checks', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { heads, check } = recording();
  const { store, a, poll } = await opened(t, f, { mainCheck: check, tracker: new ApprovalTracker(), mode: 'coalesced' });
  const b = parked(store, f.repo, 'second');
  assert.equal((await approve(store, b.id)).merge.code, 'mr-opened');
  await poll();
  const m2 = git(f.forge, 'rev-parse', 'main');
  const m1 = git(f.forge, 'rev-parse', 'main^1');
  assert.deepEqual([git(f.forge, 'rev-parse', `${m1}^2`), git(f.forge, 'rev-parse', `${m2}^2`)].sort(),
    [git(f.repo, 'rev-parse', 'work'), git(f.repo, 'rev-parse', 'second')].sort(), 'both merged in this tick');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), m2, 'the checkout is at the newer merge');
  assert.ok(heads.length >= 1 && heads.length <= 2, `checks: ${heads.join(', ')}`);
  assert.equal(heads.at(-1), m2, 'the last check covers the newer merge');
  assert.ok(heads.every((h) => h === m1 || h === m2));
  assert.equal(store.isLanding(a.id), false);
  assert.equal(store.isLanding(b.id), false);
  assert.equal(landingRows(store), 0);
});

test('with FOREMAN_POSTMERGE_CHECK=off the hold ends at the sync', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { heads, check } = recording();
  const { store, a, child, poll } = await opened(t, f, postMerge(check));
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  t.after(() => { delete process.env['FOREMAN_POSTMERGE_CHECK']; });
  await poll();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'));
  assert.deepEqual(heads, [], 'no check ran');
  assert.equal(store.isLanding(a.id), false);
  assert.equal(released(store, child.id), 'queued');
});

test('a task repo whose config sends the forge and the mirror elsewhere still lands on the real merge commit', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, poll } = await opened(t, f);
  const attacker = path.join(scratchDir('landing-mr-sync-evil-'), 'evil.git');
  git(path.dirname(attacker), 'init', '-q', '--bare', '-b', 'main', attacker);
  const evil = scratchDir('landing-mr-sync-evil-work-');
  git(evil, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(evil, 'evil.txt'), 'x\n');
  git(evil, 'add', '-A');
  git(evil, 'commit', '-qm', 'evil');
  git(evil, 'push', '-q', attacker, 'main:refs/heads/main');
  git(f.repo, 'config', `url.${attacker}.insteadOf`, f.forge);
  git(f.repo, 'config', '--add', `url.${attacker}.insteadOf`, mirrorPath(f.home, f.repo));
  await poll();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'));
  assert.equal(fs.existsSync(path.join(f.repo, 'evil.txt')), false);
  assert.equal(store.isLanding(a.id), false);
});

test('a merge the mirror cannot confirm holds the repo until land-clear', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, child, poll } = await opened(t, f);
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
  assert.ok(messages(store, a.id).some((msg) => msg.startsWith(`land-held(${f.repo}): merge request !1 merged, but the merged commit is not the reviewed commit `)));
  assert.equal(pendingMr(a.id), undefined, 'the hold owns it now');
  assert.equal(released(store, child.id), 'blocked');
  assert.equal(store.clearLandInterrupted(f.repo), true);
  assert.equal(store.isLanding(a.id), false, 'land-clear ends the hold');
  assert.equal(landingRows(store), 0, 'and drops the marker');
  assert.equal(released(store, child.id), 'queued');
});

test('two MRs merged in one tick: the second sync does not start until the first sync\'s merge section ends', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, poll } = await opened(t, f);
  const b = parked(store, f.repo, 'second');
  assert.equal((await approve(store, b.id)).merge.code, 'mr-opened');
  // The first import into the checkout waits until the test lets it go; the ones after it run at once.
  let imports = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  useLanding(new (class extends Landing {
    override mirror(m: Fixture['map'], home: string) {
      const real = super.mirror(m, home);
      const importCommit = real.importCommit.bind(real);
      real.importCommit = async (sha) => {
        imports += 1;
        if (imports === 1) await gate;
        return importCommit(sha);
      };
      return real;
    }
  })([f.map], null), f.home);
  const polled = poll();
  // The second settle either queues behind the first in the repo's section, or (unsectioned) starts its own import.
  await until(() => mergeSectionsPending(f.repo) === 2 || imports === 2);
  assert.equal(imports, 1, 'the second sync waits for the first one\'s section');
  assert.equal(mergeSectionsPending(f.repo), 2);
  release();
  await polled;
  assert.equal(imports, 2);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.forge, 'rev-parse', 'main'));
  assert.equal(store.isLanding(a.id), false);
  assert.equal(store.isLanding(b.id), false);
});

test('an MR merged by a person on the forge while the repo is held does not move the checkout, and joins the hold', async (t) => {
  const f = await fixture(t, { pipeline: 'success' });
  const { store, a, poll } = await opened(t, f);
  const before = git(f.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'edited by hand\n');
  await poll();
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id, 'the repo is held');
  const b = parked(store, f.repo, 'other');
  assert.equal((await approve(store, b.id)).merge.code, 'mr-opened');
  await poll();
  assert.ok(messages(store, b.id).includes('merge request !2 waiting: the repo is held until foreman land-clear'));
  // The operator cleans the checkout but has not cleared the hold; a person merges !2 on the forge meanwhile.
  git(f.repo, 'checkout', '-q', '--', 'a.txt');
  const out = await new Landing([f.map], null).forge(f.map).merge(f.map.project, 2, git(f.repo, 'rev-parse', 'other'));
  assert.ok(out.merged);
  await poll();
  const m2 = git(f.forge, 'rev-parse', 'main');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, 'the checkout is left to the operator');
  assert.ok(messages(store, b.id).some((msg) => msg.startsWith(`land-held(${f.repo}): merge request !2 merged at ${m2}, but the repo is held for an earlier landing;`)));
  assert.equal(store.landInterrupted(f.repo)?.taskId, a.id, 'still the earlier landing\'s hold');
  assert.equal(pendingMr(b.id), undefined, 'the hold owns it now');
  assert.equal(store.isLanding(b.id), true);
  assert.equal(landingRows(store), 2, 'its marker passes to the hold');
  assert.equal(store.clearLandInterrupted(f.repo), true);
  assert.equal(store.isLanding(a.id), false);
  assert.equal(store.isLanding(b.id), false);
  assert.equal(landingRows(store), 0, 'land-clear drops both markers');
});

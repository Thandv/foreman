import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { redBackoffMs, Scheduler } from '../src/scheduler.ts';
import type { MainCheck } from '../src/postMerge.ts';
import { acquireVerifySlot } from '../src/verify/slots.ts';

const MIN = 60_000;

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the red-main backoff is 10, 30, 60 minutes, then hourly', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(redBackoffMs), [10 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
});

test('a red main is re-checked at the same HEAD on a backoff, and its red state survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-red-'));
  const dbFile = path.join(dir, 'foreman.db');
  const repo = path.join(dir, 'repo');
  let now = 1_700_000_000_000;
  const results = [false, true];
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    const ok = results[calls++] ?? true;
    return { ok, head: 'abc123', cmd: 'npm test', tail: ok ? 'pass' : 'FAIL again', firstTail: '' };
  };
  const store = new Store(dbFile);
  const sched = new Scheduler(store, {
    tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'abc123',
  });
  const idle = (): boolean => sched['redChecking'].size === 0;
  try {
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: now });

    // A restarted daemon (a fresh Store on the same file) still sees it red.
    const reopened = new Store(dbFile);
    assert.equal(reopened.repoRed(repo)?.head, 'abc123', 'red state is persisted');
    assert.equal(reopened.repoRed(repo)?.since, now);
    reopened.close();

    await sched.tick();
    await until(idle, 'the first window');
    assert.equal(calls, 0, 'not re-checked before the first backoff');

    now += 10 * MIN + 1;
    await sched.tick();
    await until(() => calls === 1 && idle(), 'the first same-HEAD re-check');
    assert.ok(store.repoRed(repo), 'a failing re-check keeps it red');
    assert.equal(store.repoRed(repo)?.attempts, 1);
    const persisted = new Store(dbFile);
    assert.equal(persisted.repoRed(repo)?.attempts, 1, 'the attempt count is persisted');
    assert.equal(persisted.repoRed(repo)?.nextCheckAt, now + 30 * MIN);
    persisted.close();

    now += 10 * MIN + 1;
    await sched.tick();
    await until(idle, 'a window inside the second backoff');
    assert.equal(calls, 1, 'the second re-check waits the longer backoff');

    now += 20 * MIN;
    await sched.tick();
    await until(() => store.repoRed(repo) === null, 'the passing re-check to release the repo');
    assert.equal(calls, 2);
    const after = new Store(dbFile);
    assert.equal(after.repoRed(repo), null, 'the release is persisted too');
    after.close();
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing tick is recorded once, rate-limited, and the next tick still dispatches', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => 1_700_000_000_000 });
  const real = store.claimable.bind(store);
  let throws = 3;
  store.claimable = ((...args: Parameters<Store['claimable']>) => {
    if (throws > 0) {
      throws--;
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return real(...args);
  }) as Store['claimable'];
  try {
    const t = store.addTask({ title: 'after the blip', prompt: 'x', runner: 'echo' });
    sched.start();
    await until(() => store.latestRun(t.id) !== null, 'the ticket to be dispatched after the failures');
    assert.equal(throws, 0);
    const errors = store.eventsSince(0, 10_000).filter((e) => e.type === 'error' && /SQLITE_BUSY/.test(e.message));
    assert.equal(errors.length, 1, 'recorded once, not once per failing tick');
    assert.match(errors[0]!.message, /scheduler tick failed/);
  } finally {
    await sched.stop();
    store.close();
  }
});

// ------------------------------------------------- held tickets never starve other repos

async function dispatchesPastHeld(hold: (sched: Scheduler, store: Store, repo: string) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-starve-'));
  const repo = path.join(dir, 'held-repo');
  const now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now,
    checkMain: async () => ({ ok: false, head: 'abc123', cmd: 'npm test', tail: 'FAIL', firstTail: '' }),
    repoHead: async () => 'abc123',
  });
  try {
    hold(sched, store, repo);
    // At the front of the queue (priority 5), on the held repo.
    const held = store.addTask({ title: 'held', prompt: 'x', runner: 'echo', repo, priority: 5 } as never);
    const other = store.addTask({ title: 'elsewhere', prompt: 'x', runner: 'echo' });
    for (let i = 0; i < 30 && !store.latestRun(other.id); i++) {
      await sched.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(store.latestRun(other.id), 'the ticket on another repo was dispatched past the held one');
    assert.equal(store.latestRun(held.id), null, 'the held ticket was not');
    assert.equal(store.getTask(held.id)!.status, 'queued');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a held dirty-checkout ticket at the front of the queue does not starve another repo', () =>
  dispatchesPastHeld((sched, _store, repo) => sched['holdDirtyRepo'](repo, 'README.md')));

test('a red repo\'s ticket at the front of the queue does not starve another repo', () =>
  dispatchesPastHeld((_sched, store, repo) =>
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: 1_700_000_000_000, nextCheckAt: 1_800_000_000_000 })));

// ------------------------------------------------- the red re-check and newer red records

/** A red repo whose same-HEAD re-check is due, with a checkMain the test resolves by hand. */
async function racingRecheck(outcome: boolean, body: (store: Store, repo: string) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-redrace-'));
  const repo = path.join(dir, 'repo');
  const now = 1_700_000_000_000;
  let release!: (c: MainCheck) => void;
  let calls = 0;
  const checkMain = (): Promise<MainCheck> => {
    calls++;
    return new Promise((r) => (release = r));
  };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'aaa111' });
  try {
    store.markRepoRed(repo, { head: 'aaa111', taskId: 't_old', testCmd: null, reason: 'FAIL', since: now - 2 * 3_600_000, nextCheckAt: now - 1 });
    await sched.tick();
    await until(() => calls === 1, 'the re-check of aaa111 to start');
    // Meanwhile a merge lands and its gate marks main red at the new HEAD.
    store.markRepoRed(repo, { head: 'bbb222', taskId: 't_new', testCmd: null, reason: 'merge broke it' });
    release({ ok: outcome, head: 'aaa111', cmd: 'npm test', tail: outcome ? 'pass' : 'FAIL again', firstTail: '' });
    await until(() => sched['redChecking'].size === 0, 'the re-check to settle');
    body(store, repo);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a passing re-check of an older HEAD does not release a repo marked red at a newer one meanwhile', () =>
  racingRecheck(true, (store, repo) => {
    assert.equal(store.repoRed(repo)?.head, 'bbb222', 'still red at the new HEAD');
    assert.equal(store.repoRed(repo)?.taskId, 't_new');
  }));

test('a failing re-check of an older HEAD does not overwrite a newer red record', () =>
  racingRecheck(false, (store, repo) => {
    const red = store.repoRed(repo)!;
    assert.equal(red.head, 'bbb222');
    assert.equal(red.taskId, 't_new');
    assert.equal(red.attempts, 0, 'the newer record keeps its own backoff');
  }));

test('the speculative same-HEAD re-check waits for a free verify slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-redslot-'));
  const repo = path.join(dir, 'repo');
  let now = 1_700_000_000_000;
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    calls++;
    return { ok: true, head: 'abc123', cmd: 'npm test', tail: 'pass', firstTail: '' };
  };
  const saved = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '1';
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'abc123' });
  const slot = await acquireVerifySlot();
  try {
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: now - 3_600_000, nextCheckAt: now - 1 });
    await sched.tick();
    await until(() => sched['redChecking'].size === 0, 'the window to pass');
    assert.equal(calls, 0, 'not re-checked while every verify slot is held by real work');
    assert.ok(store.repoRed(repo));
    slot.release();
    now += 16_000;
    await sched.tick();
    await until(() => store.repoRed(repo) === null, 'the re-check once a slot is free');
    assert.equal(calls, 1);
  } finally {
    slot.release();
    if (saved === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = saved;
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-marking a repo that is already red does not make its re-check due at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-remark-'));
  const repo = path.join(dir, 'repo');
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    calls++;
    return { ok: false, head: 'bbb222', cmd: 'npm test', tail: 'FAIL', firstTail: '' };
  };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, checkMain, repoHead: async () => 'bbb222' });
  try {
    // Red for two hours already; then a merge's gate marks it red again, as gate.ts does (no since, no nextCheckAt).
    store.markRepoRed(repo, { head: 'aaa111', taskId: 't_a', testCmd: null, reason: 'FAIL', since: Date.now() - 2 * 3_600_000 });
    store.markRepoRed(repo, { head: 'bbb222', taskId: 't_b', testCmd: null, reason: 'FAIL at the new HEAD' });
    await sched.tick();
    await until(() => sched['redChecking'].size === 0, 'the window to pass');
    assert.equal(calls, 0, 'the gate just ran the suite at this HEAD; no second run straight after it');
    assert.ok((store.repoRed(repo)!.nextCheckAt ?? 0) > Date.now(), 'the next check is in the future');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- dirty-checkout holds

function cleanRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-clean-'));
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

test('six runs failing dirty together are one hold, probed on the first 30s backoff', async () => {
  const repo = cleanRepo();
  let now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now });
  const holds = sched['dirtyHolds'] as Map<string, unknown>;
  try {
    for (let i = 0; i < 6; i++) sched['holdDirtyRepo'](repo, 'README.md');
    // The operator commits; the first probe (30s) must find it, not one 10 minutes out.
    now += 31_000;
    await sched.tick();
    await until(() => !holds.has(path.resolve(repo)), 'the first probe to release the clean checkout');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a dirty-checkout probe that errors keeps the hold rather than releasing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-probeerr-'));
  const repo = path.join(dir, 'gone'); // git cannot even start here
  let now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now });
  const holds = sched['dirtyHolds'] as Map<string, { probes: number; probing: boolean; files: string }>;
  try {
    sched['holdDirtyRepo'](repo, 'README.md');
    now += 31_000;
    await sched.tick();
    await until(() => !holds.has(repo) || holds.get(repo)!.probes > 0, 'the probe to finish');
    assert.ok(holds.has(repo), 'an error proved nothing; still held');
    assert.equal(holds.get(repo)!.probes, 1, 'backing off like a dirty result');
    assert.match(holds.get(repo)!.files, /git status failed/);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a probe still running at stop() and store close raises no unhandled rejection', async () => {
  const repo = cleanRepo();
  let now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now });
  const holds = sched['dirtyHolds'] as Map<string, { probing: boolean }>;
  const rejections: unknown[] = [];
  const onRejection = (err: unknown): void => void rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    sched['holdDirtyRepo'](repo, 'README.md');
    now += 31_000;
    await sched.tick();
    const key = path.resolve(repo);
    assert.equal(holds.get(key)?.probing, true, 'the probe is in flight');
    await sched.stop();
    store.close();
    await until(() => !holds.has(key) || !holds.get(key)!.probing, 'the probe to settle');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a red re-check whose checkMain throws backs off instead of retrying every window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-redthrow-'));
  const repo = path.join(dir, 'repo');
  let now = 1_700_000_000_000;
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    calls++;
    throw new Error('git worktree add failed: repo moved');
  };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'abc123' });
  try {
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: now - 3_600_000, nextCheckAt: now - 1 });
    for (let w = 0; w < 5; w++) {
      await sched.tick();
      await until(() => sched['redChecking'].size === 0, `window ${w}`);
      now += 16_000; // past the 15s window, well inside any backoff
    }
    assert.equal(calls, 1, 'one attempt, then the backoff');
    assert.equal(store.repoRed(repo)?.attempts, 1);
    const warnings = store.eventsSince(0, 1000).filter((e) => e.type === 'warning' && /could not run/.test(e.message));
    assert.equal(warnings.length, 1, 'the error is recorded once');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a ticket with no test command is detected at run time from its jail, and the row is left as the operator wrote it', async () => {
  const repo = cleanRepo();
  // Only a Makefile, and it is a directory: run-time detection reaches the Makefile branch and must not throw.
  fs.mkdirSync(path.join(repo, 'Makefile'));
  fs.writeFileSync(path.join(repo, 'Makefile', 'part.mk'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'pkg'], { cwd: repo });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({ title: 'gated', prompt: 'true', kind: 'code', runner: 'shell', repo });
    await sched.tick();
    await until(() => store.getTask(t.id)!.status !== 'running' && store.getTask(t.id)!.status !== 'verifying' && sched.activeCount === 0, 'the run to settle');
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.equal(store.getTask(t.id)!.testCmd, null, 'nothing written over the operator\'s (empty) test command');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a throwing re-check after HEAD moved also backs off (the observed HEAD is recorded)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-redthrow2-'));
  const repo = path.join(dir, 'repo');
  let now = 1_700_000_000_000;
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    calls++;
    throw new Error('npm install failed');
  };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'NEWHEAD' });
  try {
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: now - 3_600_000, nextCheckAt: now + 3_600_000 });
    for (let w = 0; w < 5; w++) {
      await sched.tick();
      await until(() => sched['redChecking'].size === 0, `window ${w}`);
      now += 16_000;
    }
    assert.equal(calls, 1, 'the moved HEAD is checked once, then waits out the backoff');
    assert.equal(store.repoRed(repo)?.head, 'NEWHEAD');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing re-check at a moved HEAD starts the backoff over: it waits redBackoffMs(1), not a longer step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-redthrow3-'));
  const repo = path.join(dir, 'repo');
  let now = 1_700_000_000_000;
  let calls = 0;
  const checkMain = async (): Promise<MainCheck> => {
    calls++;
    throw new Error('worktree add failed');
  };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now, checkMain, repoHead: async () => 'NEWHEAD' });
  try {
    // Two failed re-checks at the old HEAD already: its next step would be 60 minutes.
    store.markRepoRed(repo, { head: 'abc123', taskId: 't_x', testCmd: null, reason: 'FAIL', since: now - 3 * 3_600_000, nextCheckAt: now + 3_600_000, attempts: 2 });
    await sched.tick();
    await until(() => calls === 1 && sched['redChecking'].size === 0, 'the moved-HEAD check');
    assert.equal(store.repoRed(repo)?.nextCheckAt, now + redBackoffMs(1));
    now += redBackoffMs(1) + 1;
    await sched.tick();
    await until(() => calls === 2 && sched['redChecking'].size === 0, 'the re-check after 30 minutes');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

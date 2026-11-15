import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { checkMain } from '../src/postMerge.ts';
import { acquireVerifySlot, maxVerifies, verifySlotStats, VerifyWaitAborted, withVerifySlot } from '../src/verify/slots.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

function withCap<T>(cap: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['FOREMAN_MAX_VERIFIES'];
  if (cap === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
  else process.env['FOREMAN_MAX_VERIFIES'] = cap;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prev;
  });
}

test('with a cap of 2 and 5 fake runs, peak concurrency never exceeds 2', () =>
  withCap('2', async () => {
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withVerifySlot(undefined, async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(20);
          running--;
        }),
      ),
    );
    assert.equal(peak, 2, 'the cap is reached but never passed');
    assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });
  }));

test('waiters start in FIFO arrival order', () =>
  withCap('1', async () => {
    const started: number[] = [];
    const runs = Array.from({ length: 5 }, (_, i) =>
      withVerifySlot(undefined, async () => {
        started.push(i);
        await sleep(5);
      }),
    );
    await Promise.all(runs);
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
  }));

test('the default cap is 2 when FOREMAN_MAX_VERIFIES is unset', async () => {
  await withCap(undefined, async () => assert.equal(maxVerifies(), 2));
  await withCap('nonsense', async () => assert.equal(maxVerifies(), 2));
  await withCap('0', async () => assert.equal(maxVerifies(), 2));
  await withCap('3', async () => assert.equal(maxVerifies(), 3));
});

test('a thrown run releases its slot', () =>
  withCap('1', async () => {
    await assert.rejects(withVerifySlot(undefined, async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });
    let ran = false;
    await withVerifySlot(undefined, async () => { ran = true; });
    assert.ok(ran, 'the next run got the slot');
  }));

test('an aborted holder releases its slot and an aborted waiter leaves the queue', () =>
  withCap('1', async () => {
    const holderAbort = new AbortController();
    const holder = withVerifySlot(holderAbort.signal, () =>
      new Promise<void>((_, reject) => holderAbort.signal.addEventListener('abort', () => reject(new Error('killed')))),
    );
    const waiterAbort = new AbortController();
    let waiterRan = false;
    const waiter = withVerifySlot(waiterAbort.signal, async () => { waiterRan = true; });
    const lastInLine = withVerifySlot(undefined, async () => 'last');
    await until(() => verifySlotStats().waiting === 2);

    waiterAbort.abort();
    await assert.rejects(waiter, VerifyWaitAborted);
    assert.equal(verifySlotStats().waiting, 1, 'the aborted waiter left the queue');

    holderAbort.abort();
    await assert.rejects(holder, /killed/);
    assert.equal(await lastInLine, 'last', 'the slot passed to the next waiter, skipping the aborted one');
    assert.equal(waiterRan, false);
    assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });

    const pre = new AbortController();
    pre.abort();
    await assert.rejects(acquireVerifySlot(pre.signal), VerifyWaitAborted);
    assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });
  }));

// ------------------------------------------------------- scheduler integration

function fixtureRepo(): string {
  const dir = scratchDir('foreman-slots-repo-');
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

/** The stand-in worker's change: a code run that changes nothing has no test stage (it parks as "nothing to change"). */
const WORK = 'printf "changed\\n" > README.md';

/** Hold the only slot, queue `task`, and release once the run is parked behind it. */
async function runBehindHeldSlot(store: Store, taskId: string, holdMs = 30): Promise<void> {
  const held = await acquireVerifySlot();
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const drained = sched.drain(30_000);
  await until(() => verifySlotStats().waiting === 1);
  assert.equal(store.latestRun(taskId)?.verifyWaitMs, 0, 'nothing is recorded until the wait ends');
  await sleep(holdMs);
  held.release();
  await drained;
}

test('a gate check takes a slot, and the run records the time it waited as verify_wait_ms', () =>
  withCap('1', async () => {
    const store = new Store(':memory:');
    const repo = fixtureRepo();
    try {
      const t = store.addTask({ title: 'gate', prompt: WORK, kind: 'code', runner: 'shell', repo, testCmd: 'sleep 0.2' });
      const startedAt = Date.now();
      await runBehindHeldSlot(store, t.id);
      const wallMs = Date.now() - startedAt;
      const run = store.latestRun(t.id)!;
      assert.equal(run.testsPassed, true);
      assert.ok(run.verifyWaitMs! > 0, `expected a recorded wait, got ${run.verifyWaitMs}`);
      const [latency] = store.recentRunsForLatency(1);
      assert.ok(latency!.suiteMs >= 200, `the gate's run time is recorded as suite time, got ${latency!.suiteMs}`);
      assert.ok(latency!.suiteMs + latency!.verifyWaitMs <= wallMs, `suite ${latency!.suiteMs} + wait ${latency!.verifyWaitMs} > wall ${wallMs}`);
      assert.ok(store.eventsForTask(t.id).some((e) => /waited \d+ms for a verify slot/.test(e.message ?? '')));
    } finally {
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }));

/** A playbook `slots-pb` with these checks, in a fresh FOREMAN_PLAYBOOKS_DIR; returns the dir. */
function crewPlaybook(checks: string[]): string {
  const dir = scratchDir('foreman-slots-pb-');
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  const fm = {
    id: 'slots-pb', description: 'checks', triggers: ['x'],
    roles: { lead: { tier: 'owner' }, worker: { tier: 'worker' } },
    reviewers: [{ role: 'lead', style: 'code-review' }],
    escalation: { chair: 'lead', afterFailures: 2 },
    checks, gate: { default: 'human', hardHuman: ['S2'] }, constraints: ['Never do the bad thing.'],
  };
  fs.writeFileSync(path.join(dir, 'slots-pb.md'), `---\n${JSON.stringify(fm, null, 2)}\n---\n\n## pipeline\n\nPlan then execute.\n\n## role: lead\n\nYou lead the work and review it.\n\n## role: worker\n\nYou execute what the lead assigns.\n`);
  return dir;
}

test('a crew test gate (a playbook check) takes a slot', () =>
  withCap('1', async () => {
    const dir = crewPlaybook(['true']);
    const store = new Store(':memory:');
    const repo = fixtureRepo();
    try {
      const t = store.addTask({ title: 'crew', prompt: WORK, kind: 'code', runner: 'shell', repo, playbook: 'slots-pb', role: 'worker' });
      await runBehindHeldSlot(store, t.id);
      const run = store.latestRun(t.id)!;
      assert.ok(run.verifyWaitMs! > 0, `expected a recorded wait, got ${run.verifyWaitMs}`);
    } finally {
      delete process.env['FOREMAN_PLAYBOOKS_DIR'];
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

test('a run whose two playbook checks take 1 s each records about 2 s of suite time, slot wait excluded', () =>
  withCap('1', async () => {
    const dir = crewPlaybook(['sleep 1', 'sleep 1']);
    const store = new Store(':memory:');
    const repo = fixtureRepo();
    try {
      const t = store.addTask({ title: 'crew', prompt: WORK, kind: 'code', runner: 'shell', repo, playbook: 'slots-pb', role: 'worker' });
      const startedAt = Date.now();
      await runBehindHeldSlot(store, t.id, 1_000);
      const wallMs = Date.now() - startedAt;
      const [run] = store.recentRunsForLatency(1);
      assert.ok(run!.verifyWaitMs >= 1_000, `the slot wait is recorded, got ${run!.verifyWaitMs}`);
      assert.ok(run!.suiteMs >= 1_990, `both checks' run time is recorded, got ${run!.suiteMs}`);
      // Counted into suite_ms as well, the wait would make the two add up to more than the whole drain took.
      assert.ok(run!.suiteMs + run!.verifyWaitMs <= wallMs, `suite ${run!.suiteMs} + wait ${run!.verifyWaitMs} > wall ${wallMs}`);
    } finally {
      delete process.env['FOREMAN_PLAYBOOKS_DIR'];
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

test('a run canceled while it queues for a slot records the wait as no suite time', () =>
  withCap('1', async () => {
    const store = new Store(':memory:');
    const repo = fixtureRepo();
    const held = await acquireVerifySlot();
    try {
      const t = store.addTask({ title: 'gate', prompt: WORK, kind: 'code', runner: 'shell', repo, testCmd: 'true' });
      const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
      const drained = sched.drain(30_000);
      await until(() => verifySlotStats().waiting === 1);
      const queuedAt = Date.now();
      await sleep(300);
      store.cancel(t.id);
      await drained;
      const queuedMs = Date.now() - queuedAt;
      const [run] = store.recentRunsForLatency(1);
      assert.ok(queuedMs >= 300);
      // Counted as suite time, the 300 ms and more it queued would all be here.
      assert.ok(run!.suiteMs < 300, `the queued time is not suite time, got ${run!.suiteMs}`);
    } finally {
      held.release();
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }));

test('the post-merge check and its re-run each take a slot', () =>
  withCap('1', async () => {
    const repo = fixtureRepo();
    try {
      let running = 0;
      let peak = 0;
      let calls = 0;
      const run = async (): Promise<{ passed: boolean; output: string }> => {
        calls++;
        running++;
        peak = Math.max(peak, running);
        await sleep(15);
        running--;
        return { passed: false, output: 'red' };
      };
      // One check alone runs twice (first + re-run), so its re-run is gated too:
      // hold the slot, and the check must park before either run starts.
      const held = await acquireVerifySlot();
      const alone = checkMain(repo, 'fake', undefined, run);
      await until(() => verifySlotStats().waiting === 1);
      assert.equal(calls, 0, 'the first run waits for a slot');
      held.release();
      await alone;
      assert.equal(calls, 2);

      // Two checks side by side: four runs in all, never more than one at once.
      calls = 0;
      await Promise.all([checkMain(repo, 'fake', undefined, run), checkMain(repo, 'fake', undefined, run)]);
      assert.equal(calls, 4);
      assert.equal(peak, 1, 'the re-run waits for a slot like any other run');
      assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }));

test('a DB created without runs.verify_wait_ms migrates, opens and reads 0', () => {
  const dir = scratchDir('foreman-slots-db-');
  const file = path.join(dir, 'f.db');
  try {
    const first = new Store(file);
    const task = first.addTask({ title: 't', prompt: 'p', runner: 'echo' });
    const runId = first.startRun(task.id).id;
    first.close?.();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE runs DROP COLUMN verify_wait_ms');
    raw.close();
    const second = new Store(file);
    assert.equal(second.getRun(runId)!.verifyWaitMs, 0);
    second.addVerifyWait(runId, 40);
    second.addVerifyWait(runId, 2);
    assert.equal(second.getRun(runId)!.verifyWaitMs, 42, 'waits accumulate across a run\'s commands');
    second.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('time queued for a test slot does not count against the run deadline', () =>
  withCap('1', async () => {
    // The only slot is held for 6 s and the run deadline is 4 s (enough to set up the worktree on a busy machine). Counting the queue, the run would be aborted while
    // waiting ('aborted while waiting for a verify slot') with its work done, as finished tickets were.
    const store = new Store(':memory:');
    const repo = fixtureRepo();
    try {
      const t = store.addTask({ title: 'gate', prompt: WORK, kind: 'code', runner: 'shell', repo, testCmd: 'true' });
      const held = await acquireVerifySlot();
      const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, taskTimeoutMs: 4000 });
      const drained = sched.drain(30_000);
      await until(() => verifySlotStats().waiting === 1);
      await sleep(6000);
      held.release();
      await drained;
      const task = store.getTask(t.id)!;
      assert.notEqual(task.status, 'canceled', `the run was cancelled in the queue: ${task.error ?? ''}`);
      assert.equal(store.latestRun(t.id)!.testsPassed, true);
      await sched.stop();
    } finally {
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }));

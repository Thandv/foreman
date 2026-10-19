// What a run's deadline counts, and how a run that reaches it ends (plan item FA4; trial findings F2 and F28).
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { RunClock } from '../src/runClock.ts';
import { BudgetExceeded } from '../src/budget.ts';
import { echoRunner } from '../src/runners/echo.ts';
import type { RunnerContext, RunnerResult } from '../src/runners/index.ts';
import { acquireVerifySlot, verifySlotStats } from '../src/verify/slots.ts';
import { FakeTime } from './fakeclock.ts';

const MIN = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous freeze guard: nothing here asserts on wall time. */
async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

/** The echo runner's `run` swapped for the test's own, and put back. */
async function withRunner(run: (ctx: RunnerContext) => Promise<RunnerResult>, fn: () => Promise<void>): Promise<void> {
  const real = echoRunner.run;
  echoRunner.run = run;
  try {
    await fn();
  } finally {
    echoRunner.run = real;
  }
}

/** A scheduler whose runs' deadlines are on `time`: a 60-minute budget that only the test's own clock spends. */
function rig(time: FakeTime, opts: { maxWorkers?: number } = {}): { store: Store; sched: Scheduler } {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    verifyEnabled: false,
    maxWorkers: opts.maxWorkers ?? 1,
    taskTimeoutMs: 60 * MIN,
    runClock: (budgetMs, onExpire) => new RunClock(budgetMs, onExpire, time.now, time),
  });
  return { store, sched };
}

const DEADLINE_IN_WORK = /run deadline \(60 min\) reached during work; 0 min queued were not counted/;

test('a worker\'s wait for a test slot is not charged to its run: past the budget on the wall clock, the run is not aborted', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  let abortedInRunner: boolean | null = null;
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      time.advance(40 * MIN);
      sched.slotQueued(ctx.runId, true);
      time.advance(25 * MIN); // 65 minutes on the wall, 40 of them the run's own
      sched.slotQueued(ctx.runId, false);
      // A run id nobody is running, and a resume with no wait open, change nothing.
      sched.slotQueued('r_not_a_run', true);
      sched.slotQueued(ctx.runId, false);
      time.advance(19 * MIN);
      abortedInRunner = ctx.signal.aborted;
      return { ok: true, summary: 'done', exitCode: 0 };
    }, async () => {
      const t = store.addTask({ title: 'waits', prompt: 'x', runner: 'echo', maxAttempts: 1 });
      await sched.drain(120_000);
      assert.equal(abortedInRunner, false, 'the deadline did not fire: 59 of its own minutes were spent');
      const task = store.getTask(t.id)!;
      assert.equal(task.status, 'awaiting-approval', task.error ?? '');
      const lines = store.eventsForTask(t.id).map((e) => e.message);
      assert.ok(lines.some((m) => /worker's suite run is waiting for a test slot/.test(m)), 'the wait is in the run\'s timeline');
      assert.ok(lines.some((m) => /stopped waiting for a test slot after \d+ s/.test(m)));
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('the same run without the slot wait does reach its deadline at 60 minutes (the wait is what made the difference)', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  let abortedInRunner: boolean | null = null;
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      time.advance(65 * MIN);
      abortedInRunner = ctx.signal.aborted;
      return { ok: false, summary: 'killed', exitCode: 143 };
    }, async () => {
      const t = store.addTask({ title: 'slow', prompt: 'x', runner: 'echo', maxAttempts: 1 });
      await sched.drain(120_000);
      assert.equal(abortedInRunner, true);
      assert.equal(store.getTask(t.id)!.status, 'failed');
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('a run that outlives its budget is failed as a timeout, not canceled: the error names the deadline and the stage, the worktree and the diff are kept', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  const repo = fixtureRepo();
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      fs.writeFileSync(path.join(ctx.dir, 'made.txt'), 'the work so far\n');
      time.advance(61 * MIN);
      // What a CLI runner does when its child is killed by the abort: it comes back not-ok.
      return { ok: false, summary: 'worker exited 143', exitCode: 143 };
    }, async () => {
      const t = store.addTask({ title: 'slow', prompt: 'x', kind: 'code', runner: 'echo', repo, maxAttempts: 1 });
      await sched.drain(120_000);
      const task = store.getTask(t.id)!;
      assert.notEqual(task.status, 'canceled', 'nobody canceled it');
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', DEADLINE_IN_WORK);
      const run = store.latestRun(t.id)!;
      assert.equal(run.status, 'failed', 'the run is a failed run, not a canceled one');
      assert.ok(run.worktreePath && fs.existsSync(path.join(run.worktreePath, 'made.txt')), 'the worktree is still on disk, with the work in it');
      const diff = store.artifactsForTask(t.id).find((a) => a.type === 'diff');
      assert.ok(diff && fs.readFileSync(diff.path, 'utf8').includes('the work so far'), 'the diff artifact is saved as before');
    });
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a run that times out with attempts left is requeued with the timeout as its note, and its dependents are not failed', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  let calls = 0;
  let letSecondFinish: () => void = () => {};
  const secondMayFinish = new Promise<void>((r) => { letSecondFinish = r; });
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      if (++calls === 1) {
        time.advance(61 * MIN);
        // A runner that throws on the abort, as the echo runner and a fetch do.
        throw new Error('aborted');
      }
      await secondMayFinish;
      return { ok: true, summary: 'done', exitCode: 0 };
    }, async () => {
      const t = store.addTask({ title: 'slow once', prompt: 'x', runner: 'echo', maxAttempts: 2 });
      const dep = store.addTask({ title: 'after', prompt: 'x', runner: 'echo', deps: [t.id] });
      const ticking = setInterval(() => void sched.tick().catch(() => {}), 10);
      try {
        // Either it is run again, or it has ended for good: the second is the failure this test is for.
        await until(() => calls === 2 || ['failed', 'canceled'].includes(store.getTask(t.id)!.status), 'the second attempt to start');
        assert.equal(calls, 2, `not requeued: ${store.getTask(t.id)!.status}: ${store.getTask(t.id)!.error ?? ''}`);
        const runs = store.runsForTask(t.id);
        const first = runs.find((r) => r.status !== 'running')!;
        assert.equal(first.status, 'failed', 'the timed-out run is failed, not canceled');
        assert.match(first.summary ?? '', DEADLINE_IN_WORK);
        const errors = store.eventsForTask(t.id).map((e) => e.message);
        assert.ok(errors.some((m) => /^queued: attempt 1 failed: run deadline \(60 min\) reached during work/.test(m)), `the requeue carries the timeout: ${errors.join(' | ')}`);
        assert.ok(!errors.some((m) => /canceled/.test(m)), 'canceled appears nowhere in its timeline');
        store.reconcileBlocked();
        assert.equal(store.getTask(dep.id)!.status, 'blocked', 'a dependent of a requeued task just keeps waiting');
        assert.equal(store.getTask(dep.id)!.error ?? null, null);
      } finally {
        letSecondFinish();
        clearInterval(ticking);
      }
      await until(() => store.getTask(t.id)!.status === 'awaiting-approval', 'the second attempt to park');
      assert.equal(store.getTask(dep.id)!.status, 'blocked');
    });
  } finally {
    letSecondFinish();
    await sched.stop();
    store.close();
  }
});

test('a task failed by its deadline fails its dependents as failed (never "ended as canceled"), and a retry revives them', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  let calls = 0;
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      if (++calls === 1) {
        time.advance(61 * MIN);
        throw new Error('aborted');
      }
      return { ok: true, summary: 'done', exitCode: 0 };
    }, async () => {
      const t = store.addTask({ title: 'slow', prompt: 'x', runner: 'echo', maxAttempts: 1 });
      const dep = store.addTask({ title: 'after', prompt: 'x', runner: 'echo', deps: [t.id] });
      const far = store.addTask({ title: 'after that', prompt: 'x', runner: 'echo', deps: [dep.id] });
      await until(() => {
        void sched.tick().catch(() => {});
        return store.getTask(far.id)!.status === 'failed';
      }, 'the cascade');
      const task = store.getTask(t.id)!;
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', DEADLINE_IN_WORK, 'the dependency itself says it timed out');
      assert.equal(store.getTask(dep.id)!.error, `dependency ${t.id} ended as failed`);
      assert.doesNotMatch(store.getTask(dep.id)!.error ?? '', /canceled/);
      assert.equal(store.getTask(far.id)!.error, `dependency ${dep.id} ended as failed`);

      store.retry(t.id);
      assert.equal(store.getTask(t.id)!.status, 'queued');
      assert.equal(store.getTask(dep.id)!.status, 'blocked', 'the dependent comes back with it');
      assert.equal(store.getTask(dep.id)!.error, `revived: dependency ${t.id} was retried`);
      assert.equal(store.getTask(far.id)!.status, 'blocked', 'transitively');
      await until(() => {
        void sched.tick().catch(() => {});
        return store.getTask(t.id)!.status === 'awaiting-approval';
      }, 'the retried task to park at the gate');
      for (const id of [dep.id, far.id]) assert.equal(store.getTask(id)!.status, 'blocked', 'waiting on the retried task, not failed again');
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('an operator cancel during the runner still ends canceled — also when the deadline had already fired', { timeout: 180_000 }, async () => {
  for (const deadlineFirst of [false, true]) {
    const time = new FakeTime();
    const { store, sched } = rig(time);
    const repo = fixtureRepo();
    let started = false;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    try {
      await withRunner(async (ctx) => {
        ctx.stage('work');
        started = true;
        await held;
        return { ok: false, summary: 'worker exited 143', exitCode: 143 };
      }, async () => {
        const t = store.addTask({ title: 'long', prompt: 'x', kind: 'code', runner: 'echo', repo, maxAttempts: 3 });
        const dep = store.addTask({ title: 'after', prompt: 'x', runner: 'echo', deps: [t.id] });
        await sched.tick();
        await until(() => started, 'the runner to start');
        if (deadlineFirst) time.advance(61 * MIN);
        store.cancel(t.id);
        release();
        await until(() => sched.activeCount === 0, 'the run to end');
        const task = store.getTask(t.id)!;
        assert.equal(task.status, 'canceled', `deadlineFirst=${deadlineFirst}`);
        assert.doesNotMatch(task.error ?? '', /run deadline/, 'a cancel is not recorded as a timeout');
        assert.equal(store.latestRun(t.id)!.status, 'canceled');
        assert.equal(store.runsForTask(t.id).length, 1, 'and it is not retried');
        store.reconcileBlocked();
        assert.equal(store.getTask(dep.id)!.error, `dependency ${t.id} ended as canceled`, 'a canceled dependency reads as before');
      });
    } finally {
      release();
      await sched.stop();
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('the verify-slot handler stops the asking run\'s clock while its wrapper queues, and starts it again on grant and on close', { timeout: 180_000 }, async () => {
  const prevCap = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '1';
  const time = new FakeTime();
  const { store, sched } = rig(time);
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  /** What the wrapper does: POST with the run's id, and read lines until told. */
  const ask = (runId: string): { req: http.ClientRequest; text: () => string } => {
    let body = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/verify-slot', method: 'POST', headers: { 'x-foreman-run': runId } }, (res) => {
      res.setEncoding('utf8').on('data', (c: string) => { body += c; });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    return { req, text: () => body };
  };
  let abortedInRunner: boolean | null = null;
  try {
    await withRunner(async (ctx) => {
      ctx.stage('work');
      time.advance(40 * MIN);
      // Every slot is taken by someone else's suite: this run's wrapper queues.
      const other = await acquireVerifySlot();
      const first = ask(ctx.runId);
      await until(() => verifySlotStats().waiting === 1 && /queued\n/.test(first.text()), 'the request to queue');
      time.advance(15 * MIN); // 55 on the wall
      // The wrapper gives up (or is killed) while queued: the close ends the wait.
      first.req.destroy();
      await until(() => verifySlotStats().waiting === 0, 'the abandoned request to leave the queue');
      time.advance(4 * MIN); // 59 on the wall, 44 its own
      const second = ask(ctx.runId);
      await until(() => verifySlotStats().waiting === 1, 'the second request to queue');
      time.advance(10 * MIN); // 69 on the wall, 44 its own
      other.release();
      await until(() => /granted/.test(second.text()), 'the grant');
      // Holding the slot is the run's own time again.
      time.advance(15 * MIN); // 59 of its own
      abortedInRunner = ctx.signal.aborted;
      second.req.destroy();
      await until(() => verifySlotStats().active === 0, 'the lease to be released');
      return { ok: true, summary: 'done', exitCode: 0 };
    }, async () => {
      const t = store.addTask({ title: 'waits on the wrapper', prompt: 'x', runner: 'echo', maxAttempts: 1 });
      await sched.drain(120_000);
      assert.equal(abortedInRunner, false, '84 minutes on the wall, 59 of them the run\'s own: no deadline');
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    if (prevCap === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prevCap;
  }
});

// ------------------------------------------------------------ review r1 on-top

test('a budget hard-stop that comes after the deadline fired still goes to the operator: the task is not given another attempt', { timeout: 180_000 }, async () => {
  const time = new FakeTime();
  const { store, sched } = rig(time);
  let calls = 0;
  try {
    await withRunner(async (ctx) => {
      calls++;
      ctx.stage('work');
      time.advance(61 * MIN);
      throw new BudgetExceeded('task budget reached: $5.0000 would exceed $1.00');
    }, async () => {
      const t = store.addTask({ title: 'over budget and out of time', prompt: 'x', runner: 'echo', maxAttempts: 3 });
      await sched.drain(120_000);
      const task = store.getTask(t.id)!;
      assert.equal(calls, 1, 'the worker was not started again on a ticket that is over its budget');
      assert.equal(task.status, 'awaiting-approval', task.error ?? '');
      assert.match(task.error ?? '', /^budget hard-stop: task budget reached/);
      const run = store.latestRun(t.id)!;
      assert.equal(run.status, 'failed', 'and the run is still a timed-out run, not a canceled one');
      assert.match(run.summary ?? '', DEADLINE_IN_WORK);
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

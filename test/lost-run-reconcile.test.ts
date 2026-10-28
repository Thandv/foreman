import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { claimRunLease } from '../src/verify/slots.ts';

// A run is lost when its row says 'running' but nothing in this daemon is executing it. The scheduler finds such
// runs from tick, at most once a minute by its injected clock, and only acts on one it has seen twice in a row.

const STEP = 60_000;

function rig(t: TestContext): { store: Store; sched: Scheduler; tick: () => Promise<void> } {
  let clock = 1_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false, now: () => clock });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  // One tick one interval after the last. A tick that throws (a launch whose record fails) is the scenario, not the test.
  const tick = async (): Promise<void> => {
    clock += STEP;
    await sched.tick().catch(() => {});
  };
  return { store, sched, tick };
}

/** A task claimed and given a run row, with no execute() behind it: the shape of a run the daemon lost track of. */
function lostRun(store: Store, maxAttempts = 2): { taskId: string; runId: string } {
  const task = store.addTask({ title: 'lost', prompt: 'x', runner: 'echo', maxAttempts });
  assert.ok(store.claim(task.id));
  return { taskId: task.id, runId: store.startRun(task.id).id };
}

const messages = (store: Store, taskId: string): string[] =>
  store.eventsSince(0, 5000).filter((e) => e.taskId === taskId).map((e) => e.message);

/** A detached process group this test owns: its pid is its pgid. Killed by the test, never by the daemon. */
async function group(t: TestContext): Promise<{ pid: number; end: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  let over = false;
  const end = async (): Promise<void> => {
    if (over) return;
    over = true;
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
  };
  t.after(end);
  return { pid: child.pid!, end };
}

test('a run lost when startRun records nothing is ended and its task requeued within two intervals of the fault clearing', async (t) => {
  const { store, tick } = rig(t);
  const task = store.addTask({ title: 'x', prompt: 'x', runner: 'echo', maxAttempts: 2 });
  const original = store.record.bind(store);
  let thrown = 0;
  t.mock.method(store, 'record', ((e: Parameters<Store['record']>[0]) => {
    if (e.taskId === task.id && e.message === 'run started' && thrown === 0) {
      thrown++;
      throw new Error('SQLITE_BUSY');
    }
    return original(e);
  }) as Store['record']);
  await tick();
  assert.equal(thrown, 1);
  assert.equal(store.getTask(task.id)!.status, 'running', 'the task is lost');
  const run = store.latestRun(task.id)!;
  assert.equal(run.status, 'running');
  await tick(); // seen once
  assert.equal(store.getRun(run.id)!.status, 'running');
  await tick(); // seen twice: ended
  const ended = store.getRun(run.id)!;
  assert.equal(ended.status, 'failed');
  assert.equal(ended.summary, 'lost by this daemon');
  assert.ok(messages(store, task.id).includes('requeued after a lost run'));
});

test('a lost run with no attempts left fails its task with an event', async (t) => {
  const { store, tick } = rig(t);
  const { taskId, runId } = lostRun(store, 1);
  await tick();
  assert.equal(store.getRun(runId)!.status, 'running', 'seen once is not enough');
  await tick();
  assert.equal(store.getRun(runId)!.status, 'failed');
  assert.equal(store.getTask(taskId)!.status, 'failed');
  assert.ok(messages(store, taskId).includes('failed: run lost by this daemon; no attempts left'));
});

test('a lost run with a live process group is left alone with one event and ended after the group exits', async (t) => {
  const { store, tick } = rig(t);
  const signals: unknown[] = [];
  const realKill = process.kill.bind(process);
  t.mock.method(process, 'kill', ((pid: number, sig?: string | number) => {
    if (pid < 0) signals.push(sig);
    return realKill(pid, sig as NodeJS.Signals);
  }) as typeof process.kill);
  const g = await group(t);
  const { taskId, runId } = lostRun(store);
  store.setRunPid(runId, g.pid);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(store.getRun(runId)!.status, 'running');
  assert.equal(store.getTask(taskId)!.status, 'running');
  const left = messages(store, taskId).filter((m) => m === `lost run ${runId} still has a live process group ${g.pid}; left alone`);
  assert.equal(left.length, 1);
  assert.deepEqual([...new Set(signals)], [0], 'only signal 0 ever reaches a group');
  mockRestore(t);
  await g.end();
  await tick();
  assert.equal(store.getRun(runId)!.status, 'failed');
  assert.ok(messages(store, taskId).includes('requeued after a lost run'));
});

function mockRestore(t: TestContext): void {
  t.mock.restoreAll();
}

test('a lost run with a null pid and one with a stale pid are both ended', async (t) => {
  const { store, tick } = rig(t);
  const g = await group(t);
  await g.end();
  const a = lostRun(store);
  const b = lostRun(store);
  store.setRunPid(b.runId, g.pid);
  await tick();
  assert.equal(store.getRun(a.runId)!.status, 'running');
  assert.equal(store.getRun(b.runId)!.status, 'running');
  await tick();
  assert.equal(store.getRun(a.runId)!.status, 'failed');
  assert.equal(store.getRun(b.runId)!.status, 'failed');
});

test('a run its daemon still holds is untouched across 100 ticks', async (t) => {
  const { store, sched, tick } = rig(t);
  const internals = sched as unknown as {
    active: Map<string, unknown>;
    gating: Map<string, Promise<void>>;
    reverifying: Set<string>;
    broker: { pending: Map<string, number> };
  };
  const entry = (lane: string, taskId: string, runId: string): unknown => ({
    lane, taskId, runId, controller: new AbortController(), done: Promise.resolve(),
  });
  const work = lostRun(store);
  internals.active.set(work.taskId, entry('work', work.taskId, work.runId));
  const verify = lostRun(store);
  internals.active.set(verify.taskId, entry('verify', verify.taskId, verify.runId));
  const gating = lostRun(store);
  internals.gating.set(gating.taskId, new Promise<void>(() => {}));
  const reverifying = lostRun(store);
  internals.reverifying.add(reverifying.taskId);
  const landing = lostRun(store);
  store.beginLanding(landing.taskId);
  const lease = lostRun(store);
  const held = claimRunLease({ 'x-foreman-run': lease.runId });
  t.after(held.release);
  const reserved = lostRun(store);
  internals.broker.pending.set(reserved.taskId, 1);
  const cases = { work, verify, gating, reverifying, landing, lease, reserved };
  // A plain lost run alongside: ended, which shows the reconcile ran on those ticks while each case above was skipped.
  const plain = lostRun(store);
  for (let i = 0; i < 100; i++) await tick();
  assert.equal(store.getRun(plain.runId)!.status, 'failed', 'the reconcile ran');
  for (const [name, c] of Object.entries(cases)) {
    assert.equal(store.getRun(c.runId)!.status, 'running', `${name}: run untouched`);
    assert.equal(store.getTask(c.taskId)!.status, 'running', `${name}: task untouched`);
  }
  internals.active.clear();
  internals.gating.clear();
});

test('a run launched in the same macrotask as a reconcile is not taken for lost', async (t) => {
  const { store, sched } = rig(t);
  const internals = sched as unknown as { launch(task: unknown): void; reconcileLostRuns(): void; lastReconcile: number | null };
  const task = store.addTask({ title: 'x', prompt: 'x', runner: 'echo', maxAttempts: 2 });
  assert.ok(store.claim(task.id));
  internals.launch(store.getTask(task.id));
  const runId = store.latestRun(task.id)!.id;
  internals.reconcileLostRuns();
  internals.lastReconcile = 0;
  internals.reconcileLostRuns();
  internals.lastReconcile = 0;
  internals.reconcileLostRuns();
  assert.notEqual(store.getRun(runId)!.summary, 'lost by this daemon');
  assert.equal(store.getRun(runId)!.status, 'running', 'still its own execute()\'s to end');
  await sched.drain(10_000);
  assert.notEqual(store.getRun(runId)!.summary, 'lost by this daemon');
});

test('a lost run whose requeue event cannot be written still reopens the closed epic and ends the run row', async (t) => {
  const { store, tick } = rig(t);
  const epic = store.addTask({ title: 'epic', prompt: 'x', runner: 'echo', isEpic: true });
  const child = store.addTask({ title: 'child', prompt: 'x', runner: 'echo', maxAttempts: 2, parentId: epic.id });
  assert.ok(store.claim(child.id));
  const runId = store.startRun(child.id).id;
  store.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(epic.id);
  const original = store.record.bind(store);
  let thrown = 0;
  t.mock.method(store, 'record', ((e: Parameters<Store['record']>[0]) => {
    if (e.message === 'requeued after a lost run') {
      thrown++;
      throw new Error('SQLITE_BUSY');
    }
    return original(e);
  }) as Store['record']);
  t.mock.method(process.stderr, 'write', (() => true) as typeof process.stderr.write);
  await tick();
  await tick();
  assert.equal(thrown, 1);
  assert.equal(store.getTask(epic.id)!.status, 'blocked', 'the epic is reopened');
  assert.equal(store.getRun(runId)!.status, 'failed', 'the run row is ended');
});

test('a dead lost run whose task is no longer running ends only its run row', async (t) => {
  const { store, tick } = rig(t);
  const { taskId, runId } = lostRun(store);
  store.db.prepare("UPDATE tasks SET status = 'awaiting-approval' WHERE id = ?").run(taskId);
  await tick();
  await tick();
  assert.equal(store.getRun(runId)!.status, 'failed');
  assert.equal(store.getRun(runId)!.summary, 'lost by this daemon');
  assert.equal(store.getTask(taskId)!.status, 'awaiting-approval');
  assert.ok(!messages(store, taskId).includes('requeued after a lost run'));
});

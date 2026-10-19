import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';

/** A verify hook that parks until released, so the lanes can be observed. */
function gatedVerify(store: Store) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered = 0;
  return {
    release,
    get entered() { return entered; },
    hook: async ({ task, runId }: { task: { id: string }; runId: string }) => {
      entered++;
      await held;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  };
}

test('work proceeds while another task is stuck in verify', async () => {
  process.env['FOREMAN_ECHO_STEP_MS'] = '10';
  const store = new Store(':memory:');
  const gate = gatedVerify(store);
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verify: gate.hook });

  // The echo runner is deliberately not council-reviewed; shell tasks are.
  for (let i = 0; i < 3; i++) store.addTask({ title: `t${i}`, prompt: 'true', runner: 'shell' });

  await sched.tick();
  await new Promise((r) => setTimeout(r, 300));

  // One task is parked in verify; the single worker slot must be free for the next.
  assert.ok(gate.entered >= 1, 'a task reached verify');
  assert.ok(sched.verifyingCount >= 1, `expected a task in the verify lane, saw ${sched.verifyingCount}`);
  const started = store.listTasks().filter((t) => t.status === 'running' || t.status === 'verifying').length;
  assert.ok(started >= 2, `expected work to overlap verify, only ${started} task(s) started`);

  gate.release();
  await sched.drain(30_000);
  assert.equal(store.stats()['awaiting-approval'], 3);
  await sched.stop();
  store.close();
  process.env['FOREMAN_ECHO_STEP_MS'] = '5';
});

test('the verify lane is capped, and a freed slot admits the next task', async () => {
  const store = new Store(':memory:');
  const gate = gatedVerify(store);
  const sched = new Scheduler(store, { maxWorkers: 4, maxVerifying: 2, tickMs: 5, verify: gate.hook });

  for (let i = 0; i < 4; i++) {
    store.addTask({ title: `t${i}`, prompt: 'true', runner: 'shell' });
  }
  await sched.tick();
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(sched.verifyingCount <= 2, `verify lane overran its cap: ${sched.verifyingCount}`);
  assert.equal(sched.verifyLaneSize, 2);
  assert.ok(gate.entered <= 2, `only lane-admitted tasks may call the council, saw ${gate.entered}`);

  gate.release();
  await sched.drain(30_000);
  assert.equal(store.stats()['awaiting-approval'], 4, 'every task eventually gets through the lane');
  await sched.stop();
  store.close();
});

test('cancelling a task parked in the verify lane releases its slot', async () => {
  const store = new Store(':memory:');
  const gate = gatedVerify(store);
  const sched = new Scheduler(store, { maxWorkers: 2, maxVerifying: 1, tickMs: 5, verify: gate.hook });

  const first = store.addTask({ title: 'a', prompt: 'true', runner: 'shell' });
  const second = store.addTask({ title: 'b', prompt: 'true', runner: 'shell' });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sched.verifyingCount, 1);

  store.cancel(first.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.getTask(first.id)!.status, 'canceled');

  gate.release();
  await sched.drain(30_000);
  assert.equal(store.getTask(second.id)!.status, 'awaiting-approval', 'the queued task got the freed lane slot');
  assert.equal(sched.verifyingCount, 0);
  await sched.stop();
  store.close();
});

test('crash recovery requeues from either lane', async () => {
  const store = new Store(':memory:');
  const working = store.addTask({ title: 'working', prompt: 'x', runner: 'shell', maxAttempts: 3 });
  const verifying = store.addTask({ title: 'verifying', prompt: 'x', runner: 'shell', maxAttempts: 3 });
  store.claim(working.id);
  store.claim(verifying.id);
  store.startRun(working.id);
  const vRun = store.startRun(verifying.id);
  store.setStatus(verifying.id, 'verifying');

  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  store.recoverOrphans();

  assert.equal(store.getTask(working.id)!.status, 'queued');
  assert.equal(store.getTask(verifying.id)!.status, 'queued', 'a task interrupted mid-verify is requeued too');
  assert.equal(store.getRun(vRun.id)!.status, 'canceled');
  await sched.stop();
  store.close();
});

test('a task never occupies both lanes at once', async () => {
  const store = new Store(':memory:');
  const gate = gatedVerify(store);
  const sched = new Scheduler(store, { maxWorkers: 2, maxVerifying: 2, tickMs: 5, verify: gate.hook });
  for (let i = 0; i < 2; i++) store.addTask({ title: `t${i}`, prompt: 'true', runner: 'shell' });

  await sched.tick();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(
      sched.activeCount + sched.verifyingCount <= 2,
      `a task was counted in both lanes: ${sched.activeCount} + ${sched.verifyingCount}`,
    );
  }
  gate.release();
  await sched.drain(30_000);
  await sched.stop();
  store.close();
});

test('time spent queued for a verify slot does not count against the run deadline', async () => {
  // One verify slot, each verify takes 400 ms, the run deadline is 600 ms. B waits ~400 ms then verifies 400 ms, and C
  // waits ~800 ms: counting the wait, both would pass their deadline in the queue and be cancelled with their work done.
  const store = new Store(':memory:');
  const hook = async ({ task, runId }: { task: { id: string }; runId: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  };
  const sched = new Scheduler(store, { maxWorkers: 3, maxVerifying: 1, tickMs: 5, taskTimeoutMs: 600, verify: hook });
  const ids = ['a', 'b', 'c'].map((t) => store.addTask({ title: t, prompt: 'true', runner: 'shell' }).id);
  await sched.tick();
  await sched.drain(30_000);
  for (const id of ids) assert.equal(store.getTask(id)!.status, 'awaiting-approval', `${id}: ${store.getTask(id)!.error ?? ''}`);
  await sched.stop();
  store.close();
});

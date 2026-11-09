// The dispatch hold (Scheduler.dispatchHold): an operator stops new work only, while the rest of the tick runs.
// Distinct from shutdown's pauseDispatch, which returns before every stage.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import type { Task } from '../src/types.ts';

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A queued echo ticket, an owner-gated S2 ticket parked green (the gate holds it for a person, no model call) and a ticket blocked on a failed one. */
function board(store: Store): { queued: Task; parked: Task; blocked: Task } {
  const queued = store.addTask({ title: 'new work', prompt: 'x', runner: 'echo' });
  const parked = store.addTask({ title: 'parked', prompt: 'x', runner: 'echo', gate: 'owner', sensitivity: 'S2' });
  const run = store.startRun(parked.id);
  store.setTestsPassed(run.id, true);
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(parked.id, 'awaiting-approval');
  const dep = store.addTask({ title: 'dep', prompt: 'x', runner: 'echo' });
  store.setStatus(dep.id, 'failed', 'boom');
  const blocked = store.addTask({ title: 'blocked', prompt: 'x', runner: 'echo', deps: [dep.id] });
  return { queued, parked, blocked };
}

const gateEvents = (store: Store, taskId: string): string[] =>
  store.eventsForTask(taskId).map((e) => e.message).filter((m) => m.startsWith('owner-gate:'));

test('with the dispatch hold set, the owner gate and reconcile still run while no task is claimed', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false, maxWorkers: 1 });
  try {
    const { queued, parked, blocked } = board(store);
    sched.dispatchHold('deploying');
    await sched.tick();
    await until(() => gateEvents(store, parked.id).length > 0, 'the owner gate to decide');
    assert.match(gateEvents(store, parked.id)[0]!, /^owner-gate: hold — hard-human: S2/);
    assert.equal(store.getTask(blocked.id)!.status, 'failed', 'reconcile ran');
    assert.equal(store.getTask(queued.id)!.status, 'queued', 'nothing claimed');
    assert.equal(store.latestRun(queued.id), null);
    assert.deepEqual(sched.dispatchHoldState?.reason, 'deploying');

    sched.releaseDispatchHold();
    assert.equal(sched.dispatchHoldState, null);
    await sched.tick();
    assert.ok(store.latestRun(queued.id), 'the next tick claims');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('the dispatch hold skips only the dispatch stage; the idle-time stages after it still run', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false, maxWorkers: 1 });
  const order: string[] = [];
  const obj = sched as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['runDueGates', 'reconcileLostRuns', 'runDueRechecks', 'recheckRedRepos', 'probeDirtyRepos']) {
    const real = obj[name]!.bind(sched);
    obj[name] = (...args: unknown[]) => { order.push(name); return real(...args); };
  }
  let claims = 0;
  const realClaimable = store.claimable.bind(store);
  store.claimable = ((...args: Parameters<Store['claimable']>) => { claims++; return realClaimable(...args); }) as Store['claimable'];
  try {
    store.addTask({ title: 'new work', prompt: 'x', runner: 'echo' });
    sched.dispatchHold('deploying');
    await sched.tick();
    assert.equal(claims, 0);
    assert.deepEqual(order, ['runDueGates', 'reconcileLostRuns', 'runDueRechecks', 'recheckRedRepos', 'probeDirtyRepos']);
  } finally {
    await sched.stop();
    store.close();
  }
});

test('pin: pauseDispatch still returns before every stage (no gate, no reconcile, no claim)', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false, maxWorkers: 1 });
  try {
    const { queued, parked, blocked } = board(store);
    sched.pauseDispatch();
    await sched.tick();
    assert.deepEqual(gateEvents(store, parked.id), []);
    assert.equal(store.getTask(blocked.id)!.status, 'blocked');
    assert.equal(store.getTask(queued.id)!.status, 'queued');
  } finally {
    await sched.stop();
    store.close();
  }
});

// ------------------------------------------------------------------ the HTTP route and the CLI

interface Daemon {
  base: string;
  store: Store;
  sched: Scheduler;
}

/** An in-process daemon whose scheduler is never started: it ticks only when a route asks for one. */
async function daemon(t: test.TestContext): Promise<Daemon> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  return { base, store, sched };
}

const stateHold = async (base: string): Promise<unknown> =>
  ((await (await fetch(`${base}/api/state`)).json()) as { dispatchHold: unknown }).dispatchHold;

test('POST and DELETE /api/dispatch-hold set and clear the hold, and GET /api/state shows it with its reason', async (t) => {
  const { base, store } = await daemon(t);
  assert.equal(await stateHold(base), null);

  const set = await fetch(`${base}/api/dispatch-hold`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'deploying' }),
  });
  assert.equal(set.status, 200);
  const shown = (await stateHold(base)) as { reason: string; since: number };
  assert.equal(shown.reason, 'deploying');
  assert.equal(typeof shown.since, 'number');
  assert.ok(store.eventsSince(0).some((e) => e.message === 'dispatch held: deploying'));

  const cleared = await fetch(`${base}/api/dispatch-hold`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal(await stateHold(base), null);
  assert.ok(store.eventsSince(0).some((e) => e.message === 'dispatch hold released'));
});

test('POST /api/dispatch-hold without a reason is refused and sets nothing', async (t) => {
  const { base } = await daemon(t);
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }, { reason: 'x'.repeat(501) }]) {
    const res = await fetch(`${base}/api/dispatch-hold`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await stateHold(base), null);
});

/** Runs the CLI against the in-process daemon. */
async function cli(base: string, argv: string[]): Promise<{ code: number | null; out: string }> {
  const { port } = new URL(base);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli.ts'), ...argv], {
    env: { ...process.env, FOREMAN_PORT: port, FOREMAN_HOST: '127.0.0.1' },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, out };
}

test('foreman hold --reason holds new work; foreman resume clears it and the next tick claims', async (t) => {
  const { base, store, sched } = await daemon(t);
  const held = await cli(base, ['hold', '--reason', 'deploying']);
  assert.equal(held.code, 0, held.out);
  assert.equal(sched.dispatchHoldState?.reason, 'deploying');
  const task = store.addTask({ title: 'new work', prompt: 'x', runner: 'echo' });
  await sched.tick();
  assert.equal(store.latestRun(task.id), null, 'held: not claimed');

  const resumed = await cli(base, ['resume']);
  assert.equal(resumed.code, 0, resumed.out);
  assert.equal(sched.dispatchHoldState, null);
  await sched.tick();
  assert.ok(store.latestRun(task.id), 'the next tick claims');

  const bare = await cli(base, ['hold']);
  assert.notEqual(bare.code, 0, 'a hold needs a reason');
  assert.equal(sched.dispatchHoldState, null);
});

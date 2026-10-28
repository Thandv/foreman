import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Broker } from '../src/budget.ts';
import { reloadSpecs } from '../src/models.ts';
import { setCloudDown } from '../src/localOnly.ts';
import type { Task, Verdict } from '../src/types.ts';

// What the scheduler does AFTER a ledger fault in a gate, a re-check or a run: the slot it held is free again and the
// next piece of work starts. (test/containment.test.ts asserts that nothing escapes; these assert that it recovers.)

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function pump(t: TestContext, sched: Scheduler, until: () => boolean): Promise<void> {
  while (!until()) {
    t.signal.throwIfAborted();
    await sched.tick();
    await nextTurn();
  }
}

function scratch(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setEnv(t: TestContext, name: string, value: string): void {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

/** A ticket parked at the gate on a finished run with a verdict, as the gate sees it. */
function park(store: Store, over: Partial<Parameters<Store['addTask']>[0]>, verdict: 'pass' | 'fail' = 'pass'): Task {
  const task = store.addTask({ title: 'parked', prompt: 'work', runner: 'echo', kind: 'code', gate: 'owner', ...over });
  const run = store.startRun(task.id);
  store.setTestsPassed(run.id, true);
  store.addVerdict({
    runId: run.id, taskId: task.id, verdict, disagreement: false,
    council: [{ model: 'local-0', provider: 'ollama', local: true, verdict, confidence: 0.9, critique: 'read the diff', costUsd: 0, latencyMs: 5 }],
  });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(task.id, 'awaiting-approval');
  return store.getTask(task.id)!;
}

test('a batched gate whose newer-run lookup throws for the first ticket still frees every gating slot', { timeout: 30_000 }, async (t) => {
  // The batched call is answered by a fake claude that fails, which the gate turns into a hold per ticket.
  const bin = path.join(scratch(t, 'foreman-recovery-claude-'), 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\necho "no answer"\nexit 1\n');
  fs.chmodSync(bin, 0o755);
  setEnv(t, 'FOREMAN_CLAUDE_BIN', bin);
  setEnv(t, 'FOREMAN_LOCAL_ONLY', 'off');
  setCloudDown(null);
  reloadSpecs();
  t.after(() => {
    setCloudDown(null);
    reloadSpecs();
  });

  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const epic = store.addTask({ title: 'epic', prompt: 'ship it', runner: 'echo', playbook: 'auto', isEpic: true });
  const pair = [1, 2].map((n) => park(store, { parentId: epic.id, title: `ticket ${n}`, playbook: 'auto', role: 'dev' }));
  const first = pair[0]!.id;
  const other = park(store, { title: 'not in the epic' }, 'fail');

  // The lookup fails once, at the batch's .finally: armed by the marker write the .catch makes just before it.
  let armed = false;
  let thrown = 0;
  const mark = store.markGateDecision.bind(store);
  t.mock.method(store, 'markGateDecision', ((id: string, decision: Parameters<Store['markGateDecision']>[1]) => {
    mark(id, decision);
    if (id === first) armed = true;
  }) as Store['markGateDecision']);
  const latest = store.latestRun.bind(store);
  t.mock.method(store, 'latestRun', ((id: string) => {
    if (armed && id === first && thrown === 0) {
      thrown++;
      throw new Error('SQLITE_BUSY');
    }
    return latest(id);
  }) as Store['latestRun']);

  await pump(t, sched, () => store.gateDecision(other.id) !== null);
  assert.equal(thrown, 1, 'the lookup failed once');
  assert.equal((sched as unknown as { gating: Map<string, unknown> }).gating.size, 0, 'no ticket is left holding the gating slot');
});

/**
 * A re-check whose reverify resolves with a settled verdict and whose settleRecheck then throws `fault`: the fault is
 * armed only once reverify has returned, so it can reach nothing but the settling step.
 */
async function recheckThatCannotSettle(t: TestContext, fault: unknown): Promise<{ store: Store; sched: Scheduler; first: Task; second: Task }> {
  setEnv(t, 'FOREMAN_RECHECK_MS', '0');
  const dir = scratch(t, 'foreman-recovery-recheck-');
  const store = new Store(':memory:');
  const broker = new Broker(store, { guardResidency: false, fitsFn: async () => true });
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1, verifyEnabled: false, broker,
    verify: async ({ runId, task }): Promise<Verdict> => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const provisional = (title: string): Task => {
    const task = store.addTask({ title, prompt: 'fix it', kind: 'code' });
    const run = store.startRun(task.id);
    store.endRun(run.id, 'succeeded', { summary: 'fixed' });
    const diffPath = path.join(dir, `${task.id}.patch`);
    fs.writeFileSync(diffPath, '+fixed\n');
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
    store.setStatus(task.id, 'awaiting-approval');
    return store.getTask(task.id)!;
  };
  const inFlight = (): unknown => (sched as unknown as { recheckInFlight: unknown }).recheckInFlight;
  const rechecked = (id: string): boolean => store.eventsForTask(id).some((e) => /full council fits now/.test(e.message));

  const first = provisional('first');
  let armed = false;
  let thrown = 0;
  t.mock.method(sched, 'reverify', (async (id: string): Promise<Verdict> => {
    const run = store.latestRun(id)!;
    const verdict = store.addVerdict({ runId: run.id, taskId: id, verdict: 'pass', disagreement: false, council: [] });
    if (id === first.id) armed = true;
    return verdict;
  }) as Scheduler['reverify']);
  const getTask = store.getTask.bind(store);
  t.mock.method(store, 'getTask', ((id: string) => {
    if (armed && id === first.id && thrown === 0) {
      thrown++;
      throw fault;
    }
    return getTask(id);
  }) as Store['getTask']);

  await pump(t, sched, () => thrown > 0 && inFlight() === null);
  assert.equal(inFlight(), null, 'the failed re-check no longer holds the in-flight mark');

  // Backed off like a re-check that did not complete: parked until a later time, not forgotten.
  const notBefore = (sched as unknown as { recheckNotBefore: Map<string, number> }).recheckNotBefore;
  assert.ok(notBefore.size === 1 && [...notBefore.values()][0]! > Date.now(), 'the ticket is backed off into the future');

  const second = provisional('second');
  await pump(t, sched, () => rechecked(second.id));
  assert.ok(rechecked(second.id), 'the next interval re-checked the other ticket');
  return { store, sched, first, second };
}

test('a re-check whose verdict cannot be settled is recorded, backed off, and a later interval re-checks another ticket', { timeout: 30_000 }, async (t) => {
  const { store, first } = await recheckThatCannotSettle(t, new Error('SQLITE_BUSY'));
  assert.ok(store.eventsForTask(first.id).some((e) => e.message === 're-check did not complete: SQLITE_BUSY'), 'the failure is recorded');
});

test('a re-check that fails with a non-Error value records the value and backs the ticket off', { timeout: 30_000 }, async (t) => {
  const { store, first } = await recheckThatCannotSettle(t, 'plain string fault');
  assert.ok(store.eventsForTask(first.id).some((e) => e.message === 're-check did not complete: plain string fault'), 'the string is recorded as the cause');
});

test('a run whose bookkeeping fails after the log is closed writes nothing to the closed log descriptor', { timeout: 30_000 }, async (t) => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  // Events pruning is the last step of execute()'s finally: when it fails the run writes a log line about it.
  t.mock.method(sched as unknown as { pruneEvents: () => void }, 'pruneEvents', () => {
    throw new Error('prune failed');
  });
  // The descriptors currently closed; a descriptor number is free for reuse the moment it closes.
  const closed = new Set<number>();
  const late: number[] = [];
  const open = fs.openSync;
  const close = fs.closeSync;
  const write = fs.writeSync;
  t.mock.method(fs, 'openSync', ((...a: Parameters<typeof fs.openSync>) => {
    const fd = open(...a);
    closed.delete(fd);
    return fd;
  }) as typeof fs.openSync);
  t.mock.method(fs, 'closeSync', ((fd: number) => {
    closed.add(fd);
    return close(fd);
  }) as typeof fs.closeSync);
  t.mock.method(fs, 'writeSync', ((fd: number, ...rest: unknown[]) => {
    if (closed.has(fd)) late.push(fd);
    return (write as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof fs.writeSync);

  const task = store.addTask({ title: 'say hello', prompt: 'say hello', runner: 'echo' });
  await pump(t, sched, () => !['queued', 'running'].includes(store.getTask(task.id)!.status));
  await sched.drain();
  assert.ok(closed.size > 0, 'the run opened and closed its log');
  assert.deepEqual(late, [], 'no write reached a descriptor after it was closed');
});

test('a run whose bookkeeping fails with a non-Error value still closes its log', { timeout: 30_000 }, async (t) => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  // A catch in execute()'s finally that read `.message` of this would throw, skip the close and leak the descriptor.
  t.mock.method(store, 'setRunFacts', () => {
    throw undefined;
  });
  t.mock.method(sched as unknown as { pruneEvents: () => void }, 'pruneEvents', () => {
    throw undefined;
  });
  const opened = new Set<number>();
  const open = fs.openSync;
  const close = fs.closeSync;
  t.mock.method(fs, 'openSync', ((...a: Parameters<typeof fs.openSync>) => {
    const fd = open(...a);
    opened.add(fd);
    return fd;
  }) as typeof fs.openSync);
  t.mock.method(fs, 'closeSync', ((fd: number) => {
    opened.delete(fd);
    return close(fd);
  }) as typeof fs.closeSync);

  const task = store.addTask({ title: 'say hello', prompt: 'say hello', runner: 'echo' });
  await pump(t, sched, () => !['queued', 'running'].includes(store.getTask(task.id)!.status));
  await sched.drain();
  assert.deepEqual([...opened], [], 'every descriptor the run opened was closed');
  assert.ok(!store.eventsForTask(task.id).some((e) => /run crashed/.test(e.message)), 'the finally did not throw');
});

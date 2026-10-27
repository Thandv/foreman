import './env.ts';
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler, type SchedulerOptions } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { Tracer } from '../src/trace.ts';
import { Broker } from '../src/budget.ts';
import { reloadSpecs } from '../src/models.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { savePersona, seedPersonas } from '../src/align/personas.ts';
import { servePersona } from '../src/align/personaServe.ts';
import type { NewTask } from '../src/queue.ts';
import type { Task, Verdict } from '../src/types.ts';

// A fault in a ledger write, a spawn or a sweep must stay inside the thing that hit it. Each case below injects one
// such fault on a path that today lets it escape, as an unhandled rejection or an uncaught exception, and asserts that
// nothing escaped. They are TODO until the ticket named on each removes the mark: a TODO that fails is the known gap,
// and a TODO that passes would be a report.

const escaped: unknown[] = [];
const collect = (reason: unknown): void => {
  escaped.push(reason);
};

before(() => {
  process.on('unhandledRejection', collect);
  process.on('uncaughtException', collect);
});

after(() => {
  process.off('unhandledRejection', collect);
  process.off('uncaughtException', collect);
});

const BUSY = (): Error => new Error('SQLITE_BUSY');

/** One turn of the event loop: a rejection nobody handled is reported once the microtask queue has drained. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Ticks the scheduler (and turns the loop) until `until` holds; the test's own timeout ends the wait. */
async function pump(t: TestContext, sched: Scheduler, until: () => boolean): Promise<void> {
  while (!until()) {
    t.signal.throwIfAborted();
    await sched.tick();
    await nextTurn();
  }
}

/** Lets a fault that has just fired reach the process-level handlers. */
async function landed(): Promise<void> {
  await nextTurn();
  await nextTurn();
}

/** What reached the process, cleared; the message of each, so a failure names it. */
function takeEscaped(): string[] {
  return escaped.splice(0).map((e) => (e instanceof Error ? e.message : String(e)));
}

type Fault = { thrown: number };

/** Makes `store[name]` throw SQLITE_BUSY whenever `when` holds for the call; counts the throws. */
function throwOn<K extends 'record' | 'endRun' | 'setStatus' | 'markGateDecision' | 'latestRun'>(
  t: TestContext,
  store: Store,
  name: K,
  when: (...args: Parameters<Store[K]>) => boolean,
): Fault {
  const fault: Fault = { thrown: 0 };
  const original = store[name].bind(store) as (...args: Parameters<Store[K]>) => unknown;
  t.mock.method(store, name, ((...args: Parameters<Store[K]>) => {
    if (when(...args)) {
      fault.thrown++;
      throw BUSY();
    }
    return original(...args);
  }) as Store[K]);
  return fault;
}

const idOf = (v: string | { taskId?: string | null } | undefined): string | undefined => (typeof v === 'string' ? v : v?.taskId ?? undefined);

function scratch(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rig(t: TestContext, opts: SchedulerOptions = {}): { store: Store; sched: Scheduler } {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false, ...opts });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  return { store, sched };
}

/** The ticket that must still run after the fault: a plain echo ticket queued behind it. */
function queueEcho(store: Store): Task {
  return store.addTask({ title: 'next in line', prompt: 'say hello', runner: 'echo' });
}

async function assertEchoDispatches(t: TestContext, store: Store, sched: Scheduler, id: string): Promise<void> {
  await pump(t, sched, () => store.getTask(id)!.status !== 'queued');
  assert.notEqual(store.getTask(id)!.status, 'queued', 'the next echo ticket was dispatched');
  assert.ok(store.latestRun(id), 'and it has a run');
}

/** A ticket parked at the gate on a green run, the gate's input (as test/gate.test.ts parks one). */
function park(store: Store, over: Partial<NewTask>, verdict: 'pass' | 'fail' = 'pass'): Task {
  const task = store.addTask({ title: 'parked', prompt: 'work', runner: 'echo', kind: 'code', gate: 'owner', ...over });
  const run = store.startRun(task.id);
  store.setTestsPassed(run.id, true);
  store.addVerdict({
    runId: run.id, taskId: task.id, verdict, disagreement: false,
    council: [{
      model: 'local-0', provider: 'ollama', local: true, verdict, confidence: 0.9, critique: 'read the diff',
      costUsd: 0, latencyMs: 5,
    }],
  });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(task.id, 'awaiting-approval');
  return store.getTask(task.id)!;
}

/** A `claude` stand-in that answers `--version` and otherwise says what `body` says, exiting `code`. */
function fakeClaude(t: TestContext, body: string, code: number): string {
  const dir = scratch(t, 'foreman-containment-claude-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\necho "${body}"\nexit ${code}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** As test/cloudmode.test.ts withCli: the fake bin for the case, the cloud state reset around it. */
function useClaude(t: TestContext, bin: string): void {
  const prev = { bin: process.env['FOREMAN_CLAUDE_BIN'], mode: process.env['FOREMAN_LOCAL_ONLY'] };
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  process.env['FOREMAN_LOCAL_ONLY'] = 'off';
  setCloudDown(null);
  reloadSpecs();
  t.after(() => {
    for (const [key, value] of [['FOREMAN_CLAUDE_BIN', prev.bin], ['FOREMAN_LOCAL_ONLY', prev.mode]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCloudDown(null);
    reloadSpecs();
  });
}

function setEnv(t: TestContext, name: string, value: string): void {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

// ------------------------------------------------------------------ the run's failure path

// Seam: Scheduler.execute's catch block, where record(type 'error'), endRun and setStatus run for a run that threw.
test('a run that fails before it spawns anything, with the ledger refusing its failure, escapes nothing', { todo: 't5 removes this mark' }, async (t) => {
  const { store, sched } = rig(t);
  // An S2 ticket on a hosted-model runner is refused in preflight, before any worker or jail exists.
  const doomed = store.addTask({ title: 'refused', prompt: 'x', runner: 'claude-code', sensitivity: 'S2', maxAttempts: 1 });
  const ofDoomed = (runId: string): boolean => store.getRun(runId)?.taskId === doomed.id;
  const faults = [
    throwOn(t, store, 'record', (e) => e.taskId === doomed.id && e.type === 'error'),
    throwOn(t, store, 'endRun', (runId) => ofDoomed(runId)),
    throwOn(t, store, 'setStatus', (id) => id === doomed.id && store.getTask(id)?.status !== 'queued' && store.getTask(id)?.status !== 'running'),
  ];
  takeEscaped();
  await pump(t, sched, () => faults[0]!.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the failing run');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// Seam: the same catch block, reached by ProviderLimited from a fake claude bin that is refused at its usage limit.
test('a run refused by the provider usage limit, with the ledger refusing its failure, escapes nothing', { todo: 't5 removes this mark' }, async (t) => {
  useClaude(t, fakeClaude(t, "You've hit your session limit · resets 4:30pm (Europe/London)", 1));
  setEnv(t, 'FOREMAN_LIMIT_BACKOFF_MS', '60000');
  const { store, sched } = rig(t);
  const limited = store.addTask({ title: 'limited work', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
  const faults = [
    throwOn(t, store, 'record', (e) => e.taskId === limited.id && e.type === 'error'),
    throwOn(t, store, 'endRun', (runId) => store.getRun(runId)?.taskId === limited.id),
  ];
  takeEscaped();
  await pump(t, sched, () => faults[0]!.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the limited run');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// ------------------------------------------------------------------ the owner gate

// Seam: Scheduler.runOwnerGate. ownerGate rejects because markGateDecision throws on a decided hold (a failed review,
// hard-human, on a ticket still parked); the .catch then makes the same two writes, and they throw too.
test('a single owner gate whose hold cannot be written escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  const { store, sched } = rig(t);
  const held = park(store, {}, 'fail');
  const faults = [
    throwOn(t, store, 'markGateDecision', (id) => id === held.id),
    throwOn(t, store, 'record', (e) => e.taskId === held.id && e.type === 'error'),
  ];
  takeEscaped();
  await pump(t, sched, () => faults[0]!.thrown >= 2);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the gate');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// Seam: Scheduler.runDueGateBatch (two eligible tickets under one parent). markGateDecision and record throw, and
// latestRun throws for the first id once the .catch has failed, so the .finally throws as well.
test('a batched owner gate whose hold cannot be written escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  // The batched call is answered by a fake claude that fails, which the gate must turn into a hold per ticket.
  useClaude(t, fakeClaude(t, 'no answer', 1));
  const { store, sched } = rig(t);
  const epic = store.addTask({ title: 'epic', prompt: 'ship it', runner: 'echo', playbook: 'auto', isEpic: true });
  const pair = [1, 2].map((n) => park(store, { parentId: epic.id, title: `ticket ${n}`, playbook: 'auto', role: 'dev' }));
  const first = pair[0]!.id;
  const ids = new Set(pair.map((p) => p.id));
  const marks = throwOn(t, store, 'markGateDecision', (id) => ids.has(id));
  throwOn(t, store, 'record', (e) => ids.has(e.taskId ?? '') && e.type === 'error');
  // Armed by the second failed marker write (the one in the .catch): from there the .finally's lookups throw.
  const finale = throwOn(t, store, 'latestRun', (id) => id === first && marks.thrown >= 2);
  takeEscaped();
  await pump(t, sched, () => finale.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the batched gate');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// ------------------------------------------------------------------ the provisional re-check

/** A ticket parked on a provisional pass whose stored diff the re-check can read, and a scheduler to re-check it. */
function provisional(t: TestContext): { store: Store; sched: Scheduler; task: Task } {
  setEnv(t, 'FOREMAN_RECHECK_MS', '0');
  const dir = scratch(t, 'foreman-containment-recheck-');
  const store = new Store(':memory:');
  const task = store.addTask({ title: 'fix', prompt: 'fix it', kind: 'code' });
  // Every model fits, so the full council is always seatable and the re-check goes ahead (test/downshift.test.ts).
  const broker = new Broker(store, { guardResidency: false, fitsFn: async () => true });
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1, verifyEnabled: false, broker,
    verify: async ({ runId }): Promise<Verdict> => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const run = store.startRun(task.id);
  store.endRun(run.id, 'succeeded', { summary: 'fixed' });
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, '+fixed\n');
  store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
  store.setStatus(task.id, 'awaiting-approval');
  return { store, sched, task: store.getTask(task.id)! };
}

// Seam: Scheduler.runDueRechecks, the record of 'the full council fits now' at the head of the re-check.
test('a re-check whose first ledger write fails escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  const { store, sched, task } = provisional(t);
  const fault = throwOn(t, store, 'record', (e) => e.taskId === task.id && /full council fits now/.test(e.message));
  takeEscaped();
  await pump(t, sched, () => fault.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the re-check');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// Seam: Scheduler.fullCouncilFits, through a broker.fits that rejects.
test('a re-check whose memory probe rejects escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  const { store, sched } = provisional(t);
  let thrown = 0;
  t.mock.method(sched.broker, 'fits', async () => {
    thrown++;
    throw BUSY();
  });
  takeEscaped();
  await pump(t, sched, () => thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the re-check');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// Seam: Scheduler.settleRecheck, whose setStatus writes the cleared park note once the full council has passed it.
test('a re-check whose verdict cannot be settled escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  const { store, sched, task } = provisional(t);
  const fault = throwOn(t, store, 'setStatus', (id) => id === task.id);
  takeEscaped();
  await pump(t, sched, () => fault.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the re-check');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
});

// ------------------------------------------------------------------ the server

// Seam: POST /api/tasks/:id/reverify through createServer on port 0; the review rejects, then the handler's own record throws.
test('a manual re-review that fails, with the ledger refusing the failure, escapes nothing', { todo: 't7 removes this mark' }, async (t) => {
  const dir = scratch(t, 'foreman-containment-server-');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1, verifyEnabled: false,
    verify: async () => {
      throw new Error('the reviewer is gone');
    },
  });
  const server = createServer(store, sched);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sched.stop();
    store.close();
  });
  const task = store.addTask({ title: 'Draft Chapter 12', prompt: 'write it', kind: 'writing' });
  const run = store.startRun(task.id);
  store.endRun(run.id, 'succeeded', { summary: 'drafted' });
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, '+++ a chapter of prose\n');
  store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
  store.setStatus(task.id, 'awaiting-approval');
  const fault = throwOn(t, store, 'record', (e) => e.taskId === task.id && /re-review failed/.test(e.message));
  takeEscaped();
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/reverify`, { method: 'POST' });
  assert.equal(res.status, 202, 'accepted; the review runs in the background');
  while (fault.thrown === 0) {
    t.signal.throwIfAborted();
    await nextTurn();
  }
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the handler');
});

// ------------------------------------------------------------------ the tracer

// Seam: Tracer.sweep at the first write past midnight, reached from store.record through the 'event' listener.
test('a trace sweep that cannot delete a stale day escapes nothing, and record returns', async (t) => {
  const dir = scratch(t, 'foreman-containment-traces-');
  const store = new Store(':memory:');
  let now = Date.UTC(2026, 0, 15, 23, 59, 0);
  const tracer = new Tracer(store, { dir, now: () => now, retainDays: 14 });
  tracer.start();
  // Kept at the first sweep (exactly at the cutoff), stale once the clock is a day on.
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), '{}\n');
  const rm = t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });
  t.after(() => {
    tracer.stop();
    store.close();
  });
  now = Date.UTC(2026, 0, 16, 0, 0, 1);
  takeEscaped();
  try {
    assert.doesNotThrow(() => store.record({ type: 'status', message: 'the first event of the new day' }), 'record returns');
    assert.ok(rm.mock.callCount() > 0, 'the sweep did try to delete the stale day');
    await landed();
    assert.deepEqual(takeEscaped(), [], 'nothing escaped the sweep');
  } finally {
    // Restored here, not in an after hook: hooks run in the order they were registered, so scratch()'s removal of
    // the dir would run first, hit the mock, throw, and skip every hook after it (leaving the dir behind).
    rm.mock.restore();
  }
});

// ------------------------------------------------------------------ a run's output

// Seam: the shell runner's stream 'data' listener, whose ctx.log records each output line as a 'log' event.
test('a ledger fault while a run prints its output escapes nothing', async (t) => {
  const { store, sched } = rig(t);
  const noisy = store.addTask({ title: 'prints lines', prompt: 'echo one; echo two; echo three', runner: 'shell', maxAttempts: 1 });
  const fault = throwOn(t, store, 'record', (e) => e.taskId === noisy.id && e.type === 'log');
  takeEscaped();
  await pump(t, sched, () => fault.thrown > 0);
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the output stream');
  await pump(t, sched, () => sched.activeCount === 0);
  assert.equal(store.getTask(noisy.id)!.status, 'failed', 'a run whose output could not be recorded fails the ticket');
  assert.ok(store.latestRun(noisy.id), 'the ticket has a run');
  assert.equal(store.latestRun(noisy.id)!.status, 'failed', 'and that run ended failed');
  const next = queueEcho(store);
  await assertEchoDispatches(t, store, sched, next.id);
  // Waited out here, not aborted by stop() in cleanup: on node 26.0.0 a run aborted that way after a shell run made a
  // later case's uncaught exception abort this file natively, and the runner dropped the cases left without a failure.
  await pump(t, sched, () => sched.activeCount === 0);
});

// ------------------------------------------------------------------ the persona server

// Seam: servePersona's spawn of `nice`, with PATH holding no `nice`, so the child emits 'error' with no listener.
test('serving a persona when the server cannot be spawned resolves not-serving and escapes nothing', async (t) => {
  const home = scratch(t, 'foreman-containment-persona-');
  const emptyBin = path.join(home, 'bin');
  fs.mkdirSync(emptyBin);
  setEnv(t, 'FOREMAN_ALIGN_DIR', path.join(home, 'align'));
  // The server URL points at a port nothing listens on, so the readiness probe cannot reach a real persona server.
  setEnv(t, 'FOREMAN_PERSONA_URL_PUBLISHING_AUTHOR', 'http://127.0.0.1:1/v1');
  const persona = seedPersonas()[0]!;
  assert.equal(persona.id, 'publishing.author');
  savePersona(persona);
  const adapter = path.join(home, 'align', 'personas', persona.id, 'adapter');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(path.join(adapter, 'adapters.safetensors'), 'weights');
  setEnv(t, 'PATH', emptyBin);
  takeEscaped();
  // A start timeout already past: the one readiness probe fails and the call gives up.
  const result = await servePersona(persona, { startTimeoutMs: -1 });
  await landed();
  assert.deepEqual(takeEscaped(), [], 'nothing escaped the spawn');
  assert.equal(result.ok, false);
  assert.equal(result.pid, null);
});

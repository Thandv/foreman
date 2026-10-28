import './env.ts';
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, safeRecord } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { RunClock } from '../src/runClock.ts';
import { echoRunner } from '../src/runners/echo.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { reloadSpecs } from '../src/models.ts';
import { FakeTime } from './fakeclock.ts';

// What the run path does when the ledger (or the disk) refuses a write while a run is failing or finishing:
// the run's outcome stands, and nothing reaches the process as an unhandled rejection or an uncaught exception.

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

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function pump(t: TestContext, sched: Scheduler, until: () => boolean): Promise<void> {
  while (!until()) {
    t.signal.throwIfAborted();
    await sched.tick();
    await nextTurn();
  }
}

/** A fault that has just fired reaches the process-level handlers within two turns. */
async function landed(): Promise<void> {
  await nextTurn();
  await nextTurn();
}

function takeEscaped(): string[] {
  return escaped.splice(0).map((e) => (e instanceof Error ? e.message : String(e)));
}

function rig(t: TestContext, over: ConstructorParameters<typeof Scheduler>[1] = {}): { store: Store; sched: Scheduler } {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false, ...over });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  return { store, sched };
}

/** Makes `store.record` throw on matching events, counting the throws. `after` writes the row first, as an emit that throws does. */
function failRecord(t: TestContext, store: Store, when: (e: Parameters<Store['record']>[0]) => boolean, writeFirst = false): { thrown: number } {
  const fault = { thrown: 0 };
  const original = store.record.bind(store);
  t.mock.method(store, 'record', ((e: Parameters<Store['record']>[0]) => {
    if (!when(e)) return original(e);
    fault.thrown++;
    if (writeFirst) original(e);
    throw new Error('SQLITE_BUSY');
  }) as Store['record']);
  return fault;
}

function fakeClaude(t: TestContext, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crash-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\necho "${body}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function useEnv(t: TestContext, vars: Record<string, string>): void {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  setCloudDown(null);
  reloadSpecs();
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setCloudDown(null);
    reloadSpecs();
  });
}

function crashEvents(store: Store, taskId: string): string[] {
  return store
    .eventsSince(0, 5000)
    .filter((e) => e.taskId === taskId && e.type === 'error' && e.message.startsWith('run crashed'))
    .map((e) => e.message);
}

test('safeRecord returns the event store.record wrote, and null with one stderr line when record throws', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.addTask({ title: 'x', prompt: 'x', runner: 'echo' });
  const ev = safeRecord(store, { taskId: task.id, type: 'error', message: 'hello' });
  assert.ok(ev);
  assert.deepEqual(store.eventsSince(ev.id - 1).find((e) => e.id === ev.id), ev);

  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  t.mock.method(store, 'record', () => {
    throw new Error('disk full');
  });
  const long = `first line\nsecond line ${'m'.repeat(5000)}`;
  assert.equal(safeRecord(store, { taskId: task.id, type: 'error', message: long }), null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.indexOf('\n'), lines[0]!.length - 1, 'one line: the only newline is the last character');
  assert.match(lines[0]!, /first line second line/);
  assert.match(lines[0]!, /error/);
  assert.ok(lines[0]!.includes(task.id));
  assert.match(lines[0]!, /disk full/);
  assert.ok(lines[0]!.length < 600, 'the message is cut');
});

test('a run whose failure handling rejects is settled by noteRunCrash: run ended, task requeued, nothing escapes', async (t) => {
  const { store, sched } = rig(t);
  // Refused in preflight on a hosted-model runner; maxAttempts 2 so the crash handler chooses queued.
  const task = store.addTask({ title: 'refused', prompt: 'x', runner: 'claude-code', sensitivity: 'S2', maxAttempts: 2 });
  let setStatusThrows = 0;
  let endRunThrows = 0;
  const realSet = store.setStatus.bind(store);
  const realEnd = store.endRun.bind(store);
  t.mock.method(store, 'setStatus', ((id: string, ...rest: [Parameters<Store['setStatus']>[1], Parameters<Store['setStatus']>[2]?]) => {
    if (id === task.id && rest[0] === 'failed' && setStatusThrows === 0) {
      setStatusThrows++;
      throw new Error('SQLITE_BUSY');
    }
    return realSet(id, ...rest);
  }) as Store['setStatus']);
  t.mock.method(store, 'endRun', ((runId: string, ...rest: [Parameters<Store['endRun']>[1], Parameters<Store['endRun']>[2]?]) => {
    if (store.getRun(runId)?.taskId === task.id && endRunThrows === 0) {
      endRunThrows++;
      throw new Error('SQLITE_BUSY');
    }
    return realEnd(runId, ...rest);
  }) as Store['endRun']);
  takeEscaped();
  await pump(t, sched, () => setStatusThrows > 0);
  await landed(); // no further tick: a queued task would be launched again
  assert.deepEqual(takeEscaped(), [], 'nothing escaped');
  assert.equal(endRunThrows, 1);
  const run = store.latestRun(task.id)!;
  assert.equal(run.status, 'failed', 'noteRunCrash ended the run');
  assert.equal(store.getTask(task.id)!.status, 'queued', 'attempts remain, so the task is queued');
});

test('a run whose failure handling rejects with no attempts left is failed by noteRunCrash', async (t) => {
  const { store, sched } = rig(t);
  const task = store.addTask({ title: 'refused', prompt: 'x', runner: 'claude-code', sensitivity: 'S2', maxAttempts: 1 });
  let thrown = 0;
  const realSet = store.setStatus.bind(store);
  t.mock.method(store, 'setStatus', ((id: string, ...rest: [Parameters<Store['setStatus']>[1], Parameters<Store['setStatus']>[2]?]) => {
    if (id === task.id && rest[0] === 'failed' && thrown === 0) {
      thrown++;
      throw new Error('SQLITE_BUSY');
    }
    return realSet(id, ...rest);
  }) as Store['setStatus']);
  takeEscaped();
  await pump(t, sched, () => thrown > 0);
  await landed();
  await sched.drain(10_000);
  assert.deepEqual(takeEscaped(), []);
  assert.equal(store.getTask(task.id)!.status, 'failed');
  assert.equal(store.latestRun(task.id)!.status, 'failed');
});

test('noteRunCrash never overwrites a status execute() already set', async (t) => {
  const { store, sched } = rig(t);
  // A fatal refusal: execute() sets failed. The status event is then refused after the row changed, so execute()
  // rejects with the task already failed; a crash handler that overwrote it would requeue it (one attempt of two used).
  const task = store.addTask({ title: 'refused', prompt: 'x', runner: 'claude-code', sensitivity: 'S2', maxAttempts: 2 });
  const fault = failRecord(t, store, (e) => e.taskId === task.id && e.type === 'status' && e.message.startsWith('failed'), true);
  takeEscaped();
  await pump(t, sched, () => fault.thrown > 0);
  await landed();
  await sched.drain(10_000);
  assert.deepEqual(takeEscaped(), []);
  assert.equal(store.getTask(task.id)!.status, 'failed');
});

test('a provider-limited failure still holds claude-code work and requeues when the error record and endRun both throw', async (t) => {
  useEnv(t, { FOREMAN_CLAUDE_BIN: fakeClaude(t, "You've hit your session limit · resets 4:30pm (Europe/London)"), FOREMAN_LOCAL_ONLY: 'off', FOREMAN_LIMIT_BACKOFF_MS: '60000' });
  const { store, sched } = rig(t);
  const task = store.addTask({ title: 'limited', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
  const fault = failRecord(t, store, (e) => e.taskId === task.id && e.type === 'error' && !e.message.startsWith('run crashed'));
  const realEnd = store.endRun.bind(store);
  let endThrown = 0;
  t.mock.method(store, 'endRun', ((runId: string, ...rest: [Parameters<Store['endRun']>[1], Parameters<Store['endRun']>[2]?]) => {
    if (store.getRun(runId)?.taskId === task.id) {
      endThrown++;
      throw new Error('SQLITE_BUSY');
    }
    return realEnd(runId, ...rest);
  }) as Store['endRun']);
  const requeue = t.mock.method(store, 'requeueAfterLimit');
  takeEscaped();
  const before = Date.now();
  await pump(t, sched, () => requeue.mock.callCount() > 0);
  await landed();
  assert.deepEqual(takeEscaped(), []);
  assert.ok(fault.thrown > 0 && endThrown > 0, 'both faults fired');
  assert.equal(requeue.mock.callCount(), 1);
  assert.ok(sched.limitHoldUntil >= before + 60_000, 'the hold is set');
  assert.equal(store.getTask(task.id)!.status, 'queued');
});

test('pruneEvents throwing leaves the run outcome unchanged and nothing escapes', async (t) => {
  const { store, sched } = rig(t);
  let thrown = 0;
  t.mock.method(sched as unknown as { pruneEvents(id: string): void }, 'pruneEvents', () => {
    thrown++;
    throw new Error('SQLITE_BUSY');
  });
  takeEscaped();
  const task = store.addTask({ title: 'fine', prompt: 'say hello', runner: 'echo', maxAttempts: 1 });
  await pump(t, sched, () => thrown > 0);
  await landed();
  await sched.drain(10_000);
  assert.deepEqual(takeEscaped(), []);
  assert.equal(store.latestRun(task.id)!.status, 'succeeded');
  assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  assert.deepEqual(crashEvents(store, task.id), [], 'execute() did not reject into noteRunCrash');
});

test('closeSync throwing on the run log leaves the run outcome unchanged and nothing escapes', async (t) => {
  const { store, sched } = rig(t);
  let thrown = 0;
  let pruned = 0;
  const realPrune = (sched as unknown as { pruneEvents(id: string): void }).pruneEvents.bind(sched);
  t.mock.method(sched as unknown as { pruneEvents(id: string): void }, 'pruneEvents', (id: string) => {
    pruned++;
    realPrune(id);
  });
  const real = fs.closeSync.bind(fs);
  t.mock.method(fs, 'closeSync', (fd: number) => {
    real(fd);
    thrown++;
    throw new Error('EIO');
  });
  takeEscaped();
  const task = store.addTask({ title: 'fine', prompt: 'say hello', runner: 'echo', maxAttempts: 1 });
  await pump(t, sched, () => thrown > 0);
  await landed();
  await sched.drain(10_000);
  assert.deepEqual(takeEscaped(), []);
  assert.equal(store.latestRun(task.id)!.status, 'succeeded');
  assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  assert.deepEqual(crashEvents(store, task.id), [], 'execute() did not reject into noteRunCrash');
  assert.ok(pruned > 0, 'the rest of the finally still ran after the close failed');
});

test('a run clock that expires while getRun throws raises nothing and ends the run as a deadline', async (t) => {
  const time = new FakeTime();
  const { store, sched } = rig(t, {
    taskTimeoutMs: 60 * 60_000,
    runClock: (budgetMs, onExpire) => new RunClock(budgetMs, onExpire, time.now, time),
  });
  const real = echoRunner.run;
  t.after(() => {
    echoRunner.run = real;
  });
  let aborted: boolean | null = null;
  echoRunner.run = async (ctx) => {
    ctx.stage('work');
    const mock = t.mock.method(store, 'getRun', () => {
      throw new Error('SQLITE_BUSY');
    });
    time.advance(65 * 60_000);
    mock.mock.restore();
    aborted = ctx.signal.aborted;
    return { ok: false, summary: 'killed', exitCode: 143 };
  };
  takeEscaped();
  const task = store.addTask({ title: 'slow', prompt: 'x', runner: 'echo', maxAttempts: 1 });
  await sched.drain(10_000);
  await landed();
  assert.deepEqual(takeEscaped(), []);
  assert.equal(aborted, true, 'the deadline aborted the run');
  assert.equal(store.getTask(task.id)!.status, 'failed');
  assert.match(store.latestRun(task.id)!.summary ?? '', /run deadline \(60 min\) reached/);
});

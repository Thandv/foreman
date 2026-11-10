import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { personaAdapterDir, savePersona, seedPersonas } from '../src/align/personas.ts';
import { acquireLocalModelLock, releaseLocalModelLock } from '../src/align/localLock.ts';
import { registerExtension } from '../src/extensions.ts';
import { alignExtension } from '../src/align/extension.ts';

registerExtension(alignExtension);

function setEnv(t: TestContext, name: string, value: string): void {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

/** Resolves once `pred` holds, re-reading after each timer turn; fails the test past `limitMs`. */
async function until(pred: () => boolean, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!pred()) {
    assert.ok(Date.now() < deadline, 'condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('start() records the status of each adopted persona it could not start', async (t) => {
  const home = scratchDir('foreman-ext-persona-');
  setEnv(t, 'FOREMAN_ALIGN_DIR', path.join(home, 'align'));
  setEnv(t, 'FOREMAN_PERSONA_URL_PUBLISHING_AUTHOR', 'http://127.0.0.1:1/v1');
  const persona = { ...seedPersonas()[0]!, status: 'adopted' as const, alias: 'publishing-author' };
  savePersona(persona);
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false });
  t.after(async () => { await s.stop(); store.close(); });
  s.dispatchHold('test: nothing is dispatched');
  s.start();
  const isPersona = (m: string): boolean => m.startsWith(`persona ${persona.id}:`);
  await until(() => store.eventsSince(0).some((e) => isPersona(e.message)));
  const events = store.eventsSince(0).filter((e) => isPersona(e.message));
  assert.deepEqual(events.map((e) => [e.type, e.message]), [
    ['status', `persona ${persona.id}: not serving — no trained adapter at ${personaAdapterDir(persona.id)}`],
  ]);
});

test('a held local-model lock pauses dispatch and holds queued work with the same messages, then releases it', async (t) => {
  const dir = scratchDir('foreman-ext-lock-');
  setEnv(t, 'FOREMAN_LOCAL_LOCK', path.join(dir, 'local-model.lock'));
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false });
  t.after(async () => { releaseLocalModelLock(); await s.stop(); store.close(); });
  const task = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
  assert.equal(acquireLocalModelLock('training extensions.test'), null);
  await s.tick();
  await s.tick();
  assert.equal(store.getTask(task.id)!.status, 'queued');
  const statuses = (): string[] => store.eventsSince(0).filter((e) => e.type === 'status' && /dispatch/.test(e.message)).map((e) => e.message);
  assert.deepEqual(statuses(), [
    `dispatch paused: training extensions.test (pid ${process.pid}) holds the local-model lock. Running work continues.`,
  ]);
  assert.equal(
    store.holdOf(task.id),
    `held: training extensions.test (pid ${process.pid}) holds the local-model lock; new work waits until it releases the lock`,
  );
  releaseLocalModelLock();
  await s.tick();
  assert.deepEqual(statuses().slice(1), ['local-model lock released; dispatch resumed']);
  assert.notEqual(store.getTask(task.id)!.status, 'queued');
});

test('an extension whose start fails is recorded as a warning, and the queue still dispatches', async (t) => {
  registerExtension({ name: 'broken', onStart: () => Promise.reject(new Error('cannot reach its server')) });
  assert.throws(() => registerExtension({ name: 'broken' }), /already registered/);
  const store = new Store(':memory:');
  const s = new Scheduler(store, { tickMs: 60_000, verifyEnabled: false });
  t.after(async () => { await s.stop(); store.close(); });
  const task = store.addTask({ title: 'a', prompt: 'x', runner: 'echo' });
  s.start();
  const warning = 'extension broken: start failed — cannot reach its server';
  await until(() => store.eventsSince(0).some((e) => e.type === 'warning' && e.message === warning));
  await until(() => store.getTask(task.id)!.status !== 'queued');
});

// allowCore is honoured only from a request that carries the host-admin secret (src/security/hostSecret.ts).
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Broker } from '../src/budget.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import type { Task } from '../src/types.ts';

interface Daemon {
  base: string;
  store: Store;
  post: (p: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
}

/** An in-process daemon that claims nothing, with a proposer that is down (improve falls back to a canned proposal). */
async function daemon(t: test.TestContext): Promise<Daemon> {
  const store = new Store(':memory:');
  const broker = new Broker(store, { guardResidency: false, chatFn: async () => { throw new Error('proposer down'); } });
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false, broker });
  sched.pauseDispatch();
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const post = (p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, store, post };
}

const DROPPED = 'allowCore dropped: request lacked the host-admin secret';
const warnings = (store: Store, taskId: string): string[] =>
  store.eventsForTask(taskId).filter((e) => e.type === 'warning').map((e) => e.message);

test('a plain POST /api/tasks with allowCore:true queues a non-core task and records why', async (t) => {
  const { store, post } = await daemon(t);
  const res = await post('/api/tasks', { title: 'core please', prompt: 'p', runner: 'echo', allowCore: true });
  assert.equal(res.status, 201);
  const task = (await res.json()) as Task;
  assert.equal(task.allowCore, false);
  assert.equal(store.getTask(task.id)!.allowCore, false);
  assert.deepEqual(warnings(store, task.id), [DROPPED]);
});

test('a plain POST /api/improve with allowCore:true queues a non-core task and records why', async (t) => {
  const { store, post } = await daemon(t);
  const res = await post('/api/improve', { confirm: true, allowCore: true, runner: 'echo' });
  assert.equal(res.status, 201);
  const { queued } = (await res.json()) as { queued: Task };
  assert.equal(queued.allowCore, false);
  assert.deepEqual(warnings(store, queued.id), [DROPPED]);
});

test('pin: a task that does not ask for allowCore is queued as before, with no warning', async (t) => {
  const { store, post } = await daemon(t);
  const task = (await (await post('/api/tasks', { title: 'plain', prompt: 'p', runner: 'echo' })).json()) as Task;
  assert.equal(task.allowCore, false);
  assert.deepEqual(warnings(store, task.id), []);
});

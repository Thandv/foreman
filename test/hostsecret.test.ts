// allowCore is honoured only from a request that carries the host-admin secret (src/security/hostSecret.ts).
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Broker } from '../src/budget.ts';
import { config } from '../src/config.ts';
import { claudeWorkerEnv } from '../src/runners/claudeIsolation.ts';
import { workerEnv } from '../src/runners/cliRunners.ts';
import { ensureHostSecret, hostSecretMatches, HOST_SECRET_HEADER, readHostSecret } from '../src/security/hostSecret.ts';
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

test('with the host-admin secret, both routes queue allowCore and record no warning', async (t) => {
  const { store, post } = await daemon(t);
  const headers = { [HOST_SECRET_HEADER]: ensureHostSecret(config.home) };
  const task = (await (await post('/api/tasks', { title: 'core', prompt: 'p', runner: 'echo', allowCore: true }, headers)).json()) as Task;
  assert.equal(task.allowCore, true);
  assert.deepEqual(warnings(store, task.id), []);
  const { queued } = (await (await post('/api/improve', { confirm: true, allowCore: true, runner: 'echo' }, headers)).json()) as { queued: Task };
  assert.equal(queued.allowCore, true);
  assert.deepEqual(warnings(store, queued.id), []);
});

test('a wrong secret is the same as none: allowCore is dropped and the warning recorded', async (t) => {
  const { store, post } = await daemon(t);
  const secret = ensureHostSecret(config.home);
  const wrong = secret.replace(/^./, secret[0] === 'a' ? 'b' : 'a');
  for (const presented of [wrong, `${secret}0`, '']) {
    const task = (await (await post('/api/tasks', { title: 'core', prompt: 'p', runner: 'echo', allowCore: true }, { [HOST_SECRET_HEADER]: presented })).json()) as Task;
    assert.equal(task.allowCore, false, `presented ${presented.length} chars`);
    assert.deepEqual(warnings(store, task.id), [DROPPED]);
  }
});

test('the secret is created once, private, and a file that is not a secret is an error', () => {
  const home = scratchDir('foreman-hostsecret-');
  assert.equal(readHostSecret(home), null);
  assert.equal(hostSecretMatches(home, 'a'.repeat(64)), false, 'no secret on disk matches nothing');
  const secret = ensureHostSecret(home);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(ensureHostSecret(home), secret, 'created once');
  const file = path.join(home, 'secrets', 'host-admin');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['host-admin'], 'no temp file left behind');
  assert.equal(hostSecretMatches(home, secret), true);
  assert.equal(hostSecretMatches(home, undefined), false);
  assert.equal(hostSecretMatches(home, [secret]), false);
  fs.writeFileSync(file, 'not a secret');
  assert.throws(() => readHostSecret(home), /does not hold a host-admin secret/);
});

test('the secret is in no worker environment', () => {
  const secret = ensureHostSecret(config.home);
  for (const env of [workerEnv({ testCmd: 'npm test' }, 'r_secret'), claudeWorkerEnv({ id: 't_secret' })]) {
    assert.ok(!Object.values(env).some((v) => v?.includes(secret)), 'no variable carries the secret');
  }
});

/** Runs the CLI against the in-process daemon; it shares this process's FOREMAN_HOME, so it finds the same secret. */
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

test('foreman add --allow-core and foreman improve --allow-core --yes still queue allowCore', async (t) => {
  const { base, store } = await daemon(t);
  const added = await cli(base, ['add', 'core edit', '--prompt', 'p', '--runner', 'echo', '--allow-core']);
  assert.equal(added.code, 0, added.out);
  const improved = await cli(base, ['improve', '--allow-core', '--yes', '--runner', 'echo']);
  assert.equal(improved.code, 0, improved.out);
  const tasks = store.listTasks();
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.allowCore), 'both queued with allowCore');
  const secret = ensureHostSecret(config.home);
  assert.ok(tasks.every((task) => warnings(store, task.id).length === 0));
  assert.doesNotMatch(JSON.stringify(store.eventsSince(0)), new RegExp(secret), 'the secret is in no event');
  assert.doesNotMatch(added.out + improved.out, new RegExp(secret), 'nor in what the CLI prints');
});

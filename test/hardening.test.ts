import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { acquireDaemonLock, DaemonLockError } from '../src/lock.ts';
import { SseClient } from '../src/server.ts';
import { Tracer } from '../src/trace.ts';

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  return cond();
}

// ---------------------------------------------------------- orphaned children

test('startup recovery kills the recorded process group of an interrupted run', async () => {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  const pid = child.pid!;
  child.unref();
  assert.ok(groupAlive(pid), 'fixture child must start in its own live pgid');

  const store = new Store(':memory:');
  const t = store.addTask({ title: 'orphaned', prompt: 'x', runner: 'shell' });
  store.claim(t.id);
  const run = store.startRun(t.id);
  store.setRunPid(run.id, pid);

  // Simulate the daemon dying here and a fresh one recovering on startup.
  store.recoverOrphans();
  assert.ok(await until(() => !groupAlive(pid)), 'the orphaned process group must be dead');
  assert.equal(store.latestRun(t.id)!.status, 'canceled');
  assert.equal(store.getTask(t.id)!.status, 'queued', 'the interrupted task is requeued');
  store.close();
});

test('a live run records its child pid on the run row and clears it on exit', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const t = store.addTask({ title: 'napper', prompt: 'sleep 0.3', runner: 'shell' });
  await sched.tick();
  let seen: number | null = null;
  await until(() => {
    seen = store.latestRun(t.id)?.pid ?? null;
    return seen !== null;
  });
  assert.ok(seen !== null && seen > 0, 'pid recorded while the child runs');
  await sched.drain(20_000);
  assert.equal(store.latestRun(t.id)!.pid, null, 'pid cleared once the child exits');
  store.close();
});

// ------------------------------------------------------------ pidfile locking

test('the pidfile lock refuses a second daemon while the holder is alive', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-lock-'));
  const release = acquireDaemonLock(home); // holder = this (live) process
  assert.equal(fs.readFileSync(path.join(home, 'daemon.pid'), 'utf8').trim(), String(process.pid));
  assert.throws(() => acquireDaemonLock(home, process.pid + 1), DaemonLockError);
  assert.throws(() => acquireDaemonLock(home, process.pid + 1), /already owns/);
  release();
  assert.equal(fs.existsSync(path.join(home, 'daemon.pid')), false, 'release removes the lock');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a stale lock from a dead pid is reclaimed, and garbage is treated as stale', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-lock-'));
  const file = path.join(home, 'daemon.pid');

  const dead = spawn('sleep', ['0']);
  await new Promise((r) => dead.once('exit', r));
  fs.writeFileSync(file, `${dead.pid}\n`);
  const release = acquireDaemonLock(home);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid), 'stale lock reclaimed');
  release();

  // A stale lock naming the pid this daemon now has (pid reuse after a reboot) is ours to reclaim, not a rival's.
  fs.writeFileSync(file, `${process.pid}\n`);
  const reused = acquireDaemonLock(home);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
  reused();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, 'not-a-pid\n');
  const release2 = acquireDaemonLock(home);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid), 'garbage lock reclaimed');
  release2();
  fs.rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------- SSE backpressure

interface FakeRes {
  writableEnded: boolean;
  write(chunk: string): boolean;
  destroy(): void;
}

test('a saturated SSE client is dropped once the pending cap is crossed', () => {
  let destroyed = false;
  const fake: FakeRes = { writableEnded: false, write: () => false, destroy: () => { destroyed = true; } };
  const client = new SseClient(fake as never, 5);
  for (let i = 0; i < 4; i++) assert.equal(client.write('ev\n\n'), true, 'buffered writes are tolerated');
  assert.equal(destroyed, false);
  assert.equal(client.write('ev\n\n'), false, 'the write that crosses the cap reports the drop');
  assert.equal(destroyed, true, 'the connection is destroyed');
  assert.equal(client.isDropped, true);
  assert.equal(client.write('ev\n\n'), false, 'a dropped client accepts nothing further');
});

test('a drain (or any successful write) resets the SSE pending counter', () => {
  let destroyed = false;
  let accepting = false;
  const fake: FakeRes = { writableEnded: false, write: () => accepting, destroy: () => { destroyed = true; } };
  const client = new SseClient(fake as never, 3);
  client.write('a');
  client.write('b');
  client.drained();
  client.write('c');
  client.write('d');
  assert.equal(destroyed, false, 'drain must reset the buffered count');
  accepting = true;
  client.write('e'); // successful write also resets
  accepting = false;
  client.write('f');
  client.write('g');
  assert.equal(destroyed, false);
  client.write('h');
  assert.equal(destroyed, true, 'three consecutive buffered writes cross the cap of 3');
});

// ----------------------------------------------------------------- trace sink

test('FOREMAN_TRACE_SINK delivers events to a local collector', async () => {
  const received: Array<{ body: Record<string, unknown>; auth: string | undefined }> = [];
  const collector = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        auth: req.headers.authorization,
      });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  const { port } = collector.address() as AddressInfo;
  process.env['FOREMAN_TRACE_SINK'] = `http://127.0.0.1:${port}/collect`;
  process.env['FOREMAN_TRACE_KEY'] = 'sekrit';

  const store = new Store(':memory:');
  const tracer = new Tracer(store);
  tracer.start();
  const t = store.addTask({ title: 'traced task', prompt: 'x', runner: 'echo' });

  assert.ok(await until(() => received.length >= 1), 'the collector must receive the event');
  const hit = received[0]!;
  assert.equal(hit.body['source'], 'foreman');
  assert.equal(hit.body['type'], 'status');
  assert.equal(hit.body['taskId'], t.id);
  assert.match(String(hit.body['message']), /traced task/);
  assert.equal(hit.auth, 'Bearer sekrit');
  // The local JSONL file is written regardless of the sink (lines are batched; flush first).
  tracer.flush();
  assert.match(fs.readFileSync(tracer.path, 'utf8'), new RegExp(t.id));

  tracer.stop();
  store.close();
  await new Promise<void>((r) => collector.close(() => r()));
  delete process.env['FOREMAN_TRACE_SINK'];
  delete process.env['FOREMAN_TRACE_KEY'];
});

test('a dead trace sink never crashes or blocks the daemon', async () => {
  process.env['FOREMAN_TRACE_SINK'] = 'http://127.0.0.1:1/collect'; // nothing listens here
  const store = new Store(':memory:');
  const tracer = new Tracer(store);
  tracer.start();
  const before = Date.now();
  for (let i = 0; i < 20; i++) store.record({ type: 'log', message: `noise ${i}` });
  assert.ok(Date.now() - before < 1000, 'recording must not block on the sink');
  await new Promise((r) => setTimeout(r, 200)); // let the fire-and-forget fetches settle
  const after = store.record({ type: 'log', message: 'still alive' });
  assert.ok(after.id > 0, 'the store keeps working after 20 failed deliveries');
  tracer.stop();
  store.close();
  delete process.env['FOREMAN_TRACE_SINK'];
});

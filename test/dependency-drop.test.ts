import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

process.env['FOREMAN_PREWARM'] = 'off';
const SRC = path.join(import.meta.dirname, '..', 'src');
const CLI = path.join(SRC, 'cli.ts');
void scratchDir;

function snapshot(store: Store): string {
  return ['tasks', 'decisions', 'events', 'runs', 'artifacts', 'task_deps']
    .map((tb) => JSON.stringify(store.db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()))
    .join('\n');
}

/** `a` fails; `b` waits on it and on `c`; reconcile fails b by cascade. */
function chain(store: Store): { a: string; b: string; c: string } {
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const c = store.addTask({ title: 'c', prompt: 'p' });
  const b = store.addTask({ title: 'b', prompt: 'p', deps: [a.id, c.id] });
  store.setStatus(a.id, 'failed', 'boom');
  store.reconcileBlocked();
  return { a: a.id, b: b.id, c: c.id };
}

const drops = (store: Store, id: string) => store.decisionsForTask(id).filter((d) => d.action === 'deps-drop');

test('a dependent failed by "dependency X ended as failed" is blocked, then queued, after dropping X, with one deps-drop row', () => {
  const store = new Store(':memory:');
  const { a, b, c } = chain(store);
  assert.equal(store.getTask(b)!.status, 'failed');
  assert.equal(store.getTask(b)!.error, `dependency ${a} ended as failed`);
  store.setStatus(c, 'done');

  const after = store.dropDependency(b, a, 'human');
  assert.equal(after.status, 'blocked');
  assert.deepEqual(store.getTask(b)!.deps, [c]);
  store.reconcileBlocked();
  assert.equal(store.getTask(b)!.status, 'queued');

  const rows = drops(store, b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, 'human');
  assert.ok(rows[0]!.note!.includes(a), 'the note names the dependency');
  store.close();
});

test('dropping a dependency of a running ticket is refused and the rows stay byte-equal', () => {
  const store = new Store(':memory:');
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const b = store.addTask({ title: 'b', prompt: 'p', deps: [a.id] });
  store.setStatus(b.id, 'running');
  const before = snapshot(store);
  assert.throws(() => store.dropDependency(b.id, a.id, 'human'), /running/);
  assert.equal(snapshot(store), before);
  store.close();
});

test('dropping a dependency of a terminal ticket this edge did not fail is refused and changes nothing', () => {
  const store = new Store(':memory:');
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const x = store.addTask({ title: 'x', prompt: 'p' });
  const other = store.addTask({ title: 'o', prompt: 'p', deps: [a.id, x.id] });
  const done = store.addTask({ title: 'd', prompt: 'p', deps: [a.id] });
  const failedOwn = store.addTask({ title: 'f', prompt: 'p', deps: [a.id] });
  store.setStatus(done.id, 'done');
  store.setStatus(failedOwn.id, 'failed', 'it broke by itself');
  // failed by cascade from x, not from a
  store.setStatus(other.id, 'failed', `dependency ${x.id} ended as failed`);
  const before = snapshot(store);
  assert.throws(() => store.dropDependency(done.id, a.id, 'human'), /done/);
  assert.throws(() => store.dropDependency(failedOwn.id, a.id, 'human'), /not because of this dependency/);
  assert.throws(() => store.dropDependency(other.id, a.id, 'human'), /not because of this dependency/);
  assert.equal(snapshot(store), before);
  store.close();
});

test('dropping an edge that does not exist is refused and changes nothing', () => {
  const store = new Store(':memory:');
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const b = store.addTask({ title: 'b', prompt: 'p' });
  const before = snapshot(store);
  assert.throws(() => store.dropDependency(b.id, a.id, 'human'), /does not depend on/);
  assert.throws(() => store.dropDependency('t_nope', a.id, 'human'), /task not found/);
  assert.equal(snapshot(store), before);
  store.close();
});

test('only task creation inserts into task_deps anywhere in src/', () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|sql)$/.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/(insert|replace)\s+(or\s+\w+\s+)?into\s+task_deps/gi)) {
          // The method the statement sits in: the nearest 2-space-indented declaration above it.
          const above = text.slice(0, m.index).split('\n');
          const decl = [...above].reverse().find((l) => /^ {2}(async\s+|private\s+)?[A-Za-z_]\w*\(/.test(l)) ?? '';
          hits.push(`${path.relative(SRC, p)} :: ${decl.trim().split('(')[0]}`);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(hits, ['queue.ts :: addTask']);
});

test('there is no --add flag on foreman deps', async () => {
  const run = (argv: string[]): Promise<{ stderr: string; code: number | null }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_PORT: '1', FOREMAN_HOST: '127.0.0.1' } });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ stderr, code }));
  });
  const r = await run(['deps', 't_aaaa', '--add', 't_bbbb']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no --add/);
  assert.ok(!/--add\b/.test(fs.readFileSync(CLI, 'utf8').split('\n').filter((l) => /flags\[['"]add['"]\]/.test(l) && !/throw/.test(l)).join('\n')));
});

function post(port: number, urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('the deps-drop route refuses a foreign Origin and a rebinding Host, and accepts a same-origin drop', async (t) => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const { a, b } = chain(store);
  const before = snapshot(store);
  const url = `/api/tasks/${b}/deps-drop`;

  const foreign = await post(port, url, { dep: a }, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error, /cross-origin/);
  const rebound = await post(port, url, { dep: a }, { host: 'evil.example', origin: 'http://evil.example' });
  assert.equal(rebound.status, 403);
  assert.match(rebound.json.error, /Host/);
  assert.equal(snapshot(store), before);

  const bad = await post(port, url, { dep: '../x' });
  assert.equal(bad.status, 400);
  const ok = await post(port, url, { dep: a });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.decision.action, 'deps-drop');
  const again = await post(port, url, { dep: a });
  assert.equal(again.status, 409);
});

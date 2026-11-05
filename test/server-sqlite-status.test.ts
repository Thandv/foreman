import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

process.env['FOREMAN_PREWARM'] = 'off';

function sqliteError(fn: () => void): { code?: unknown; errcode?: unknown } {
  try {
    fn();
  } catch (e) {
    return e as { code?: unknown; errcode?: unknown };
  }
  return assert.fail('expected a sqlite error');
}

async function post(store: Store, body: unknown): Promise<{ status: number; body: { error: string } }> {
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error: string } };
  } finally {
    server.close();
  }
}

test('a real BUSY error from node:sqlite carries code ERR_SQLITE_ERROR and errcode 5', () => {
  const file = path.join(scratchDir('ft-busy-'), 'a.db');
  const holder = new DatabaseSync(file);
  holder.exec('CREATE TABLE t (x)');
  holder.exec('BEGIN IMMEDIATE');
  const other = new DatabaseSync(file);
  other.exec('PRAGMA busy_timeout = 0');
  const err = sqliteError(() => other.exec('BEGIN IMMEDIATE'));
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(err.errcode, 5);
  holder.exec('ROLLBACK');
});

test('POST /api/tasks that hits a real BUSY answers 503 ledger busy, retry', async () => {
  const file = path.join(scratchDir('ft-busy-route-'), 'ledger.db');
  const store = new Store(file);
  store.db.exec('PRAGMA busy_timeout = 0');
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const r = await post(store, { title: 'x', prompt: 'p' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /^ledger busy: .+; retry$/);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('POST /api/tasks that hits a real FULL answers 507 ledger disk full', async () => {
  // A real FULL from a scratch DB with a low page cap. Store.addTask's own
  // ROLLBACK would mask it (SQLite has already rolled back), so the route's
  // store is made to throw the captured real error.
  const scratch = new DatabaseSync(path.join(scratchDir('ft-full-'), 'full.db'));
  scratch.exec('CREATE TABLE t (x)');
  scratch.exec('PRAGMA max_page_count = 3');
  const err = sqliteError(() => {
    for (let i = 0; i < 100; i++) scratch.prepare('INSERT INTO t VALUES (zeroblob(5000))').run();
  });
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(err.errcode, 13);
  const store = new Store(':memory:');
  store.addTask = () => {
    throw err;
  };
  const r = await post(store, { title: 'y', prompt: 'p' });
  assert.equal(r.status, 507);
  assert.match(r.body.error, /^ledger disk full: /);
});

test('POST /api/tasks with an empty title is still a 400 with its own message', async () => {
  const store = new Store(':memory:');
  const r = await post(store, { title: '', prompt: 'p' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.length > 0);
  assert.doesNotMatch(r.body.error, /ledger/);
});

import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

process.env['FOREMAN_PREWARM'] = 'off';

const DAY = 86_400_000;

function scratchStore(): Store {
  return new Store(path.join(scratchDir('ft-addatomic-'), 'ledger.db'));
}

/** Freeze the file at its current size, so the next write that needs a page hits a real SQLITE_FULL. */
function fillUp(s: Store): void {
  const pages = Number((s.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
  s.db.exec(`PRAGMA max_page_count = ${pages}`);
}

function caught(fn: () => unknown): { code?: unknown; errcode?: unknown; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code?: unknown; errcode?: unknown; message: string };
  }
  return assert.fail('expected a throw');
}

test('a real SQLITE_FULL at the task insert comes out of addTask as the original FULL error', () => {
  const s = scratchStore();
  fillUp(s);
  const err = caught(() => s.addTask({ title: 'big', prompt: 'x'.repeat(2_000_000) }));
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(err.errcode, 13, err.message);
  assert.doesNotMatch(err.message, /no transaction is active/);
  assert.equal(s.db.isTransaction, false, 'no transaction left open');
  s.close();
});

test('a real SQLITE_FULL inside archiveClosed comes out as the original FULL error', () => {
  const s = scratchStore();
  const t = s.addTask({ title: 'h'.repeat(300_000), prompt: 'x' });
  s.setStatus(t.id, 'done');
  s.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 30 * DAY, t.id);
  fillUp(s);
  const err = caught(() => s.archiveClosed(7));
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(err.errcode, 13, err.message);
  assert.doesNotMatch(err.message, /no transaction is active/);
  assert.equal(s.db.isTransaction, false);
  s.close();
});

test('a BUSY at the status-event write leaves nothing half-applied, and a retry creates exactly one task', () => {
  const s = scratchStore();
  const realPrepare = s.db.prepare.bind(s.db);
  let armed = true;
  (s.db as { prepare: unknown }).prepare = (sql: string) => {
    if (armed && /INSERT INTO events/.test(sql)) {
      armed = false;
      const e = new Error('database is locked') as Error & { code: string; errcode: number };
      e.code = 'ERR_SQLITE_ERROR';
      e.errcode = 5;
      throw e;
    }
    return realPrepare(sql);
  };
  const count = (table: string): number => Number((s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  const err = caught(() => s.addTask({ title: 'once', prompt: 'x' }));
  assert.equal(err.errcode, 5);
  assert.equal(count('tasks'), 0, 'no task row');
  assert.equal(count('events'), 0, 'no event row');
  assert.equal(s.db.isTransaction, false);

  const t = s.addTask({ title: 'once', prompt: 'x' });
  assert.equal(count('tasks'), 1);
  assert.equal(count('events'), 1);
  assert.equal(s.eventsForTask(t.id).length, 1);
  s.close();
});

test('the status event is emitted once, after the commit', () => {
  const s = scratchStore();
  const seen: boolean[] = [];
  s.on('event', () => seen.push(s.db.isTransaction));
  s.addTask({ title: 'emit', prompt: 'x' });
  assert.deepEqual(seen, [false]);
  s.close();
});

test('POST /api/tasks on a really full ledger answers 507, not 400', async () => {
  const s = scratchStore();
  fillUp(s);
  const server = createServer(s, new Scheduler(s, { maxWorkers: 1, tickMs: 5, verifyEnabled: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'big', prompt: 'x'.repeat(200_000) }),
    });
    const body = (await res.json()) as { error: string };
    assert.deepEqual([res.status, body.error], [507, 'ledger disk full: database or disk is full']);
  } finally {
    server.close();
    s.close();
  }
});

test('an error from the ROLLBACK itself never replaces the original error, and nothing is half-written', () => {
  const s = scratchStore();
  // RAISE(ABORT) undoes the statement only, so the transaction is still open and the guard must roll it back.
  s.db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'the original error'); END`);
  const exec = s.db.exec.bind(s.db);
  (s.db as { exec: unknown }).exec = (sql: string) => {
    exec(sql);
    if (sql === 'ROLLBACK') throw new Error('the rollback failed too');
  };
  assert.equal(caught(() => s.addTask({ title: 'x', prompt: 'p' })).message, 'the original error');
  assert.equal(s.db.isTransaction, false);
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n), 0);
  s.close();
});

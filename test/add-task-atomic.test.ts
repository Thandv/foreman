import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/queue.ts';

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

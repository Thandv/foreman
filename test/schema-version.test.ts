import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeAfterStops } from './helpers/removal.ts';
import { Store } from '../src/queue.ts';
import { backupNow, restoreFrom } from '../src/backup.ts';

const NOW = new Date(2026, 9, 11, 12, 0, 0);

/** A scratch folder removed when the test ends, pass or fail. */
function scratch(t: TestContext): string {
  return removeAfterStops(t, scratchDir('foreman-schema-version-'));
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}

/** A real ledger whose header claims schema version `v`. */
function ledgerAt(dbPath: string, v: number): void {
  new Store(dbPath).close();
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${v}`);
  db.close();
}

test('pin: a ledger stamped with a newer schema version is opened and migrated by Store today', (t) => {
  const dbPath = path.join(scratch(t), 'foreman.db');
  ledgerAt(dbPath, 99);
  const store = new Store(dbPath);
  store.addTask({ title: 'written by an older binary', prompt: 'x' });
  store.close();
  assert.equal(userVersion(dbPath), 99);
});

test('pin: restore of an archive stamped with a newer schema version succeeds today', async (t) => {
  const home = scratch(t);
  const src = path.join(home, 'src', 'foreman.db');
  ledgerAt(src, 99);
  const made = await backupNow({ dbPath: src, dir: path.join(home, 'backups'), now: NOW });
  const dbPath = path.join(home, 'foreman.db');
  await restoreFrom({ file: made.file, dbPath, home });
  assert.equal(userVersion(dbPath), 99);
});

import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { removeAfterStops } from './helpers/removal.ts';
import { Store } from '../src/queue.ts';
import { backupNow, restoreFrom } from '../src/backup.ts';
import { COLUMNS, MIGRATED_INDEXES, SCHEMA, SCHEMA_VERSION } from '../src/db.ts';

const NOW = new Date(2026, 9, 11, 12, 0, 0);

/**
 * One row per schema version: the sha256 of the schema that version stamps.
 * A change to SCHEMA, COLUMNS or MIGRATED_INDEXES fails here until
 * SCHEMA_VERSION is bumped and its row added; rows are never edited.
 */
const FINGERPRINTS: Record<number, string> = {
  1: '846ef77b5af7182a0d1a35aa9a569615f6d574bb67cc6652e8f1110898a17600',
  2: '0dc3ebfa071ec30c65004aabc02dfd510cce85ebe2df68baf567c23d01876465',
};

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

/** Every file in `dir` with its bytes, so "nothing changed on disk" is one comparison. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = fs.readFileSync(p).toString('base64');
  }
  return out;
}

test('the schema fingerprint matches the row for SCHEMA_VERSION, the newest row', () => {
  const sha = createHash('sha256').update(SCHEMA + JSON.stringify(COLUMNS) + MIGRATED_INDEXES).digest('hex');
  assert.equal(Math.max(...Object.keys(FINGERPRINTS).map(Number)), SCHEMA_VERSION, 'SCHEMA_VERSION has no fingerprint row');
  assert.equal(sha, FINGERPRINTS[SCHEMA_VERSION], 'the schema changed: bump SCHEMA_VERSION and add its row');
});

test('a new ledger carries SCHEMA_VERSION; serve opens an older one as before and stamps it', (t) => {
  const home = scratch(t);
  const fresh = path.join(home, 'fresh.db');
  new Store(fresh).close();
  assert.equal(userVersion(fresh), SCHEMA_VERSION);

  const older = path.join(home, 'older.db');
  ledgerAt(older, 0);
  const store = new Store(older, { migrate: true });
  const task = store.addTask({ title: 'still opens', prompt: 'x' });
  assert.equal(store.getTask(task.id)!.title, 'still opens');
  store.close();
  assert.equal(userVersion(older), SCHEMA_VERSION);

  // Same version: opens, stamp unchanged.
  new Store(older).close();
  assert.equal(userVersion(older), SCHEMA_VERSION);
});

test('Store refuses a ledger stamped with a newer schema version and changes nothing on disk', (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  ledgerAt(dbPath, SCHEMA_VERSION + 1);
  const before = snapshot(home);
  assert.throws(
    () => new Store(dbPath),
    (err: Error) => err.name === 'NewerSchemaError' && err.message.includes(dbPath) &&
      err.message.includes(`schema version ${SCHEMA_VERSION + 1}`) && err.message.includes('upgrade Foreman'),
  );
  assert.deepEqual(snapshot(home), before);
});

test('restore refuses an archive stamped with a newer schema version and changes nothing on disk', async (t) => {
  const home = scratch(t);
  const src = path.join(home, 'src', 'foreman.db');
  ledgerAt(src, SCHEMA_VERSION + 1);
  const made = await backupNow({ dbPath: src, dir: path.join(home, 'backups'), now: NOW });
  const dbPath = path.join(home, 'foreman.db');
  const store = new Store(dbPath);
  store.addTask({ title: 'the current ledger', prompt: 'x' });
  store.close();
  const before = snapshot(home);

  await assert.rejects(
    restoreFrom({ file: made.file, dbPath, home }),
    (err: Error) => err.name === 'NewerSchemaError' && err.message.includes(made.file),
  );
  assert.deepEqual(snapshot(home), before);
});

/** A real ledger one schema version behind: stamped SCHEMA_VERSION - 1 and missing a column this binary adds. */
function olderLedger(dbPath: string): void {
  ledgerAt(dbPath, SCHEMA_VERSION - 1);
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE tasks DROP COLUMN repair_notes');
  db.close();
}

function hasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  } finally {
    db.close();
  }
}

test('only a migrating opener (serve) upgrades a ledger one schema version older; others refuse it unchanged', (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  olderLedger(dbPath);
  const before = snapshot(home);
  assert.throws(
    () => new Store(dbPath),
    (err: Error) => err.name === 'OlderSchemaError' && err.message.includes(dbPath) &&
      err.message.includes(`schema version ${SCHEMA_VERSION - 1}`) && err.message.includes('run foreman serve once'),
  );
  assert.deepEqual(snapshot(home), before);

  new Store(dbPath, { migrate: true }).close();
  assert.equal(userVersion(dbPath), SCHEMA_VERSION);
  assert.ok(hasColumn(dbPath, 'tasks', 'repair_notes'));
  new Store(dbPath).close();
});

test('foreman serve migrates a ledger one schema version older', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  olderLedger(dbPath);
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const env: NodeJS.ProcessEnv = {
    ...process.env, FOREMAN_HOME: path.join(home, 'home'), FOREMAN_DB: dbPath, FOREMAN_PORT: '0',
    FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on', FOREMAN_CLAUDE_BIN: path.join(home, 'no-claude'),
    FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
  };
  delete env['FOREMAN_RUN_ID'];
  const child = spawn(process.execPath, [cli, 'serve'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  // Read until "foreman up" (no sleeps); the process exiting first is a failure rather than a wait.
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (/^foreman up .*$/m.test(out)) resolve();
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error(`serve exited before "foreman up": ${out}`)));
  });
  child.kill('SIGKILL');
  await exited;
  assert.equal(userVersion(dbPath), SCHEMA_VERSION, out);
  assert.ok(hasColumn(dbPath, 'tasks', 'repair_notes'), out);
});

test('any opener creates a brand-new ledger, including an empty file already on disk', (t) => {
  const home = scratch(t);
  const empty = path.join(home, 'empty.db');
  fs.writeFileSync(empty, '');
  new Store(empty).close();
  assert.equal(userVersion(empty), SCHEMA_VERSION);
  assert.ok(hasColumn(empty, 'tasks', 'repair_notes'));
});

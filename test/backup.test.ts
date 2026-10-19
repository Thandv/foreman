import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import {
  backupIfDue, backupNow, backupSettings, isoWeek, restoreFrom, selectPrune,
} from '../src/backup.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const NOW = new Date(2026, 9, 11, 12, 0, 0); // Sunday 11 Oct 2026, the last day of ISO week 41
const TABLES = { memory: 5, receipts: 7, verdicts: 3 } as const;

/** A scratch folder removed when the test ends, pass or fail. */
function scratch(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A database with rows in three tables; `tag` makes two of them tell apart.
 * It also carries the (empty) tables restore requires of a ledger.
 */
function scratchDb(file: string, tag = 'a'): void {
  const db = new DatabaseSync(file);
  for (const table of ['tasks', 'runs', 'events']) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  for (const [table, rows] of Object.entries(TABLES)) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, body TEXT)`);
    const ins = db.prepare(`INSERT INTO ${table} (body) VALUES (?)`);
    for (let i = 0; i < rows; i++) ins.run(`${tag}-${table}-${i}-${'x'.repeat(200)}`);
  }
  db.close();
}

function counts(file: string): { rows: Record<string, number>; integrity: string; first: string } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows: Record<string, number> = {};
    for (const table of Object.keys(TABLES)) {
      rows[table] = Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    }
    const integrity = String(Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]);
    const first = String((db.prepare('SELECT body FROM memory ORDER BY id LIMIT 1').get() as { body: string }).body);
    return { rows, integrity, first };
  } finally {
    db.close();
  }
}

/** Run the CLI in its own home; SIGKILLed if it ever hangs. */
function cli(
  argv: string[], env: Record<string, string>, timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The pid of a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
    child.on('error', reject);
    child.on('close', () => resolve(child.pid!));
  });
}

test('backupNow: the archive gunzips to a database with the same rows that passes integrity_check', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);

  const r = await backupNow({ dbPath, dir, now: NOW });

  assert.equal(r.file, path.join(dir, 'foreman-2026-10-11.db.gz'));
  assert.equal(r.bytes, fs.statSync(r.file).size);
  assert.equal(r.copied, false);
  assert.deepEqual(r.pruned, []);
  // gunzipSync throws on anything that is not a gzip stream — a renamed .db included.
  const restored = path.join(root, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(r.file)));
  const got = counts(restored);
  assert.deepEqual(got.rows, { ...TABLES });
  assert.equal(got.integrity, 'ok');
  // Only the archive is left behind: no temp copy, and the source is untouched.
  assert.deepEqual(fs.readdirSync(dir), ['foreman-2026-10-11.db.gz']);
  assert.deepEqual(counts(dbPath).rows, { ...TABLES });
});

test('backupNow: a database a live Store holds open is copied whole, rows still in its WAL included', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const store = new Store(dbPath);
  t.after(() => store.close());
  const task = store.addTask({ title: 'kept', prompt: 'x' });
  store.record({ taskId: task.id, type: 'status', message: 'written while the backup is taken' });

  const r = await backupNow({ dbPath, dir: path.join(root, 'backups'), now: NOW });

  const restored = path.join(root, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(r.file)));
  const db = new DatabaseSync(restored, { readOnly: true });
  t.after(() => db.close());
  assert.equal((db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id) as { title: string }).title, 'kept');
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM events WHERE message = 'written while the backup is taken'").get() as { n: number }).n,
    1,
  );
  // The daemon's connection still works afterwards.
  assert.equal(store.getTask(task.id)!.title, 'kept');
});

test('backupNow: with 9 dailies present, one run leaves 7 dailies plus the weekly keeper and names what it pruned', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);
  fs.mkdirSync(dir);
  for (let day = 2; day <= 10; day++) {
    fs.writeFileSync(path.join(dir, `foreman-2026-10-${String(day).padStart(2, '0')}.db.gz`), 'old');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');

  const r = await backupNow({ dbPath, dir, now: NOW });

  // 5..11 Oct are the seven newest (and all of week 41); 4 Oct is the newest
  // of week 40, so it stays as that week's keeper; 2 and 3 Oct go.
  assert.deepEqual(r.pruned.sort(), ['foreman-2026-10-02.db.gz', 'foreman-2026-10-03.db.gz']);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'foreman-2026-10-04.db.gz',
    'foreman-2026-10-05.db.gz', 'foreman-2026-10-06.db.gz', 'foreman-2026-10-07.db.gz', 'foreman-2026-10-08.db.gz',
    'foreman-2026-10-09.db.gz', 'foreman-2026-10-10.db.gz', 'foreman-2026-10-11.db.gz',
    'notes.txt',
  ]);
});

test('selectPrune: keeps the newest of each of the last 4 ISO weeks beyond the dailies, and nothing older', () => {
  assert.equal(isoWeek('2026-10-11'), '2026-W41');
  assert.equal(isoWeek('2026-10-12'), '2026-W42');
  assert.equal(isoWeek('2027-01-01'), '2026-W53'); // a Friday: still the old ISO year
  const names: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(2026, 9, 11) - i * 86_400_000);
    names.push(`foreman-${d.toISOString().slice(0, 10)}.db.gz`);
  }
  const pruned = new Set(selectPrune([...names, 'foreman.db', 'foreman-latest.db.gz'], 7, 4));
  const kept = names.filter((n) => !pruned.has(n)).sort();
  assert.deepEqual(kept, [
    'foreman-2026-09-20.db.gz', // newest of W38
    'foreman-2026-09-27.db.gz', // newest of W39
    'foreman-2026-10-04.db.gz', // newest of W40
    'foreman-2026-10-05.db.gz', 'foreman-2026-10-06.db.gz', 'foreman-2026-10-07.db.gz', 'foreman-2026-10-08.db.gz',
    'foreman-2026-10-09.db.gz', 'foreman-2026-10-10.db.gz', 'foreman-2026-10-11.db.gz', // W41, the dailies
  ]);
  assert.equal(pruned.has('foreman.db'), false);
  assert.equal(pruned.has('foreman-latest.db.gz'), false);
});

test('backupNow: a copyDir that does not exist leaves the local backup good, copied false, and is not created', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  const copyDir = path.join(root, 'unplugged-drive');
  scratchDb(dbPath);

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });

  assert.equal(r.copied, false);
  assert.match(r.copyError ?? '', /copy dir missing/);
  assert.equal(fs.existsSync(copyDir), false);
  const restored = path.join(root, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(r.file)));
  assert.equal(counts(restored).integrity, 'ok');
});

test('backupNow: a copyDir that exists receives a byte-identical archive and copied is true', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });

  assert.equal(r.copied, true);
  assert.equal(r.copyError, undefined);
  assert.deepEqual(fs.readdirSync(copyDir), ['foreman-2026-10-11.db.gz']);
  assert.deepEqual(fs.readFileSync(path.join(copyDir, 'foreman-2026-10-11.db.gz')), fs.readFileSync(r.file));
});

test('backupNow: under twice the database in free space is a named error and writes nothing', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);
  const size = fs.statSync(dbPath).size;

  await assert.rejects(
    backupNow({ dbPath, dir, now: NOW, statfs: () => ({ bavail: size * 2 - 1, bsize: 1 }) }),
    (err: Error) => err.name === 'BackupSpaceError' && /not enough free space/.test(err.message),
  );
  assert.deepEqual(fs.readdirSync(dir), []);

  // Exactly twice is enough.
  const r = await backupNow({ dbPath, dir, now: NOW, statfs: () => ({ bavail: size * 2, bsize: 1 }) });
  assert.equal(fs.existsSync(r.file), true);
});

test('backupNow: a source that is not a database fails, and leaves no archive or temp file behind', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  fs.writeFileSync(dbPath, 'this is not a sqlite database, only text '.repeat(200));

  await assert.rejects(backupNow({ dbPath, dir, now: NOW }), /VACUUM INTO failed/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('backupIfDue: records "backup: <file> <MB> MB" as a status event, then does nothing while today\'s archive exists', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const record = (type: 'status' | 'error', message: string): void => void store.record({ type, message });
  const events = (): { type: string; message: string }[] =>
    (store.db.prepare("SELECT type, message FROM events WHERE message LIKE 'backup%' ORDER BY id").all() as { type: string; message: string }[])
      .map((e) => ({ type: e.type, message: e.message }));

  const r = await backupIfDue({ dbPath, dir, now: NOW, record });
  assert.ok(r);
  assert.deepEqual(events(), [
    { type: 'status', message: `backup: ${r.file} ${(r.bytes / (1024 * 1024)).toFixed(1)} MB` },
  ]);

  const before = fs.statSync(r.file).mtimeMs;
  assert.equal(await backupIfDue({ dbPath, dir, now: new Date(2026, 9, 11, 23, 59), record }), null);
  assert.equal(events().length, 1);
  assert.equal(fs.statSync(r.file).mtimeMs, before);

  // The next day is due again.
  const next = await backupIfDue({ dbPath, dir, now: new Date(2026, 9, 12, 0, 1), record });
  assert.equal(path.basename(next!.file), 'foreman-2026-10-12.db.gz');
  assert.equal(events().length, 2);
});

test('backupIfDue: a missing copy dir is an error event naming it, beside the status event for the local backup', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  scratchDb(dbPath);
  const seen: { type: string; message: string }[] = [];

  const r = await backupIfDue({
    dbPath, dir: path.join(root, 'backups'), copyDir: path.join(root, 'gone'), now: NOW,
    record: (type, message) => void seen.push({ type, message }),
  });

  assert.equal(r?.copied, false);
  assert.deepEqual(seen.map((e) => e.type), ['status', 'error']);
  assert.match(seen[0]!.message, /^backup: .*foreman-2026-10-11\.db\.gz \d+\.\d MB$/);
  assert.match(seen[1]!.message, /copy dir missing: .*gone/);
});

test('backupIfDue: a failed backup is an error event with the reason, never a rejection', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  scratchDb(dbPath);
  const seen: { type: string; message: string }[] = [];

  const r = await backupIfDue({
    dbPath, dir: path.join(root, 'backups'), now: NOW,
    statfs: () => ({ bavail: 0, bsize: 4096 }),
    record: (type, message) => void seen.push({ type, message }),
  });

  assert.equal(r, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.type, 'error');
  assert.match(seen[0]!.message, /^backup failed: not enough free space/);
});

test('backupSettings: defaults under the home, FOREMAN_BACKUP=off, and the two folder overrides', () => {
  assert.deepEqual(backupSettings({}, '/h'), { enabled: true, dir: path.join('/h', 'backups') });
  assert.equal(backupSettings({ FOREMAN_BACKUP: 'off' }, '/h').enabled, false);
  assert.equal(backupSettings({ FOREMAN_BACKUP: 'on' }, '/h').enabled, true);
  assert.deepEqual(
    backupSettings({ FOREMAN_BACKUP_DIR: '/b', FOREMAN_BACKUP_COPY_DIR: '/c' }, '/h'),
    { enabled: true, dir: path.resolve('/b'), copyDir: path.resolve('/c') },
  );
  assert.equal(backupSettings({ FOREMAN_BACKUP_COPY_DIR: '  ' }, '/h').copyDir, undefined);
});

test('CLI backup --to <dir> runs once and prints the archive it wrote', async (t) => {
  const home = scratch(t);
  scratchDb(path.join(home, 'foreman.db'));
  const to = path.join(home, 'elsewhere');

  const r = await cli(['backup', '--to', to], { FOREMAN_HOME: home, FOREMAN_DB: '', FOREMAN_BACKUP_COPY_DIR: path.join(home, 'gone') });

  assert.equal(r.code, 0, r.stderr);
  const files = fs.readdirSync(to);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^foreman-\d{4}-\d{2}-\d{2}\.db\.gz$/);
  assert.match(r.stdout, new RegExp(`^backup: .*${files[0]!.replaceAll('.', '\\.')} \\d+\\.\\d MB$`, 'm'));
  assert.match(r.stdout, /NOT copied — copy dir missing/);
  assert.equal(fs.existsSync(path.join(home, 'backups')), false);
});

test('CLI restore refuses while daemon.pid names a live process: non-zero exit and nothing changes', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  scratchDb(dbPath, 'backedup');
  const made = await backupNow({ dbPath, dir: path.join(home, 'backups'), now: NOW });
  fs.rmSync(dbPath);
  scratchDb(dbPath, 'current');
  fs.writeFileSync(path.join(home, 'daemon.pid'), `${process.pid}\n`); // this test process: certainly alive
  const before = fs.readFileSync(dbPath);
  const listing = fs.readdirSync(home).sort();

  const r = await cli(['restore', made.file], { FOREMAN_HOME: home, FOREMAN_DB: '' });

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, new RegExp(`daemon \\(pid ${process.pid}\\) is running`));
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(home).sort(), listing);
  assert.equal(counts(dbPath).first.startsWith('current-'), true);
});

test('CLI restore with a stale daemon.pid moves the current database aside and writes the restored one', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  scratchDb(dbPath, 'backedup');
  const made = await backupNow({ dbPath, dir: path.join(home, 'backups'), now: NOW });
  fs.rmSync(dbPath);
  scratchDb(dbPath, 'current');
  fs.writeFileSync(`${dbPath}-wal`, 'left over from the old database');
  fs.writeFileSync(path.join(home, 'daemon.pid'), `${await deadPid()}\n`);

  const r = await cli(['restore', made.file], { FOREMAN_HOME: home, FOREMAN_DB: '' });

  assert.equal(r.code, 0, r.stderr);
  const restored = counts(dbPath);
  assert.equal(restored.integrity, 'ok');
  assert.deepEqual(restored.rows, { ...TABLES });
  assert.equal(restored.first.startsWith('backedup-'), true);
  const aside = fs.readdirSync(home).filter((n) => /^foreman\.db\.before-restore-[\dT-]+$/.test(n));
  assert.equal(aside.length, 1);
  assert.match(r.stdout, new RegExp(aside[0]!.replaceAll('.', '\\.')));
  // The old WAL went with the old database; it must not sit beside the new one.
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.readFileSync(path.join(home, `${aside[0]!}-wal`), 'utf8'), 'left over from the old database');
});

test('restoreFrom: a file that is not a gzip archive is refused and the database is left as it was', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  scratchDb(dbPath, 'current');
  const bogus = path.join(home, 'foreman-2026-10-11.db.gz');
  fs.copyFileSync(dbPath, bogus); // a plain database under an archive's name
  const before = fs.readFileSync(dbPath);

  await assert.rejects(restoreFrom({ file: bogus, dbPath, home }), /cannot unpack/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['foreman-2026-10-11.db.gz', 'foreman.db']);
});

test('restoreFrom: a valid gzip that does not hold a sound database fails the integrity check and changes nothing', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  scratchDb(dbPath, 'current');
  const bogus = path.join(home, 'foreman-2026-10-11.db.gz');
  fs.writeFileSync(bogus, zlib.gzipSync('not a database at all '.repeat(500)));
  const before = fs.readFileSync(dbPath);

  await assert.rejects(restoreFrom({ file: bogus, dbPath, home }), (err: Error) => err.name === 'BackupIntegrityError');
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['foreman-2026-10-11.db.gz', 'foreman.db']);
});

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

/** A gzip of whatever `build` puts in a fresh SQLite file. */
function gzippedDb(file: string, build: (db: DatabaseSync) => void): void {
  const plain = `${file}.plain`;
  const db = new DatabaseSync(plain);
  build(db);
  db.close();
  fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(plain)));
  fs.rmSync(plain);
}

test('restoreFrom: an empty gzip and other databases are refused with the ledger untouched; a real archive then restores', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  let store = new Store(dbPath);
  const kept = store.addTask({ title: 'in the backup', prompt: 'x' });
  store.close();
  const made = await backupNow({ dbPath, dir: path.join(home, 'backups'), now: NOW });
  store = new Store(dbPath);
  const later = store.addTask({ title: 'after the backup', prompt: 'x' });
  store.close();

  const empty = path.join(home, 'empty.db.gz');
  fs.writeFileSync(empty, zlib.gzipSync(Buffer.alloc(0)));
  const other = path.join(home, 'other-app.db.gz');
  gzippedDb(other, (db) => {
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    db.exec("INSERT INTO notes (body) VALUES ('not a ledger')");
  });
  const partial = path.join(home, 'tasks-only.db.gz');
  gzippedDb(partial, (db) => db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY)'));
  const before = fs.readFileSync(dbPath);
  const listing = fs.readdirSync(home).sort();

  const refused: [string, string][] = [
    [empty, 'tasks, runs, events tables'], [other, 'tasks, runs, events tables'], [partial, 'runs, events tables'],
  ];
  for (const [file, missing] of refused) {
    await assert.rejects(
      restoreFrom({ file, dbPath, home }),
      (err: Error) => err.name === 'NotALedgerError' && err.message.includes('not a Foreman database') &&
        err.message.includes(file) && err.message.includes(`has no ${missing}`),
      file,
    );
    assert.deepEqual(fs.readFileSync(dbPath), before, file);
    assert.deepEqual(fs.readdirSync(home).sort(), listing, file);
  }
  // Still the ledger it was: the store opens it and finds the newest task.
  store = new Store(dbPath);
  assert.equal(store.getTask(later.id)!.title, 'after the backup');
  store.close();

  const r = await restoreFrom({ file: made.file, dbPath, home, now: NOW });

  assert.equal(r.aside, `${dbPath}.before-restore-2026-10-11T12-00-00`);
  store = new Store(dbPath);
  t.after(() => store.close());
  assert.equal(store.getTask(kept.id)!.title, 'in the backup');
  assert.ok(!store.getTask(later.id));
});

test('CLI restore of a database that is not a ledger: non-zero exit, one plain line, and the ledger is untouched', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  scratchDb(dbPath, 'current');
  const other = path.join(home, 'other-app.db.gz');
  gzippedDb(other, (db) => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'));
  const before = fs.readFileSync(dbPath);
  const listing = fs.readdirSync(home).sort();

  const r = await cli(['restore', other], { FOREMAN_HOME: home, FOREMAN_DB: '' });

  assert.equal(r.code, 1);
  const said = r.stderr.split('\n').filter((l) => l.startsWith('error: '));
  assert.equal(said.length, 1, r.stderr);
  assert.match(said[0]!, /^error: not a Foreman database: .*other-app\.db\.gz has no tasks, runs, events tables/);
  assert.doesNotMatch(r.stderr, /^\s+at /m); // a message, not a stack
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(home).sort(), listing);
});

test('modes: archives and the restored database are 0600, folders Foreman makes are 0700, a copy dir the operator made keeps its own', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'made', 'backups');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);
  fs.chmodSync(copyDir, 0o755);

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });

  assert.equal(r.copied, true);
  assert.equal(mode(r.file), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.dirname(dir)), 0o700);
  assert.equal(mode(path.join(copyDir, 'foreman-2026-10-11.db.gz')), 0o600);
  assert.equal(mode(copyDir), 0o755);

  const freshHome = path.join(root, 'fresh', 'home');
  const restored = await restoreFrom({ file: r.file, dbPath: path.join(freshHome, 'foreman.db'), home: freshHome });
  assert.equal(mode(restored.dbPath), 0o600);
  assert.equal(mode(freshHome), 0o700);
  assert.equal(mode(path.dirname(freshHome)), 0o700);
});

test('backupNow: the retention defaults are 7 dailies and 4 weeklies — 8 or 5 would each keep one more here', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);
  fs.mkdirSync(dir);
  // 42 days up to Tuesday 13 Oct; the run is on Wednesday 14 Oct, mid-week 42,
  // so the daily window (8..14 Oct) ends inside week 41 rather than on its edge.
  const names: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(2026, 9, 13) - i * 86_400_000);
    names.push(`foreman-${d.toISOString().slice(0, 10)}.db.gz`);
    fs.writeFileSync(path.join(dir, names.at(-1)!), 'old');
  }
  const expected = [
    'foreman-2026-09-27.db.gz', // newest of W39, the 4th week back
    'foreman-2026-10-04.db.gz', // newest of W40
    'foreman-2026-10-08.db.gz', 'foreman-2026-10-09.db.gz', 'foreman-2026-10-10.db.gz',
    'foreman-2026-10-11.db.gz', // a daily, and the newest of W41
    'foreman-2026-10-12.db.gz', 'foreman-2026-10-13.db.gz', 'foreman-2026-10-14.db.gz',
  ];

  const r = await backupNow({ dbPath, dir, now: new Date(2026, 9, 14, 12, 0, 0) });

  assert.deepEqual(fs.readdirSync(dir).sort(), expected);
  assert.equal(r.pruned.length, 43 - expected.length);
  // The fixture tells the neighbours apart: one more daily or one more week shows.
  const all = [...names, 'foreman-2026-10-14.db.gz'];
  const keptWith = (daily: number, weekly: number): string[] => {
    const gone = new Set(selectPrune(all, daily, weekly));
    return all.filter((n) => !gone.has(n)).sort();
  };
  assert.deepEqual(keptWith(7, 4), expected);
  assert.deepEqual(keptWith(8, 4), [...expected, 'foreman-2026-10-07.db.gz'].sort());
  assert.deepEqual(keptWith(7, 5), ['foreman-2026-09-20.db.gz', ...expected]);
});

test('backupNow: a temp copy that fails integrity_check is never published', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  scratchDb(dbPath);
  let corrupted = false;

  await assert.rejects(
    backupNow({
      dbPath, dir, now: NOW,
      // The second page is the root of the first table; the header on page 1
      // is left alone, so the file still opens and gzips like any other.
      afterCopy: (tmpDb) => {
        assert.ok(fs.statSync(tmpDb).size >= 8192);
        const fd = fs.openSync(tmpDb, 'r+');
        fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096);
        fs.closeSync(fd);
        corrupted = true;
      },
    }),
    (err: Error) => err.name === 'BackupIntegrityError',
  );
  assert.equal(corrupted, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('backupNow: the copy dir is pruned with the same retention, and only names that are exactly ours', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);
  for (let day = 2; day <= 10; day++) {
    fs.writeFileSync(path.join(copyDir, `foreman-2026-10-${String(day).padStart(2, '0')}.db.gz`), 'old');
  }
  // All older than anything retention would keep, were they ours.
  const lookAlikes = [
    'foreman-2026-09-01.db', 'foreman-2026-09-01.db.gz.bak', 'foreman-2026-09-01.db.gz.tmp',
    'foreman-2026-9-01.db.gz', 'foreman-20260901.db.gz', 'foreman-2026-09-01.sqlite.gz',
    'my-foreman-2026-09-01.db.gz', 'foreman-2026-09-01-copy.db.gz', 'foreman-latest.db.gz', 'notes.txt',
  ];
  for (const name of lookAlikes) fs.writeFileSync(path.join(copyDir, name), 'not ours');
  // Our name exactly, but a folder: whatever it is, it is not an archive we wrote.
  fs.mkdirSync(path.join(copyDir, 'foreman-2026-09-02.db.gz'));
  fs.writeFileSync(path.join(copyDir, 'foreman-2026-09-02.db.gz', 'inside.txt'), 'not ours');

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });

  assert.equal(r.copied, true);
  assert.equal(r.copyError, undefined);
  assert.deepEqual(r.pruned, []); // the local dir had nothing old
  // The same answer the local dir gives for the same nine dailies (see above).
  assert.deepEqual(r.copyPruned.sort(), ['foreman-2026-10-02.db.gz', 'foreman-2026-10-03.db.gz']);
  assert.deepEqual(fs.readdirSync(copyDir).sort(), [
    'foreman-2026-09-02.db.gz',
    'foreman-2026-10-04.db.gz',
    'foreman-2026-10-05.db.gz', 'foreman-2026-10-06.db.gz', 'foreman-2026-10-07.db.gz', 'foreman-2026-10-08.db.gz',
    'foreman-2026-10-09.db.gz', 'foreman-2026-10-10.db.gz', 'foreman-2026-10-11.db.gz',
    ...lookAlikes,
  ].sort());
  assert.equal(fs.readFileSync(path.join(copyDir, 'foreman-2026-09-02.db.gz', 'inside.txt'), 'utf8'), 'not ours');
});

test('CLI backup warns in one line when FOREMAN_BACKUP_COPY_DIR is unset, and not when it is set', async (t) => {
  const home = scratch(t);
  scratchDb(path.join(home, 'foreman.db'));
  const drive = path.join(home, 'drive');
  fs.mkdirSync(drive);
  const warnings = (stderr: string): string[] => stderr.split('\n').filter((l) => l.includes('FOREMAN_BACKUP_COPY_DIR'));
  const env = { FOREMAN_HOME: home, FOREMAN_DB: '', FOREMAN_BACKUP_DIR: '' };

  const alone = await cli(['backup'], { ...env, FOREMAN_BACKUP_COPY_DIR: '' });
  assert.equal(alone.code, 0, alone.stderr);
  assert.equal(warnings(alone.stderr).length, 1, alone.stderr);
  assert.match(warnings(alone.stderr)[0]!, /^warning: FOREMAN_BACKUP_COPY_DIR is not set .*same disk/);

  const copied = await cli(['backup'], { ...env, FOREMAN_BACKUP_COPY_DIR: drive });
  assert.equal(copied.code, 0, copied.stderr);
  assert.deepEqual(warnings(copied.stderr), []);
  assert.match(copied.stdout, /^copied to /m);
});

test('a restore killed between its renames: restore and the next start say how to recover, and make no empty ledger', async (t) => {
  const home = scratch(t);
  const dbPath = path.join(home, 'foreman.db');
  const src = path.join(home, 'source.db');
  scratchDb(src, 'backedup');
  const made = await backupNow({ dbPath: src, dir: path.join(home, 'backups'), now: NOW });
  // What the kill leaves: the old ledger (and its WAL) under the set-aside name, nothing at foreman.db.
  const aside = `${dbPath}.before-restore-2026-10-11T12-00-00`;
  scratchDb(aside, 'old');
  fs.writeFileSync(`${aside}-wal`, '');
  const listing = fs.readdirSync(home).sort();
  const env = { FOREMAN_HOME: home, FOREMAN_DB: '', FOREMAN_BACKUP: 'off' };
  const recovery = `mv '${aside}' '${dbPath}'\n  mv '${aside}-wal' '${dbPath}-wal'\n`;

  await assert.rejects(
    restoreFrom({ file: made.file, dbPath, home }),
    (err: Error) => err.name === 'InterruptedRestoreError' && err.message.includes(recovery) &&
      /restore was interrupted/.test(err.message),
  );
  assert.deepEqual(fs.readdirSync(home).sort(), listing);

  for (const argv of [['restore', made.file], ['serve'], ['doctor', '--latency']]) {
    const r = await cli(argv, env, 20_000);
    assert.equal(r.code, 1, `${argv[0]}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(recovery), `${argv[0]}: ${r.stderr}`);
    assert.equal(fs.existsSync(dbPath), false, argv[0]);
    assert.deepEqual(fs.readdirSync(home).sort(), listing, argv[0]);
  }

  // Doing what it says puts the old ledger back, and the restore then goes through.
  fs.rmSync(`${aside}-wal`);
  fs.renameSync(aside, dbPath);
  assert.equal(counts(dbPath).first.startsWith('old-'), true);
  const first = await restoreFrom({ file: made.file, dbPath, home, now: NOW });
  assert.equal(first.aside, aside);
  assert.equal(counts(dbPath).first.startsWith('backedup-'), true);
  // A set-aside file beside a ledger that IS there is the normal state after a restore, not an interruption.
  const second = await restoreFrom({ file: made.file, dbPath, home, now: new Date(2026, 9, 11, 12, 0, 1) });
  assert.equal(second.aside, `${dbPath}.before-restore-2026-10-11T12-00-01`);
  assert.equal(counts(dbPath).first.startsWith('backedup-'), true);
});

// ---- reviewer additions (t_e07a2892a6 r1): the copy dir is the operator's folder ----

/** Nine dailies 02..10 Oct: with today's (11 Oct) the retention deletes 02 and 03 and keeps 04 as week 40's. */
function nineDailies(dir: string): void {
  for (let day = 2; day <= 10; day++) fs.writeFileSync(path.join(dir, `foreman-2026-10-${String(day).padStart(2, '0')}.db.gz`), 'old');
}

test('copy-dir pruning: names that merely contain ours, on days the retention WOULD delete, all survive', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);
  nineDailies(copyDir);
  // 01 Oct is in week 40 and older than 04 Oct, so an archive of ours for that day would be deleted.
  // (The look-alikes in the test above sit on 01 Sep, which the weekly rule keeps anyway.)
  const lookAlikes = [
    'my-foreman-2026-10-01.db.gz', 'xforeman-2026-10-01.db.gz', '.foreman-2026-10-01.db.gz', 'Foreman-2026-10-01.db.gz',
    'foreman-2026-10-01.db.gz ', 'foreman-2026-10-01.db.gz\n', 'foreman-2026-10-01.db.gz.bak', 'foreman-2026-10-01.DB.GZ.old',
  ];
  for (const name of lookAlikes) fs.writeFileSync(path.join(copyDir, name), 'not ours');
  fs.mkdirSync(path.join(copyDir, 'sub'));
  fs.writeFileSync(path.join(copyDir, 'sub', 'foreman-2026-10-02.db.gz'), 'not ours');

  const r = await backupNow({ dbPath, dir: path.join(root, 'backups'), copyDir, now: NOW });

  assert.deepEqual(r.copyPruned.sort(), ['foreman-2026-10-02.db.gz', 'foreman-2026-10-03.db.gz']);
  for (const name of lookAlikes) assert.equal(fs.existsSync(path.join(copyDir, name)), true, JSON.stringify(name));
  assert.equal(fs.existsSync(path.join(copyDir, 'sub', 'foreman-2026-10-02.db.gz')), true);
});

test('pruning never follows or empties what is not a regular file: a folder and a link under our exact name stay, in both dirs', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  const copyDir = path.join(root, 'drive');
  const outside = path.join(root, 'outside.txt');
  scratchDb(dbPath);
  fs.writeFileSync(outside, 'the operator\'s file');
  for (const d of [dir, copyDir]) {
    fs.mkdirSync(d);
    nineDailies(d);
    fs.rmSync(path.join(d, 'foreman-2026-10-02.db.gz'));
    fs.rmSync(path.join(d, 'foreman-2026-10-03.db.gz'));
    fs.mkdirSync(path.join(d, 'foreman-2026-10-02.db.gz'));
    fs.writeFileSync(path.join(d, 'foreman-2026-10-02.db.gz', 'inside.txt'), 'not ours');
    fs.symlinkSync(outside, path.join(d, 'foreman-2026-10-03.db.gz'));
  }

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });

  assert.equal(r.copied, true);
  assert.equal(r.copyError, undefined);
  assert.deepEqual([r.pruned, r.copyPruned], [[], []]);
  for (const d of [dir, copyDir]) {
    assert.equal(fs.readFileSync(path.join(d, 'foreman-2026-10-02.db.gz', 'inside.txt'), 'utf8'), 'not ours');
    assert.equal(fs.lstatSync(path.join(d, 'foreman-2026-10-03.db.gz')).isSymbolicLink(), true);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'the operator\'s file');
});

test('a copy dir that could not take today\'s archive is not pruned', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);
  nineDailies(copyDir);
  // Today's name is taken by a non-empty folder, so the rename into place fails.
  fs.mkdirSync(path.join(copyDir, 'foreman-2026-10-11.db.gz'));
  fs.writeFileSync(path.join(copyDir, 'foreman-2026-10-11.db.gz', 'x'), 'x');
  const before = fs.readdirSync(copyDir).sort();

  const r = await backupNow({ dbPath, dir: path.join(root, 'backups'), copyDir, now: NOW });

  assert.equal(r.copied, false);
  assert.match(r.copyError ?? '', /^copy to .* failed: /);
  assert.deepEqual(r.copyPruned, []);
  assert.deepEqual(fs.readdirSync(copyDir).sort(), before);
});

test('a copy dir that cannot be pruned does not fail the backup: the archive and the copy stand, and the reason is reported', async (t) => {
  const root = scratch(t);
  const dbPath = path.join(root, 'foreman.db');
  const dir = path.join(root, 'backups');
  const copyDir = path.join(root, 'drive');
  scratchDb(dbPath);
  fs.mkdirSync(copyDir);
  nineDailies(copyDir);
  const realRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === path.join(copyDir, 'foreman-2026-10-03.db.gz')) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRm(p, o);
  });

  const r = await backupNow({ dbPath, dir, copyDir, now: NOW });
  t.mock.restoreAll();

  assert.equal(r.copied, true);
  assert.match(r.copyError ?? '', /^pruning .*drive failed: EPERM/);
  assert.equal(fs.existsSync(path.join(dir, 'foreman-2026-10-11.db.gz')), true);
  assert.equal(fs.existsSync(path.join(copyDir, 'foreman-2026-10-11.db.gz')), true);

  // And through the daemon's tick: one status event for the backup, one error event that does not say the copy failed.
  fs.rmSync(path.join(dir, 'foreman-2026-10-11.db.gz'));
  t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === path.join(copyDir, 'foreman-2026-10-03.db.gz')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return realRm(p, o);
  });
  const said: string[] = [];
  const again = await backupIfDue({ dbPath, dir, copyDir, now: NOW, record: (type, message) => said.push(`${type}: ${message}`) });
  t.mock.restoreAll();
  assert.equal(again?.copied, true);
  assert.equal(said.length, 2);
  assert.match(said[0]!, /^status: backup: /);
  assert.match(said[1]!, /^error: backup copy: pruning .* failed: EPERM/);
});

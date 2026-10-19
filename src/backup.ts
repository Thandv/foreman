import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { config } from './config.ts';

/** Not enough room in the backup folder for a copy and its archive. */
export class BackupSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupSpaceError';
  }
}

/** The copy (or an archive being restored) did not pass `PRAGMA integrity_check`. */
export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

/** `restore` was asked to replace the database under a running daemon. */
export class DaemonRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonRunningError';
  }
}

/** `restore` was handed a sound SQLite file that is not a Foreman ledger. */
export class NotALedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotALedgerError';
  }
}

/** No ledger, but one a restore moved aside: that restore died between its two renames. */
export class InterruptedRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptedRestoreError';
  }
}

export interface BackupOptions {
  dbPath: string;
  dir: string;
  /** A second folder (another disk, a synced folder) the new archive is copied to. */
  copyDir?: string;
  keepDaily?: number;
  keepWeekly?: number;
  now?: Date;
  /** Ceiling on the VACUUM child; it is SIGKILLed past this. */
  timeoutMs?: number;
  /** Test seam for the free-space probe. */
  statfs?: (dir: string) => { bavail: number | bigint; bsize: number | bigint };
  /** Test seam: handed the temp copy after VACUUM, before it is checked. */
  afterCopy?: (tmpDb: string) => void;
}

export interface BackupResult {
  file: string;
  bytes: number;
  copied: boolean;
  /**
   * Why the copy did not happen, when `copyDir` was set and `copied` is false;
   * or, with `copied` true, why the copy dir could not be pruned afterwards.
   */
  copyError?: string;
  pruned: string[];
  /** Old archives deleted from `copyDir`, under the same retention as `dir`. */
  copyPruned: string[];
}

const DAILY = /^foreman-(\d{4}-\d{2}-\d{2})\.db\.gz$/;
const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day, as it appears in an archive's name. */
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function backupFileName(now: Date = new Date()): string {
  return `foreman-${dayStamp(now)}.db.gz`;
}

/** ISO-8601 week of a YYYY-MM-DD day, e.g. 2026-W41 (the week owning its Thursday). */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

/**
 * Which archives to delete: everything but the newest `keepDaily`, plus the
 * newest archive of each of the `keepWeekly` most recent ISO weeks that have
 * one. Weeks are counted from the archives present, not from the clock, so a
 * daemon that was off for a month does not lose its only older history on its
 * first run back. Names that are not ours are never touched.
 */
export function selectPrune(names: string[], keepDaily: number, keepWeekly: number): string[] {
  const dated = names
    .map((name) => ({ name, day: DAILY.exec(name)?.[1] }))
    .filter((f): f is { name: string; day: string } => f.day !== undefined)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const keep = new Set(dated.slice(0, Math.max(0, keepDaily)).map((f) => f.name));
  const weeks = new Set<string>();
  for (const f of dated) {
    const week = isoWeek(f.day);
    if (weeks.has(week)) continue;
    if (weeks.size >= keepWeekly) break;
    weeks.add(week);
    keep.add(f.name); // newest first, so the first seen in a week is its newest
  }
  return dated.filter((f) => !keep.has(f.name)).map((f) => f.name);
}

/**
 * Apply the retention to one folder and name what went. Only regular files
 * are considered: a folder or a link under one of our names is the operator's.
 */
function pruneDir(dir: string, justWritten: string, keepDaily: number, keepWeekly: number): string[] {
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const pruned: string[] = [];
  for (const old of selectPrune(files, keepDaily, keepWeekly)) {
    if (old === justWritten) continue; // a clock set back must not delete what was just written
    fs.rmSync(path.join(dir, old), { force: true });
    pruned.push(old);
  }
  return pruned;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Temp files of a backup whose process died mid-run (a daemon stopped during one). */
function sweepStaleTemps(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const pid = Number(/^\.tmp-(\d+)\.db(\.gz|-journal)?$/.exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

// Runs in a child: VACUUM INTO over 100+ MB is synchronous, and the daemon's
// loop must keep turning while it runs.
const VACUUM_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [src, dest] = process.argv.slice(-2);
const db = new DatabaseSync(src, { readOnly: true });
db.exec('PRAGMA busy_timeout = 30000');
db.exec("VACUUM INTO '" + dest.replaceAll("'", "''") + "'");
db.close();
`;

function vacuumInto(dbPath: string, dest: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', VACUUM_SCRIPT, '--', dbPath, dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4_000) stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const why = signal ? `killed by ${signal} (timeout ${timeoutMs} ms)` : `exit ${code}`;
      const last = stderr.trim().split('\n').filter((l) => /error/i.test(l)).pop() ?? stderr.trim().split('\n').pop() ?? '';
      reject(new Error(`VACUUM INTO failed: ${why}${last ? `: ${last.trim()}` : ''}`));
    });
  });
}

function requireIntegrity(file: string): void {
  let verdict: string;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
      verdict = String(row ? Object.values(row)[0] : 'no result');
    } finally {
      db.close();
    }
  } catch (err) {
    throw new BackupIntegrityError(`integrity check could not read ${file}: ${(err as Error).message}`);
  }
  if (verdict !== 'ok') throw new BackupIntegrityError(`integrity check failed for ${file}: ${verdict.slice(0, 300)}`);
}

const LEDGER_TABLES = ['tasks', 'runs', 'events'];

/**
 * A sound SQLite file is not yet a ledger: an empty file and another
 * application's database both pass `integrity_check`. `label` is the archive
 * the operator named, not the temp file it was unpacked to.
 */
function requireLedger(file: string, label: string): void {
  let missing: string[];
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const have = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
      );
      missing = LEDGER_TABLES.filter((t) => !have.has(t));
      // Foreman stamps no schema version today; the header field must still read.
      db.prepare('PRAGMA user_version').get();
    } finally {
      db.close();
    }
  } catch (err) {
    throw new NotALedgerError(`not a Foreman database: the schema of ${label} cannot be read: ${(err as Error).message}`);
  }
  if (missing.length) {
    throw new NotALedgerError(
      `not a Foreman database: ${label} has no ${missing.join(', ')} table${missing.length > 1 ? 's' : ''}; nothing was changed`,
    );
  }
}

/**
 * One verified, compressed copy of the database in `dir`, named for the day.
 * The archive only ever appears under its final name complete: it is written
 * beside it and renamed. Archives are the ledger in plain text, so they are
 * written 0600 and a folder made here is 0700; a folder that already exists
 * keeps the mode its owner gave it.
 */
export async function backupNow(opts: BackupOptions): Promise<BackupResult> {
  const { dbPath, dir, copyDir, keepDaily = 7, keepWeekly = 4, now = new Date(), timeoutMs = 600_000 } = opts;
  const dbBytes = fs.statSync(dbPath).size;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fsStat = (opts.statfs ?? fs.statfsSync)(dir);
  const free = Number(fsStat.bavail) * Number(fsStat.bsize);
  if (free < dbBytes * 2) {
    throw new BackupSpaceError(
      `not enough free space in ${dir}: ${Math.floor(free / 1e6)} MB free, need ${Math.ceil((dbBytes * 2) / 1e6)} MB (twice the database)`,
    );
  }
  sweepStaleTemps(dir);

  const tmpDb = path.join(dir, `.tmp-${process.pid}.db`);
  const tmpGz = `${tmpDb}.gz`;
  const name = backupFileName(now);
  const file = path.join(dir, name);
  try {
    fs.rmSync(tmpDb, { force: true }); // VACUUM INTO refuses an existing target
    await vacuumInto(path.resolve(dbPath), tmpDb, timeoutMs);
    fs.chmodSync(tmpDb, 0o600);
    opts.afterCopy?.(tmpDb);
    requireIntegrity(tmpDb);
    fs.rmSync(tmpGz, { force: true }); // `mode` only applies to a file this creates
    await pipeline(fs.createReadStream(tmpDb), zlib.createGzip(), fs.createWriteStream(tmpGz, { mode: 0o600 }));
    fs.renameSync(tmpGz, file);
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-journal`, { force: true });
    fs.rmSync(tmpGz, { force: true });
  }
  const bytes = fs.statSync(file).size;

  const pruned = pruneDir(dir, name, keepDaily, keepWeekly);

  let copied = false;
  let copyError: string | undefined;
  let copyPruned: string[] = [];
  if (copyDir) {
    // Never created: a missing folder is usually an unplugged drive, and
    // making it would quietly put the "off-disk" copy back on this disk.
    if (!fs.existsSync(copyDir) || !fs.statSync(copyDir).isDirectory()) {
      copyError = `copy dir missing: ${copyDir}`;
    } else {
      const part = path.join(copyDir, `.tmp-${process.pid}.db.gz`);
      try {
        await fs.promises.copyFile(file, part);
        fs.chmodSync(part, 0o600);
        fs.renameSync(part, path.join(copyDir, name));
        copied = true;
      } catch (err) {
        fs.rmSync(part, { force: true });
        copyError = `copy to ${copyDir} failed: ${(err as Error).message}`;
      }
      // Only once today's archive is there, so a drive that takes no copies
      // never loses the ones it has; and only our dated names (selectPrune).
      if (copied) {
        try {
          copyPruned = pruneDir(copyDir, name, keepDaily, keepWeekly);
        } catch (err) {
          copyError = `pruning ${copyDir} failed: ${(err as Error).message}`;
        }
      }
    }
  }
  return { file, bytes, copied, ...(copyError ? { copyError } : {}), pruned, copyPruned };
}

export interface BackupSettings {
  enabled: boolean;
  dir: string;
  copyDir?: string;
}

/** FOREMAN_BACKUP=off, FOREMAN_BACKUP_DIR (default <home>/backups), FOREMAN_BACKUP_COPY_DIR (default unset). */
export function backupSettings(env: NodeJS.ProcessEnv = process.env, home: string = config.home): BackupSettings {
  const dir = env['FOREMAN_BACKUP_DIR']?.trim();
  const copyDir = env['FOREMAN_BACKUP_COPY_DIR']?.trim();
  return {
    enabled: env['FOREMAN_BACKUP']?.trim().toLowerCase() !== 'off',
    dir: dir ? path.resolve(dir) : path.join(home, 'backups'),
    ...(copyDir ? { copyDir: path.resolve(copyDir) } : {}),
  };
}

/** The one line said when no second folder is set; null when one is. */
export function sameDiskWarning(settings: BackupSettings): string | null {
  if (settings.copyDir) return null;
  return 'warning: FOREMAN_BACKUP_COPY_DIR is not set — backups sit on the same disk as the database, so losing that disk loses both';
}

export const backupMb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * The daemon's hourly tick: back up unless today's archive is already there,
 * and say what happened as an event. Never rejects — a failed backup is an
 * `error` event, not a crashed timer.
 */
export async function backupIfDue(
  opts: BackupOptions & { record: (type: 'status' | 'error', message: string) => void },
): Promise<BackupResult | null> {
  const { record, ...rest } = opts;
  const say = (type: 'status' | 'error', message: string): void => {
    try {
      record(type, message);
    } catch {
      /* the store closed under a backup that outlived shutdown */
    }
  };
  try {
    if (fs.existsSync(path.join(rest.dir, backupFileName(rest.now ?? new Date())))) return null;
    const r = await backupNow(rest);
    say('status', `backup: ${r.file} ${backupMb(r.bytes)} MB`);
    if (r.copyError) say('error', r.copied ? `backup copy: ${r.copyError}` : `backup copy failed: ${r.copyError}`);
    return r;
  } catch (err) {
    say('error', `backup failed: ${(err as Error).message}`);
    return null;
  }
}

export interface RestoreResult {
  dbPath: string;
  /** Where the database that was there went; null when there was none. */
  aside: string | null;
}

const ASIDE = /^\.before-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/**
 * The newest database a restore moved aside, when no database stands where
 * it was: the mark of a restore killed between its two renames. Null when the
 * database is present, or when nothing was ever moved aside.
 */
export function interruptedRestore(dbPath: string): string | null {
  if (dbPath === ':memory:' || fs.existsSync(dbPath)) return null;
  const base = path.basename(dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(dbPath));
  } catch {
    return null; // no folder: nothing was ever here
  }
  const asides = names.filter((n) => n.startsWith(base) && ASIDE.test(n.slice(base.length))).sort();
  return asides.length ? path.join(path.dirname(dbPath), asides.at(-1)!) : null;
}

/**
 * Refuse to go on in that state. Opening the store would make an empty
 * database where the real one was, and the old one would sit unnoticed
 * beside it under a name nothing reads.
 */
export function requireNoInterruptedRestore(dbPath: string): void {
  const aside = interruptedRestore(dbPath);
  if (!aside) return;
  const q = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`;
  const wal = fs.existsSync(`${aside}-wal`) ? `  mv ${q(`${aside}-wal`)} ${q(`${dbPath}-wal`)}\n` : '';
  throw new InterruptedRestoreError(
    `the database ${dbPath} is missing, but ${aside} is beside it: a restore was interrupted ` +
      `after it moved the old database aside. Nothing has been created or changed. Put the old database back with:\n` +
      `  mv ${q(aside)} ${q(dbPath)}\n${wal}` +
      `then run 'foreman restore <file.gz>' again if you still want the backup. ` +
      `(To start with an empty database instead, move that file out of ${path.dirname(dbPath)} first.)`,
  );
}

/** The unpacked copy of a restore whose process died before renaming it in. */
function sweepStaleRestoreTemps(dbPath: string): void {
  const base = path.basename(dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(dbPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.restore-`)) continue;
    const pid = Number(/^(\d+)\.tmp$/.exec(name.slice(base.length + '.restore-'.length))?.[1]);
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue;
    fs.rmSync(path.join(path.dirname(dbPath), name), { force: true });
  }
}

/**
 * Replace the database with an archive. Refused while `daemon.pid` names a
 * live process; the archive is unpacked, integrity-checked and checked to be
 * a Foreman database BEFORE the current one is moved, so a bad archive changes
 * nothing. Between moving the old database aside and the new one in there is
 * no database at all; that gap is renames only, and a process killed inside
 * it is found by `requireNoInterruptedRestore` on the next start.
 */
export async function restoreFrom(
  opts: { file: string; dbPath?: string; home?: string; now?: Date },
): Promise<RestoreResult> {
  const { file, dbPath = config.dbPath, home = config.home, now = new Date() } = opts;
  const pidFile = path.join(home, 'daemon.pid');
  let holder = NaN;
  try {
    holder = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    /* no pidfile: no daemon */
  }
  if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
    throw new DaemonRunningError(`the daemon (pid ${holder}) is running — run 'foreman stop' first, then restore`);
  }
  requireNoInterruptedRestore(dbPath);
  if (!fs.existsSync(file)) throw new Error(`no such backup: ${file}`);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  sweepStaleRestoreTemps(dbPath);
  const tmp = `${dbPath}.restore-${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true }); // `mode` only applies to a file this creates
    await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o600 }));
    requireIntegrity(tmp);
    requireLedger(tmp, file);
    // On disk before it is the database: the rename below must not outlive its bytes.
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err instanceof BackupIntegrityError || err instanceof NotALedgerError) throw err;
    throw new Error(`cannot unpack ${file}: ${(err as Error).message}`);
  }

  // Everything that can be decided is decided here, so that the stretch with
  // no database holds nothing but renames.
  const ts = `${dayStamp(now)}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const aside = fs.existsSync(dbPath) ? `${dbPath}.before-restore-${ts}` : null;
  // The old database's WAL must not be replayed onto the restored one; it goes
  // aside under the name SQLite will look for beside the old file. It cannot
  // go first (the old database would be left standing without its last
  // writes) nor last (the new one would stand beside a WAL that is not its).
  const sidecars = ['-wal', '-shm'].filter((suffix) => fs.existsSync(dbPath + suffix));
  if (!aside) {
    for (const suffix of sidecars) fs.rmSync(dbPath + suffix, { force: true });
    fs.renameSync(tmp, dbPath);
    return { dbPath, aside };
  }
  const moved: string[] = [];
  try {
    fs.renameSync(dbPath, aside);
    moved.push('');
    for (const suffix of sidecars) {
      fs.renameSync(dbPath + suffix, aside + suffix);
      moved.push(suffix);
    }
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    // Still running, so put back what was moved rather than leave no database.
    for (const suffix of moved.reverse()) fs.renameSync(aside + suffix, dbPath + suffix);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { dbPath, aside };
}

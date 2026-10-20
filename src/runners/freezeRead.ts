import fs from 'node:fs';
import path from 'node:path';
import type { ProcRow } from './proctree.ts';
import { FREEZE_MAX_BYTES, freezeDir, nameMatchesRecord, parseFreezeRecord, parseRecordName, recordFileName } from './freezeRecord.ts';
import type { FreezeRecord } from './freezeRecord.ts';

/**
 * A pure reader of `<home>/frozen/*.json`: it reads, classifies and reports. It signals nothing and writes nothing;
 * what to do about a dead recorder's groups is the caller's. Scope: one host, a recorder named by pid + start only.
 */

/**
 * At most this many directory entries are read and classified per call; the cursor carries the sweep on to the rest.
 * Only names a record can have count (freezeRecord's parseRecordName): a stale `<name>.json.tmp` or any other entry
 * is never read, reported or counted, so it cannot use up the window.
 */
export const FREEZE_READ_MAX_FILES = 64;

export interface FreezeFound {
  file: string;
  record: FreezeRecord;
}
export interface FreezeSkipped {
  file: string;
  reason: string;
}
export interface FreezeReadResult {
  /** Valid records whose recorder is dead (its pid is absent from the snapshot, or its start differs). Empty when the snapshot is null. */
  actionable: FreezeFound[];
  /** Valid records whose recorder is alive. */
  kept: FreezeFound[];
  skipped: FreezeSkipped[];
  /** Process groups not to be touched: see readFrozen. */
  held: Set<number>;
  /** The last file name looked at; pass it back to continue after it, wrapping. */
  cursor: string | null;
}

type Read = { ok: true; record: FreezeRecord } | { ok: false; reason: string };

/** Read one record file defensively: a regular file (lstat, then fstat of what was opened), at most the size bound, valid, named for its content. */
function readRecordFile(dir: string, name: string): Read {
  const file = path.join(dir, name);
  try {
    const l = fs.lstatSync(file);
    if (!l.isFile()) return { ok: false, reason: l.isSymbolicLink() ? 'a symbolic link' : 'not a regular file' };
    if (l.size > FREEZE_MAX_BYTES) return { ok: false, reason: `over the size bound (${FREEZE_MAX_BYTES} bytes)` };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let text: string;
    try {
      if (!fs.fstatSync(fd).isFile()) return { ok: false, reason: 'not a regular file' };
      const buf = Buffer.alloc(FREEZE_MAX_BYTES + 1);
      let n = 0;
      while (n < buf.length) {
        const got = fs.readSync(fd, buf, n, buf.length - n, null);
        if (got === 0) break;
        n += got;
      }
      if (n > FREEZE_MAX_BYTES) return { ok: false, reason: `over the size bound (${FREEZE_MAX_BYTES} bytes)` };
      text = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
    const record = parseFreezeRecord(text);
    if (!record) return { ok: false, reason: 'not a valid freeze record' };
    if (!nameMatchesRecord(name, record)) return { ok: false, reason: 'the file name disagrees with its content' };
    return { ok: true, record };
  } catch (err) {
    return { ok: false, reason: `unreadable: ${(err as Error).message}` };
  }
}

/** The record names under `<home>/frozen`, sorted; none when the directory is absent, not a real directory or unreadable. */
function listNames(dir: string): string[] {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter((n) => parseRecordName(n) !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** The names to read this call: up to the cap, after `cursor` in name order, then wrapping round to the start. */
function windowAfter(names: string[], cursor: string | null): string[] {
  const after = cursor === null ? 0 : names.filter((n) => n <= cursor).length;
  return [...names.slice(after), ...names.slice(0, after)].slice(0, FREEZE_READ_MAX_FILES);
}

/**
 * One sweep step. `procs` is the injected process snapshot (null: unavailable, so nothing is known and nothing is
 * returned). `held` is exactly: (1) every group named by a valid record whose recorder is alive; (2) any pgid equal
 * to the pid of a live process whose presence marker (its own record file, matching pid AND start) exists.
 * `held` is exact whatever the window: the cap bounds the scan of the directory (what is classified and reported),
 * not the safety set. A live recorder's file is found by the one name its snapshot row gives (pid + start key), not by
 * scanning, so beyond the window at most one more file per live process with a file present is read, whatever else
 * the directory holds. Clause (2) rests on the marker existing, not on its content being readable: a live process's
 * own group is held even when its file cannot be read (when in doubt, hold). Clause (1) needs the groups, so a live
 * recorder's record that cannot be read adds nothing beyond clause (2).
 */
export function readFrozen(home: string, procs: readonly ProcRow[] | null, cursor: string | null): FreezeReadResult {
  const result: FreezeReadResult = { actionable: [], kept: [], skipped: [], held: new Set(), cursor };
  if (procs === null) return result;
  const dir = freezeDir(home);
  const names = listNames(dir);
  const alive = (r: Pick<ProcRow, 'pid' | 'start'>): boolean => procs.some((p) => p.pid === r.pid && p.start === r.start);
  const window = windowAfter(names, cursor);
  if (window.length > 0) result.cursor = window[window.length - 1]!;
  const inWindow = new Set(window);

  for (const name of window) {
    const r = readRecordFile(dir, name);
    if (!r.ok) {
      result.skipped.push({ file: name, reason: r.reason });
    } else if (alive(r.record.recorder)) {
      result.kept.push({ file: name, record: r.record });
      for (const g of r.record.groups) result.held.add(g.pgid);
    } else {
      result.actionable.push({ file: name, record: r.record });
    }
  }

  // Live recorders, by exact name: clause (2) for every live process with a marker, clause (1) for records the window
  // did not reach (those it reached were held above).
  const present = new Set(names);
  for (const p of procs) {
    const name = recordFileName(p);
    if (!present.has(name)) continue;
    result.held.add(p.pid);
    if (inWindow.has(name)) continue;
    const r = readRecordFile(dir, name);
    if (r.ok && r.record.recorder.start === p.start) for (const g of r.record.groups) result.held.add(g.pgid);
  }
  return result;
}

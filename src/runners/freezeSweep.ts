import fs from 'node:fs';
import path from 'node:path';
import { forbiddenGroups, signalGroups, snapshotProcs } from './proctree.ts';
import type { ProcRow } from './proctree.ts';
import { freezeDir, parseRecordName, recordFileName } from './freezeRecord.ts';
import type { FreezeGroup } from './freezeRecord.ts';
import { FREEZE_READ_MAX_FILES, readFrozen } from './freezeRead.ts';

/**
 * What `foreman serve` does with `<home>/frozen/` before its scheduler starts: groups that a dead recorder had
 * stopped (SIGSTOP) are ended, so nothing stays frozen for good. The reader (freezeRead.ts) classifies; this acts.
 *
 * A group is signalled only when a FRESH snapshot shows a member whose pid AND start match the record, still in the
 * recorded group; never a group the reader holds (a live recorder's), pgid 0 or 1, our own group or an ancestor's.
 * SIGTERM then SIGCONT, the grace, then a second fresh snapshot: SIGKILL only the groups it still matches, and then
 * the record goes. If that second snapshot is null or throws, no SIGKILL is sent and the record is KEPT, for the
 * next start. A dead recorder's record with nothing to signal (no groups, no group that still matches, or only
 * groups not to be touched) is removed at once: it has been dealt with. A `<record>.json.tmp` a dead recorder left
 * (it died between its write and its rename) is removed unread; a live recorder's is left. Nothing at all is done when
 * `frozen/` is not a directory of this user that only it can write: a record there could name any of our processes.
 */

export const FREEZE_CURSOR_FILE = 'cursor';
/** The wall-clock cap is never more than the grace plus this. */
export const FREEZE_SWEEP_CAP_EXTRA_MS = 5_000;
export const FREEZE_SWEEP_GRACE_MS = 2_000;

export interface FreezeSweepOptions {
  home: string;
  graceMs?: number;
  /** Wall-clock cap for the whole sweep; clamped to at most graceMs + 5 s. */
  capMs?: number;
  snapshot?: () => Promise<ProcRow[] | null>;
  signal?: (groups: Iterable<number>, sig: NodeJS.Signals) => number[];
  selfPid?: number;
  log?: (line: string) => void;
}

export interface FreezeSweepReport {
  /** Records removed. */
  removed: string[];
  /** Stale `<record>.json.tmp` files of dead recorders removed. */
  removedTemps: string[];
  /** Records kept because the SIGKILL check could not be made. */
  kept: string[];
  signalled: number[];
}

function cursorPath(home: string): string {
  return path.join(freezeDir(home), FREEZE_CURSOR_FILE);
}

/** The saved cursor, or null (absent, not a regular file, or not a record's name: start over). */
function loadCursor(home: string): string | null {
  const file = cursorPath(home);
  try {
    const l = fs.lstatSync(file);
    if (!l.isFile() || l.size > 256) return null;
    const text = fs.readFileSync(file, 'utf8').trim();
    return parseRecordName(text) ? text : null;
  } catch {
    return null;
  }
}

function saveCursor(home: string, cursor: string): void {
  const file = cursorPath(home);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, cursor);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** The pgids among `groups` that `rows` shows a member of: pid AND start as recorded, still in that group. */
function matching(groups: FreezeGroup[], rows: readonly ProcRow[], untouchable: ReadonlySet<number>): number[] {
  return groups
    .filter((g) => Number.isInteger(g.pgid) && g.pgid > 1 && !untouchable.has(g.pgid))
    .filter((g) => g.members.some(([pid, start]) => rows.some((r) => r.pid === pid && r.start === start && r.pgid === g.pgid)))
    .map((g) => g.pgid);
}

/** Why `dir` is not to be acted on (it exists but is not a directory owned by this user and closed to others), or null. */
function untrustedDir(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return null; // absent or unreadable: the reader finds nothing in it either
  }
  if (!st.isDirectory()) return 'not a directory';
  if (st.uid !== process.geteuid?.()) return `owned by uid ${st.uid}, not this user`;
  if ((st.mode & 0o022) !== 0) return `writable by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/**
 * Remove the `<record>.json.tmp` files whose recorder (pid + start key, from the name) is not alive in `rows`: at most
 * FREEZE_READ_MAX_FILES per sweep, regular files only (lstat), never opened. The reader does not list them.
 */
function removeStaleTemps(dir: string, rows: readonly ProcRow[], log: (line: string) => void): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const live = new Set(rows.map((r) => recordFileName(r)));
  for (const name of names) {
    if (removed.length >= FREEZE_READ_MAX_FILES) break;
    if (!name.endsWith('.json.tmp')) continue;
    const record = name.slice(0, -'.tmp'.length);
    if (parseRecordName(record) === null || live.has(record)) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch (err) {
      log(`freeze sweep: cannot remove ${name}: ${(err as Error).message}`);
    }
  }
  return removed;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One sweep. May throw; `runFreezeSweep` is the contained form. `live.aborted` stops it before its next signal. */
export async function sweepFrozen(opts: FreezeSweepOptions, live: { aborted: boolean } = { aborted: false }): Promise<FreezeSweepReport> {
  const log = opts.log ?? (() => {});
  const snapshot = opts.snapshot ?? (() => snapshotProcs());
  const signal = opts.signal ?? signalGroups;
  const selfPid = opts.selfPid ?? process.pid;
  const report: FreezeSweepReport = { removed: [], removedTemps: [], kept: [], signalled: [] };

  const rows = await snapshot();
  if (rows === null || live.aborted) return report;
  const dir = freezeDir(opts.home);
  const distrust = untrustedDir(dir);
  if (distrust !== null) {
    log(`freeze sweep: ${dir} is ${distrust}; nothing read, signalled or removed`);
    return report;
  }
  const read = readFrozen(opts.home, rows, loadCursor(opts.home));
  if (read.cursor !== null) {
    try {
      saveCursor(opts.home, read.cursor);
    } catch (err) {
      log(`freeze sweep: cannot save the cursor: ${(err as Error).message}`);
    }
  }
  for (const s of read.skipped) log(`freeze sweep: ${s.file} skipped: ${s.reason}`);

  const forbidden = forbiddenGroups(rows, selfPid);
  const remove = (file: string): void => {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
      report.removed.push(file);
    } catch (err) {
      log(`freeze sweep: cannot remove ${file}: ${(err as Error).message}`);
    }
  };

  const untouchable = new Set<number>([...read.held, ...(forbidden ?? [])]);
  const planned: { file: string; groups: number[] }[] = [];
  // Our own place in the table unknown: nothing can be checked against us, so nothing is signalled or removed.
  if (forbidden === null) {
    if (read.actionable.length > 0) log('freeze sweep: this process is not in the snapshot; nothing signalled, records kept');
    return report;
  }
  report.removedTemps.push(...removeStaleTemps(dir, rows, log));
  for (const f of read.actionable) {
    const groups = matching(f.record.groups, rows, untouchable);
    if (groups.length === 0) remove(f.file);
    else planned.push({ file: f.file, groups });
  }
  const all = [...new Set(planned.flatMap((p) => p.groups))];
  if (all.length === 0 || live.aborted) return report;

  for (const g of all) {
    if (signal([g], 'SIGTERM').length > 0) report.signalled.push(g);
    signal([g], 'SIGCONT');
  }
  log(`freeze sweep: ended group(s) ${all.join(', ')} left stopped by a dead recorder`);
  await sleep(opts.graceMs ?? FREEZE_SWEEP_GRACE_MS);
  if (live.aborted) return report;

  let fresh: ProcRow[] | null = null;
  try {
    fresh = await snapshot();
  } catch (err) {
    log(`freeze sweep: the SIGKILL check threw (${(err as Error).message}); no SIGKILL was sent, records kept`);
  }
  if (fresh === null) {
    log('freeze sweep: no process snapshot for the SIGKILL check; no SIGKILL was sent, records kept');
    report.kept.push(...planned.map((p) => p.file));
    return report;
  }
  if (live.aborted) return report;
  const freshForbidden = forbiddenGroups(fresh, selfPid);
  const freshUntouchable = new Set<number>([...read.held, ...(freshForbidden ?? [0, 1, selfPid])]);
  for (const p of planned) {
    const still = freshForbidden === null ? [] : matching(read.actionable.find((a) => a.file === p.file)!.record.groups, fresh, freshUntouchable);
    if (freshForbidden === null) {
      log('freeze sweep: this process is not in the SIGKILL check snapshot; no SIGKILL was sent, records kept');
      report.kept.push(p.file);
      continue;
    }
    if (still.length > 0) signal(still, 'SIGKILL');
    remove(p.file);
  }
  return report;
}

/**
 * The sweep as serve runs it: never throws and never outlasts `capMs` (at most grace + 5 s). An error or an overrun
 * is logged and the caller carries on; an overrun also stops the sweep before any signal it has not yet sent.
 */
export async function runFreezeSweep(opts: FreezeSweepOptions): Promise<FreezeSweepReport | null> {
  const log = opts.log ?? (() => {});
  const grace = opts.graceMs ?? FREEZE_SWEEP_GRACE_MS;
  const cap = Math.min(opts.capMs ?? grace + FREEZE_SWEEP_CAP_EXTRA_MS, grace + FREEZE_SWEEP_CAP_EXTRA_MS);
  const live = { aborted: false };
  let timer: NodeJS.Timeout | undefined;
  const overrun = new Promise<'overrun'>((resolve) => {
    timer = setTimeout(() => resolve('overrun'), cap);
  });
  const work = sweepFrozen({ ...opts, graceMs: grace }, live);
  work.catch(() => {}); // an error after the cap was given up on is not an unhandled rejection
  try {
    const r = await Promise.race([work, overrun]);
    if (r === 'overrun') {
      live.aborted = true;
      log(`freeze sweep: gave up after ${cap} ms; serve carries on`);
      return null;
    }
    return r;
  } catch (err) {
    live.aborted = true;
    log(`freeze sweep failed: ${(err as Error).message}; serve carries on`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For serve: the options from the environment. FOREMAN_FREEZE_SWEEP_GRACE_MS and _CAP_MS shorten the timings, and
 * FOREMAN_FREEZE_SWEEP_FAULT=hang|throw makes the snapshot hang or throw (so a test can see serve survive both).
 * Anything else is ignored.
 */
export function freezeSweepOptionsFromEnv(home: string, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): FreezeSweepOptions {
  const n = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : undefined);
  const opts: FreezeSweepOptions = { home, log };
  const graceMs = n(env['FOREMAN_FREEZE_SWEEP_GRACE_MS']);
  const capMs = n(env['FOREMAN_FREEZE_SWEEP_CAP_MS']);
  if (graceMs !== undefined) opts.graceMs = graceMs;
  if (capMs !== undefined) opts.capMs = capMs;
  const fault = env['FOREMAN_FREEZE_SWEEP_FAULT'];
  if (fault === 'hang') opts.snapshot = () => new Promise<ProcRow[] | null>(() => {});
  else if (fault === 'throw') opts.snapshot = () => Promise.reject(new Error('injected snapshot failure'));
  return opts;
}

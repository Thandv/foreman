import fs from 'node:fs';
import path from 'node:path';
import type { ProcRow } from './proctree.ts';

/**
 * The one owner of freeze records: what a process that has stopped (SIGSTOP) process groups writes to
 * `<home>/frozen/` so that a later process can continue them if this one dies first. This file only reads and writes
 * the records; it stops and signals nothing.
 *
 * One file per recorder process, `<pid>-<startKey>.json`; the pid and its start (ProcRow.start) are the recorder's
 * identity, so two processes sharing a home never write the same file and need no lock. Written whole on every
 * change: a temp file in the same directory, mode 0600, renamed over the record. The directory is 0700.
 *
 * A file with `groups: []` is the presence marker: it says a recorder lives, and is removed at a clean exit.
 */

export type Identity = Pick<ProcRow, 'pid' | 'start'>;
export type FreezeMember = [pid: number, start: string];
export interface FreezeGroup {
  pgid: number;
  members: FreezeMember[];
}
export interface FreezeRecord {
  v: 1;
  recorder: Identity;
  groups: FreezeGroup[];
}

/** Bounds. Input over one is refused with an error, never cut. */
export const FREEZE_MAX_GROUPS = 512;
export const FREEZE_MEMBERS_MAX = 4;
/** A start string longer than this is not one ps or /proc gives. */
export const FREEZE_START_MAX = 64;
/** 512 groups of 4 members with 64-character starts is about 200 KB; no record is larger, and none larger is read. */
export const FREEZE_MAX_BYTES = 512 * 1024;

export type Outcome = { ok: true } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 32;
}

function isStart(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= FREEZE_START_MAX;
}

/** A start as it may stand in a file name: letters and digits only (`Fri Oct 16 20:00:00 2026` → `FriOct162000002026`). */
export function startKey(start: string): string {
  return start.replace(/[^A-Za-z0-9]/g, '');
}

export function freezeDir(home: string): string {
  return path.join(home, 'frozen');
}

export function recordFileName(recorder: Identity): string {
  return `${recorder.pid}-${startKey(recorder.start)}.json`;
}

const NAME = /^([1-9]\d{0,9})-([A-Za-z0-9]{1,64})\.json$/;

/** The pid and start key a record file's name carries, or null if it is not a record's name. */
export function parseRecordName(name: string): { pid: number; key: string } | null {
  const m = NAME.exec(name);
  return m ? { pid: Number(m[1]), key: m[2]! } : null;
}

/** Whether a file's name is the one its content's recorder gives (a file that disagrees is not to be trusted). */
export function nameMatchesRecord(name: string, record: FreezeRecord): boolean {
  const n = parseRecordName(name);
  return n !== null && n.pid === record.recorder.pid && n.key === startKey(record.recorder.start);
}

/** The first bound or shape a group list breaks, or null. */
function groupsProblem(groups: unknown): string | null {
  if (!Array.isArray(groups)) return 'groups is not a list';
  if (groups.length > FREEZE_MAX_GROUPS) return `${groups.length} groups is over the bound (${FREEZE_MAX_GROUPS})`;
  for (const g of groups as unknown[]) {
    if (typeof g !== 'object' || g === null) return 'a group is not an object';
    const { pgid, members } = g as Record<string, unknown>;
    if (!isId(pgid)) return 'a group has no valid pgid';
    if (!Array.isArray(members)) return `group ${pgid} has no member list`;
    if (members.length > FREEZE_MEMBERS_MAX) return `group ${pgid} has ${members.length} members, over the bound (${FREEZE_MEMBERS_MAX})`;
    for (const m of members as unknown[]) {
      if (!Array.isArray(m) || m.length !== 2 || !isId(m[0])) return `group ${pgid} has a malformed member`;
      if (!isStart(m[1])) return `group ${pgid} has a member start that is empty or over ${FREEZE_START_MAX} characters`;
    }
  }
  return null;
}

/** The record `text` holds, or null if it is not exactly one within the bounds. Pure. */
export function parseFreezeRecord(text: string): FreezeRecord | null {
  if (Buffer.byteLength(text) > FREEZE_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { v, recorder, groups } = raw as Record<string, unknown>;
  if (v !== 1 || typeof recorder !== 'object' || recorder === null) return null;
  const { pid, start } = recorder as Record<string, unknown>;
  if (!isId(pid) || !isStart(start) || !startKey(start)) return null;
  if (groupsProblem(groups) !== null) return null;
  const gs = (groups as FreezeGroup[]).map((g) => ({ pgid: g.pgid, members: g.members.map((m): FreezeMember => [m[0], m[1]]) }));
  return { v: 1, recorder: { pid, start }, groups: gs };
}

/** What the rest of Foreman holds: record groups, forget them. */
export interface FreezeRecorder {
  /** True when the recorder cannot write (it was installed badly, or the write failed at install). */
  readonly failed: boolean;
  /** The file this recorder owns, or null when it has none (failed). */
  readonly file: string | null;
  /** Add groups (a group already held under the same pgid is replaced); written before it returns. */
  record(groups: FreezeGroup[]): Outcome;
  /** Drop the groups with these pgids; written before it returns. */
  forget(pgids: number[]): Outcome;
}

class Recorder implements FreezeRecorder {
  private readonly held = new Map<number, FreezeGroup>();
  private self: Identity | null = null;
  private dir: string | null = null;
  file: string | null = null;
  readonly home: string | null;
  failedWith: string | null = null;

  constructor(home: unknown, self: unknown) {
    this.home = typeof home === 'string' ? home : null;
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
      this.failedWith = 'the home is missing or not an absolute path';
      return;
    }
    const s = self as Partial<Identity> | null | undefined;
    if (!s || typeof s !== 'object' || !isId(s.pid) || !isStart(s.start) || !startKey(s.start)) {
      this.failedWith = 'the recorder has no valid pid and start';
      return;
    }
    this.self = { pid: s.pid, start: s.start };
    this.dir = freezeDir(home);
    const file = path.join(this.dir, recordFileName(this.self));
    const w = this.flush(file);
    if (w.ok) this.file = file;
    else this.failedWith = w.error;
  }

  get failed(): boolean {
    return this.failedWith !== null;
  }

  get empty(): boolean {
    return this.held.size === 0;
  }

  record(groups: FreezeGroup[]): Outcome {
    if (this.failedWith !== null) return fail(`the freeze recorder is failed: ${this.failedWith}`);
    const problem = groupsProblem(groups);
    if (problem) return fail(problem);
    const next = new Map(this.held);
    for (const g of groups) next.set(g.pgid, { pgid: g.pgid, members: g.members.map((m): FreezeMember => [m[0], m[1]]) });
    if (next.size > FREEZE_MAX_GROUPS) return fail(`${next.size} groups would be over the bound (${FREEZE_MAX_GROUPS})`);
    return this.commit(next);
  }

  forget(pgids: number[]): Outcome {
    if (this.failedWith !== null) return fail(`the freeze recorder is failed: ${this.failedWith}`);
    const next = new Map(this.held);
    for (const p of pgids) next.delete(p);
    return this.commit(next);
  }

  private commit(next: Map<number, FreezeGroup>): Outcome {
    const before = new Map(this.held);
    this.held.clear();
    for (const [k, v] of next) this.held.set(k, v);
    const w = this.flush(this.file!);
    if (!w.ok) {
      this.held.clear();
      for (const [k, v] of before) this.held.set(k, v);
    }
    return w;
  }

  /** Write the record whole: a temp file in the same directory, then rename over `file`. */
  private flush(file: string): Outcome {
    const record: FreezeRecord = { v: 1, recorder: this.self!, groups: [...this.held.values()] };
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > FREEZE_MAX_BYTES) return fail(`the record would be over ${FREEZE_MAX_BYTES} bytes`);
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.dir!, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir!, 0o700);
      fs.rmSync(tmp, { force: true });
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the write error is the one to report */
      }
      return fail((err as Error).message);
    }
  }

  /** Remove the file when no group is left on it (the sync 'exit' cleanup). */
  cleanup(): void {
    if (this.failedWith !== null || !this.empty || !this.file) return;
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* gone already; nothing more to say at exit */
    }
  }
}

let active: Recorder | null = null;
let exitRegistered = false;

/** The installed recorder, or null when none is (the default: callers then behave as before). */
export function activeRecorder(): FreezeRecorder | null {
  return active;
}

export type InstallResult = { ok: true; recorder: FreezeRecorder } | { ok: false; error: string; recorder: FreezeRecorder | null };

/**
 * Install this process's recorder and write its presence marker (a record with no groups) at once. The same home
 * again is a no-op. Another home is an error and changes nothing. A relative or missing home, a missing `self` or a
 * failed write installs a recorder in a FAILED state: its record() is always an error.
 */
export function installFreezeRecorder(home: string, self: Identity): InstallResult {
  if (!active) {
    active = new Recorder(home, self);
    if (!exitRegistered) {
      exitRegistered = true;
      process.on('exit', () => active?.cleanup());
    }
  } else if (active.home !== home) {
    return { ok: false, error: `a freeze recorder is already installed for ${active.home ?? 'no home'}`, recorder: active };
  }
  return active.failed ? { ok: false, error: active.failedWith!, recorder: active } : { ok: true, recorder: active };
}

/** For tests only: forget the installed recorder (its file is left; the exit hook stays registered). */
export function resetFreezeRecorderForTest(): void {
  active = null;
}

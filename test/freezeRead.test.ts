import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FREEZE_MAX_BYTES, installFreezeRecorder, recordFileName, resetFreezeRecorderForTest } from '../src/runners/freezeRecord.ts';
import { FREEZE_READ_MAX_FILES, readFrozen } from '../src/runners/freezeRead.ts';
import type { ProcRow } from '../src/runners/proctree.ts';
import { NEEDS_PS, procGuard, snapshotFrozen } from './helpers/procguard.ts';

const row = (pid: number, start: string, pgid = pid): ProcRow => ({ pid, ppid: 1, pgid, sid: null, start });
const ID = { pid: 5000, start: 'Fri Oct 16 20:00:00 2026' };
const GROUPS = [{ pgid: 777, members: [[778, 'Fri Oct 16 20:00:01 2026']] }];
const json = (recorder = ID, groups: unknown = GROUPS) => JSON.stringify({ v: 1, recorder, groups });
const put = (home: string, name: string, text: string) => {
  fs.mkdirSync(path.join(home, 'frozen'), { recursive: true });
  fs.writeFileSync(path.join(home, 'frozen', name), text);
};
const putRecord = (home: string, rec = ID, groups: unknown = GROUPS) => put(home, recordFileName(rec), json(rec, groups));

/** A live child: its row as ps gives it, so the start is a real one. */
async function liveChild(g: ReturnType<typeof procGuard>): Promise<ProcRow> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  g.track(child.pid);
  await new Promise((r) => child.once('spawn', r));
  const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }).stdout.trim();
  assert.ok(start, 'ps gave the child a start');
  return row(child.pid!, start);
}

test('a record whose recorder is absent or has another start is actionable; one whose recorder is alive is kept', (t) => {
  const g = procGuard(t);
  putRecord(g.home, ID); // pid 5000, alive in the snapshot below
  putRecord(g.home, { pid: 5001, start: 'Fri Oct 16 20:00:00 2026' }); // absent
  putRecord(g.home, { pid: 5002, start: 'Fri Oct 16 20:00:00 2026' }); // pid alive, start differs
  const procs = [row(5000, ID.start), row(5002, 'Sat Oct 17 01:00:00 2026')];
  const r = readFrozen(g.home, procs, null);
  assert.deepEqual(r.kept.map((k) => k.file), ['5000-FriOct162000002026.json']);
  assert.deepEqual(r.actionable.map((k) => k.file), ['5001-FriOct162000002026.json', '5002-FriOct162000002026.json']);
  assert.deepEqual(r.actionable[0]!.record.groups, GROUPS);
  assert.deepEqual(r.skipped, []);
});

test('a null snapshot returns nothing actionable, kept or held', (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 5001, start: 'x' });
  const r = readFrozen(g.home, null, null);
  assert.deepEqual([r.actionable, r.kept, r.skipped, [...r.held]], [[], [], [], []]);
});

test('a missing frozen directory reads as empty', (t) => {
  const g = procGuard(t);
  const r = readFrozen(g.home, [], null);
  assert.deepEqual([r.actionable, r.kept, r.skipped, r.cursor], [[], [], [], null]);
});

test('a symbolic link is skipped, and what it points at is not read', (t) => {
  const g = procGuard(t);
  const target = path.join(g.home, 'elsewhere.json');
  fs.writeFileSync(target, json({ pid: 5001, start: 'x' }));
  fs.mkdirSync(path.join(g.home, 'frozen'));
  fs.symlinkSync(target, path.join(g.home, 'frozen', '5001-x.json'));
  const r = readFrozen(g.home, [], null);
  assert.deepEqual(r.actionable, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /symbolic link/);
});

test('a directory and a fifo named like a record are skipped as not regular files', (t) => {
  const g = procGuard(t);
  fs.mkdirSync(path.join(g.home, 'frozen', '5001-x.json'), { recursive: true });
  const fifo = path.join(g.home, 'frozen', '5002-x.json');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const r = readFrozen(g.home, [], null);
  assert.deepEqual(r.skipped.map((s) => [s.file, s.reason]), [['5001-x.json', 'not a regular file'], ['5002-x.json', 'not a regular file']]);
});

test('an oversized file is skipped', (t) => {
  const g = procGuard(t);
  put(g.home, '5001-x.json', ' '.repeat(FREEZE_MAX_BYTES + 1) + json({ pid: 5001, start: 'x' }));
  const r = readFrozen(g.home, [], null);
  assert.deepEqual(r.actionable, []);
  assert.match(r.skipped[0]!.reason, /size bound/);
});

test('a file with a bad field is skipped (pid 0, a non-list groups, not JSON)', (t) => {
  const g = procGuard(t);
  put(g.home, '5001-x.json', json({ pid: 0, start: 'x' }));
  put(g.home, '5002-x.json', json({ pid: 5002, start: 'x' }, 'nope'));
  put(g.home, '5003-x.json', '{not json');
  const r = readFrozen(g.home, [], null);
  assert.deepEqual(r.actionable, []);
  assert.deepEqual(r.skipped.map((s) => [s.file, s.reason]), ['5001-x.json', '5002-x.json', '5003-x.json'].map((f) => [f, 'not a valid freeze record']));
});

test('a file whose name disagrees with its content is skipped', (t) => {
  const g = procGuard(t);
  put(g.home, '5999-FriOct162000002026.json', json(ID)); // content says pid 5000
  put(g.home, '5000-Other.json', json(ID)); // content says another start
  const r = readFrozen(g.home, [], null);
  assert.deepEqual(r.actionable, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), Array(2).fill('the file name disagrees with its content'));
});

test('held (1): every group of a record whose recorder is alive; not those of a dead recorder', { ...NEEDS_PS }, async (t) => {
  const g = procGuard(t);
  const child = await liveChild(g);
  resetFreezeRecorderForTest();
  const rec = installFreezeRecorder(g.home, { pid: child.pid, start: child.start });
  assert.equal(rec.ok, true);
  assert.equal(rec.recorder!.record([{ pgid: 4321, members: [[4322, 's']] }, { pgid: 4400, members: [] }]).ok, true);
  resetFreezeRecorderForTest();
  putRecord(g.home, { pid: 5001, start: 'dead' }, [{ pgid: 6001, members: [] }]); // recorder absent
  const r = readFrozen(g.home, [child], null);
  assert.deepEqual([...r.held].sort(), [child.pid, 4321, 4400].sort());
  assert.deepEqual(r.actionable.map((a) => a.record.recorder.pid), [5001]);
});

test('held (1) negative: the same record with a start mismatch holds nothing and is actionable', { ...NEEDS_PS }, async (t) => {
  const g = procGuard(t);
  const child = await liveChild(g);
  resetFreezeRecorderForTest();
  installFreezeRecorder(g.home, { pid: child.pid, start: 'Mon Jan  1 00:00:00 2001' }).recorder!.record([{ pgid: 4321, members: [] }]);
  resetFreezeRecorderForTest();
  const r = readFrozen(g.home, [child], null);
  assert.deepEqual([...r.held], []);
  assert.equal(r.actionable.length, 1);
});

test('held (2): a live process with its marker holds its own pgid', { ...NEEDS_PS }, async (t) => {
  const g = procGuard(t);
  const child = await liveChild(g);
  resetFreezeRecorderForTest();
  assert.equal(installFreezeRecorder(g.home, { pid: child.pid, start: child.start }).ok, true); // groups: []
  resetFreezeRecorderForTest();
  const r = readFrozen(g.home, [child, row(1, 'init')], null);
  assert.deepEqual([...r.held], [child.pid]);
  assert.equal(r.kept.length, 1);
});

test('held (2) negative: a live process with no marker, or a marker with another start, holds nothing', { ...NEEDS_PS }, async (t) => {
  const g = procGuard(t);
  const child = await liveChild(g);
  assert.deepEqual([...readFrozen(g.home, [child], null).held], []); // no frozen/ at all
  resetFreezeRecorderForTest();
  installFreezeRecorder(g.home, { pid: child.pid, start: 'Mon Jan  1 00:00:00 2001' }); // marker of an earlier owner of the pid
  resetFreezeRecorderForTest();
  const r = readFrozen(g.home, [child], null);
  assert.deepEqual([...r.held], []);
  assert.equal(r.actionable.length, 1);
});

test('64 kept files and 1 valid dead record: the dead one is returned within two calls', (t) => {
  const g = procGuard(t);
  const procs: ProcRow[] = [];
  for (let i = 0; i < FREEZE_READ_MAX_FILES; i++) {
    const pid = 100 + i;
    if (i % 2 === 0) {
      put(g.home, `${pid}-a.json`, '{garbage'); // unreadable
    } else {
      putRecord(g.home, { pid, start: 'a' }, []); // live recorder
      procs.push(row(pid, 'a'));
    }
  }
  putRecord(g.home, { pid: 9000, start: 'a' }, GROUPS); // valid, dead; sorts after the 64
  const first = readFrozen(g.home, procs, null);
  assert.equal(first.kept.length + first.skipped.length, FREEZE_READ_MAX_FILES);
  assert.equal(first.actionable.length, 0);
  const second = readFrozen(g.home, procs, first.cursor);
  assert.deepEqual(second.actionable.map((a) => a.file), ['9000-a.json']);
});

test('the cursor wraps: a sweep past the last name starts again at the first', (t) => {
  const g = procGuard(t);
  for (const pid of [11, 12, 13]) putRecord(g.home, { pid, start: 'a' }, []);
  const a = readFrozen(g.home, [], '12-a.json');
  assert.deepEqual(a.actionable.map((x) => x.file), ['13-a.json', '11-a.json', '12-a.json']);
  assert.equal(a.cursor, '12-a.json');
});

test('reading changes nothing in frozen/', (t) => {
  const g = procGuard(t);
  putRecord(g.home);
  put(g.home, '5001-x.json', '{bad');
  const before = snapshotFrozen(path.join(g.home, 'frozen'));
  readFrozen(g.home, [row(5000, ID.start)], null);
  assert.deepEqual(snapshotFrozen(path.join(g.home, 'frozen')), before);
});

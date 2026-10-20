import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FREEZE_MAX_BYTES,
  FREEZE_MAX_GROUPS,
  FREEZE_MEMBERS_MAX,
  FREEZE_START_MAX,
  activeRecorder,
  installFreezeRecorder,
  nameMatchesRecord,
  parseFreezeRecord,
  parseRecordName,
  recordFileName,
  resetFreezeRecorderForTest,
  startKey,
} from '../src/runners/freezeRecord.ts';
import { procGuard } from './helpers/procguard.ts';

const SELF = { pid: 4242, start: 'Fri Oct 16 20:00:00 2026' };
const FILE = '4242-FriOct162000002026.json';
const MODULE = fileURLToPath(new URL('../src/runners/freezeRecord.ts', import.meta.url));

const group = (pgid: number, n = 1) => ({ pgid, members: Array.from({ length: n }, (_, i): [number, string] => [pgid + i, `s${i}`]) });
const read = (home: string, name = FILE) => JSON.parse(fs.readFileSync(path.join(home, 'frozen', name), 'utf8'));

test('activeRecorder is null until one is installed', () => {
  resetFreezeRecorderForTest();
  assert.equal(activeRecorder(), null);
});

test('install writes the presence marker at once: the file name, the content, the modes', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const r = installFreezeRecorder(g.home, SELF);
  assert.equal(r.ok, true);
  assert.equal(activeRecorder(), r.recorder);
  assert.deepEqual(fs.readdirSync(path.join(g.home, 'frozen')), [FILE]);
  assert.deepEqual(read(g.home), { v: 1, recorder: SELF, groups: [] });
  assert.equal(fs.statSync(path.join(g.home, 'frozen')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(g.home, 'frozen', FILE)).mode & 0o777, 0o600);
  resetFreezeRecorderForTest();
});

test('an existing frozen dir with loose modes is chmodded to 0700', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  fs.mkdirSync(path.join(g.home, 'frozen'), { mode: 0o755 });
  fs.chmodSync(path.join(g.home, 'frozen'), 0o755);
  installFreezeRecorder(g.home, SELF);
  assert.equal(fs.statSync(path.join(g.home, 'frozen')).mode & 0o777, 0o700);
  resetFreezeRecorderForTest();
});

test('install is idempotent for the same home and an error for another, which changes nothing', (t) => {
  const g = procGuard(t);
  const other = procGuard(t);
  resetFreezeRecorderForTest();
  const first = installFreezeRecorder(g.home, SELF);
  assert.equal(first.ok, true);
  assert.equal(first.recorder!.record([group(10)]).ok, true);
  const again = installFreezeRecorder(g.home, SELF);
  assert.equal(again.ok, true);
  assert.equal(again.recorder, first.recorder);
  assert.equal(read(g.home).groups.length, 1, 'the second install did not rewrite the file empty');
  const second = installFreezeRecorder(other.home, SELF);
  assert.equal(second.ok, false);
  assert.equal(activeRecorder(), first.recorder);
  assert.equal(fs.existsSync(path.join(other.home, 'frozen')), false);
  resetFreezeRecorderForTest();
});

test('a relative home, a missing home or a missing self installs a FAILED recorder whose record is an error', (t) => {
  const g = procGuard(t);
  for (const [home, self] of [
    ['relative/home', SELF],
    [undefined, SELF],
    [g.home, undefined],
  ] as const) {
    resetFreezeRecorderForTest();
    const r = installFreezeRecorder(home as string, self as never);
    assert.equal(r.ok, false);
    const rec = activeRecorder();
    assert.ok(rec, 'a failed recorder is still installed');
    assert.equal(rec.failed, true);
    assert.equal(rec.record([group(10)]).ok, false);
    assert.equal(rec.forget([10]).ok, false);
  }
  assert.deepEqual(fs.readdirSync(g.home), [], 'nothing was written');
  assert.equal(fs.existsSync('relative'), false);
  resetFreezeRecorderForTest();
});

test('a failed write at install installs a FAILED recorder', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  fs.writeFileSync(path.join(g.home, 'frozen'), 'a file where the directory should be');
  const r = installFreezeRecorder(g.home, SELF);
  assert.equal(r.ok, false);
  assert.equal(activeRecorder()!.failed, true);
  assert.equal(activeRecorder()!.record([group(10)]).ok, false);
  resetFreezeRecorderForTest();
});

test('record and forget rewrite the file; the content is the format {v, recorder, groups}', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const rec = installFreezeRecorder(g.home, SELF).recorder!;
  assert.deepEqual(rec.record([group(10, 2), group(20)]), { ok: true });
  assert.deepEqual(read(g.home), {
    v: 1,
    recorder: SELF,
    groups: [
      { pgid: 10, members: [[10, 's0'], [11, 's1']] },
      { pgid: 20, members: [[20, 's0']] },
    ],
  });
  assert.deepEqual(rec.forget([10]), { ok: true });
  assert.deepEqual(read(g.home).groups, [{ pgid: 20, members: [[20, 's0']] }]);
  assert.deepEqual(rec.forget([20]), { ok: true });
  assert.deepEqual(read(g.home).groups, []);
  resetFreezeRecorderForTest();
});

test('over-bound input is refused with an error and the file is unchanged', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const rec = installFreezeRecorder(g.home, SELF).recorder!;
  rec.record([group(10)]);
  const tooMany = Array.from({ length: FREEZE_MAX_GROUPS + 1 }, (_, i) => group(i + 100));
  const tooBig = group(30, FREEZE_MEMBERS_MAX + 1);
  const longStart = { pgid: 31, members: [[31, 'x'.repeat(FREEZE_START_MAX + 1)] as [number, string]] };
  for (const bad of [tooMany, [tooBig], [longStart]]) {
    const r = rec.record(bad);
    assert.equal(r.ok, false);
  }
  // Held and new together over the bound is refused too, not cut to fit.
  rec.record(Array.from({ length: FREEZE_MAX_GROUPS - 1 }, (_, i) => group(i + 1000)));
  assert.equal(rec.record([group(5000), group(5001)]).ok, false);
  assert.equal(read(g.home).groups.length, FREEZE_MAX_GROUPS, 'the refused call changed nothing');
  resetFreezeRecorderForTest();
});

test('the exact bounds are accepted: 4 members, a start of the maximum length', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const rec = installFreezeRecorder(g.home, SELF).recorder!;
  assert.equal(rec.record([group(10, FREEZE_MEMBERS_MAX)]).ok, true);
  assert.equal(rec.record([{ pgid: 11, members: [[11, 'y'.repeat(FREEZE_START_MAX)]] }]).ok, true);
  resetFreezeRecorderForTest();
});

test('a recorder start over the bound installs a FAILED recorder', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const r = installFreezeRecorder(g.home, { pid: 4242, start: 'z'.repeat(FREEZE_START_MAX + 1) });
  assert.equal(r.ok, false);
  assert.equal(activeRecorder()!.failed, true);
  resetFreezeRecorderForTest();
});

test('a full record stays under the file byte bound', () => {
  const groups = Array.from({ length: FREEZE_MAX_GROUPS }, (_, i) => ({
    pgid: 4_000_000_000 + i,
    members: Array.from({ length: FREEZE_MEMBERS_MAX }, (): [number, string] => [4_000_000_000, 'x'.repeat(FREEZE_START_MAX)]),
  }));
  const text = JSON.stringify({ v: 1, recorder: { pid: 4_000_000_000, start: 'x'.repeat(FREEZE_START_MAX) }, groups });
  assert.ok(Buffer.byteLength(text) < FREEZE_MAX_BYTES);
  assert.ok(parseFreezeRecord(text));
  assert.equal(parseFreezeRecord(' '.repeat(FREEZE_MAX_BYTES) + text), null, 'over the byte bound is not read');
});

test('the write is a temp file in the same dir renamed over the record, and a failed rename leaves the old record', (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const rec = installFreezeRecorder(g.home, SELF).recorder!;
  rec.record([group(10)]);
  const dir = path.join(g.home, 'frozen');
  const calls: Array<[string, string]> = [];
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    calls.push([from, to]);
    throw new Error('rename refused');
  });
  const r = rec.record([group(20)]);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(path.dirname(calls[0]![0]), dir, 'the temp file is in the record\'s directory');
  assert.equal(calls[0]![1], path.join(dir, FILE));
  assert.deepEqual(fs.readdirSync(dir), [FILE], 'no temp file is left');
  assert.deepEqual(read(g.home).groups, [{ pgid: 10, members: [[10, 's0']] }], 'the old record is whole');
  t.mock.restoreAll();
  assert.equal(fs.renameSync, real);
  assert.equal(rec.record([group(30)]).ok, true, 'the failed write was not held: the next one starts from the old record');
  assert.deepEqual(read(g.home).groups.map((x: { pgid: number }) => x.pgid), [10, 30]);
  resetFreezeRecorderForTest();
});

test('the read contract: a record parses, a bad one does not, and the name must match the content', () => {
  const ok = JSON.stringify({ v: 1, recorder: SELF, groups: [group(10, 2)] });
  const rec = parseFreezeRecord(ok)!;
  assert.deepEqual(rec, { v: 1, recorder: SELF, groups: [{ pgid: 10, members: [[10, 's0'], [11, 's1']] }] });
  for (const bad of [
    'not json',
    '[]',
    JSON.stringify({ v: 2, recorder: SELF, groups: [] }),
    JSON.stringify({ v: 1, recorder: { pid: 0, start: 'a' }, groups: [] }),
    JSON.stringify({ v: 1, recorder: { pid: 1, start: '   ' }, groups: [] }),
    JSON.stringify({ v: 1, recorder: SELF }),
    JSON.stringify({ v: 1, recorder: SELF, groups: [group(10, FREEZE_MEMBERS_MAX + 1)] }),
    JSON.stringify({ v: 1, recorder: SELF, groups: [{ pgid: -1, members: [] }] }),
  ]) assert.equal(parseFreezeRecord(bad), null, bad);
  assert.equal(startKey(SELF.start), 'FriOct162000002026');
  assert.equal(recordFileName(SELF), FILE);
  assert.deepEqual(parseRecordName(FILE), { pid: 4242, key: 'FriOct162000002026' });
  assert.equal(parseRecordName('../4242-a.json'), null);
  assert.equal(nameMatchesRecord(FILE, rec), true);
  assert.equal(nameMatchesRecord('4243-FriOct162000002026.json', rec), false, 'another pid');
  assert.equal(nameMatchesRecord('4242-FriOct162000002027.json', rec), false, 'another start');
});

function runChild(home: string, body: string, env: NodeJS.ProcessEnv): void {
  const script = path.join(home, 'child.mjs');
  fs.writeFileSync(
    script,
    `import { installFreezeRecorder } from ${JSON.stringify(MODULE)};
const r = installFreezeRecorder(${JSON.stringify(home)}, { pid: process.pid, start: 'child start' });
if (!r.ok) throw new Error(r.error);
${body}
`,
  );
  const out = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

test('exit cleanup removes an empty file and keeps one with groups', (t) => {
  const g = procGuard(t);
  const dir = path.join(g.home, 'frozen');
  runChild(g.home, '', g.env);
  assert.deepEqual(fs.readdirSync(dir), [], 'the presence marker is gone after a clean exit');

  runChild(g.home, 'r.recorder.record([{ pgid: 77, members: [[77, "m"]] }]);', g.env);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, 'the record with a group is kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8')).groups, [{ pgid: 77, members: [[77, 'm']] }]);

  runChild(g.home, 'r.recorder.record([{ pgid: 77, members: [[77, "m"]] }]); r.recorder.forget([77]);', g.env);
  assert.equal(fs.readdirSync(dir).length, 1, 'only the first child\'s kept record remains; the one that forgot its group removed its own');
});

import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { recordFileName } from '../src/runners/freezeRecord.ts';
import { FREEZE_READ_MAX_FILES } from '../src/runners/freezeRead.ts';
import { runFreezeSweep, sweepFrozen, type FreezeSweepOptions } from '../src/runners/freezeSweep.ts';
import { signalGroups, snapshotProcs, type ProcRow } from '../src/runners/proctree.ts';
import { NEEDS_PS as PS, procGuard, stoppedPids, type ProcGuard } from './helpers/procguard.ts';

const NEEDS_PS = { ...PS, timeout: 120_000 };
const START = 'Fri Oct 16 20:00:00 2026';
const row = (pid: number, start = START, pgid = pid, ppid = 1): ProcRow => ({ pid, ppid, pgid, sid: null, start });
const putRecord = (home: string, rec: { pid: number; start: string }, groups: unknown = []) => {
  fs.mkdirSync(path.join(home, 'frozen'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'frozen', recordFileName(rec)), JSON.stringify({ v: 1, recorder: rec, groups }));
};
const recordNames = (home: string) => (fs.existsSync(path.join(home, 'frozen')) ? fs.readdirSync(path.join(home, 'frozen')).filter((n) => n.endsWith('.json')).sort() : []);
const running = (pid: number): boolean => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
};
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

/** Options with every signal logged (and, where `real`, really sent) and a short grace. */
function harness(home: string, extra: Partial<FreezeSweepOptions> = {}, real = true) {
  const sent: string[] = [];
  const logs: string[] = [];
  const opts: FreezeSweepOptions = {
    home,
    graceMs: 100,
    log: (l) => logs.push(l),
    signal: (groups, sig) => {
      const list = [...groups];
      for (const g of list) sent.push(`${sig}:${g}`);
      return real ? signalGroups(list, sig) : list;
    },
    ...extra,
  };
  return { opts, sent, logs };
}

/** Fake table: this process (900, under 800), its ancestor 800, launchd, and `more`. */
const fakeRows = (...more: ProcRow[]): ProcRow[] => [row(1), row(800, START, 800), row(900, START, 900, 800), ...more];
const fake = (rows: ProcRow[]) => ({ snapshot: async () => rows, selfPid: 900 });

/** A recorder process (a real child) that froze a real group and is then SIGKILLed. */
async function frozenByDeadRecorder(t: TestContext, g: ProcGuard, mode: 'ignore' | 'obey'): Promise<{ pgid: number; recorder: ChildProcess }> {
  const script = path.join(import.meta.dirname, 'helpers', 'freezeChild.ts');
  const recorder = spawn(process.execPath, [script, mode], { env: g.env, stdio: ['ignore', 'pipe', 'inherit'] });
  g.track(recorder.pid);
  let out = '';
  recorder.stdout!.on('data', (d) => { out += d; });
  assert.ok(await until(() => /frozen \d+/.test(out), 60_000), `the recorder froze a group: ${out}`);
  const pgid = Number(/frozen (\d+)/.exec(out)![1]);
  g.track(pgid);
  // Every member too: procGuard's end check throws when one is left stopped, and node then skips the later t.after
  // hooks (the group kill below), so a failing test would otherwise leave the group's sleep in state T for good.
  for (const r of (await snapshotProcs()) ?? []) if (r.pgid === pgid) g.track(r.pid);
  t.after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } });
  // Reaped, not just a zombie: a zombie is still in the process table, so the sweep would see its recorder alive.
  const exited = new Promise((r) => recorder.once('exit', r));
  recorder.kill('SIGKILL');
  await exited;
  assert.ok(await until(() => spawnSync('ps', ['-p', String(recorder.pid)]).status !== 0, 10_000), 'the recorder is gone from the table');
  return { pgid, recorder };
}

test('a recorder SIGKILLed mid-freeze: the sweep ends its group with TERM, CONT, then KILL on a fresh match, and removes the record', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const { pgid } = await frozenByDeadRecorder(t, g, 'ignore');
  assert.equal(recordNames(g.home).length, 1, 'the dead recorder left its record');
  assert.deepEqual(stoppedPids([pgid]), [pgid], 'the group is frozen (state T)');
  const h = harness(g.home);
  const report = await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, [`SIGTERM:${pgid}`, `SIGCONT:${pgid}`, `SIGKILL:${pgid}`]);
  assert.deepEqual(report.signalled, [pgid]);
  assert.ok(await until(() => !running(pgid), 10_000), 'the group is gone');
  assert.deepEqual(recordNames(g.home), []);
});

test('a group that ends on TERM and CONT gets no SIGKILL, and its record goes', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const { pgid } = await frozenByDeadRecorder(t, g, 'obey');
  const h = harness(g.home, { graceMs: 1_000 });
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, [`SIGTERM:${pgid}`, `SIGCONT:${pgid}`]);
  assert.ok(await until(() => !running(pgid), 10_000));
  assert.deepEqual(recordNames(g.home), []);
});

test('a live process\'s group named by a dead record is left alone, and the dead record goes', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const live = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  g.track(live.pid);
  await new Promise((r) => live.once('spawn', r));
  const rows = (await snapshotProcs())!;
  const me = rows.find((r) => r.pid === live.pid)!;
  putRecord(g.home, { pid: me.pid, start: me.start }); // its presence marker: the group it leads is held
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: me.pid, members: [[me.pid, me.start]] }]);
  const h = harness(g.home);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.ok(running(live.pid!), 'the held group was not signalled');
  assert.deepEqual(recordNames(g.home), [recordFileName(me)], 'only the live marker is left');
});

test('a pid that matches with another start, and a start with another pid, are not signalled; their records go', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const live = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  g.track(live.pid);
  await new Promise((r) => live.once('spawn', r));
  const me = (await snapshotProcs())!.find((r) => r.pid === live.pid)!;
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: me.pid, members: [[me.pid, 'Mon Jan  1 00:00:00 2001']] }]);
  putRecord(g.home, { pid: 4_000_002, start: START }, [{ pgid: me.pid, members: [[me.pid + 1_000_000, me.start]] }]);
  const h = harness(g.home);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.ok(running(live.pid!));
  assert.deepEqual(recordNames(g.home), []);
});

test('groups 1, our own, an ancestor\'s and a held one are never signalled; another group is, TERM then CONT then KILL', async (t) => {
  const g = procGuard(t);
  const rows = fakeRows(row(700), row(701, START, 701), row(5000));
  const member = (r: ProcRow) => [r.pid, r.start];
  putRecord(g.home, { pid: 4_000_001, start: START }, [1, 900, 800, 701, 700].map((pgid) => ({ pgid, members: [[pgid, START]] })));
  putRecord(g.home, { pid: 5000, start: START }, [{ pgid: 701, members: [member(row(701))] }]); // 5000 is alive: 701 is held
  const h = harness(g.home, fake(rows), false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, ['SIGTERM:700', 'SIGCONT:700', 'SIGKILL:700']);
  assert.deepEqual(recordNames(g.home), [recordFileName({ pid: 5000, start: START })]);
});

test('against the real process table: our own group, our parent\'s and group 1 are never signalled, and pgid 0 is no record at all', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const rows = (await snapshotProcs())!;
  const byPid = (pid: number): ProcRow => rows.find((r) => r.pid === pid)!;
  const self = byPid(process.pid);
  const parent = byPid(process.ppid);
  const init = byPid(1);
  assert.ok(self && parent && init, 'the table has this process, its parent and pid 1');
  const group = (r: ProcRow, pgid = r.pgid) => ({ pgid, members: [[r.pid, r.start]] });
  putRecord(g.home, { pid: 4_000_001, start: START }, [group(self), group(parent), group(init, 1)]);
  // pgid 0 cannot be written into a valid record: the reader skips the whole file.
  fs.writeFileSync(path.join(g.home, 'frozen', recordFileName({ pid: 4_000_002, start: START })),
    JSON.stringify({ v: 1, recorder: { pid: 4_000_002, start: START }, groups: [{ pgid: 0, members: [[self.pid, self.start]] }] }));
  const h = harness(g.home, {}, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, [], 'nothing is signalled');
  assert.deepEqual(recordNames(g.home), [recordFileName({ pid: 4_000_002, start: START })], 'the dealt-with record went; the pgid-0 file is skipped, not acted on');
  assert.ok(h.logs.some((l) => /4000002-.*skipped/.test(l)), h.logs.join('\n'));
});

/** Two detached `sleep`s of our own, each leading its own group, with their snapshot rows. */
async function twoSleeps(g: ProcGuard): Promise<[ProcRow, ProcRow]> {
  const kids: ChildProcess[] = [];
  for (let i = 0; i < 2; i++) {
    const k = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    g.track(k.pid);
    await new Promise((r) => k.once('spawn', r));
    kids.push(k);
  }
  const rows = (await snapshotProcs())!;
  const [a, b] = kids.map((k) => rows.find((r) => r.pid === k.pid)!);
  assert.ok(a && b && a.pgid === a.pid && b.pgid === b.pid, 'each sleep leads its own group');
  return [a, b];
}

test('a dead record\'s group with no members matches nothing: a live group of that pgid is not signalled, and the record goes', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const [, other] = await twoSleeps(g);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: other.pgid, members: [] }]);
  const h = harness(g.home, {}, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.ok(running(other.pid));
  assert.deepEqual(recordNames(g.home), []);
});

test('a member alive with its pid and start but now in another group does not make the recorded group a match', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const [moved, other] = await twoSleeps(g);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: other.pgid, members: [[moved.pid, moved.start]] }]);
  const h = harness(g.home, {}, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(recordNames(g.home), []);
});

test('against the real process table: the group of an ancestor other than our own group is never signalled', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const rows = (await snapshotProcs())!;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const self = byPid.get(process.pid)!;
  let anc: ProcRow | undefined;
  for (let r = byPid.get(self.ppid); r && r.pid > 1; r = byPid.get(r.ppid)) {
    if (r.pgid !== self.pgid && r.pgid > 1) {
      anc = r;
      break;
    }
  }
  if (!anc) {
    t.skip('no ancestor outside our own group (other than pid 1)');
    return;
  }
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: anc.pgid, members: [[anc.pid, anc.start]] }]);
  const h = harness(g.home, {}, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(recordNames(g.home), []);
});

test('this process missing from the snapshot: nothing is signalled and the records are kept', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const h = harness(g.home, { snapshot: async () => [row(1), row(700)], selfPid: 900 }, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.equal(recordNames(g.home).length, 1);
  assert.ok(h.logs.some((l) => /not in the snapshot/.test(l)), h.logs.join('\n'));
});

test('the SIGKILL check comes after the grace', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const rows = fakeRows(row(700));
  const at: number[] = [];
  const h = harness(g.home, { graceMs: 300, selfPid: 900, snapshot: async () => { at.push(performance.now()); return rows; } }, false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, ['SIGTERM:700', 'SIGCONT:700', 'SIGKILL:700']);
  assert.equal(at.length, 2);
  assert.ok(at[1]! - at[0]! >= 290, `the second snapshot came ${at[1]! - at[0]!} ms after the first`);
});

test('after an overrun the sweep sends nothing more and removes nothing: in the first snapshot, and in the grace', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const rows = fakeRows(row(700));
  const late = harness(g.home, { graceMs: 50, capMs: 100, selfPid: 900, snapshot: () => new Promise((r) => setTimeout(() => r(rows), 300)) }, false);
  assert.equal(await runFreezeSweep(late.opts), null);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(late.sent, [], 'a first snapshot that comes after the cap starts nothing');
  const inGrace = harness(g.home, { graceMs: 300, capMs: 100, selfPid: 900, snapshot: async () => rows }, false);
  assert.equal(await runFreezeSweep(inGrace.opts), null);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(inGrace.sent, ['SIGTERM:700', 'SIGCONT:700'], 'no SIGKILL after the cap');
  assert.equal(recordNames(g.home).length, 1, 'the record is kept for the next start');
});

test('stale temp files: a dead recorder\'s regular .json.tmp goes unread; a live one\'s, a link, a directory and other names stay', async (t) => {
  const g = procGuard(t);
  const dir = path.join(g.home, 'frozen');
  fs.mkdirSync(dir, { mode: 0o700 });
  const dead = `${recordFileName({ pid: 4_000_001, start: START })}.tmp`;
  // Content a record would have, naming a group that matches: it must not be read as one.
  fs.writeFileSync(path.join(dir, dead), JSON.stringify({ v: 1, recorder: { pid: 4_000_001, start: START }, groups: [{ pgid: 700, members: [[700, START]] }] }));
  const liveTmp = `${recordFileName({ pid: 5000, start: START })}.tmp`;
  fs.writeFileSync(path.join(dir, liveTmp), '{');
  const target = path.join(g.home, 'target');
  fs.writeFileSync(target, 'keep');
  const link = `${recordFileName({ pid: 4_000_002, start: START })}.tmp`;
  fs.symlinkSync(target, path.join(dir, link));
  const sub = `${recordFileName({ pid: 4_000_003, start: START })}.tmp`;
  fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, 'junk.json.tmp'), 'x');
  const h = harness(g.home, fake(fakeRows(row(700), row(5000))), false);
  const report = await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, [], 'a temp file is never read as a record');
  assert.deepEqual(report.removedTemps, [dead]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [liveTmp, link, sub, 'junk.json.tmp'].sort());
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('frozen/ writable by group or others: nothing is read, signalled or removed', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 4_000_001, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const stale = `${recordFileName({ pid: 4_000_002, start: START })}.tmp`;
  fs.writeFileSync(path.join(g.home, 'frozen', stale), 'x');
  fs.chmodSync(path.join(g.home, 'frozen'), 0o777);
  const h = harness(g.home, fake(fakeRows(row(700))), false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.equal(fs.readdirSync(path.join(g.home, 'frozen')).length, 2);
  assert.ok(h.logs.some((l) => /writable by group or others/.test(l)), h.logs.join('\n'));
});

test('a dead recorder\'s marker, and a record with no matching group, are removed; a live recorder\'s is kept', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 4_000_001, start: START }); // dead marker
  putRecord(g.home, { pid: 4_000_002, start: START }, [{ pgid: 600, members: [[600, START]] }]); // nothing of it left
  putRecord(g.home, { pid: 5000, start: START }); // alive
  const h = harness(g.home, fake(fakeRows(row(5000))), false);
  const report = await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, []);
  assert.equal(report.removed.length, 2);
  assert.deepEqual(recordNames(g.home), [recordFileName({ pid: 5000, start: START })]);
});

for (const [name, second] of [['null', async () => null], ['throws', async () => { throw new Error('injected: no snapshot'); }]] as const) {
  test(`the KILL check ${name} after a real first snapshot: the record is kept and the log says no SIGKILL was sent`, NEEDS_PS, async (t) => {
    const g = procGuard(t);
    const { pgid } = await frozenByDeadRecorder(t, g, 'ignore');
    let calls = 0;
    const h = harness(g.home, { snapshot: () => (++calls === 1 ? snapshotProcs() : second()) });
    const report = await sweepFrozen(h.opts);
    assert.deepEqual(h.sent, [`SIGTERM:${pgid}`, `SIGCONT:${pgid}`]);
    assert.equal(report.kept.length, 1);
    assert.equal(recordNames(g.home).length, 1, 'the record is kept');
    assert.ok(h.logs.some((l) => /no SIGKILL was sent/.test(l)), h.logs.join('\n'));
    assert.ok(running(pgid), 'the group, which ignores TERM, was not killed');
  });
}

test('65 unreadable files and 1 valid record: the valid one is acted on, the cursor carrying the second sweep on', async (t) => {
  const g = procGuard(t);
  fs.mkdirSync(path.join(g.home, 'frozen'), { mode: 0o700 });
  for (let i = 0; i < FREEZE_READ_MAX_FILES + 1; i++) fs.writeFileSync(path.join(g.home, 'frozen', `${10_000 + i}-x.json`), 'not json');
  putRecord(g.home, { pid: 99_000, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const h = harness(g.home, fake(fakeRows(row(700))), false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, [], 'the first sweep reads only the first 64 files');
  const cursor = path.join(g.home, 'frozen', 'cursor');
  assert.equal(fs.statSync(cursor).mode & 0o777, 0o600);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, ['SIGTERM:700', 'SIGCONT:700', 'SIGKILL:700']);
  assert.ok(!recordNames(g.home).includes(recordFileName({ pid: 99_000, start: START })));
});

test('64 kept records and 1 valid dead one: the dead one is acted on within two sweeps', async (t) => {
  const g = procGuard(t);
  const alive = Array.from({ length: FREEZE_READ_MAX_FILES }, (_, i) => row(10_000 + i));
  for (const r of alive) putRecord(g.home, { pid: r.pid, start: r.start });
  putRecord(g.home, { pid: 99_000, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  const h = harness(g.home, fake(fakeRows(row(700), ...alive)), false);
  await sweepFrozen(h.opts);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, ['SIGTERM:700', 'SIGCONT:700', 'SIGKILL:700']);
  assert.equal(recordNames(g.home).length, FREEZE_READ_MAX_FILES);
});

test('an invalid cursor starts the sweep over', async (t) => {
  const g = procGuard(t);
  putRecord(g.home, { pid: 99_000, start: START }, [{ pgid: 700, members: [[700, START]] }]);
  fs.writeFileSync(path.join(g.home, 'frozen', 'cursor'), '../../etc/passwd');
  const h = harness(g.home, fake(fakeRows(row(700))), false);
  await sweepFrozen(h.opts);
  assert.deepEqual(h.sent, ['SIGTERM:700', 'SIGCONT:700', 'SIGKILL:700']);
});

test('the cap is at most grace + 5 s, and an overrun or a throw is logged and returned from', async (t) => {
  const g = procGuard(t);
  const small = harness(g.home, { graceMs: 50, capMs: 200, snapshot: () => new Promise(() => {}) });
  assert.equal(await runFreezeSweep(small.opts), null);
  assert.ok(small.logs.some((l) => /gave up after 200 ms/.test(l)), small.logs.join('\n'));
  const thrower = harness(g.home, { snapshot: async () => { throw new Error('boom'); } });
  assert.equal(await runFreezeSweep(thrower.opts), null);
  assert.ok(thrower.logs.some((l) => /failed: boom/.test(l)));
  // A cap asked for above grace + 5 s is cut to it.
  const big = harness(g.home, { graceMs: 50, capMs: 1_000_000, snapshot: () => new Promise(() => {}) });
  assert.equal(await runFreezeSweep(big.opts), null);
  assert.ok(big.logs.some((l) => /gave up after 5050 ms/.test(l)), big.logs.join('\n'));
});

/**
 * A scratch serve with the given freeze-sweep fault (none: a real sweep) and FOREMAN_HOME relative to its cwd;
 * `prepare` gets the home first. Resolves with its output up to "foreman up".
 */
async function serveWith(t: TestContext, fault: string | null, prepare: (home: string) => void = () => {}): Promise<string> {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sweep-serve-')));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  prepare(path.join(parent, 'home'));
  const env: NodeJS.ProcessEnv = {
    ...process.env, FOREMAN_HOME: 'home', FOREMAN_DB: path.join(parent, 'scratch.db'), FOREMAN_PORT: '0',
    FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on', FOREMAN_CLAUDE_BIN: path.join(parent, 'no-claude'),
    FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off', FOREMAN_FREEZE_SWEEP_GRACE_MS: '50', FOREMAN_FREEZE_SWEEP_CAP_MS: '300',
  };
  if (fault !== null) env['FOREMAN_FREEZE_SWEEP_FAULT'] = fault;
  else delete env['FOREMAN_FREEZE_SWEEP_FAULT'];
  delete env['FOREMAN_RUN_ID'];
  const child = spawn(process.execPath, [cli, 'serve'], { cwd: parent, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, 'SIGKILL');
    fs.rmSync(parent, { recursive: true, force: true });
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (/^foreman up .*$/m.test(out)) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error(`serve exited before "foreman up": ${out}`)));
  });
  return out;
}

test('serve reaches listen when the snapshot hangs past the cap, and logs it', { timeout: 120_000 }, async (t) => {
  const out = await serveWith(t, 'hang');
  assert.match(out, /freeze sweep: gave up after 300 ms/);
});

test('serve reaches listen when the sweep throws, and logs the error', { timeout: 120_000 }, async (t) => {
  const out = await serveWith(t, 'throw');
  assert.match(out, /freeze sweep failed: injected snapshot failure/);
});

test('serve sweeps the home it resolved before it is up: a dead record and a dead recorder\'s temp file are gone', { ...NEEDS_PS, timeout: 120_000 }, async (t) => {
  const record = recordFileName({ pid: 4_000_001, start: START });
  let frozen = '';
  await serveWith(t, null, (home) => {
    putRecord(home, { pid: 4_000_001, start: START });
    frozen = path.join(home, 'frozen');
    fs.writeFileSync(path.join(frozen, `${record}.tmp`), 'x');
  });
  // The cursor, and serve's own presence marker (written after the sweep, which is why the sweep did not count it).
  const left = fs.readdirSync(frozen).filter((n) => n !== 'cursor');
  assert.equal(left.length, 1, `only the cursor and serve's own marker are left: ${left.join(', ')}`);
  assert.ok(left[0]!.endsWith('.json') && left[0] !== record, 'the one other file is a marker, not the dead record');
});

test('at most 64 stale temp files go per sweep; the rest go on the next', async (t) => {
  const g = procGuard(t);
  const dir = path.join(g.home, 'frozen');
  fs.mkdirSync(dir, { mode: 0o700 });
  for (let i = 0; i < FREEZE_READ_MAX_FILES + 1; i++) fs.writeFileSync(path.join(dir, `${recordFileName({ pid: 4_000_000 + i, start: START })}.tmp`), 'x');
  const h = harness(g.home, fake(fakeRows()), false);
  assert.equal((await sweepFrozen(h.opts)).removedTemps.length, FREEZE_READ_MAX_FILES);
  assert.equal((await sweepFrozen(h.opts)).removedTemps.length, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LeftoverReaper, snapshotProcs, type ProcRow, type ReaperOptions } from '../src/runners/proctree.ts';
import {
  FREEZE_MEMBERS_MAX,
  activeRecorder,
  installFreezeRecorder,
  resetFreezeRecorderForTest,
  type FreezeGroup,
} from '../src/runners/freezeRecord.ts';
import { NEEDS_PS as PS, procGuard, type ProcGuard } from './helpers/procguard.ts';

// LeftoverReaper and the freeze record (freezeRecord.ts): recorded before the first SIGSTOP, forgotten once the reap
// has settled (after the grace and the SIGKILL), never at release. The leftovers are real detached process groups.
const NEEDS_PS = { ...PS, timeout: 120_000 };

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

function running(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = r.stdout.trim();
  return r.status === 0 && stat !== '' && !stat.startsWith('Z');
}

/** The groups every record file under `home/frozen` holds, or null where there is no frozen/ directory. */
function recordedGroups(home: string): FreezeGroup[] | null {
  const dir = path.join(home, 'frozen');
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => (JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { groups: FreezeGroup[] }).groups);
}

/** The pgids every record file under `home/frozen` holds, or null where there is no frozen/ directory. */
function recorded(home: string): number[] | null {
  return recordedGroups(home)?.map((g) => g.pgid) ?? null;
}

/** The members a record should hold for `pgid`: the first FREEZE_MEMBERS_MAX of the group's rows in `rows`. */
function membersIn(rows: ProcRow[], pgid: number): [number, string][] {
  return rows.filter((r) => r.pgid === pgid).slice(0, FREEZE_MEMBERS_MAX).map((r): [number, string] => [r.pid, r.start]);
}

/** Make the recorder's next write fail without touching freezeRecord.ts: its temp file's name is taken by a directory. */
function blockWrites(home: string): void {
  const dir = path.join(home, 'frozen');
  const file = fs.readdirSync(dir).find((n) => n.endsWith('.json'));
  assert.ok(file, 'the recorder wrote its presence marker');
  fs.mkdirSync(path.join(dir, `${file}.tmp`, 'block'), { recursive: true });
}

interface Leftover {
  child: ReturnType<typeof spawn>;
  pid: number;
  work: string;
}

/**
 * A command that has exited leaving, in its own group, a process that ignores SIGTERM (so the SIGKILL is needed).
 * `extra` more `sleep 300`s join that group first. `ownGroup`: a second leftover, moved to a group of its own
 * (setpgid), whose pid is `other`.
 */
async function leftover(t: TestContext, g: ProcGuard, opts: { extra?: number; ownGroup?: boolean } = {}): Promise<Leftover & { other?: number }> {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-frz-')));
  const pidFile = path.join(work, 'left.pid');
  const otherFile = path.join(work, 'other.pid');
  const loop = path.join(work, 'loop.sh');
  const sleeps = 'sleep 300 &\n'.repeat(opts.extra ?? 0);
  fs.writeFileSync(loop, `trap '' TERM\n${sleeps}echo $$ > '${pidFile}'\nwhile :; do sleep 0.2; done\n`);
  const otherCmd = opts.ownGroup
    ? `/usr/bin/perl -e 'setpgrp(0, 0); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "300"' '${otherFile}' >/dev/null 2>&1 & while [ ! -s '${otherFile}' ]; do sleep 0.05; done; `
    : '';
  const child = spawn('/bin/sh', ['-c', `${otherCmd}/bin/sh '${loop}' >/dev/null 2>&1 & exit 0`], { detached: true, stdio: 'ignore' });
  g.track(child.pid);
  // Every member, not only the ones read below: the loop's current `sleep` is in the group too, and procGuard's own
  // end check (which throws when a test fails) runs before the t.after below, which node then skips.
  g.trackGroup(child.pid);
  t.after(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
    fs.rmSync(work, { recursive: true, force: true });
  });
  await new Promise<void>((r) => child.on('exit', () => r()));
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000), 'fixture started');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  g.track(pid);
  if (!opts.ownGroup) return { child, pid, work };
  const other = Number(fs.readFileSync(otherFile, 'utf8').trim());
  g.track(other);
  g.trackGroup(other);
  t.after(() => {
    try {
      process.kill(-other, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  return { child, pid, work, other };
}

/** Reaper options that log every signal and, at the first SIGSTOP, what the record held (before it goes out). */
function watch(home: string, extra: ReaperOptions = {}, afterStop: () => void = () => {}) {
  const sent: string[] = [];
  const atFirstStop: { held: number[] | null | undefined } = { held: undefined };
  const opts: ReaperOptions = {
    sampleMs: 0,
    graceMs: 300,
    killWaitMs: 1_000,
    kill: (pid, sig) => {
      if (sig !== 0) sent.push(`${sig}`);
      if (sig === 'SIGSTOP' && atFirstStop.held === undefined) atFirstStop.held = recorded(home);
      process.kill(pid, sig);
      if (sig === 'SIGSTOP') afterStop();
    },
    ...extra,
  };
  return { sent, atFirstStop, opts };
}

test('no recorder installed: nothing is written, and the reap freezes, ends and kills as before', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  assert.equal(activeRecorder(), null);
  const l = await leftover(t, g);
  const w = watch(g.home);
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.groups, [l.child.pid]);
  assert.deepEqual(report.killed, [l.child.pid]);
  assert.deepEqual(w.sent.filter((s, i) => w.sent.indexOf(s) === i), ['SIGSTOP', 'SIGTERM', 'SIGCONT', 'SIGKILL']);
  assert.equal(running(l.pid), false);
  assert.equal(activeRecorder(), null);
  assert.equal(fs.existsSync(path.join(g.home, 'frozen')), false, 'no file written');
});

test('normal path: the record holds the group when the first SIGSTOP goes out and is gone after the reap settles', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const l = await leftover(t, g);
  const w = watch(g.home);
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.killed, [l.child.pid], 'it needed the SIGKILL');
  assert.deepEqual(w.atFirstStop.held, [l.child.pid], 'recorded before the SIGSTOP');
  assert.deepEqual(recorded(g.home), [], 'forgotten once settled (the presence marker stays)');
  assert.equal(running(l.pid), false);
});

test('end-for-good (a host with its own SIGHUP listener): the record outlives the release and is gone after the reap settles', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const l = await leftover(t, g);
  const host = (): void => {};
  process.on('SIGHUP', host);
  t.after(() => process.removeListener('SIGHUP', host));
  let heldAfterRelease: number[] | null = null;
  let hupped = false;
  const w = watch(g.home, {}, () => {
    if (hupped) return;
    hupped = true;
    process.emit('SIGHUP');
    heldAfterRelease = recorded(g.home);
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(w.atFirstStop.held, [l.child.pid]);
  assert.deepEqual(heldAfterRelease, [l.child.pid], 'release() does not forget');
  assert.equal(w.sent.filter((s) => s === 'SIGSTOP').length, 1, 'nothing frozen after the hangup');
  assert.deepEqual(recorded(g.home), []);
  assert.equal(running(l.pid), false);
});

test('the bound: the record outlives the timed-out report and is gone when the background reap settles', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const l = await leftover(t, g);
  let looks = 0;
  const w = watch(g.home, {
    boundMs: 300,
    // The look after the SIGSTOP is slow, so the bound fires with the group frozen.
    snapshot: async () => {
      const rows = await snapshotProcs();
      if (++looks === 2) await new Promise((r) => setTimeout(r, 1_500));
      return rows;
    },
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const started = Date.now();
  const report = await reaper.reap();
  assert.equal(report.timedOut, true);
  assert.ok(Date.now() - started < 1_400, 'the injected bound, not a real 15 s');
  assert.deepEqual(w.atFirstStop.held, [l.child.pid]);
  assert.deepEqual(recorded(g.home), [l.child.pid], 'release() at the bound does not forget');
  assert.ok(await until(() => (recorded(g.home) ?? []).length === 0, 30_000), 'forgotten once the background reap settled');
  assert.equal(running(l.pid), false, 'the background reap went on to the SIGKILL');
});

for (const [name, mkHome] of [
  ['a recorder that failed at install (a relative home)', (_g: ProcGuard) => 'relative/home'],
  ['a home that cannot be written', (g: ProcGuard) => {
    const ro = path.join(g.home, 'ro');
    fs.mkdirSync(ro, { mode: 0o500 });
    return ro;
  }],
] as const) {
  test(`${name}: no SIGSTOP is sent that round, SIGTERM still is, and the failure is logged`, NEEDS_PS, async (t) => {
    if (process.getuid?.() === 0) return t.skip('root writes anywhere');
    const g = procGuard(t);
    resetFreezeRecorderForTest();
    t.after(() => resetFreezeRecorderForTest());
    const home = mkHome(g);
    assert.equal(installFreezeRecorder(home, { pid: process.pid, start: 'T0' }).ok, false);
    const logged: string[] = [];
    t.mock.method(console, 'error', (...a: unknown[]) => void logged.push(a.join(' ')));
    const l = await leftover(t, g);
    const w = watch(g.home);
    const reaper = new LeftoverReaper(l.child.pid!, w.opts);
    reaper.childExited();
    const report = await reaper.reap();
    assert.equal(report.error, null);
    assert.equal(w.sent.includes('SIGSTOP'), false, 'nothing was stopped');
    assert.equal(w.sent.includes('SIGTERM'), true, 'but TERM went out');
    assert.deepEqual(report.killed, [l.child.pid]);
    assert.equal(running(l.pid), false);
    assert.ok(logged.some((m) => m.includes('freeze record failed')), 'the change in behaviour is visible in the log');
    assert.equal(fs.existsSync(path.join(g.home, 'frozen')), false);
  });
}

test('the record holds each group with its members from the snapshot that found it, until after the SIGKILL', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  // More members than a record keeps: the record is cut to FREEZE_MEMBERS_MAX, the group is still frozen.
  const l = await leftover(t, g, { extra: FREEZE_MEMBERS_MAX });
  const snaps: ProcRow[][] = [];
  let atKill: number[] | null = null;
  let heldAtStop: FreezeGroup[] = [];
  let wanted: [number, string][] = [];
  const w = watch(g.home, {
    snapshot: async () => {
      const rows = await snapshotProcs();
      if (rows) snaps.push(rows);
      return rows;
    },
    kill: (pid, sig) => {
      if (sig !== 0) w.sent.push(`${sig}`);
      // Checked after the reap: the reaper swallows what its kill throws.
      if (sig === 'SIGSTOP' && w.atFirstStop.held === undefined) {
        heldAtStop = recordedGroups(g.home) ?? [];
        w.atFirstStop.held = heldAtStop.map((x) => x.pgid);
        wanted = membersIn(snaps.at(-1)!, l.child.pid!);
      }
      if (sig === 'SIGKILL' && atKill === null) atKill = recorded(g.home);
      process.kill(pid, sig);
    },
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(heldAtStop, [{ pgid: l.child.pid, members: wanted }], 'members from the snapshot that found the group');
  assert.equal(wanted.length, FREEZE_MEMBERS_MAX, 'cut to the bound, not refused');
  assert.ok(w.sent.includes('SIGSTOP'));
  assert.deepEqual(atKill, [l.child.pid], 'still recorded at the SIGKILL: forgotten after it, not after the TERM');
  assert.deepEqual(recorded(g.home), []);
  assert.equal(running(l.pid), false);
});

test('a second SIGSTOP round records the group it found, from that round\'s snapshot, before stopping it', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const l = await leftover(t, g, { ownGroup: true });
  const other = l.other!;
  let looks = 0;
  let latest: ProcRow[] = [];
  const atStop = new Map<number, FreezeGroup[]>();
  let wanted: [number, string][] = [];
  const w = watch(g.home, {
    // The first look does not see the own-group leftover, so the second round is the one that finds it.
    snapshot: async () => {
      const rows = await snapshotProcs();
      if (!rows) return rows;
      latest = ++looks === 1 ? rows.filter((r) => r.pgid !== other) : rows;
      return latest;
    },
    kill: (pid, sig) => {
      if (sig !== 0) w.sent.push(`${sig}`);
      if (sig === 'SIGSTOP') {
        atStop.set(-pid, recordedGroups(g.home) ?? []);
        if (-pid === other) wanted = membersIn(latest, other);
      }
      process.kill(pid, sig);
    },
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.groups, [l.child.pid!, other].sort((a, b) => a - b));
  assert.deepEqual([...atStop.keys()], [l.child.pid, other], 'one SIGSTOP per round');
  assert.deepEqual(atStop.get(l.child.pid!)!.map((x) => x.pgid), [l.child.pid]);
  assert.deepEqual(atStop.get(other)!.map((x) => x.pgid).sort((a, b) => a - b), [l.child.pid!, other].sort((a, b) => a - b), 'both held');
  assert.ok(wanted.length > 0);
  assert.deepEqual(atStop.get(other)!.find((x) => x.pgid === other)!.members, wanted, 'members from the snapshot that found it');
  assert.deepEqual(recorded(g.home), []);
  assert.equal(running(l.pid), false);
  assert.equal(running(other), false);
});

test('a write that fails after a successful install: no SIGSTOP, TERM and the SIGKILL still go out, and it is logged', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  blockWrites(g.home);
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => void logged.push(a.join(' ')));
  const l = await leftover(t, g);
  const w = watch(g.home);
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.equal(w.sent.includes('SIGSTOP'), false, 'nothing was stopped');
  assert.equal(w.sent.includes('SIGTERM'), true);
  assert.deepEqual(report.killed, [l.child.pid]);
  assert.equal(running(l.pid), false);
  assert.ok(logged.some((m) => m.includes('freeze record failed')));
  assert.deepEqual(recorded(g.home), [], 'the marker is as it was');
});

test('a forget that fails is logged and leaves the record; the reap still ends the leftovers', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => void logged.push(a.join(' ')));
  const l = await leftover(t, g);
  let blocked = false;
  const w = watch(g.home, {}, () => {
    if (blocked) return;
    blocked = true;
    blockWrites(g.home);
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.killed, [l.child.pid]);
  assert.equal(running(l.pid), false);
  assert.ok(logged.some((m) => m.includes('could not clear the freeze record')));
  assert.deepEqual(recorded(g.home), [l.child.pid], 'kept: a later sweep finds nothing alive that matches it');
});

test('an error after the SIGSTOP: the reap reports it, and the record is still forgotten once it settles', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const l = await leftover(t, g);
  let looks = 0;
  const w = watch(g.home, {
    snapshot: async () => {
      if (++looks === 2) throw new Error('injected: the look after the SIGSTOP failed');
      return snapshotProcs();
    },
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.match(report.error ?? '', /injected/);
  assert.deepEqual(w.atFirstStop.held, [l.child.pid]);
  assert.ok(w.sent.includes('SIGKILL'), 'the stopped group still got the grace and the SIGKILL');
  assert.deepEqual(recorded(g.home), [], 'forgotten on the error path too');
  assert.equal(running(l.pid), false);
});

test('two reapers in one process: one settling does not forget the group the other still holds', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  t.after(() => resetFreezeRecorderForTest());
  assert.equal(installFreezeRecorder(g.home, { pid: process.pid, start: 'T0' }).ok, true);
  const a = await leftover(t, g);
  const b = await leftover(t, g);
  let aSettled!: () => void;
  const aDone = new Promise<void>((r) => (aSettled = r));
  let heldWhileBFrozen: number[] | null = null;
  let looksB = 0;
  const wa = watch(g.home);
  const wb = watch(g.home, {
    // B's look after its SIGSTOP waits for A's whole reap: B's group is frozen and recorded while A forgets.
    snapshot: async () => {
      if (++looksB === 2) {
        await aDone;
        heldWhileBFrozen = recorded(g.home);
      }
      return snapshotProcs();
    },
  });
  const ra = new LeftoverReaper(a.child.pid!, wa.opts);
  const rb = new LeftoverReaper(b.child.pid!, wb.opts);
  ra.childExited();
  rb.childExited();
  const pb = rb.reap();
  // A starts once B has stopped its group.
  assert.ok(await until(() => wb.sent.includes('SIGSTOP'), 30_000));
  const repA = await ra.reap();
  aSettled();
  const repB = await pb;
  assert.equal(repA.error, null);
  assert.equal(repB.error, null);
  assert.deepEqual(wa.atFirstStop.held?.sort((x, y) => x - y), [a.child.pid!, b.child.pid!].sort((x, y) => x - y));
  assert.deepEqual(heldWhileBFrozen, [b.child.pid], "A forgot its own group only");
  assert.deepEqual(recorded(g.home), []);
  assert.equal(running(a.pid), false);
  assert.equal(running(b.pid), false);
});

// The process listeners of the reapers (one registry in proctree.ts). SIGTERM and SIGINT are not registered yet: their
// counts are asserted only to show that nothing was added to them.
type Counts = { exit: number; SIGHUP: number; SIGTERM: number; SIGINT: number };

function listenerCounts(): Counts {
  return { exit: process.listenerCount('exit'), SIGHUP: process.listenerCount('SIGHUP'), SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') };
}

/** The listeners on `event` that were not in `before`. */
function addedTo(event: 'exit' | 'SIGHUP', before: Function[]): Function[] {
  const now: Function[] = event === 'exit' ? process.listeners('exit') : process.listeners('SIGHUP');
  return now.filter((l) => !before.includes(l));
}

function stopped(pid: number): boolean {
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('T');
}

test('20 concurrent reapers share one listener per event, and every event\'s listener count is back to its baseline after the last reap', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const base = listenerCounts();
  const leftovers = [];
  for (let i = 0; i < 20; i++) leftovers.push(await leftover(t, g));
  let stops = 0;
  let during: Counts | null = null;
  const reapers = leftovers.map((l) => {
    let looks = 0;
    const w = watch(g.home, {
      graceMs: 200,
      killWaitMs: 1_000,
      boundMs: 60_000,
      // Every reaper's look after its SIGSTOP waits until all 20 have stopped a group: all 20 are enrolled at once.
      snapshot: async () => {
        if (++looks === 2) {
          await until(() => stops >= 20, 60_000);
          during ??= listenerCounts();
        }
        return snapshotProcs();
      },
    }, () => void stops++);
    const r = new LeftoverReaper(l.child.pid!, w.opts);
    r.childExited();
    return r;
  });
  const reports = await Promise.all(reapers.map((r) => r.reap()));
  for (const r of reports) assert.equal(r.error, null);
  assert.ok(during, 'the 20 were frozen together');
  assert.equal((during as Counts).exit, base.exit + 1, "one 'exit' listener for all 20");
  assert.equal((during as Counts).SIGHUP, base.SIGHUP + 1, 'one SIGHUP listener for all 20');
  assert.equal((during as Counts).SIGTERM, base.SIGTERM);
  assert.equal((during as Counts).SIGINT, base.SIGINT);
  assert.deepEqual(listenerCounts(), base);
  for (const l of leftovers) assert.equal(running(l.pid), false);
});

test("two reapers: one's release leaves the other's groups frozen until its own release", NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const base = listenerCounts();
  const a = await leftover(t, g);
  const b = await leftover(t, g);
  let freeB!: () => void;
  const bHeld = new Promise<void>((r) => (freeB = r));
  let looksA = 0;
  let looksB = 0;
  // B's look after its SIGSTOP waits until A has released; A's look waits past A's bound. A sees only its own group.
  const wb = watch(g.home, {
    boundMs: 60_000,
    snapshot: async () => {
      if (++looksB === 2) await bHeld;
      return snapshotProcs();
    },
  });
  const wa = watch(g.home, {
    boundMs: 500,
    snapshot: async () => {
      if (++looksA === 2) await new Promise((r) => setTimeout(r, 2_000));
      const rows = await snapshotProcs();
      return rows && rows.filter((r) => r.pgid !== b.child.pid);
    },
  });
  const rb = new LeftoverReaper(b.child.pid!, wb.opts);
  const ra = new LeftoverReaper(a.child.pid!, wa.opts);
  rb.childExited();
  ra.childExited();
  const pb = rb.reap();
  assert.ok(await until(() => wb.sent.includes('SIGSTOP'), 30_000), 'B froze its group');
  assert.equal(stopped(b.pid), true);
  const pa = ra.reap();
  const repA = await pa;
  assert.equal(repA.timedOut, true, "A's bound released it");
  assert.equal(stopped(b.pid), true, "B's group is still frozen after A's release");
  assert.deepEqual(wb.sent, ['SIGSTOP'], 'B was sent nothing since its SIGSTOP');
  assert.equal(process.listenerCount('exit'), base.exit + 1, "B's listeners stay while it is frozen");
  freeB();
  const repB = await pb;
  assert.equal(repB.error, null);
  assert.equal(running(b.pid), false);
  assert.ok(await until(() => !running(a.pid), 30_000), "A's own background reap ended its group");
  assert.deepEqual(listenerCounts(), base);
});

test('pinned: the SIGHUP listener releases the frozen group (TERM, CONT), freezes nothing more and goes away', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const l = await leftover(t, g);
  const host = (): void => {};
  process.on('SIGHUP', host);
  t.after(() => process.removeListener('SIGHUP', host));
  const base = listenerCounts();
  const before = process.listeners('SIGHUP');
  let sentAtHup: string[] = [];
  let hupCount = -1;
  let hupped = false;
  const w = watch(g.home, {}, () => {
    if (hupped) return;
    hupped = true;
    const mine = addedTo('SIGHUP', before);
    assert.equal(mine.length, 1, 'one SIGHUP listener while frozen');
    (mine[0] as () => void)();
    sentAtHup = w.sent.slice();
    hupCount = process.listenerCount('SIGHUP');
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(sentAtHup, ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
  assert.equal(hupCount, base.SIGHUP, 'the listener was removed by the release');
  assert.equal(w.sent.filter((s) => s === 'SIGSTOP').length, 1, 'nothing frozen after the hangup');
  assert.deepEqual(listenerCounts(), base);
  assert.equal(running(l.pid), false);
});

test("pinned: the 'exit' listener releases the frozen group (TERM, CONT) and goes away", NEEDS_PS, async (t) => {
  const g = procGuard(t);
  resetFreezeRecorderForTest();
  const l = await leftover(t, g);
  const base = listenerCounts();
  const before = process.listeners('exit');
  let sentAtExit: string[] = [];
  let exitCount = -1;
  let fired = false;
  const w = watch(g.home, {}, () => {
    if (fired) return;
    fired = true;
    const mine = addedTo('exit', before);
    assert.equal(mine.length, 1, "one 'exit' listener while frozen");
    (mine[0] as () => void)();
    sentAtExit = w.sent.slice();
    exitCount = process.listenerCount('exit');
  });
  const reaper = new LeftoverReaper(l.child.pid!, w.opts);
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(sentAtExit, ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
  assert.equal(exitCount, base.exit, 'the listener was removed by the release');
  assert.deepEqual(listenerCounts(), base);
  assert.equal(running(l.pid), false);
});

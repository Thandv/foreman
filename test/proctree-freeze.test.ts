import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { LeftoverReaper, snapshotProcs, type ReaperOptions } from '../src/runners/proctree.ts';
import { activeRecorder, installFreezeRecorder, resetFreezeRecorderForTest } from '../src/runners/freezeRecord.ts';
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

/** The pgids every record file under `home/frozen` holds, or null where there is no frozen/ directory. */
function recorded(home: string): number[] | null {
  const dir = path.join(home, 'frozen');
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => (JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { groups: { pgid: number }[] }).groups.map((g) => g.pgid));
}

interface Leftover {
  child: ReturnType<typeof spawn>;
  pid: number;
  work: string;
}

/** A command that has exited leaving, in its own group, a process that ignores SIGTERM (so the SIGKILL is needed). */
async function leftover(t: TestContext, g: ProcGuard): Promise<Leftover> {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-frz-')));
  const pidFile = path.join(work, 'left.pid');
  const loop = path.join(work, 'loop.sh');
  fs.writeFileSync(loop, `trap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 0.2; done\n`);
  const child = spawn('/bin/sh', ['-c', `/bin/sh '${loop}' >/dev/null 2>&1 & exit 0`], { detached: true, stdio: 'ignore' });
  g.track(child.pid);
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
  return { child, pid, work };
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

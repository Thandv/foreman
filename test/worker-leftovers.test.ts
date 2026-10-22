import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertSignallable,
  forbiddenGroups,
  leftoverGroups,
  LeftoverReaper,
  ownedPids,
  UnsafeSignal,
  type ProcRow,
} from '../src/runners/proctree.ts';
import { spawnStreaming } from '../src/runners/proc.ts';

// What a command leaves running when it exits by itself (proctree.ts LeftoverReaper, wired into proc.ts
// spawnStreaming and tools/run.ts). The process-table tests need ps, which a sandboxed suite cannot start.
const psRefused = (spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)]).error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
const NEEDS_PS = {
  timeout: 120_000,
  skip: psRefused ? 'ps cannot be started here (this suite is running inside a sandbox): there is no process table to walk' : false,
};

/** Running: present and not a zombie (an orphan killed a moment ago may not have been reaped by launchd yet). */
function running(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = r.stdout.trim();
  return r.status === 0 && stat !== '' && !stat.startsWith('Z');
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-left-')));
}

function readPid(file: string): number {
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 1, `a pid in ${file}`);
  return pid;
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/** The command's last step: wait for the leftover to have written its pid (after it changed group or session), then exit 0. */
const WAIT_PID = 'while [ ! -s PIDFILE ]; do sleep 0.05; done; exit 0';

/** Run `script` as the command, which backgrounds something, records its pid and exits 0 at once. */
async function runLeaving(script: string): Promise<{ pid: number; code: number; work: string }> {
  const work = scratch();
  const pidFile = path.join(work, 'left.pid');
  const code = await spawnStreaming('/bin/sh', ['-c', script.replaceAll('PIDFILE', `'${pidFile}'`)], {
    cwd: work,
    signal: new AbortController().signal,
    onLine: () => {},
  });
  return { pid: readPid(pidFile), code, work };
}

// ------------------------------------------------------------ through spawnStreaming, a normal exit

test('a command that backgrounds `sleep 300` in its own group: the sleep is gone when the run ends normally', NEEDS_PS, async () => {
  const { pid, code, work } = await runLeaving('sleep 300 >/dev/null 2>&1 & echo $! > PIDFILE; exit 0');
  try {
    assert.equal(code, 0);
    assert.equal(running(pid), false, 'the leftover was ended before spawnStreaming resolved');
  } finally {
    killQuietly(pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a leftover that moved to a new process group (setpgid, not setsid) is gone too: it is still in the session', NEEDS_PS, async () => {
  const { pid, code, work } = await runLeaving(
    // The pid is written after the setpgid, and the command waits for it: the leftover has left the group before the exit.
    `/usr/bin/perl -e 'setpgrp(0, 0); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "300"' PIDFILE >/dev/null 2>&1 & ${WAIT_PID}`,
  );
  try {
    assert.equal(code, 0);
    assert.equal(running(pid), false, 'the own-group leftover was ended');
  } finally {
    killQuietly(pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('KNOWN ESCAPE: a leftover that made its own session (setsid) and was orphaned before any sample still runs', NEEDS_PS, async () => {
  // Pinned so a change to it is seen: nothing ties such a process to the command once its parent is gone (proctree.ts).
  const { pid, code, work } = await runLeaving(
    `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "300"' PIDFILE >/dev/null 2>&1 & ${WAIT_PID}`,
  );
  try {
    assert.equal(code, 0);
    assert.equal(running(pid), true, 'the setsid leftover escaped the reap (the stated limit without the worker sandbox)');
  } finally {
    killQuietly(pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ the reaper on real processes

test('a setsid leftover seen by a sample while its parent lived is ended after the parent exits', NEEDS_PS, async () => {
  const work = scratch();
  const pidFile = path.join(work, 'left.pid');
  const goFile = path.join(work, 'go');
  // The command: a setsid sleep in the background, then wait for the test's go-ahead and exit.
  const script = `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "300"' >/dev/null 2>&1 & echo $! > '${pidFile}'; while [ ! -f '${goFile}' ]; do sleep 0.05; done; exit 0`;
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  const reaper = new LeftoverReaper(child.pid!, { sampleMs: 0 });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  let pid = 0;
  try {
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000), 'fixture started');
    pid = readPid(pidFile);
    assert.ok(await until(() => spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes('sleep'), 30_000), 'exec done');
    await reaper.sampleNow();
    fs.writeFileSync(goFile, '');
    await exited;
    reaper.childExited();
    const report = await reaper.reap();
    assert.equal(report.error, null);
    assert.equal(running(pid), false, 'the sampled setsid leftover was ended');
  } finally {
    if (pid) killQuietly(pid);
    killQuietly(child.pid!);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a leftover that ignores SIGTERM gets SIGKILL after the grace', NEEDS_PS, async () => {
  const work = scratch();
  const pidFile = path.join(work, 'left.pid');
  const loop = path.join(work, 'loop.sh');
  fs.writeFileSync(loop, `trap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 0.2; done\n`);
  const child = spawn('/bin/sh', ['-c', `/bin/sh '${loop}' >/dev/null 2>&1 & exit 0`], { detached: true, stdio: 'ignore' });
  const reaper = new LeftoverReaper(child.pid!, { sampleMs: 0, graceMs: 300 });
  let pid = 0;
  try {
    await new Promise<void>((r) => child.on('exit', () => r()));
    reaper.childExited();
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000), 'fixture started');
    pid = readPid(pidFile);
    const report = await reaper.reap();
    assert.equal(report.error, null);
    assert.deepEqual(report.groups, [child.pid], 'the command\'s own group was found');
    assert.deepEqual(report.killed, [child.pid], 'it outlived the SIGTERM grace and was SIGKILLed');
    assert.equal(running(pid), false);
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
    if (pid) killQuietly(pid);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ safety, on injected tables

const START = 'Fri Oct 16 20:00:00 2026';
const row = (pid: number, ppid: number, pgid: number, sid: number | null, start = START): ProcRow => ({ pid, ppid, pgid, sid, start });

test('the daemon\'s own group and its ancestors\' are never signalled, even when the table puts them in the command\'s session', async () => {
  const self = 500;
  const root = 900;
  const rows = [
    row(1, 0, 1, 1),
    row(400, 1, 400, 400), // the daemon's parent (a shell)
    row(500, 400, 450, 400), // us, in group 450
    row(901, 1, 450, root), // a confused row: in the command's session and in our group
    row(902, 1, 400, root), // ...and in our parent's group
    row(903, 1, 903, root), // a real leftover
  ];
  const forbidden = forbiddenGroups(rows, self)!;
  assert.deepEqual(leftoverGroups(rows, root, new Map(), false, forbidden), [903]);
  assert.throws(() => assertSignallable([450], forbidden), UnsafeSignal);
  assert.throws(() => assertSignallable([1], forbidden), UnsafeSignal);
  assert.throws(() => assertSignallable([2.5], forbidden), UnsafeSignal);

  // The reaper itself, with signals recorded instead of sent.
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let live = new Set([903]);
  const reaper = new LeftoverReaper(root, {
    sampleMs: 0,
    graceMs: 0,
    killWaitMs: 0,
    selfPid: self,
    snapshot: async () => rows,
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0 && !live.has(-pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (sig === 'SIGTERM') live = new Set();
    },
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.groups, [903]);
  for (const [pid] of sent) assert.ok(![-450, -400, -1, -500].includes(pid), `never signalled ${pid}`);
  assert.deepEqual(sent.filter(([, s]) => s !== 0), [[-903, 'SIGSTOP'], [-903, 'SIGTERM'], [-903, 'SIGCONT']]);
});

test('without a process table only the command\'s own group is signalled', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0,
    graceMs: 0,
    killWaitMs: 0,
    snapshot: async () => null,
    kill: (pid, sig) => void sent.push([pid, sig]),
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.noTable, true);
  assert.deepEqual([...new Set(sent.map(([pid]) => pid))], [-900]);
});

test('ownedPids: a pid reused after the command exited, and a seen pid now held by another process, are not ours', () => {
  const root = 900;
  const seen = new Map([[950, START], [960, START]]);
  const rows = [
    row(1, 0, 1, 1),
    row(500, 1, 500, 500), // us
    row(900, 1, 900, 900, 'Sat Oct 17 09:00:00 2026'), // a stranger now holds the command's pid, leading its own group and session
    row(905, 900, 900, 900), // ...and its child
    row(950, 1, 950, 950, 'Sat Oct 17 09:00:00 2026'), // seen once, but this 950 started later: someone else
    row(951, 1, 950, 950), // ...its member
    row(960, 1, 970, 960), // the 960 we saw, still running (moved to group 970)
    row(961, 1, 960, 960), // a member of the session 960 leads
    row(962, 961, 962, 962), // ...whose child made its own session: a descendant, still ours
  ];
  assert.deepEqual([...ownedPids(rows, root, seen, false)].sort((a, b) => a - b), [960, 961, 962]);
  // While the command runs, its pid, session and group are ours.
  assert.ok(ownedPids(rows, root, new Map(), true).has(905));
});

// ------------------------------------------------------------ review r1: pid reuse, SIGCONT, the toolbox wiring

test('a seen pid reused by a stranger whose session and group outlive their leader is not ours (a pid wrap during a long run)', async () => {
  const root = 900;
  const self = 500;
  const later = 'Fri Oct 16 20:40:00 2026';
  // 950 was in the command's tree when sampled, then exited. After a pid wrap a stranger got 950, made its own
  // session (950) and exited, as a daemonizing program does, leaving 4000 and 4001 in that session and group.
  const before = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(900, 500, 900, 900), row(950, 900, 900, 900)];
  const after = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(4000, 1, 950, 950, later), row(4001, 4000, 950, 950, later)];
  assert.deepEqual(leftoverGroups(after, root, new Map([[950, START]]), false, forbiddenGroups(after, self)!), []);
  // Through the reaper: sampled while the command ran, reaped after the stranger appeared. Nothing is signalled.
  let table = before;
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const reaper = new LeftoverReaper(root, {
    sampleMs: 0,
    graceMs: 0,
    killWaitMs: 0,
    selfPid: self,
    snapshot: async () => table,
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  await reaper.sampleNow();
  table = after;
  reaper.childExited();
  const report = await reaper.reap();
  assert.deepEqual(report.groups, []);
  assert.deepEqual(sent, [], 'no signal of any kind reached the stranger');
  // The same session while a process we saw is still in it, or while it held ours at the latest sample, is ours.
  const withSeenMember = [...after, row(960, 1, 950, 950)];
  assert.deepEqual(leftoverGroups(withSeenMember, root, new Map([[950, START], [960, START]]), false, forbiddenGroups(after, self)!), [950]);
  assert.deepEqual(leftoverGroups(after, root, new Map([[950, START]]), false, forbiddenGroups(after, self)!, new Set([950])), [950]);
});

test('every frozen group is continued even when a later check refuses to signal one of them', async () => {
  const root = 900;
  const self = 500;
  const first = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(901, 1, 901, root), row(902, 1, 902, root)];
  const confused = [row(1, 0, 1, 1), row(500, 1, 902, 500), row(901, 1, 901, root), row(902, 1, 902, root)]; // our row now reads group 902
  let n = 0;
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const reaper = new LeftoverReaper(root, {
    sampleMs: 0,
    graceMs: 0,
    killWaitMs: 0,
    selfPid: self,
    snapshot: async () => (n++ === 0 ? first : confused),
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  reaper.childExited();
  await reaper.reap();
  const stopped = sent.filter(([, s]) => s === 'SIGSTOP').map(([p]) => p);
  const continued = sent.filter(([, s]) => s === 'SIGCONT').map(([p]) => p);
  assert.deepEqual(stopped.sort(), [-902, -901].sort());
  assert.deepEqual(continued.sort(), stopped.sort(), 'nothing is left stopped');
});

test('a toolbox tool that leaves `sleep 300` behind: the sleep is gone when runTool resolves', NEEDS_PS, async () => {
  const { runTool } = await import('../src/tools/run.ts');
  const { registerTool } = await import('../src/tools/catalog.ts');
  const catalog = scratch();
  const src = scratch();
  const jail = scratch();
  const saved = process.env['FOREMAN_TOOLS_DIR'];
  process.env['FOREMAN_TOOLS_DIR'] = catalog;
  let pid = 0;
  try {
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
      name: 'leaves-sleep', description: 'leaves a sleep running', runtime: 'node', entry: 'tool.js',
      input: { type: 'object', properties: {} }, output: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'] },
    }));
    fs.writeFileSync(path.join(src, 'tool.js'), `
const { spawn } = require('node:child_process');
const c = spawn('sleep', ['300'], { stdio: 'ignore' });
c.unref();
require('node:fs').writeFileSync('left.pid', String(c.pid));
process.stdout.write(JSON.stringify({ pid: c.pid }));
process.exit(0);
`);
    fs.mkdirSync(path.join(src, 'test'));
    fs.writeFileSync(path.join(src, 'test', 'tool.test.js'), 'require("node:test")("noop", () => {});\n');
    const tool = registerTool({ sourceDir: src });
    const result = await runTool(tool, {}, { cwd: jail });
    assert.equal(result.ok, true, result.error ?? '');
    pid = readPid(path.join(jail, 'left.pid'));
    assert.equal(running(pid), false, 'the tool\'s leftover was ended before its result was handed on');
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_TOOLS_DIR'];
    else process.env['FOREMAN_TOOLS_DIR'] = saved;
    if (pid) killQuietly(pid);
    for (const d of [catalog, src, jail]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ review r2: each way an id stays ours, and the one it must not

test('a session id stays ours through a live seen member, and not through a stranger now holding a seen pid', () => {
  const root = 900;
  const forbidden = (rows: ProcRow[]): Set<number> => forbiddenGroups(rows, 500)!;
  const seen = new Map([[950, START], [960, START]]);
  // 950 led a session of the command's and exited; 960, seen in it, still runs (its own group); 4000 was forked in
  // that session after the last sample, into a group of its own. The session cannot have been emptied and reused.
  const ours = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(960, 1, 960, 950), row(4000, 960, 4000, 950, 'Fri Oct 16 20:41:00 2026')];
  assert.deepEqual(leftoverGroups(ours.map((r) => (r.pid === 4000 ? { ...r, ppid: 1 } : r)), root, seen, false, forbidden(ours)), [960, 4000]);
  // The same numbers, but 960 is now a stranger (another start time) in a session 950 that is a stranger's too.
  const later = 'Fri Oct 16 20:42:00 2026';
  const strangers = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(960, 1, 960, 950, later), row(4000, 1, 4000, 950, later)];
  assert.deepEqual(leftoverGroups(strangers, root, seen, false, forbidden(strangers)), []);
});

test('the ids held at the latest sample keep a session ours after its seen members exited, through the samples and the reap', async () => {
  const root = 900;
  const self = 500;
  const t1 = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(900, 500, 900, 900), row(950, 900, 950, 950), row(960, 950, 960, 950)];
  // 960 forked 4000 into a group of its own, then 950 and 960 exited: 4000 is tied to the command only by session 950.
  const t2 = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(900, 500, 900, 900), row(4000, 1, 4000, 950)];
  const run = async (tables: ProcRow[][], samples: number): Promise<Array<[number, NodeJS.Signals | 0]>> => {
    let n = 0;
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    const reaper = new LeftoverReaper(root, {
      sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: self,
      snapshot: async () => tables[Math.min(n++, tables.length - 1)]!,
      kill: (pid, sig) => {
        sent.push([pid, sig]);
        if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
    });
    for (let i = 0; i < samples; i++) await reaper.sampleNow();
    reaper.childExited();
    await reaper.reap();
    return sent.filter(([, s]) => s !== 0);
  };
  // Reaped right after the sample that saw 950 and 960: only the ids they held tie 4000 to the command.
  const gone = t2.filter((r) => r.pid !== 900);
  assert.deepEqual(await run([t1, gone], 1), [[-4000, 'SIGSTOP'], [-4000, 'SIGTERM'], [-4000, 'SIGCONT']]);
  // One more sample first, which sees 4000 only through those ids: then it is seen, and ended at the reap.
  assert.deepEqual(await run([t1, t2, gone], 2), [[-4000, 'SIGSTOP'], [-4000, 'SIGTERM'], [-4000, 'SIGCONT']]);
  // The leader 950 gone by the latest sample, 960 still in its session: the session id comes from 960's row.
  const leaderGone = t1.filter((r) => r.pid !== 950);
  assert.deepEqual(await run([t1, leaderGone, gone], 2), [[-4000, 'SIGSTOP'], [-4000, 'SIGTERM'], [-4000, 'SIGCONT']]);
});

// ------------------------------------------------------------ follow-up A7: the bound fires mid-freeze

/** A reaper over `tables`, in turn, whose snapshot number `hangAt` (0-based) waits for `release()`. */
function hangingReaper(tables: ProcRow[][], hangAt: number, opts: { boundMs: number }) {
  let n = 0;
  let release: () => void = () => {};
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500, boundMs: opts.boundMs,
    snapshot: () => {
      const t = tables[Math.min(n, tables.length - 1)]!;
      if (n++ !== hangAt) return Promise.resolve(t);
      return new Promise((r) => (release = () => r(t)));
    },
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  reaper.childExited();
  return { reaper, sent, release: () => release(), real: () => sent.filter(([, s]) => s !== 0) };
}

const A7_FIRST = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(901, 1, 901, 900), row(902, 1, 902, 900)];
// The late look finds one more group: the hung continuation must not stop it.
const A7_LATE = [...A7_FIRST, row(903, 1, 903, 900)];

test('the bound firing while the freeze\'s second look hangs: every frozen group gets TERM and CONT before reap() resolves; the reap goes on without freezing', async () => {
  const { reaper, real, release } = hangingReaper([A7_FIRST, A7_LATE], 1, { boundMs: 100 });
  const report = await reaper.reap();
  assert.equal(report.timedOut, true);
  const atResolve = real();
  assert.deepEqual(atResolve, [
    [-901, 'SIGSTOP'], [-902, 'SIGSTOP'],
    [-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT'],
  ]);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(real().slice(atResolve.length), [[-901, 'SIGTERM'], [-902, 'SIGTERM'], [-903, 'SIGTERM']],
    'the late look\'s continuation stops nothing (no SIGSTOP of 903) and still ends what it found, 903 included');
});

test('the bound firing during the first look: nothing is frozen, and the reap still ends the leftovers in the background', async () => {
  const { reaper, real, release } = hangingReaper([A7_FIRST], 0, { boundMs: 50 });
  const report = await reaper.reap();
  assert.equal(report.timedOut, true);
  assert.deepEqual(real(), []);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(real(), [[-901, 'SIGTERM'], [-902, 'SIGTERM']], 'TERM without a SIGSTOP');
});

test('an error thrown after a SIGSTOP: every frozen group gets TERM and CONT', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let n = 0;
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500,
    snapshot: async () => {
      if (n++ === 0) return A7_FIRST;
      throw new Error('ps went away');
    },
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, 'ps went away');
  assert.deepEqual(sent.filter(([, s]) => s !== 0), [
    [-901, 'SIGSTOP'], [-902, 'SIGSTOP'],
    [-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT'],
  ]);
});

test('a process exit mid-freeze continues the frozen groups; the exit handler is gone after the reap, and 100 reaps leak none', async () => {
  const before = process.listeners('exit').slice();
  const { reaper, real, release } = hangingReaper([A7_FIRST], 1, { boundMs: 60_000 });
  const done = reaper.reap();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(real(), [[-901, 'SIGSTOP'], [-902, 'SIGSTOP']], 'frozen, waiting on the second look');
  const added = process.listeners('exit').filter((l) => !before.includes(l));
  assert.equal(added.length, 1, 'an exit handler is installed while groups are frozen');
  (added[0] as () => void)();
  assert.deepEqual(real().slice(2), [[-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT']], 'the exit handler ended the freeze');
  release();
  await done;
  assert.equal(process.listenerCount('exit'), before.length, 'removed when the reap ends');
  for (let i = 0; i < 100; i++) {
    const { reaper: r } = hangingReaper([A7_FIRST], -1, { boundMs: 60_000 });
    const rep = await r.reap();
    assert.deepEqual(rep.groups, [901, 902]);
  }
  for (let i = 0; i < 5; i++) {
    const { reaper: r, release: go } = hangingReaper([A7_FIRST], 1, { boundMs: 10 });
    await r.reap();
    go();
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(process.listenerCount('exit'), before.length, 'no listener leak across normal or timed-out reaps');
});

test('the bound firing mid-freeze: a group gone before its release (ESRCH) does not keep the next one stopped', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let n = 0;
  let go: () => void = () => {};
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500, boundMs: 50,
    snapshot: () => (n++ === 0 ? Promise.resolve(A7_FIRST) : new Promise((r) => (go = () => r(A7_FIRST)))),
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 0 || (pid === -901 && sig !== 'SIGSTOP')) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  reaper.childExited();
  assert.equal((await reaper.reap()).timedOut, true);
  assert.deepEqual(sent.filter(([, s]) => s !== 0).slice(2), [[-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT']]);
  go();
});

test('a SIGHUP mid-freeze continues the frozen groups; a listener is installed only while groups are frozen', async () => {
  const before = process.listeners('SIGHUP').slice();
  // A listener of our own, so the reaper's handler sees another listener and does not raise SIGHUP on the test process.
  const keep = (): void => {};
  process.on('SIGHUP', keep);
  try {
    const { reaper, real, release } = hangingReaper([A7_FIRST], 1, { boundMs: 60_000 });
    const done = reaper.reap();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(real(), [[-901, 'SIGSTOP'], [-902, 'SIGSTOP']], 'frozen, waiting on the second look');
    const added = process.listeners('SIGHUP').filter((l) => !before.includes(l) && l !== keep);
    assert.equal(added.length, 1, 'a SIGHUP handler is installed while groups are frozen');
    (added[0] as () => void)();
    assert.deepEqual(real().slice(2), [[-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT']], 'the hangup ended the freeze');
    release();
    await done;
    assert.deepEqual(process.listeners('SIGHUP').filter((l) => l !== keep), before, 'removed when the reap ends');
  } finally {
    process.removeListener('SIGHUP', keep);
  }
});

test('a real SIGHUP to a process with no SIGHUP listener of its own: the frozen groups are continued, then the hangup still ends the process', async () => {
  const dir = scratch();
  try {
    const log = path.join(dir, 'signals.log');
    const script = path.join(dir, 'hup.ts');
    const proctree = path.join(import.meta.dirname, '..', 'src', 'runners', 'proctree.ts');
    fs.writeFileSync(script, `
import fs from 'node:fs';
import { LeftoverReaper } from ${JSON.stringify(proctree)};
const row = (pid, ppid, pgid, sid) => ({ pid, ppid, pgid, sid, start: ${JSON.stringify(START)} });
const first = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(901, 1, 901, 900), row(902, 1, 902, 900)];
let n = 0;
const reaper = new LeftoverReaper(900, {
  sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500, boundMs: 60000,
  snapshot: () => (n++ === 0 ? Promise.resolve(first) : new Promise(() => {})),
  kill: (pid, sig) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    fs.appendFileSync(${JSON.stringify(log)}, pid + ' ' + sig + '\\n');
  },
});
reaper.childExited();
void reaper.reap();
setTimeout(() => process.kill(process.pid, 'SIGHUP'), 100);
setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'still alive\\n'); process.exit(3); }, 10000);
`);
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    assert.equal(signal, 'SIGHUP', `ended by the hangup (code ${code})`);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      '-901 SIGSTOP', '-902 SIGSTOP', '-901 SIGTERM', '-901 SIGCONT', '-902 SIGTERM', '-902 SIGCONT',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`a real ${sig} to a process with no ${sig} listener of its own: the frozen groups are continued, then the signal still ends the process`, async () => {
    const dir = scratch();
    try {
      const log = path.join(dir, 'signals.log');
      const script = path.join(dir, 'sig.ts');
      const proctree = path.join(import.meta.dirname, '..', 'src', 'runners', 'proctree.ts');
      fs.writeFileSync(script, `
import fs from 'node:fs';
import { LeftoverReaper } from ${JSON.stringify(proctree)};
const row = (pid, ppid, pgid, sid) => ({ pid, ppid, pgid, sid, start: ${JSON.stringify(START)} });
const first = [row(1, 0, 1, 1), row(500, 1, 500, 500), row(901, 1, 901, 900), row(902, 1, 902, 900)];
let n = 0;
const reaper = new LeftoverReaper(900, {
  sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500, boundMs: 60000,
  snapshot: () => (n++ === 0 ? Promise.resolve(first) : new Promise(() => {})),
  kill: (pid, sig) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    fs.appendFileSync(${JSON.stringify(log)}, pid + ' ' + sig + '\\n');
  },
});
reaper.childExited();
void reaper.reap();
setTimeout(() => process.kill(process.pid, ${JSON.stringify(sig)}), 100);
setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'still alive\\n'); process.exit(3); }, 10000);
`);
      const child = spawn(process.execPath, [script], { stdio: 'ignore' });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
      assert.equal(signal, sig, `ended by the signal (code ${code})`);
      assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
        '-901 SIGSTOP', '-902 SIGSTOP', '-901 SIGTERM', '-901 SIGCONT', '-902 SIGTERM', '-902 SIGCONT',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a SIGHUP mid-freeze in a process that lives on (its own SIGHUP listener): the late look freezes nothing more, and still ends what it found', async () => {
  const before = process.listeners('SIGHUP').slice();
  const keep = (): void => {};
  process.on('SIGHUP', keep);
  try {
    const { reaper, real, release } = hangingReaper([A7_FIRST, A7_LATE], 1, { boundMs: 60_000 });
    const done = reaper.reap();
    await new Promise((r) => setTimeout(r, 20));
    const added = process.listeners('SIGHUP').filter((l) => !before.includes(l) && l !== keep);
    assert.equal(added.length, 1);
    (added[0] as () => void)();
    release(); // the second look comes back after the hangup and finds 903
    await done;
    assert.deepEqual(real().slice(6), [[-901, 'SIGTERM'], [-902, 'SIGTERM'], [-903, 'SIGTERM']],
      'no SIGSTOP of 903 after the hangup: no handler is installed any more to continue it');
    assert.deepEqual(process.listeners('SIGHUP').filter((l) => l !== keep), before);
  } finally {
    process.removeListener('SIGHUP', keep);
  }
});

test('the daemon (`serve`) ends in order on SIGHUP, as on SIGTERM: "stopping", exit 0, its lock released', async (t) => {
  const home = scratch();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  // Nothing outside: no model pre-warm, no Claude CLI (local-only, and a binary that does not exist), port 0.
  const env = {
    ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: '0', FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on',
    FOREMAN_CLAUDE_BIN: path.join(home, 'no-claude'), FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
  };
  const child = spawn(process.execPath, [cli, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  assert.ok(await until(() => out.includes('foreman up'), 30_000), `the daemon came up: ${out}`);
  assert.ok(fs.existsSync(path.join(home, 'daemon.pid')), 'it holds the lock');
  child.kill('SIGHUP');
  const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code, signal] = await ended;
  clearTimeout(guard);
  assert.deepEqual([code, signal], [0, null], `an orderly exit, not death by the hangup: ${out}`);
  assert.ok(out.includes('stopping'), out);
  assert.equal(fs.existsSync(path.join(home, 'daemon.pid')), false, 'the lock was released');
});

test('an error thrown after a SIGSTOP, with groups that survive TERM: each stopped group still gets the grace and a SIGKILL', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let n = 0;
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500,
    snapshot: async () => {
      if (n++ === 0) return A7_FIRST;
      throw new Error('ps went away');
    },
    // Every group answers signal 0: it ignores TERM and stays alive until SIGKILL.
    kill: (pid, sig) => void sent.push([pid, sig]),
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, 'ps went away', 'the report still names the failure');
  assert.deepEqual(sent.filter(([, s]) => s !== 0), [
    [-901, 'SIGSTOP'], [-902, 'SIGSTOP'],
    [-901, 'SIGTERM'], [-901, 'SIGCONT'], [-902, 'SIGTERM'], [-902, 'SIGCONT'],
    [-901, 'SIGKILL'], [-902, 'SIGKILL'],
  ]);
});

test('a last look that throws still sends SIGKILL to what survived the grace', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let n = 0;
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500,
    // The first look and the freeze's second look answer; the look after the grace throws.
    snapshot: async () => {
      if (n++ < 2) return A7_FIRST;
      throw new Error('ps went away late');
    },
    kill: (pid, sig) => void sent.push([pid, sig]),
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, null);
  assert.deepEqual(report.killed, [901, 902]);
  assert.deepEqual(sent.filter(([, s]) => s === 'SIGKILL'), [[-901, 'SIGKILL'], [-902, 'SIGKILL']]);
});

test('an error thrown mid-freeze after a later look forbids a stopped group: no SIGKILL goes out (the latest fence holds), and the report names the original error', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  // The second look puts the daemon (500) under 901, so 901 is an ancestor's group from then on; it also finds 903.
  const forbid901 = [row(1, 0, 1, 1), row(500, 901, 500, 500), row(901, 1, 901, 900), row(902, 1, 902, 900), row(903, 1, 903, 900)];
  let n = 0;
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500,
    snapshot: async () => {
      n++;
      if (n === 1) return A7_FIRST;
      if (n === 2) return forbid901;
      throw new Error('ps went away');
    },
    kill: (pid, sig) => void sent.push([pid, sig]),
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, 'ps went away', 'the refused SIGKILL does not replace the error that ended the reap');
  assert.deepEqual(sent.filter(([, s]) => s === 'SIGSTOP'), [[-901, 'SIGSTOP'], [-902, 'SIGSTOP'], [-903, 'SIGSTOP']]);
  assert.deepEqual(sent.filter(([, s]) => s === 'SIGKILL'), [], 'nothing is SIGKILLed past a fence that refuses 901');
});

test('an error thrown after a SIGSTOP: a group that ends within the grace after TERM gets no SIGKILL', async () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  let termAt = 0;
  let n = 0;
  const reaper = new LeftoverReaper(900, {
    sampleMs: 0, graceMs: 1_000, killWaitMs: 0, selfPid: 500,
    snapshot: async () => {
      if (n++ === 0) return A7_FIRST;
      throw new Error('ps went away');
    },
    kill: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === 'SIGTERM' && !termAt) termAt = Date.now();
      // Both groups end 150 ms after the TERM: inside the grace, so only a reap that skips the grace would SIGKILL them.
      if (sig === 0 && termAt && Date.now() - termAt >= 150) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  reaper.childExited();
  const report = await reaper.reap();
  assert.equal(report.error, 'ps went away');
  assert.deepEqual(sent.filter(([, s]) => s === 'SIGKILL'), []);
});

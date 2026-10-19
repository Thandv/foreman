import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LeftoverReaper, parseProcStat, readProcFs, snapshotProcs } from '../src/runners/proctree.ts';

// Follow-up A1 (worker-leftovers r2 review): on Linux the reaper's (pid, start) identity uses the kernel's exact
// start time from /proc/<pid>/stat, not ps's one-second lstart. Only macOS runs here, so Linux is driven through
// fixture /proc trees (the proc root is injectable).

/** A /proc/<pid>/stat line: `pid (comm) state ppid pgrp session ... starttime(22) ...`. */
function statLine(pid: number, comm: string, state: string, ppid: number, pgrp: number, session: number, starttime: number): string {
  const f7to21 = [34816, pgrp, 4194560, 120, 0, 0, 0, 3, 1, 0, 0, 20, 0, 1, 0]; // tty_nr .. itrealvalue
  const tail = [12345678, 456, '18446744073709551615', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 17, 3, 0, 0, 0, 0, 0];
  return [`${pid} (${comm}) ${state}`, ppid, pgrp, session, ...f7to21, starttime, ...tail].join(' ') + '\n';
}

interface Proc {
  pid: number;
  comm?: string;
  state?: string;
  ppid: number;
  pgrp: number;
  session: number;
  ticks: number;
}

/** A fresh fixture /proc holding `procs`, plus the entries a real one has that are not processes. */
function procTree(procs: Proc[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-proc-')));
  for (const d of ['self', 'net', 'sys']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00\n');
  setProcs(root, procs);
  return root;
}

function setProcs(root: string, procs: Proc[]): void {
  for (const name of fs.readdirSync(root)) if (/^\d+$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true });
  for (const p of procs) {
    fs.mkdirSync(path.join(root, String(p.pid)));
    fs.writeFileSync(path.join(root, String(p.pid), 'stat'), statLine(p.pid, p.comm ?? 'sh', p.state ?? 'S', p.ppid, p.pgrp, p.session, p.ticks));
  }
}

test('a stat line parses after the last `)`: comm with spaces and `)`, a kernel thread, a zombie; junk is no row', () => {
  assert.deepEqual(parseProcStat(statLine(4242, 'a b) (c) d', 'S', 900, 4242, 900, 123456)), {
    pid: 4242, ppid: 900, pgid: 4242, sid: 900, start: 'ticks:123456',
  });
  // kthreadd and a kworker: session 0 is unknown, like getsid would say; pgrp 0 is kept (treeGroups never signals it).
  assert.deepEqual(parseProcStat(statLine(2, 'kthreadd', 'S', 0, 0, 0, 3)), { pid: 2, ppid: 0, pgid: 0, sid: null, start: 'ticks:3' });
  assert.deepEqual(parseProcStat(statLine(77, 'kworker/0:1-events', 'I', 2, 0, 0, 40)), { pid: 77, ppid: 2, pgid: 0, sid: null, start: 'ticks:40' });
  // A zombie still has its row (the reaper counts a zombie as a survivor).
  assert.deepEqual(parseProcStat(statLine(31, 'defunct', 'Z', 30, 30, 30, 9000)), { pid: 31, ppid: 30, pgid: 30, sid: 30, start: 'ticks:9000' });
  for (const junk of [
    '', '42', '42 (sh S 1 1 1', 'x (sh) S 1 1 1 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 5', '42 (sh) S 1 1 1 0 1 0',
    ' (sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 9', // no pid
    '42 (sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 -9', // a starttime that is not a count of ticks
  ]) {
    assert.equal(parseProcStat(junk), null, JSON.stringify(junk));
  }
  // Two starts in the same second (100 ticks a second) are different identities.
  assert.notEqual(parseProcStat(statLine(5, 'a', 'S', 1, 5, 5, 1000))!.start, parseProcStat(statLine(5, 'a', 'S', 1, 5, 5, 1050))!.start);
});

test('a fixture /proc is read: non-process entries and a pid that vanished mid-scan are skipped; nothing readable is no table', async () => {
  const root = procTree([
    { pid: 1, ppid: 0, pgrp: 1, session: 1, ticks: 1 },
    { pid: 2, comm: 'kthreadd', ppid: 0, pgrp: 0, session: 0, ticks: 2 },
    { pid: 31, comm: 'x) y', state: 'Z', ppid: 1, pgrp: 31, session: 31, ticks: 500 },
  ]);
  try {
    fs.mkdirSync(path.join(root, '33')); // exited between the listing and the read: no stat
    const rows = await readProcFs(root);
    assert.deepEqual(rows?.map((r) => [r.pid, r.ppid, r.pgid, r.sid, r.start]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [1, 0, 1, 1, 'ticks:1'],
      [2, 0, 0, null, 'ticks:2'],
      [31, 1, 31, 31, 'ticks:500'],
    ]);
    // On Linux, snapshotProcs reads /proc, not ps.
    assert.deepEqual(await snapshotProcs(5_000, { platform: 'linux', procRoot: root }), rows);
    assert.equal(await readProcFs(path.join(root, 'missing')), null);
    setProcs(root, []);
    assert.equal(await snapshotProcs(5_000, { platform: 'linux', procRoot: root }), null, 'an empty /proc is no table, not an empty one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux: a pid reused within the same second, with another starttime, is not the process the sample saw', async () => {
  const self = 500;
  const cmd = 900;
  const base: Proc[] = [
    { pid: 1, ppid: 0, pgrp: 1, session: 1, ticks: 1 },
    { pid: 500, ppid: 1, pgrp: 500, session: 500, ticks: 100 },
  ];
  // The command 900 (its own session) runs 950, which made a session of its own: seen only by the sample.
  const running: Proc[] = [
    ...base,
    { pid: 900, ppid: 500, pgrp: 900, session: 900, ticks: 1000 },
    { pid: 950, comm: 'leftover (x)', ppid: 900, pgrp: 950, session: 950, ticks: 1010 },
  ];
  const reapWith = async (after: Proc[]): Promise<Array<[number, NodeJS.Signals | 0]>> => {
    const root = procTree(running);
    try {
      const sent: Array<[number, NodeJS.Signals | 0]> = [];
      const reaper = new LeftoverReaper(cmd, {
        sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: self,
        snapshot: () => snapshotProcs(5_000, { platform: 'linux', procRoot: root }),
        kill: (pid, sig) => {
          sent.push([pid, sig]);
          if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        },
      });
      await reaper.sampleNow();
      reaper.childExited();
      setProcs(root, after);
      await reaper.reap();
      return sent.filter(([, s]) => s !== 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  // The seen 950 outlived the command: same pid, same starttime, so it is ended.
  assert.deepEqual(await reapWith([...base, running[3]!]), [[-950, 'SIGSTOP'], [-950, 'SIGTERM'], [-950, 'SIGCONT']]);
  // 950 exited too and its pid went to a stranger (setsid, its own group) 0.4 s after the seen one started, in the
  // same second: lstart would print the same string. The kernel's starttime differs, so nothing is signalled.
  const stranger: Proc = { pid: 950, comm: 'stranger', ppid: 1, pgrp: 950, session: 950, ticks: 1050 };
  assert.deepEqual(await reapWith([...base, stranger]), []);
});

test('a /proc scan that fails part-way is no table, never the rows read so far: past the deadline, or a stat file that fails for want of a descriptor', async (t) => {
  // After a pid wrap a stranger holds the command's pid 900 and leads session 900, with 905 in it. Read, its row shows
  // the pid is a stranger's; missed, session 900 would look like the command's and 905 would be signalled.
  const procs: Proc[] = [
    { pid: 1, ppid: 0, pgrp: 1, session: 1, ticks: 1 },
    { pid: 500, ppid: 1, pgrp: 500, session: 500, ticks: 100 },
    { pid: 900, comm: 'stranger', ppid: 1, pgrp: 900, session: 900, ticks: 90_000 },
    { pid: 905, ppid: 900, pgrp: 905, session: 900, ticks: 90_001 },
  ];
  const root = procTree(procs);
  const realOpen = fs.promises.open;
  /** Make opening `<pid>/stat` fail with `code` while `fn` runs. */
  const failing = async <T>(pid: number, code: string, fn: () => Promise<T>): Promise<T> => {
    const m = t.mock.method(fs.promises, 'open', (p: fs.PathLike, ...rest: [fs.OpenMode?, fs.Mode?]) =>
      String(p) === path.join(root, String(pid), 'stat')
        ? Promise.reject(Object.assign(new Error(`${code}: open`), { code }))
        : realOpen.call(fs.promises, p, ...rest));
    try {
      return await fn();
    } finally {
      m.mock.restore();
    }
  };
  const reapAfterExit = async (): Promise<Array<[number, NodeJS.Signals | 0]>> => {
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    const reaper = new LeftoverReaper(900, {
      sampleMs: 0, graceMs: 0, killWaitMs: 0, selfPid: 500,
      snapshot: () => snapshotProcs(5_000, { platform: 'linux', procRoot: root }),
      kill: (pid, sig) => {
        sent.push([pid, sig]);
        if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
    });
    reaper.childExited();
    await reaper.reap();
    return sent.filter(([, s]) => s !== 0);
  };
  try {
    assert.equal((await readProcFs(root))?.length, 4);
    assert.deepEqual(await reapAfterExit(), [], 'the stranger\'s session is not the command\'s');
    // Out of descriptors at the stranger's row: no table (only the command's own group, gone here), not a table without it.
    assert.equal(await failing(900, 'EMFILE', () => readProcFs(root)), null);
    assert.deepEqual(await failing(900, 'EMFILE', reapAfterExit), []);
    // A process that exited mid-scan, or one hidden from us (hidepid), is skipped, as ps skips it.
    for (const code of ['ENOENT', 'EACCES']) {
      assert.deepEqual((await failing(905, code, () => readProcFs(root)))?.map((r) => r.pid).sort((a, b) => a - b), [1, 500, 900], code);
    }
    // The deadline passes once the first stat file has been opened: no table, not the one row read.
    const now = Date.now();
    let opened = 0;
    const counting = t.mock.method(fs.promises, 'open', (...a: [fs.PathLike, fs.OpenMode?, fs.Mode?]) => {
      opened++;
      return realOpen.call(fs.promises, ...a);
    });
    const clock = t.mock.method(Date, 'now', () => now + (opened ? 60_000 : 0));
    try {
      assert.equal(await readProcFs(root, 5_000), null);
      assert.equal(opened, 1, 'one stat file was read before the deadline passed');
    } finally {
      clock.mock.restore();
      counting.mock.restore();
    }
    // A stat file naming another pid than its directory is no row.
    fs.mkdirSync(path.join(root, '16'));
    fs.writeFileSync(path.join(root, '16', 'stat'), statLine(17, 'sh', 'S', 1, 17, 17, 7));
    assert.deepEqual((await readProcFs(root))?.map((r) => r.pid).sort((a, b) => a - b), [1, 500, 900, 905]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

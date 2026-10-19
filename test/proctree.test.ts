import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { escalationFor, escalationGroups, parsePsRows, treeGroups } from '../src/runners/proctree.ts';
import { spawnStreaming } from '../src/runners/proc.ts';
import { Store } from '../src/queue.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

// ------------------------------------------------------------ the tree walk

test('parsePsRows reads ps output and skips junk', () => {
  assert.deepEqual(parsePsRows('  1     0     1\n 90383 1 90383\nbogus line\n60268 90383 60268\n\n'), [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 90383, ppid: 1, pgid: 90383 },
    { pid: 60268, ppid: 90383, pgid: 60268 },
  ]);
});

test('treeGroups finds every group under the root, including own-group grandchildren and orphaned group members', () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 500, ppid: 1, pgid: 500 }, // us, the daemon
    { pid: 900, ppid: 500, pgid: 900 }, // the worker (root)
    { pid: 901, ppid: 900, pgid: 900 }, // same-group child
    { pid: 950, ppid: 901, pgid: 950 }, // npm run verify, its own group
    { pid: 951, ppid: 950, pgid: 950 },
    { pid: 960, ppid: 951, pgid: 960 }, // a suite's detached grandchild
    { pid: 970, ppid: 1, pgid: 900 }, // a group member reparented to launchd
    { pid: 971, ppid: 970, pgid: 971 }, // ...whose own-group child still counts
    { pid: 800, ppid: 1, pgid: 800 }, // unrelated
  ];
  assert.deepEqual(treeGroups(rows, 900, 500).sort((a, b) => a - b), [900, 950, 960, 971]);
});

test('treeGroups never returns our own group or launchd, even from a confused table', () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 500, ppid: 1, pgid: 500 }, // us
    { pid: 900, ppid: 500, pgid: 900 },
    { pid: 901, ppid: 900, pgid: 500 }, // a descendant somehow in our group
    { pid: 902, ppid: 900, pgid: 1 },
  ];
  assert.deepEqual(treeGroups(rows, 900, 500), [900]);
  assert.deepEqual(treeGroups(rows, 500, 500), [], 'a reused pid that is our own group is never signalled');
  assert.deepEqual(treeGroups(rows, 1, 500), []);
});

test('treeGroups does not walk a recorded leader\'s reused pid: only the recorded group\'s members count', () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 500, ppid: 1, pgid: 500 }, // us
    { pid: 4242, ppid: 1, pgid: 900 }, // the recorded leader died; 4242 now belongs to someone else's group 900
    { pid: 4300, ppid: 4242, pgid: 4300 }, // ...and that process's own-group child
    { pid: 5000, ppid: 1, pgid: 4242 }, // an orphaned member of the group we recorded
    { pid: 5001, ppid: 5000, pgid: 5001 }, // ...whose own-group child is ours too
  ];
  assert.deepEqual(treeGroups(rows, 4242, 500).sort((a, b) => a - b), [4242, 5001]);
});

test('escalationGroups: only groups that still have a member, and no fresh walk from a settled child\'s pid', () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 500, ppid: 1, pgid: 500 }, // us
    { pid: 900, ppid: 500, pgid: 900 }, // the child, or a stranger reusing its pid once it is reaped
    { pid: 950, ppid: 900, pgid: 950 }, // an own-group process under that pid
    { pid: 960, ppid: 1, pgid: 960 }, // a group remembered at the abort, still alive
  ];
  // 970 was remembered but has no member left: its id may be reused, so it is not signalled.
  assert.deepEqual(escalationGroups([960, 970], 900, false, rows, 500).sort((a, b) => a - b), [950, 960]);
  // Once the child settled, pid 900 is no longer ours: nothing is walked from it.
  assert.deepEqual(escalationGroups([960], 900, true, rows, 500), [960]);
  assert.deepEqual(escalationGroups([970], 900, true, rows, 500), []);
});

test('escalationFor: a child whose exit status is known is no longer walked from, though stdio may keep it unclosed', () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 500, ppid: 1, pgid: 500 }, // us
    { pid: 900, ppid: 500, pgid: 900 }, // a stranger reusing the reaped child's pid
    { pid: 950, ppid: 900, pgid: 950 },
  ];
  // Exited (its 'exit' fired) but not closed: a grandchild still holds its stdout.
  assert.deepEqual(escalationFor({ pid: 900, exitCode: 0, signalCode: null }, [], rows, 500), []);
  assert.deepEqual(escalationFor({ pid: 900, exitCode: null, signalCode: 'SIGTERM' }, [], rows, 500), []);
  assert.deepEqual(escalationFor({ pid: 900, exitCode: null, signalCode: null }, [], rows, 500), [950], 'still running: its tree is walked');
});

// ------------------------------------------------------------ integration

// These walk the live process table, and inside a sandbox there is none: `ps` is a setuid program and macOS starts
// no setuid program in a sandbox (EPERM at exec) — which is where this suite runs when Foreman's own gate is
// sandboxed (FOREMAN_SANDBOX). Only that refusal skips them; any other ps failure runs them, and they fail.
const psRefused = (spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)]).error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
const NEEDS_PS = { skip: psRefused ? 'ps cannot be started here (this suite is running inside a sandbox): there is no process table to walk' : false };

/** A node script that starts `sleep` in its own process group, records its pid, then idles. */
function grandchildScript(pidFile: string): string {
  return (
    `const { spawn } = require('node:child_process');` +
    `const c = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });` +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));` +
    `console.log('started'); setInterval(() => {}, 1000);`
  );
}

test('aborting a run kills a descendant that made its own process group', NEEDS_PS, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pt-'));
  const pidFile = path.join(work, 'grandchild.pid');
  let gpid = 0;
  try {
    const ac = new AbortController();
    const done = spawnStreaming(process.execPath, ['-e', grandchildScript(pidFile)], {
      cwd: work,
      signal: ac.signal,
      onLine: () => {},
    });
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 30_000), 'fixture started');
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(gpid), 'the grandchild is running in its own group');
    ac.abort();
    await done;
    assert.ok(await until(() => !alive(gpid), 6_000), 'the own-group grandchild died with the run');
  } finally {
    if (gpid && alive(gpid)) process.kill(gpid, 'SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('killLiveRunGroups (stop / restart recovery) also kills own-group descendants of a recorded run', NEEDS_PS, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pt-'));
  const pidFile = path.join(work, 'grandchild.pid');
  const worker = spawn(process.execPath, ['-e', grandchildScript(pidFile)], { detached: true, stdio: 'ignore' });
  worker.unref();
  let gpid = 0;
  const store = new Store(':memory:');
  try {
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 30_000), 'fixture started');
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    const t = store.addTask({ title: 'orphaned', prompt: 'x', runner: 'shell' });
    store.claim(t.id);
    const run = store.startRun(t.id);
    store.setRunPid(run.id, worker.pid!);

    assert.deepEqual(store.killLiveRunGroups(), [worker.pid]);
    assert.ok(await until(() => !alive(gpid), 6_000), 'the own-group grandchild died too');
    assert.ok(await until(() => !alive(worker.pid!), 6_000), 'and the worker itself');
  } finally {
    store.close();
    if (gpid && alive(gpid)) process.kill(gpid, 'SIGKILL');
    if (alive(worker.pid!)) process.kill(worker.pid!, 'SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/**
 * A node script that starts a node grandchild in its own process group. The
 * grandchild records its pid, and either writes `term` to `sigFile` and exits
 * on SIGTERM, or (`ignoreTerm`) ignores SIGTERM altogether.
 */
function trappingScript(pidFile: string, sigFile: string, ignoreTerm: boolean): string {
  const grandchild =
    `const fs = require('node:fs');` +
    (ignoreTerm
      ? `process.on('SIGTERM', () => {});`
      : `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(sigFile)}, 'term'); process.exit(0); });`) +
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  return (
    `const { spawn } = require('node:child_process');` +
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' });` +
    `setInterval(() => {}, 1000);`
  );
}

async function abortWithGrandchild(ignoreTerm: boolean): Promise<{ gpid: number; sigFile: string; work: string }> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pt-'));
  const pidFile = path.join(work, 'grandchild.pid');
  const sigFile = path.join(work, 'grandchild.sig');
  const ac = new AbortController();
  const done = spawnStreaming(process.execPath, ['-e', trappingScript(pidFile, sigFile, ignoreTerm)], { cwd: work, signal: ac.signal, onLine: () => {} });
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 30_000), 'fixture started');
  const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
  ac.abort();
  await done;
  return { gpid, sigFile, work };
}

test('an abort SIGTERMs an own-group descendant first, so it can shut down cleanly', NEEDS_PS, async () => {
  const { gpid, sigFile, work } = await abortWithGrandchild(false);
  try {
    assert.ok(await until(() => !alive(gpid), 30_000), 'the grandchild exited');
    assert.equal(fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8') : 'no SIGTERM (killed outright)', 'term');
  } finally {
    if (alive(gpid)) process.kill(gpid, 'SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an own-group descendant that ignores SIGTERM is SIGKILLed by the escalation, after the child itself is gone', NEEDS_PS, async () => {
  const { gpid, work } = await abortWithGrandchild(true);
  try {
    assert.ok(await until(() => !alive(gpid), 30_000), 'the SIGTERM-proof grandchild died on the escalation');
  } finally {
    if (alive(gpid)) process.kill(gpid, 'SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

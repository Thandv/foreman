import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// An uncaught exception in a process that holds a frozen group, guarded by containProcessErrors with a shutdown that
// ends in process.exit(1): the freeze registry's 'exit' listener must still run, so the group is left running.
const psRefused = (spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)]).error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
const NEEDS_PS = {
  timeout: 120_000,
  skip: psRefused ? 'ps cannot be started here (this suite is running inside a sandbox): there is no process table to walk' : false,
};

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

function stat(pid: number): string {
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

/** A shell loop that ignores TERM, in its own group (the shell that started it exits at once): the leftover to freeze. */
async function leftover(t: TestContext): Promise<{ pid: number; group: number; work: string }> {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gfx-')));
  const pidFile = path.join(work, 'left.pid');
  const loop = path.join(work, 'loop.sh');
  fs.writeFileSync(loop, `trap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 0.2; done\n`);
  const child = spawn('/bin/sh', ['-c', `/bin/sh '${loop}' >/dev/null 2>&1 & exit 0`], { detached: true, stdio: 'ignore' });
  await new Promise<void>((r) => child.on('exit', () => r()));
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000), 'fixture started');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  t.after(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
    fs.rmSync(work, { recursive: true, force: true });
  });
  return { pid, group: child.pid!, work };
}

test('an uncaught exception in a guarded process holding a frozen group: it exits 1 and the group is running again, not stopped', NEEDS_PS, async (t) => {
  const l = await leftover(t);
  const frozenFile = path.join(l.work, 'frozen');
  // Written by the guard's shutdown only: Node's own uncaught-exception path also exits 1 and emits 'exit'.
  const guardedFile = path.join(l.work, 'guarded');
  const guardModule = path.join(import.meta.dirname, '..', 'src', 'daemonGuard.ts');
  const proctree = path.join(import.meta.dirname, '..', 'src', 'runners', 'proctree.ts');
  const script = path.join(l.work, 'holder.ts');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { LeftoverReaper, snapshotProcs } from ${JSON.stringify(proctree)};
import { containProcessErrors } from ${JSON.stringify(guardModule)};
// Installed first, as the daemon does, ahead of the registry's own listeners.
containProcessErrors({ record: () => {}, shutdown: (code) => { fs.writeFileSync(${JSON.stringify(guardedFile)}, String(code)); process.exit(code); }, now: Date.now, write: () => {} });
let n = 0;
const reaper = new LeftoverReaper(${l.group}, {
  sampleMs: 0, graceMs: 200, killWaitMs: 1000, boundMs: 120000,
  snapshot: () => (n++ === 0 ? snapshotProcs() : new Promise(() => {})),
  kill: (pid, s) => {
    process.kill(pid, s);
    if (s === 'SIGSTOP') {
      fs.writeFileSync(${JSON.stringify(frozenFile)}, 'x');
      setImmediate(() => { throw new Error('injected exception'); });
    }
  },
});
reaper.childExited();
void reaper.reap();
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  assert.ok(await until(() => fs.existsSync(frozenFile), 60_000), 'the group was frozen');
  const [code, signal] = await ended;
  assert.deepEqual([code, signal], [1, null], 'exited 1');
  assert.equal(fs.readFileSync(guardedFile, 'utf8'), '1', 'through the guard: its shutdown(1) ran');
  assert.ok(await until(() => !stat(l.pid).startsWith('T'), 30_000), `the group is running again (stat ${stat(l.pid)})`);
  assert.ok(stat(l.pid) !== '' && !stat(l.pid).startsWith('Z'), 'and alive');
});

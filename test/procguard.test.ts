import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { NEEDS_PS, procGuard, snapshotFrozen } from './helpers/procguard.ts';

function fakeRealHome(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fakereal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleeper(): ReturnType<typeof spawn> {
  return spawn('sleep', ['60'], { stdio: 'ignore' });
}

async function waitState(pid: number, want: RegExp): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const out = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    if (want.test(out)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid ${pid} never reached ${want}`);
}

test('procGuard gives a fresh temp FOREMAN_HOME and removes it afterwards', (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)] });
  assert.equal(g.env['FOREMAN_HOME'], g.home);
  assert.ok(fs.statSync(g.home).isDirectory());
  assert.notEqual(g.home, process.env['FOREMAN_HOME']);
  g.finish();
  assert.equal(fs.existsSync(g.home), false);
});

test('procGuard fails the test when the real home\'s frozen/ changes', (t) => {
  const real = fakeRealHome(t);
  fs.mkdirSync(path.join(real, 'frozen'));
  fs.writeFileSync(path.join(real, 'frozen', 'a.json'), 'one');
  const g = procGuard(t, { realHomes: [real] });
  fs.writeFileSync(path.join(real, 'frozen', 'a.json'), 'three');
  assert.throws(() => g.finish(), /changed a\.json/);
});

test('procGuard fails when frozen/ appears in a real home that had none, and passes when it is untouched', (t) => {
  const real = fakeRealHome(t);
  procGuard(t, { realHomes: [real] }).finish();
  const g = procGuard(t, { realHomes: [real] });
  fs.mkdirSync(path.join(real, 'frozen'));
  assert.throws(() => g.finish(), /frozen\/ appeared/);
});

test('procGuard watches every home it is given: a change under the second one fails the test', (t) => {
  const first = fakeRealHome(t);
  const second = fakeRealHome(t);
  fs.mkdirSync(path.join(second, 'frozen'));
  const g = procGuard(t, { realHomes: [first, second] });
  fs.writeFileSync(path.join(second, 'frozen', 'new.json'), 'x');
  assert.throws(() => g.finish(), /added new\.json/);
});

test('test/env.ts lists FOREMAN_TEST_REAL_HOME (a path), the starting FOREMAN_HOME and ~/.foreman as the real homes', () => {
  const probe = "import './test/env.ts'; const { realHomes } = await import('./test/env.ts'); console.log(JSON.stringify(realHomes));";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, FOREMAN_HOME: '/tmp/fm-start-home', FOREMAN_TEST_REAL_HOME: '/tmp/fm-real-home' },
  });
  assert.equal(r.status, 0, r.stderr);
  const homes = JSON.parse(r.stdout.trim()) as string[];
  assert.deepEqual(homes, ['/tmp/fm-start-home', '/tmp/fm-real-home', path.join(os.homedir(), '.foreman')]);
});

test('procGuard still kills a tracked pid and removes the temp home when the state check cannot run ps', (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)], psBin: '/nonexistent/ps' });
  const child = sleeper();
  g.track(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  assert.throws(() => g.finish(), /cannot check pids for state T/);
  assert.equal(fs.existsSync(g.home), false);
  return exited.then(() => assert.equal(child.signalCode, 'SIGKILL'));
});

test('procGuard fails when a tracked pid is left in state T, and kills it', NEEDS_PS, async (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)] });
  const child = sleeper();
  g.track(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  process.kill(child.pid!, 'SIGSTOP');
  await waitState(child.pid!, /^T/);
  assert.throws(() => g.finish(), new RegExp(`state T: ${child.pid}`));
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
});

test('procGuard kills a running tracked pid without complaint', NEEDS_PS, async (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)] });
  const child = sleeper();
  g.track(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  await waitState(child.pid!, /^S/);
  g.finish();
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
});

// Real homes are shared with every Foreman process on the machine (presence markers, recorded groups): the guard counts
// only what this test can have done.

/** A `sleep 60` whose parent has exited: alive, and not a descendant of this process. Killed when the test ends. */
function orphan(t: test.TestContext): number {
  const r = spawnSync('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 1, r.stderr);
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  return pid;
}

const rec = (pid: number): string => `${pid}-ThuOct221000002026.json`;

test('procGuard does not count records of live processes that are not ours: added, rewritten, a temp file, one removed by its exiting owner', NEEDS_PS, async (t) => {
  const real = fakeRealHome(t);
  const frozen = path.join(real, 'frozen');
  fs.mkdirSync(frozen);
  const leaving = orphan(t);
  const staying = orphan(t);
  fs.writeFileSync(path.join(frozen, rec(leaving)), '{}');
  fs.writeFileSync(path.join(frozen, rec(staying)), '{}');
  const g = procGuard(t, { realHomes: [real] });
  const arriving = orphan(t);
  fs.writeFileSync(path.join(frozen, rec(arriving)), '{}');
  fs.writeFileSync(path.join(frozen, `${rec(arriving)}.tmp`), '{');
  fs.writeFileSync(path.join(frozen, rec(staying)), '{"groups":[1]}');
  process.kill(leaving, 'SIGKILL');
  fs.rmSync(path.join(frozen, rec(leaving)));
  await new Promise((r) => setTimeout(r, 50));
  g.finish();
});

test('procGuard does not count a frozen/ that appeared holding only a live foreign process\'s record', NEEDS_PS, (t) => {
  const real = fakeRealHome(t);
  const g = procGuard(t, { realHomes: [real] });
  fs.mkdirSync(path.join(real, 'frozen'));
  fs.writeFileSync(path.join(real, 'frozen', rec(orphan(t))), '{}');
  g.finish();
});

test('procGuard counts a record of this process, of a child it made, of a gone recorder, a gone recorder\'s removed record, and the cursor', NEEDS_PS, async (t) => {
  const child = sleeper();
  t.after(() => child.kill('SIGKILL'));
  const done = spawn('true');
  await new Promise((r) => done.once('exit', r));
  const cases: [string, (frozen: string) => void, (frozen: string) => void, RegExp][] = [
    ['this process', () => {}, (f) => fs.writeFileSync(path.join(f, rec(process.pid)), '{}'), new RegExp(`added ${rec(process.pid)}`)],
    ['a child', () => {}, (f) => fs.writeFileSync(path.join(f, `${rec(child.pid!)}.tmp`), '{}'), new RegExp(`added ${rec(child.pid!)}\\.tmp`)],
    ['a gone recorder', () => {}, (f) => fs.writeFileSync(path.join(f, rec(done.pid!)), '{}'), new RegExp(`added ${rec(done.pid!)}`)],
    ['a gone recorder\'s record removed', (f) => fs.writeFileSync(path.join(f, rec(done.pid!)), '{}'), (f) => fs.rmSync(path.join(f, rec(done.pid!))), new RegExp(`removed ${rec(done.pid!)}`)],
    ['the cursor', () => {}, (f) => fs.writeFileSync(path.join(f, 'cursor'), rec(1234)), /added cursor/],
  ];
  for (const [what, setup, act, want] of cases) {
    const real = fakeRealHome(t);
    const frozen = path.join(real, 'frozen');
    fs.mkdirSync(frozen);
    setup(frozen);
    const g = procGuard(t, { realHomes: [real] });
    act(frozen);
    assert.throws(() => g.finish(), want, what);
  }
});

test('snapshotFrozen skips an entry removed between the listing and its lstat', (t) => {
  const dir = fakeRealHome(t);
  fs.writeFileSync(path.join(dir, 'kept.json'), 'x');
  fs.writeFileSync(path.join(dir, 'gone.json.tmp'), 'x');
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', ((p: fs.PathLike, ...rest: never[]) => {
    if (String(p).endsWith('gone.json.tmp')) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
    return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
  }) as typeof fs.lstatSync);
  assert.deepEqual([...snapshotFrozen(dir)!.keys()], ['kept.json']);
});

test('procGuard trackGroup: a stopped member it was never told of is reported, and the whole group is killed', NEEDS_PS, async (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)] });
  const leader = spawn('/bin/sh', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(-leader.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  let members: number[] = [];
  for (let i = 0; i < 100 && members.length < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    members = spawnSync('pgrep', ['-g', String(leader.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
  }
  assert.equal(members.length, 3, `the group's members: ${members.join(', ')}`);
  process.kill(-leader.pid!, 'SIGSTOP');
  for (const m of members) await waitState(m, /^T/);
  g.trackGroup(leader.pid);
  const sleeps = members.filter((m) => m !== leader.pid);
  assert.throws(() => g.finish(), (e: Error) => sleeps.every((m) => new RegExp(`state T: .*\\b${m}\\b`).test(e.message)));
  for (let i = 0; i < 100 && spawnSync('ps', ['-o', 'pid=', '-g', String(leader.pid)], { encoding: 'utf8' }).stdout.trim(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(spawnSync('pgrep', ['-g', String(leader.pid)], { encoding: 'utf8' }).stdout.trim(), '', 'the group is gone');
});

test('procGuard trackGroup never kills a group this process is in', NEEDS_PS, (t) => {
  const g = procGuard(t, { realHomes: [fakeRealHome(t)] });
  const own = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
  g.trackGroup(own);
  assert.throws(() => g.finish(), /hold this process: not killed/);
});

test('snapshotFrozen reads a frozen/ it may not list as absent (a sandboxed suite is refused Foreman\'s home)', { skip: process.getuid?.() === 0 ? 'root lists any directory' : false }, (t) => {
  const dir = path.join(fakeRealHome(t), 'frozen');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), 'x');
  fs.chmodSync(dir, 0o000);
  try {
    assert.equal(snapshotFrozen(dir), null);
  } finally {
    fs.chmodSync(dir, 0o700); // before fakeRealHome's removal, which runs first among the after hooks
  }
});

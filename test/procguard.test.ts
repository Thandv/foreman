import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { NEEDS_PS, procGuard } from './helpers/procguard.ts';

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

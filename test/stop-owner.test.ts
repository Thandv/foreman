import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { stopDaemon, systemDescribe, type StopDeps, type ProcInfo } from '../src/daemonOwner.ts';

const DAEMON = 'node /x/foreman/src/cli.ts serve';

function setup(procs: Record<number, ProcInfo>, listeners: number[], pidfile: string | null) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-stop-')));
  if (pidfile !== null) fs.writeFileSync(path.join(home, 'daemon.pid'), pidfile);
  const live = new Set(Object.keys(procs).map(Number));
  const signals: Array<[number, string | number]> = [];
  const out: string[] = [];
  const deps: StopDeps = {
    home,
    defaultHome: path.join(home, 'default'),
    port: 4100,
    alive: (p) => live.has(p),
    listeners: () => listeners,
    describe: (p) => procs[p],
    kill: (pid, sig) => {
      if (!live.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      signals.push([pid, sig]);
      if (sig === 'SIGTERM') live.delete(pid); // the fake daemon exits on SIGTERM
    },
    sleep: async () => {},
    now: Date.now,
    out: (s) => void out.push(s),
    err: (s) => void out.push(s),
  };
  return { home, deps, signals, out, pidFile: path.join(home, 'daemon.pid') };
}

test('with a stale pidfile and a live owner, stop stops the live owner', async (t) => {
  const s = setup({ 52502: { command: DAEMON, home: '' } }, [52502], '99580\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  s.deps.describe = (p) => (p === 52502 ? { command: DAEMON, home: s.home } : undefined);
  assert.equal(await stopDaemon(s.deps), 0);
  assert.deepEqual(s.signals.filter(([, g]) => g === 'SIGTERM'), [[52502, 'SIGTERM']]);
  assert.match(s.out.join(''), /daemon 52502 stopped/);
  assert.doesNotMatch(s.out.join(''), /stale pidfile/);
});

test('with a stale pidfile and no owner, stop clears the pidfile and signals nothing', async (t) => {
  const s = setup({}, [], '99580\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  assert.equal(await stopDaemon(s.deps), 0);
  assert.deepEqual(s.signals, []);
  assert.equal(fs.existsSync(s.pidFile), false);
  assert.match(s.out.join(''), /clearing a stale pidfile/);
});

test('a pid that is not a foreman daemon for this home is never signalled', async (t) => {
  const s = setup(
    {
      100: { command: 'node /x/foreman/src/cli.ts serve', home: '/some/other/home' }, // a daemon, another home
      200: { command: 'vim notes.txt', home: undefined }, // not a daemon (pid reused by something else)
      300: { command: 'node /x/foreman/src/cli.ts status' }, // foreman, but not serve
    },
    [100, 200, 300],
    '200\n',
  );
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  assert.equal(await stopDaemon(s.deps), 0);
  assert.deepEqual(s.signals, []);
  assert.equal(fs.existsSync(s.pidFile), false, 'no owner exists, so the stale pidfile is cleared');
});

test('a live pidfile holder that is the daemon for this home is stopped, and nothing else is', async (t) => {
  const s = setup({}, [999], '500\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const info = { command: DAEMON, home: s.home };
  let live = new Set([500, 999]);
  s.deps.alive = (p) => live.has(p);
  s.deps.describe = () => info;
  s.deps.kill = (pid, sig) => {
    if (!live.has(pid)) throw new Error('ESRCH');
    s.signals.push([pid, sig]);
    if (sig === 'SIGTERM') live = new Set([...live].filter((p) => p !== pid));
  };
  assert.equal(await stopDaemon(s.deps), 0);
  assert.deepEqual(s.signals.filter(([, g]) => g === 'SIGTERM'), [[500, 'SIGTERM']]);
});

test('a daemon that outlives the wait makes stop exit 1 without a second signal', async (t) => {
  const s = setup({ 7: { command: DAEMON } }, [], '7\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  s.deps.describe = () => ({ command: DAEMON, home: s.home });
  s.deps.kill = (pid, sig) => void s.signals.push([pid, sig]); // ignores SIGTERM
  s.deps.graceMs = -1;
  assert.equal(await stopDaemon(s.deps), 1);
  assert.deepEqual(s.signals.filter(([, g]) => g === 'SIGTERM'), [[7, 'SIGTERM']]);
});

test('no pidfile and no owner: stop says so and exits 0', async (t) => {
  const s = setup({}, [], null);
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  assert.equal(await stopDaemon(s.deps), 0);
  assert.match(s.out.join(''), /no daemon pidfile/);
});

test('a live daemon whose home cannot be matched keeps its pidfile and is not signalled; a symlinked spelling matches', async (t) => {
  const s = setup({ 42: { command: DAEMON, home: '/some/other/home' } }, [42], '42\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  assert.equal(await stopDaemon(s.deps), 1);
  assert.equal(s.signals.length, 0);
  assert.equal(fs.existsSync(s.pidFile), true, 'removing a live daemon\'s lock would let a second one start');
  fs.symlinkSync(s.home, `${s.home}-link`);
  t.after(() => fs.rmSync(`${s.home}-link`, { force: true }));
  s.deps.describe = () => ({ command: DAEMON, home: s.home });
  assert.equal(await stopDaemon({ ...s.deps, home: `${s.home}-link` }), 0);
  assert.deepEqual(s.signals.filter(([, g]) => g === 'SIGTERM'), [[42, 'SIGTERM']]);
});

test('a foreman process for this home that is not `serve` (a CLI call, a worker) is never signalled', async (t) => {
  const s = setup({ 300: { command: '' } }, [300], '300\n');
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  s.deps.describe = () => ({ command: 'node /x/foreman/src/cli.ts status', home: s.home });
  assert.equal(await stopDaemon(s.deps), 0);
  assert.deepEqual(s.signals, []);
});

test('systemDescribe reads a FOREMAN_HOME that contains a space', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, FOREMAN_HOME: '/x/sp ace/h' }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((r) => child.once('spawn', r));
  // Under the test sandbox (FOREMAN_SANDBOX=tests) ps shows no process environment at all; `foreman stop` itself never
  // runs sandboxed, so there the case cannot be observed rather than failing.
  const shown = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' });
  if (process.platform === 'darwin' && !shown.includes('FOREMAN_HOME=')) {
    t.skip('ps shows no process environment here (sandboxed)');
    return;
  }
  assert.equal(systemDescribe(child.pid!)?.home, '/x/sp ace/h');
});

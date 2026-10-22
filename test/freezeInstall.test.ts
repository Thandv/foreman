import { realHomes } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../src/config.ts';
import { sandboxAvailable, wrap } from '../src/security/sandbox.ts';
import { installProcessRecorder } from '../src/runners/freezeInstall.ts';
import { resetFreezeRecorderForTest, type FreezeRecord } from '../src/runners/freezeRecord.ts';
import { frozenChanges, NEEDS_PS as PS, procGuard, snapshotFrozen, type ProcGuard } from './helpers/procguard.ts';

// Where the freeze recorder is installed (src/cli.ts, src/verify/testSlot.ts) and what that does to a home. Every
// process here is a real one with a throwaway FOREMAN_HOME; the live home's frozen/ is watched throughout.
const NEEDS_PS = { ...PS, timeout: 120_000 };
const SRC = path.join(import.meta.dirname, '..', 'src');
const CLI = path.join(SRC, 'cli.ts');
const TEST_SLOT = path.join(SRC, 'verify', 'testSlot.ts');
const INNER = path.join(import.meta.dirname, 'helpers', 'innerCli.ts');

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every record file under `<home>/frozen`, parsed. */
function records(home: string): { name: string; rec: FreezeRecord }[] {
  const dir = path.join(home, 'frozen');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((name) => ({ name, rec: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FreezeRecord }));
}

const leftovers = (home: string): string[] => (fs.existsSync(path.join(home, 'frozen')) ? fs.readdirSync(path.join(home, 'frozen')) : []);
const liveFrozen = (): Map<string, ReturnType<typeof snapshotFrozen>> => new Map(realHomes.map((h) => [h, snapshotFrozen(path.join(h, 'frozen'))]));
const liveChanges = (before: ReturnType<typeof liveFrozen>): string[] =>
  [...before].flatMap(([h, snap]) => frozenChanges(snap, snapshotFrozen(path.join(h, 'frozen'))).map((c) => `${h}: ${c}`));

/** A process that ignores SIGTERM, named by `home/daemon.pid`: `foreman stop` against it waits until the test kills it. */
function stubbornDaemon(g: ProcGuard): ChildProcess {
  const holder = spawn('sh', ['-c', 'trap "" TERM; exec sleep 60'], { stdio: 'ignore' });
  g.track(holder.pid);
  fs.writeFileSync(path.join(g.home, 'daemon.pid'), String(holder.pid));
  return holder;
}

function run(t: TestContext, file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, exe = process.execPath): { child: ChildProcess; out: () => string; exit: Promise<number | null> } {
  const child = spawn(exe, [file, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d));
  child.stderr!.on('data', (d: Buffer) => (out += d));
  t.after(() => child.kill('SIGKILL'));
  return { child, out: () => out, exit: new Promise((r) => child.on('exit', (code) => r(code))) };
}

test('cli.ts: a command writes its presence marker to the home while it runs, and nothing is left after it', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const holder = stubbornDaemon(g);
  const cli = run(t, CLI, ['stop'], g.env);
  await until(() => records(g.home).length > 0, `the CLI's marker:\n${cli.out()}`);
  const [only, ...rest] = records(g.home);
  assert.equal(rest.length, 0);
  assert.equal(only!.rec.recorder.pid, cli.child.pid, 'the marker is the CLI process\'s own');
  assert.deepEqual(only!.rec.groups, [], 'a presence marker holds no group');
  holder.kill('SIGKILL');
  assert.equal(await cli.exit, 0, cli.out());
  assert.deepEqual(leftovers(g.home), [], 'a clean exit removes the marker');
});

test('cli.ts: a command the worker ledger guard refuses writes no marker', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const cli = run(t, CLI, ['ls'], { ...g.env, FOREMAN_RUN_ID: 'r_refused' });
  assert.equal(await cli.exit, 2);
  assert.match(cli.out(), /worker ledger guard/);
  assert.equal(fs.existsSync(path.join(g.home, 'frozen')), false, 'no frozen/ directory was made');
});

test('serve sweeps before it installs its recorder: its marker is absent during the sweep and present once it is up', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const env: NodeJS.ProcessEnv = {
    ...g.env, FOREMAN_DB: path.join(g.home, 'scratch.db'), FOREMAN_PORT: '0', FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on',
    FOREMAN_CLAUDE_BIN: path.join(g.home, 'no-claude'), FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
    FOREMAN_FREEZE_SWEEP_GRACE_MS: '50', FOREMAN_FREEZE_SWEEP_CAP_MS: '3000', FOREMAN_FREEZE_SWEEP_FAULT: 'hang',
  };
  const serve = run(t, CLI, ['serve'], env);
  // The sweep hangs for its whole 3 s cap. A marker first seen well before the sweep reported giving up was written
  // by a recorder installed before it.
  let firstMarker = 0;
  let gaveUp = 0;
  let up = false;
  const poll = setInterval(() => {
    const now = Date.now();
    if (!firstMarker && records(g.home).length) firstMarker = now;
    if (!gaveUp && /freeze sweep: gave up/.test(serve.out())) gaveUp = now;
    if (/^foreman up /m.test(serve.out())) up = true;
  }, 10);
  t.after(() => clearInterval(poll));
  await until(() => up, `serve to be up:\n${serve.out()}`);
  assert.ok(gaveUp, serve.out());
  assert.ok(firstMarker >= gaveUp - 1_000, `serve's marker was there ${gaveUp - firstMarker} ms before the sweep ended`);
  const [only, ...rest] = records(g.home);
  assert.equal(rest.length, 0);
  assert.equal(only!.rec.recorder.pid, serve.child.pid);
  assert.deepEqual(only!.rec.groups, []);
});

test('testSlot.ts: the suite\'s detached leftover group is recorded under the home while it is frozen, and nothing is left after', NEEDS_PS, async (t) => {
  const g = procGuard(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-slotwire-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(work, 'leftover.cjs'),
    `const c = require('child_process').spawn('sh', ['-c', 'trap "" TERM; sleep 60'], { detached: true, stdio: 'ignore' });
c.unref();
require('fs').writeFileSync('leftover.pid', String(c.pid));
setTimeout(() => {}, 700);\n`,
  );
  const env = {
    ...g.env, FOREMAN_WORKER_TEST_CMD: 'node leftover.cjs', FOREMAN_LEFTOVER_SAMPLE_MS: '20', FOREMAN_PORT: '1', FOREMAN_SANDBOX: 'off',
  };
  const slot = run(t, TEST_SLOT, [], env, work);
  let marker = false;
  let group: number | null = null;
  const poll = setInterval(() => {
    for (const { rec } of records(g.home)) {
      if (rec.recorder.pid !== slot.child.pid) continue;
      if (rec.groups.length === 0) marker = true;
      else group = rec.groups[0]!.pgid;
    }
  }, 5);
  t.after(() => clearInterval(poll));
  assert.equal(await slot.exit, 0, slot.out());
  clearInterval(poll);
  const leftoverPid = Number(fs.readFileSync(path.join(work, 'leftover.pid'), 'utf8'));
  g.track(leftoverPid);
  assert.ok(marker, 'the presence marker was there while the suite ran');
  assert.equal(group, leftoverPid, 'a record of the leftover group was there while it was frozen');
  assert.deepEqual(leftovers(g.home), [], 'after the run the home holds nothing of it');
});

test('a suite run under testSlot records nothing in the live home while its tests run, even when they start the CLI', NEEDS_PS, async (t) => {
  const g = procGuard(t); // g.home stands for the daemon's absolute home, the one testSlot is given
  const ctrl = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-slotiso-'));
  t.after(() => fs.rmSync(ctrl, { recursive: true, force: true }));
  const live = liveFrozen();
  const env = { ...g.env, FOREMAN_WORKER_TEST_CMD: `node ${INNER} ${ctrl}`, FOREMAN_PORT: '1', FOREMAN_SANDBOX: 'off' };
  const slot = run(t, TEST_SLOT, [], env, ctrl);
  await until(() => fs.existsSync(path.join(ctrl, 'ready')), `the inner process to have started the CLI:\n${slot.out()}`);

  const inner = fs.readFileSync(path.join(ctrl, 'home'), 'utf8');
  assert.notEqual(inner, g.home, 'the tests run with a home of their own');
  const mine = records(g.home);
  assert.equal(mine.length, 1, `the daemon's home holds testSlot's marker alone: ${leftovers(g.home).join(', ')}`);
  assert.equal(mine[0]!.rec.recorder.pid, slot.child.pid);
  assert.deepEqual(mine[0]!.rec.groups, []);
  const theirs = records(inner);
  assert.equal(theirs.length, 1, 'the CLI the tests started wrote to the tests\' own home');
  assert.notEqual(theirs[0]!.rec.recorder.pid, slot.child.pid);
  assert.deepEqual(liveChanges(live), [], 'while the tests run, the live homes\' frozen/ is as it was');

  fs.writeFileSync(path.join(ctrl, 'go'), '');
  assert.equal(await slot.exit, 0, slot.out());
  assert.deepEqual(leftovers(g.home), [], 'after the run the daemon\'s home holds nothing');
  assert.deepEqual(liveChanges(live), [], 'after the run, the live homes\' frozen/ is as it was');
});

test('installProcessRecorder: a process whose start cannot be read installs FAILED, writes nothing and says so', async (t) => {
  const g = procGuard(t);
  t.after(() => resetFreezeRecorderForTest());
  for (const snapshot of [async () => null, async () => []]) {
    resetFreezeRecorderForTest();
    const logs: string[] = [];
    const r = await installProcessRecorder(g.home, (l) => logs.push(l), snapshot);
    assert.equal(r.ok, false);
    assert.equal(r.recorder?.failed, true);
    assert.equal(r.recorder?.record([{ pgid: 4_000_001, members: [[4_000_001, 'x']] }]).ok, false, 'a failed recorder records nothing');
    assert.equal(fs.existsSync(path.join(g.home, 'frozen')), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /start time could not be read.*without being frozen/);
  }
});

test('installProcessRecorder: a home it cannot write installs FAILED and says why', async (t) => {
  const g = procGuard(t);
  t.after(() => resetFreezeRecorderForTest());
  fs.writeFileSync(path.join(g.home, 'frozen'), 'not a directory');
  const logs: string[] = [];
  const r = await installProcessRecorder(g.home, (l) => logs.push(l), async () => [{ pid: process.pid, ppid: 1, pgid: process.pid, sid: null, start: 'Fri Oct 16 20:00:00 2026' }]);
  assert.equal(r.ok, false);
  assert.equal(r.recorder?.failed, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /freeze recorder not installed \((?!this process).*\).*without being frozen/);
});

// The worker's real path: its testSlot runs inside the worker sandbox, where Foreman's home is closed to it. The
// recorder cannot write there, so it is FAILED: the suite still runs and passes, the home gets nothing, and the
// stderr line says leftovers are now ended without a freeze.
const sandboxAnswer = await sandboxAvailable();
const SANDBOX_SKIP = sandboxAnswer === 'ok' ? false : `the sandbox cannot be exercised here: ${sandboxAnswer}`;

test('a worker\'s testSlot inside the worker sandbox cannot write the home: it says so, writes nothing, and the suite still passes', { skip: SANDBOX_SKIP, timeout: 170_000 }, async (t) => {
  const g = procGuard(t);
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-slotbox-')));
  t.after(() => fs.rmSync(area, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['jail', 'tmp', 'home', 'cfg'].map((n) => [n, path.join(area, n)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dirs['jail']!, 'suite.cjs'), 'console.log("suite ran");\n');
  const home = config.home; // the home the sandbox closes (wrap() reads it); the wrapper is given the same one below
  const wrapped = await wrap(
    'worker',
    { jail: dirs['jail']!, tmp: dirs['tmp']!, home: dirs['home']!, claudeCfg: dirs['cfg']!, readOnly: [path.join(SRC, '..')] },
    process.execPath,
    [TEST_SLOT],
  );
  const env = {
    ...process.env, FOREMAN_HOME: home, FOREMAN_WORKER_TEST_CMD: 'node suite.cjs', FOREMAN_PORT: '1', TMPDIR: dirs['tmp']!, HOME: dirs['home']!,
  };
  const before = snapshotFrozen(path.join(home, 'frozen'));
  const [first, ...rest] = wrapped.args;
  const slot = run(t, first!, rest, env, dirs['jail'], wrapped.cmd);
  assert.equal(await slot.exit, 0, slot.out());
  assert.match(slot.out(), /testSlot: node suite\.cjs PASSED/);
  assert.match(slot.out(), /foreman: freeze recorder not installed .*without being frozen/);
  assert.deepEqual(frozenChanges(before, snapshotFrozen(path.join(home, 'frozen'))), [], 'nothing was written to the home');
});

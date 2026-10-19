import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { claudeWorkerEnv } from '../src/runners/claudeIsolation.ts';
import { workerEnv } from '../src/runners/cliRunners.ts';
import { sandboxAvailable } from '../src/security/sandbox.ts';

// FOREMAN_HOME=.foreman is what the daemon passes its workers: resolved against the worker's own cwd (its jail) it names
// a different directory than the daemon's, and the sandbox then refuses the jail as "containing Foreman's home".
// Each test runs the code under test in a child with the relative home, from a cwd that is not the daemon's.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(SRC, 'src', 'cli.ts');
const SLOT = path.join(SRC, 'src', 'verify', 'testSlot.ts');
const href = (rel: string): string => JSON.stringify(path.join(SRC, rel));

const scratchDirs: string[] = [];
function scratch(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `foreman-workerhome-${name}-`)));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A clean environment: nothing of the suite's own FOREMAN_* settings, so a child reads only what a test hands it. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FOREMAN_')) env[k] = v;
  return { ...env, ...extra };
}

function writeModule(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const darwin = process.platform === 'darwin' ? false : 'the OS sandbox (sandbox-exec) the refusal comes from exists on macOS only';
const sandboxOff = darwin || (await sandboxAvailable()) === 'ok'
  ? darwin
  : 'the sandbox cannot be exercised here (sandbox-exec missing, or this suite is itself inside a sandbox)';

// ------------------------------------------------------------------------------------------------------- (a)

test('a relative FOREMAN_HOME is resolved once: a grandchild started from another cwd reads the same home', () => {
  const daemonCwd = scratch('daemon');
  const elsewhere = scratch('elsewhere');
  const grand = writeModule(elsewhere, 'grand.mjs', `
    const { config } = await import(${href('src/config.ts')});
    process.stdout.write(config.home);
  `);
  const child = writeModule(daemonCwd, 'child.mjs', `
    import { execFileSync } from 'node:child_process';
    const { config } = await import(${href('src/config.ts')});
    const grandHome = execFileSync(process.execPath, [${JSON.stringify(grand)}], { cwd: ${JSON.stringify(elsewhere)}, env: process.env, encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ home: config.home, grandHome }));
  `);
  const out = JSON.parse(
    execFileSync(process.execPath, [child], { cwd: daemonCwd, env: cleanEnv({ FOREMAN_HOME: '.foreman' }), encoding: 'utf8' }),
  ) as { home: string; grandHome: string };
  assert.equal(out.home, path.join(daemonCwd, '.foreman'));
  assert.equal(out.grandHome, out.home, 'the grandchild did not re-resolve .foreman against its own cwd');
});

// ------------------------------------------------------------------------------------------------------- (b)

test('workers are given the daemon\'s absolute home, not the relative text', () => {
  const daemonCwd = scratch('daemon');
  const elsewhere = scratch('elsewhere');
  const child = writeModule(daemonCwd, 'child.mjs', `
    const { config } = await import(${href('src/config.ts')});
    const { claudeWorkerEnv } = await import(${href('src/runners/claudeIsolation.ts')});
    const { workerEnv } = await import(${href('src/runners/cliRunners.ts')});
    // Whatever puts the relative text back after config has resolved it (a spec's env, a later assignment).
    process.env.FOREMAN_HOME = '.foreman';
    process.chdir(${JSON.stringify(elsewhere)});
    process.stdout.write(JSON.stringify({
      home: config.home,
      claude: claudeWorkerEnv({ id: 't_home' }).FOREMAN_HOME,
      runner: workerEnv({ testCmd: 'npm run verify' }, 'r_home').FOREMAN_HOME,
    }));
  `);
  const out = JSON.parse(
    execFileSync(process.execPath, [child], { cwd: daemonCwd, env: cleanEnv({ FOREMAN_HOME: '.foreman' }), encoding: 'utf8' }),
  ) as { home: string; claude: string; runner: string };
  assert.equal(out.home, path.join(daemonCwd, '.foreman'));
  assert.ok(path.isAbsolute(out.claude), `claudeWorkerEnv: ${out.claude}`);
  assert.ok(path.isAbsolute(out.runner), `workerEnv: ${out.runner}`);
  assert.equal(out.claude, out.home);
  assert.equal(out.runner, out.home);
});

// ------------------------------------------------------------------------------------- (a)+(b) through the sandbox

test('a suite run in a jail under a relative home is not refused as containing Foreman\'s home (macOS)', { skip: sandboxOff, timeout: 120_000 }, () => {
  const daemonCwd = scratch('daemon');
  // The parent: starts with the relative home, makes the run's jail under it, and starts the slot wrapper there with
  // the environment a worker gets.
  const parent = writeModule(daemonCwd, 'parent.mjs', `
    import { spawnSync } from 'node:child_process';
    const { createJail } = await import(${href('src/isolate.ts')});
    const { claudeWorkerEnv } = await import(${href('src/runners/claudeIsolation.ts')});
    const { workerEnv } = await import(${href('src/runners/cliRunners.ts')});
    const task = { id: 't_slot', repo: null };
    const jail = await createJail(task, 'r_slot');
    const env = { ...claudeWorkerEnv(task), ...workerEnv({ testCmd: 'node -e 0' }, 'r_slot'), FOREMAN_PORT: '0' };
    delete env.FOREMAN_SANDBOX;
    const r = spawnSync(process.execPath, [${JSON.stringify(SLOT)}], { cwd: jail.dir, env, encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr, stdout: r.stdout }));
  `);
  const out = JSON.parse(
    execFileSync(process.execPath, [parent], { cwd: daemonCwd, env: cleanEnv({ FOREMAN_HOME: '.foreman' }), encoding: 'utf8' }),
  ) as { status: number; stderr: string; stdout: string };
  assert.doesNotMatch(out.stderr + out.stdout, /contains Foreman's home/);
  assert.equal(out.status, 0, out.stderr + out.stdout);
});

// ------------------------------------------------------------------------------------------- (c) the ledger guard

/** What a worker session gets: the allowlisted daemon environment, then the runner's own, with an absolute home. */
function workerSessionEnv(): NodeJS.ProcessEnv {
  const task = { id: 't_guard', testCmd: 'node -e 0' };
  return { ...claudeWorkerEnv(task), ...workerEnv(task, 'r_guard'), FOREMAN_PORT: '0' };
}

/** Every file under `dir` with its bytes and mtime. */
function stat(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const s = fs.statSync(path.join(dir, name));
    out[name] = s.isDirectory() ? 'dir' : `${s.mtimeMs}:${fs.readFileSync(path.join(dir, name)).toString('base64')}`;
  }
  return out;
}

function plantLedger(): void {
  const db = new DatabaseSync(path.join(config.home, 'foreman.db'));
  db.exec('create table if not exists planted (n integer); delete from planted; insert into planted values (1);');
  db.close();
}

test('worker ledger guard: ls, add and restore exit non-zero before touching the daemon\'s ledger', () => {
  const jail = scratch('jail');
  fs.writeFileSync(path.join(jail, 'backup.gz'), 'not a backup');
  plantLedger();
  const env = workerSessionEnv();
  assert.equal(env['FOREMAN_HOME'], config.home);
  assert.equal(env['FOREMAN_RUN_ID'], 'r_guard');
  const before = stat(config.home);
  // (building the environment made claude-config/ here; the guard must add nothing to what is there now)
  for (const name of ['work', 'artifacts', 'daemon.pid', 'foreman.db-wal', 'foreman.db-shm']) assert.ok(!(name in before), name);
  for (const argv of [['ls'], ['add', 'x'], ['restore', path.join(jail, 'backup.gz')]]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: jail, env, encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(r.status, 0, `${argv[0]}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /worker ledger guard/, argv[0]);
  }
  // Byte for byte, mtime for mtime — and no -wal, -shm, pidfile, lock, work/ or artifacts/ made beside it.
  assert.deepEqual(stat(config.home), before);
});

test('worker ledger guard: the slot wrapper still finds the home, and its sandbox still closes it (macOS)', { skip: sandboxOff, timeout: 120_000 }, () => {
  const jail = scratch('jail');
  plantLedger();
  const env = workerSessionEnv();
  delete env['FOREMAN_SANDBOX'];
  const probe = writeModule(jail, 'home.mjs', `
    const { config } = await import(${href('src/config.ts')});
    process.stdout.write(config.home);
  `);
  const seen = spawnSync(process.execPath, [probe], { cwd: jail, env, encoding: 'utf8' });
  assert.equal(seen.stdout, config.home, 'testSlot resolves the planted home');

  const slot = (suite: string): { status: number | null; out: string } => {
    fs.writeFileSync(path.join(jail, 'suite.cjs'), suite);
    const r = spawnSync(process.execPath, [SLOT], { cwd: jail, env: { ...env, FOREMAN_WORKER_TEST_CMD: 'node suite.cjs' }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const inJail = slot(`require('fs').writeFileSync('ok.txt', 'y');`);
  assert.equal(inJail.status, 0, inJail.out);
  const intoHome = slot(`require('fs').writeFileSync(${JSON.stringify(path.join(config.home, 'x'))}, 'y');`);
  assert.notEqual(intoHome.status, 0, intoHome.out);
  assert.equal(fs.existsSync(path.join(config.home, 'x')), false, 'the stand-in suite could not write into the home');
});

/** Every name main() in cli.ts dispatches on, read from its source, so a command added later is covered too. */
function dispatchedCommands(): string[] {
  const src = fs.readFileSync(CLI, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s*case '([a-z-]+)':/gm)) names.add(m[1]!);
  for (const m of src.matchAll(/\bcmd === '([a-z-]+)'/g)) names.add(m[1]!);
  names.delete('help');
  return [...names].sort();
}

/** Every path under `dir`, recursively, with its bytes and mtime. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(entry.parentPath, entry.name);
    const s = fs.statSync(p);
    out[path.relative(dir, p)] = entry.isDirectory() ? `dir:${s.mtimeMs}` : `${s.mtimeMs}:${fs.readFileSync(p).toString('base64')}`;
  }
  return out;
}

function runCli(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...argv], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    let stderr = '';
    c.stderr.on('data', (d: Buffer) => (stderr += d));
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, stderr }));
  });
}

test('worker ledger guard: every command the CLI dispatches is refused, for any worker, keyed on FOREMAN_RUN_ID alone', { timeout: 180_000 }, async () => {
  const commands = dispatchedCommands();
  for (const name of ['ls', 'add', 'restore', 'serve', 'stop', 'approve', 'backup', 'prune', 'doctor', 'debrief', 'archive']) {
    assert.ok(commands.includes(name), `the dispatcher scan found ${name}`);
  }
  const jail = scratch('jail');
  plantLedger();
  // A claude-code worker whose ticket names no test command, and a worker of another CLI runner (the daemon's own
  // environment plus workerEnv, here only PATH and HOME of it): FOREMAN_RUN_ID is the one marker both carry.
  const noTestCmd = { id: 't_every', testCmd: null };
  const workers: Record<string, NodeJS.ProcessEnv> = {
    'claude-code': { ...claudeWorkerEnv(noTestCmd), ...workerEnv(noTestCmd, 'r_every'), FOREMAN_PORT: '0' },
    other: { PATH: process.env['PATH'], HOME: process.env['HOME'], ...workerEnv(noTestCmd, 'r_every'), FOREMAN_PORT: '0' },
  };
  const before = tree(config.home);
  for (const [runner, env] of Object.entries(workers)) {
    const results = await Promise.all([...commands, 'nosuchcmd'].map(async (cmd) => ({ cmd, ...(await runCli([cmd, 't_x'], jail, env)) })));
    for (const r of results) {
      assert.equal(r.status, 2, `${runner} ${r.cmd}: ${r.stderr}`);
      assert.match(r.stderr, /worker ledger guard/, `${runner} ${r.cmd}`);
    }
  }
  assert.deepEqual(tree(config.home), before);
  // The same session without the marker is not refused by the guard: nothing else in a worker's environment keys it.
  const { FOREMAN_RUN_ID: _marker, ...unmarked } = workers['other']!;
  const r = await runCli(['ls'], jail, unmarked);
  assert.doesNotMatch(r.stderr, /worker ledger guard/);
});

// ----------------------------------------------------------------------------------------- (d) the suite's marker

test('a suite started by a worker (FOREMAN_RUN_ID set) clears the marker, so the CLI it starts is not guarded', async () => {
  const dir = scratch('suite');
  const stub = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tasks: [], workers: { active: 0, max: 1 }, archivedCount: 0 }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as { port: number }).port;
  try {
    const suite = writeModule(dir, 'suite.mjs', `
      import ${JSON.stringify(path.join(SRC, 'test', 'env.ts'))};
      import { spawnSync } from 'node:child_process';
      process.env.FOREMAN_PORT = ${JSON.stringify(String(port))};
      const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'ls'], { env: process.env, encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ status: r.status, out: r.stdout + r.stderr }));
    `);
    const done = await new Promise<{ status: number; out: string }>((resolve, reject) => {
      const c = spawn(process.execPath, [suite], { cwd: dir, env: cleanEnv({ FOREMAN_RUN_ID: 'r_test' }), stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      c.stdout.on('data', (d: Buffer) => (buf += d));
      c.on('error', reject);
      c.on('close', () => resolve(JSON.parse(buf)));
    });
    assert.equal(done.status, 0, done.out);
    assert.match(done.out, /no tasks/);
  } finally {
    stub.close();
  }
});

void testHome;

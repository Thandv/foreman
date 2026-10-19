import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { provisionDeps } from '../src/deps.ts';
import { workerSuiteInJail } from '../src/doctorJail.ts';
import { sandboxAvailable } from '../src/security/sandbox.ts';

// `foreman doctor`'s "worker suite in a jail" line. Every test runs against the scratch home test/env.ts made
// (never the live daemon's or .foreman/), and cuts its jail from a clean clone of this checkout, which the
// working tree being edited is not.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchDirs: string[] = [];
function scratch(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `foreman-doctorjail-${name}-`)));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

function cloneOfCheckout(): string {
  const dest = path.join(scratch('clone'), 'foreman');
  execFileSync('git', ['clone', '-q', SRC, dest], { stdio: 'ignore' });
  return dest;
}

const leftovers = (): string[] => (fs.existsSync(config.workRoot) ? fs.readdirSync(config.workRoot) : []);

const darwin = process.platform === 'darwin' ? false : 'the OS sandbox (sandbox-exec) the check turns on exists on macOS only';
const sandboxOff = darwin || (await sandboxAvailable()) === 'ok'
  ? darwin
  : 'the sandbox cannot be exercised here (sandbox-exec missing, or this suite is itself inside a sandbox)';

test('doctor line: the worker suite runs in a jail of the checkout, and no jail is left (macOS)', { skip: sandboxOff, timeout: 120_000 }, async () => {
  assert.equal(await workerSuiteInJail({ repo: cloneOfCheckout() }), 'worker suite in a jail: ok');
  assert.deepEqual(leftovers(), []);
});

test('doctor line: a repo createJail refuses is FAIL <reason>, not a throw', async () => {
  const line = await workerSuiteInJail({ repo: path.join(scratch('none'), 'missing') });
  assert.match(line, /^worker suite in a jail: FAIL repo not found: /);
  assert.deepEqual(leftovers(), []);
});

test('doctor line: a createJail that throws is FAIL with its message', async () => {
  const line = await workerSuiteInJail({ createJail: async () => { throw new Error('repo has uncommitted changes'); } });
  assert.equal(line, 'worker suite in a jail: FAIL repo has uncommitted changes');
});

test('doctor line: a testSlot child that outlives the timeout is FAIL timed out, and its jail is removed', { timeout: 120_000 }, async () => {
  const line = await workerSuiteInJail({ repo: cloneOfCheckout(), timeoutMs: 1 });
  assert.equal(line, 'worker suite in a jail: FAIL timed out after 1ms');
  assert.deepEqual(leftovers(), []);
});

test('doctor line: a suite that exits non-zero is FAIL with the exit code', { timeout: 120_000 }, async () => {
  const repo = cloneOfCheckout();
  // Break the wrapper in the checkout the jail is cut from: it exits 1 on a syntax error.
  fs.writeFileSync(path.join(repo, 'src', 'verify', 'testSlot.ts'), 'throw new Error("boom");\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'break'], { cwd: repo, stdio: 'ignore' });
  const line = await workerSuiteInJail({ repo });
  assert.match(line, /^worker suite in a jail: FAIL exit 1: .*boom/);
  assert.deepEqual(leftovers(), []);
});

test('doctor line: a jail that cannot be removed is FAIL naming the jail, never ok', { timeout: 120_000 }, async () => {
  for (const removeJail of [
    async () => { throw new Error('worktree is locked'); },
    async () => {}, // removeJail swallows its own errors: the directory is simply still there
  ]) {
    const line = await workerSuiteInJail({ repo: cloneOfCheckout(), timeoutMs: 1, removeJail });
    const left = leftovers();
    try {
      assert.equal(left.length, 1);
      assert.ok(line.startsWith('worker suite in a jail: FAIL (timed out after 1ms) jail left at '), line);
      assert.ok(line.includes(path.join(config.workRoot, left[0]!)), line);
    } finally {
      for (const d of left) fs.rmSync(path.join(config.workRoot, d), { recursive: true, force: true });
    }
  }
});

test('provisionDeps never runs npm when installing is not allowed (an npm stub first on PATH records any call)', { timeout: 120_000 }, async () => {
  const bin = scratch('bin');
  const log = path.join(bin, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`, { mode: 0o755 });
  const savedPath = process.env['PATH'];
  process.env['PATH'] = `${bin}${path.delimiter}${savedPath}`;
  try {
    // The checkout has a lockfile, ignores node_modules, and (in this clone) has none installed and no cached install.
    const repo = cloneOfCheckout();
    const jailDir = scratch('jail');
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(jailDir, 'package.json'));
    fs.copyFileSync(path.join(repo, 'package-lock.json'), path.join(jailDir, 'package-lock.json'));
    const r = await provisionDeps(jailDir, repo, { allowInstall: false });
    assert.equal(r.provisioned, false);
    assert.match(r.reason, /^no cached install for lockfile /);
    assert.equal(fs.existsSync(log), false, 'npm was called by provisionDeps');

    // The whole doctor check, which provisions on the way to the wrapper.
    await workerSuiteInJail({ repo, timeoutMs: 1 });
    assert.equal(fs.existsSync(log), false, 'npm was called by the doctor check');

    // The stub can see a call: with installing allowed the same tree does run it.
    await provisionDeps(jailDir, repo, { allowInstall: true });
    assert.match(fs.readFileSync(log, 'utf8'), /^ci /);
  } finally {
    process.env['PATH'] = savedPath;
  }
});

test('doctor line: a relative FOREMAN_HOME still gives ok (macOS)', { skip: sandboxOff, timeout: 120_000 }, () => {
  const daemonCwd = scratch('daemon');
  const repo = cloneOfCheckout();
  const child = path.join(daemonCwd, 'child.mjs');
  fs.writeFileSync(child, `
    const { workerSuiteInJail } = await import(${JSON.stringify(path.join(SRC, 'src', 'doctorJail.ts'))});
    process.stdout.write(await workerSuiteInJail({ repo: ${JSON.stringify(repo)} }));
  `);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FOREMAN_')) env[k] = v;
  const out = execFileSync(process.execPath, [child], { cwd: daemonCwd, env: { ...env, FOREMAN_HOME: '.foreman' }, encoding: 'utf8' });
  assert.equal(out, 'worker suite in a jail: ok');
  assert.deepEqual(fs.existsSync(path.join(daemonCwd, '.foreman', 'work')) ? fs.readdirSync(path.join(daemonCwd, '.foreman', 'work')) : [], []);
});

test('doctor line: with the worker-home fix reverted, a relative FOREMAN_HOME is FAIL contains Foreman\'s home (macOS)', { skip: sandboxOff, timeout: 120_000 }, () => {
  // A clone of this checkout with t1's (a) config.ts absolutising and (b) FOREMAN_HOME-from-config.home removed.
  const clone = cloneOfCheckout();
  const edit = (file: string, from: string, to: string): void => {
    const p = path.join(clone, file);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(from), `${file} no longer contains ${from}`);
    fs.writeFileSync(p, text.replace(from, to));
  };
  // The clone is of the commits, which may not have the check itself yet.
  fs.copyFileSync(path.join(SRC, 'src', 'doctorJail.ts'), path.join(clone, 'src', 'doctorJail.ts'));
  execFileSync('git', ['add', '-A'], { cwd: clone, stdio: 'ignore' });
  edit('src/config.ts', 'if (process.env.FOREMAN_HOME) process.env.FOREMAN_HOME = home;', '');
  edit('src/runners/claudeIsolation.ts', '{ ...out, FOREMAN_HOME: config.home, ...', '{ ...out, ...');
  edit('src/runners/cliRunners.ts', 'const env: NodeJS.ProcessEnv = { FOREMAN_HOME: config.home };', 'const env: NodeJS.ProcessEnv = {};');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'revert t1'], { cwd: clone, stdio: 'ignore' });
  const daemonCwd = scratch('daemon');
  const child = path.join(daemonCwd, 'child.mjs');
  fs.writeFileSync(child, `
    const { workerSuiteInJail } = await import(${JSON.stringify(path.join(clone, 'src', 'doctorJail.ts'))});
    process.stdout.write(await workerSuiteInJail({ repo: ${JSON.stringify(clone)} }));
  `);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FOREMAN_')) env[k] = v;
  // FOREMAN_SANDBOX=off in the operator's shell: the check turns the sandbox on for its own run regardless, so the
  // sandbox's home check still refuses (without the override the worker env would carry 'off' and this would be ok).
  const out = execFileSync(process.execPath, [child], { cwd: daemonCwd, env: { ...env, FOREMAN_HOME: '.foreman', FOREMAN_SANDBOX: 'off' }, encoding: 'utf8' });
  assert.match(out, /^worker suite in a jail: FAIL .*contains Foreman's home/);
});

test('doctor line: the wrapper is told FOREMAN_PORT=0, so it asks no daemon for a slot (a listener on the shell\'s port sees nothing)', { timeout: 120_000 }, async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.statusCode = 503; res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = process.env['FOREMAN_PORT'];
  process.env['FOREMAN_PORT'] = String((server.address() as AddressInfo).port);
  try {
    // The line itself does not matter here, only whom the wrapper asked.
    await workerSuiteInJail({ repo: cloneOfCheckout() });
    assert.deepEqual(seen, [], 'the doctor check asked the daemon on the shell\'s FOREMAN_PORT for a test slot');
  } finally {
    process.env['FOREMAN_PORT'] = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(leftovers(), []);
});

void testHome;

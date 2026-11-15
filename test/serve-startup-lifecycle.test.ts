import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isProtectedPath } from '../src/security/coreGuard.ts';

// Pins what `node src/cli.ts serve` does from start to an orderly stop: the startup lines in order, then SIGTERM
// (sent once the startup output is complete, no sleeps) and exit code 0. The output is normalised: the scratch
// parent becomes <HOME>, the bound port <PORT>.
test('serve prints its startup lines (home, mode, sandbox, foreman up), stops on SIGTERM and exits 0', async (t) => {
  const parent = fs.realpathSync(scratchDir('foreman-lifecycle-'));
  const home = path.join(parent, 'home');
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const env: NodeJS.ProcessEnv = {
    ...process.env, FOREMAN_HOME: home, FOREMAN_DB: path.join(parent, 'scratch.db'), FOREMAN_PORT: '0',
    FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on', FOREMAN_CLAUDE_BIN: path.join(parent, 'no-claude'),
    FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
  };
  delete env['FOREMAN_RUN_ID'];
  const child = spawn(process.execPath, [cli, 'serve'], { cwd: parent, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(parent, { recursive: true, force: true });
  });
  let out = '';
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  child.stderr.on('data', (d) => { out += d; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (/^trace .*$/m.test(out)) resolve();
    });
    void ended.then(() => reject(new Error(`serve exited before "foreman up": ${out}`)));
  });
  child.kill('SIGTERM');
  const [code, signal] = await ended;
  assert.deepEqual([code, signal], [0, null], out);
  // Under FOREMAN_SANDBOX=tests the process start time cannot be read, and serve says so on one extra line; that
  // line depends on where the suite runs, not on what serve does, so it is not part of the pin.
  const normalised = out
    .replace(/^foreman: freeze recorder not installed .*\n/m, '')
    .split(parent).join('<HOME>')
    .replace(/board (http:\/\/\S+?):\d+/, 'board $1:<PORT>')
    .replace(/trace \S+/, 'trace <TRACE>');
  assert.equal(normalised, GOLDEN, normalised);
});

const GOLDEN =
  'home <HOME>/home\n' +
  'mode LOCAL-ONLY (FOREMAN_LOCAL_ONLY is set)\n' +
  'sandbox off (FOREMAN_SANDBOX=off): test commands and shell tickets run unconfined\n' +
  'foreman up — board http://127.0.0.1:<PORT>  db <HOME>/scratch.db  workers 4\n' +
  'trace <TRACE>\n' +
  '\n' +
  'stopping…\n';

// cli.ts hands serve()'s result to process.exit unless it is -1: a refusal to start must still exit 1, not leave the
// process to run out with 0.
test('serve refuses an unknown FOREMAN_SANDBOX value with exit 1, before it prints or opens anything', async (t) => {
  const parent = fs.realpathSync(scratchDir('foreman-refuse-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'home');
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: '0', FOREMAN_PREWARM: 'off', FOREMAN_SANDBOX: 'bogus' };
  delete env['FOREMAN_RUN_ID'];
  const child = spawn(process.execPath, [cli, 'serve'], { cwd: parent, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('close', (c, s) => resolve([c, s])));
  assert.deepEqual([code, signal, out], [1, null, ''], err);
  assert.match(err, /^foreman: FOREMAN_SANDBOX must be off, tests or all, got "bogus"\n$/);
  assert.deepEqual(['daemon.pid', 'foreman.db'].filter((f) => fs.existsSync(path.join(home, f))), []);
});

test('src/daemon.ts is a protected path', () => {
  assert.equal(isProtectedPath('src/daemon.ts'), true);
});

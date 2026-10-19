import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Starts a scratch serve with the given FOREMAN_HOME (cwd a scratch parent) and returns its stdout+stderr up to and
// including the "foreman up" line: every startup line is written before it, so the whole startup output is in hand.
async function startupOutput(t: test.TestContext, homeFor: (parent: string) => string): Promise<{ parent: string; out: string }> {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-homeline-')));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const env: NodeJS.ProcessEnv = {
    ...process.env, FOREMAN_HOME: homeFor(parent), FOREMAN_DB: path.join(parent, 'scratch.db'), FOREMAN_PORT: '0',
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
  // Read until "foreman up" (no sleeps); the process exiting first is a failure rather than a wait.
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (/^foreman up .*$/m.test(out)) resolve();
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error(`serve exited before "foreman up": ${out}`)));
  });
  return { parent, out };
}

function homeLines(out: string): string[] {
  return [...out.matchAll(/^home (.*)$/gm)].map((m) => m[1] as string);
}

test('serve prints one startup line with the absolute home, resolved from a relative FOREMAN_HOME', async (t) => {
  const { parent, out } = await startupOutput(t, () => 'rel-home');
  const lines = homeLines(out);
  assert.equal(lines.length, 1, `exactly one home line before "foreman up": ${out}`);
  assert.ok(path.isAbsolute(lines[0] as string), `absolute: ${lines[0]}`);
  assert.equal(lines[0], path.resolve(parent, 'rel-home'));
});

test('serve prints the absolute FOREMAN_HOME unchanged', async (t) => {
  const { parent, out } = await startupOutput(t, (p) => path.join(p, 'abs-home'));
  assert.deepEqual(homeLines(out), [path.join(parent, 'abs-home')], out);
});

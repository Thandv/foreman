import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MAX_LATER_WRITTEN, processErrorHandlers } from '../src/daemonGuard.ts';
import { APPROVAL_DRAIN_CAP_MS } from '../src/gate.ts';

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const fixture = path.join(import.meta.dirname, 'fixtures', 'daemon-guard-inject.ts');

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

function serveWith(t: TestContext, inject: string) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const marker = path.join(home, 'exit-marker');
  const env = {
    ...process.env, FOREMAN_HOME: home, FOREMAN_DB: path.join(home, 'foreman.db'), FOREMAN_PORT: '0', FOREMAN_PREWARM: 'off',
    FOREMAN_LOCAL_ONLY: 'on', FOREMAN_CLAUDE_BIN: path.join(home, 'no-claude'), FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
    GUARD_INJECT: inject, GUARD_EXIT_MARKER: marker,
  };
  const child = spawn(process.execPath, ['--import', fixture, cli, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
  t.after(() => clearTimeout(guard));
  const out = { text: '' };
  child.stdout.on('data', (d) => (out.text += d));
  child.stderr.on('data', (d) => (out.text += d));
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  return { home, marker, child, out, ended };
}

test('an uncaught exception during a SIGTERM shutdown still exits 1', async (t) => {
  const s = serveWith(t, 'stop-throws');
  assert.ok(await until(() => s.out.text.includes('foreman up'), 30_000), s.out.text);
  s.child.kill('SIGTERM');
  const [code, signal] = await s.ended;
  assert.deepEqual([code, signal], [1, null], s.out.text);
  assert.ok(s.out.text.includes('uncaught exception: Error: injected exception'), s.out.text);
});

test('a SIGTERM during the shutdown an uncaught exception started does not lower the exit code to 0', async (t) => {
  const s = serveWith(t, 'throw-then-term');
  assert.ok(await until(() => s.out.text.includes('stopping…'), 30_000), s.out.text);
  s.child.kill('SIGTERM');
  const [code, signal] = await s.ended;
  assert.deepEqual([code, signal], [1, null], s.out.text);
});

test('a second uncaught exception is written to stderr and does not call shutdown again', () => {
  const written: string[] = [];
  const shutdowns: number[] = [];
  const { onException } = processErrorHandlers({
    record: () => {}, shutdown: (c) => void shutdowns.push(c), now: Date.now, write: (l) => void written.push(l),
  });
  onException(new Error('first'));
  onException(new Error('second'));
  assert.deepEqual(shutdowns, [1]);
  assert.equal(written.filter((l) => l.startsWith('uncaught exception:')).length, 2);
  assert.ok(written.some((l) => l.includes('second')), written.join(''));
});

test('exceptions after the first are written only a bounded number of times (a closed stderr feeds them back)', async (t) => {
  const written: string[] = [];
  const shutdowns: number[] = [];
  let over = false;
  t.after(() => { over = true; });
  // Each write fails the way a closed stderr does: the EPIPE comes back as the next uncaught exception.
  const epipe = (): void => { if (!over) onException(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); };
  const { onException } = processErrorHandlers({
    record: () => {}, shutdown: (c) => void shutdowns.push(c), now: Date.now,
    write: (l) => { written.push(l); setImmediate(epipe); },
  });
  onException(new Error('first'));
  for (let i = 0; i < 5 * MAX_LATER_WRITTEN; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(shutdowns, [1]);
  assert.equal(written.length, 1 + MAX_LATER_WRITTEN);
});

test('a scheduler.stop() that never settles is cut at the drain cap, said on stderr, and the lock is released', async (t) => {
  const s = serveWith(t, 'stop-hangs');
  assert.ok(await until(() => s.out.text.includes('foreman up'), 30_000), s.out.text);
  assert.equal(fs.existsSync(path.join(s.home, 'daemon.pid')), true, 'the lock is held while running');
  const sent = Date.now();
  s.child.kill('SIGTERM');
  const [code, signal] = await s.ended;
  // The fixture shortens the cap to 300 ms; a cap other than APPROVAL_DRAIN_CAP_MS is not shortened and overruns.
  assert.ok(Date.now() - sent < 5_000, `exited ${Date.now() - sent}ms after the SIGTERM`);
  assert.deepEqual([code, signal], [0, null], s.out.text);
  assert.equal(s.out.text.split(`did not stop within ${APPROVAL_DRAIN_CAP_MS}ms`).length, 2, s.out.text);
  assert.ok(s.out.text.includes('fixture: live run groups killed at shutdown'), s.out.text);
  assert.equal(fs.existsSync(path.join(s.home, 'daemon.pid')), false, 'the lock was released');
});

test("serve's own exit path runs the process 'exit' listeners", async (t) => {
  const s = serveWith(t, 'none');
  assert.ok(await until(() => s.out.text.includes('foreman up'), 30_000), s.out.text);
  s.child.kill('SIGTERM');
  const [code] = await s.ended;
  assert.equal(code, 0, s.out.text);
  assert.equal(fs.readFileSync(s.marker, 'utf8'), 'exit listener ran');
});

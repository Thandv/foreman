import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// A real `foreman serve` with an error injected after its 'foreman up' line (test/fixtures/daemon-guard-inject.ts).
const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const fixture = path.join(import.meta.dirname, 'fixtures', 'daemon-guard-inject.ts');

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

function serveWith(t: TestContext, inject: 'reject' | 'throw') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, 'foreman.db');
  const portFile = path.join(home, 'port');
  const env = {
    ...process.env, FOREMAN_HOME: home, FOREMAN_DB: dbPath, FOREMAN_PORT: '0', FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on',
    FOREMAN_CLAUDE_BIN: path.join(home, 'no-claude'), FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
    GUARD_INJECT: inject, GUARD_PORT_FILE: portFile,
  };
  const child = spawn(process.execPath, ['--import', fixture, cli, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const out = { text: '' };
  child.stdout.on('data', (d) => (out.text += d));
  child.stderr.on('data', (d) => (out.text += d));
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  return { home, dbPath, portFile, child, out, ended };
}

function errorEvents(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT message FROM events WHERE type = 'error'").all() as Array<{ message: string }>).map((r) => r.message);
  } finally {
    db.close();
  }
}

function status(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

test('an unhandled rejection in a running serve is recorded as an error event, the daemon keeps answering HTTP, and a later SIGTERM exits 0', async (t) => {
  const s = serveWith(t, 'reject');
  const guard = setTimeout(() => s.child.kill('SIGKILL'), 60_000);
  t.after(() => clearTimeout(guard));
  assert.ok(await until(() => s.out.text.includes('foreman up') && fs.existsSync(s.portFile), 30_000), `it came up: ${s.out.text}`);
  const recorded = (): boolean => {
    try {
      return errorEvents(s.dbPath).some((m) => m.includes('injected rejection'));
    } catch {
      return false;
    }
  };
  assert.ok(await until(recorded, 30_000), `the rejection was recorded: ${s.out.text}`);
  // The event row lands over SQLite, the stderr line over a pipe: the pipe's 'data' event can arrive after the row is visible.
  assert.ok(await until(() => s.out.text.includes('unhandled rejection: Error: injected rejection'), 30_000), `and written to stderr: ${s.out.text}`);
  assert.equal(s.child.exitCode, null, 'still running');
  assert.equal(await status(Number(fs.readFileSync(s.portFile, 'utf8'))), 200, 'still answering');
  s.child.kill('SIGTERM');
  const [code, signal] = await s.ended;
  assert.deepEqual([code, signal], [0, null], s.out.text);
});

test('an uncaught exception in a running serve prints "stopping", removes the pidfile and exits 1', async (t) => {
  const s = serveWith(t, 'throw');
  const guard = setTimeout(() => s.child.kill('SIGKILL'), 60_000);
  t.after(() => clearTimeout(guard));
  const [code, signal] = await s.ended;
  assert.deepEqual([code, signal], [1, null], s.out.text);
  assert.ok(s.out.text.includes('stopping'), s.out.text);
  assert.ok(s.out.text.includes('uncaught exception: Error: injected exception'), s.out.text);
  assert.equal(fs.existsSync(path.join(s.home, 'daemon.pid')), false, 'the lock was released');
});

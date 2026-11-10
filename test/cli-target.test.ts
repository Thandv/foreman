import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Seen { path: string; authorization: string | undefined }

/** A stub daemon that answers every request with an empty board and records what it was sent. */
async function stubDaemon(): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tasks: [], workers: { active: 0, max: 1 }, playbooks: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
}

/** Run the CLI against the environment given and resolve once `done` says enough was seen (or it exits). */
function runCli(argv: string[], env: Record<string, string>, done: () => boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_HOME: testHome, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const poll = setInterval(() => { if (done()) child.kill(); }, 20);
    child.on('close', (code) => { clearInterval(poll); resolve({ code, stdout, stderr }); });
  });
}

const COMMANDS: Array<{ name: string; argv: string[]; path: string; done: (seen: Seen[]) => boolean }> = [
  { name: 'apiCall (ls)', argv: ['ls'], path: '/api/state', done: (s) => s.length > 0 },
  { name: 'apiCallLong (approve)', argv: ['approve', 't1'], path: '/api/tasks/t1/approve', done: (s) => s.length > 0 },
  { name: 'watch', argv: ['watch'], path: '/api/state', done: (s) => s.length > 1 },
];

for (const c of COMMANDS) {
  test(`${c.name} reaches the daemon at FOREMAN_HOST:FOREMAN_PORT and sends no Authorization header`, async () => {
    const stub = await stubDaemon();
    try {
      await runCli(c.argv, { FOREMAN_HOST: '127.0.0.1', FOREMAN_PORT: String(stub.port) }, () => c.done(stub.seen));
      assert.ok(stub.seen.some((s) => s.path === c.path), `no ${c.path} request in ${JSON.stringify(stub.seen)}`);
      assert.deepEqual(stub.seen.filter((s) => s.authorization !== undefined), []);
    } finally { stub.close(); }
  });
}

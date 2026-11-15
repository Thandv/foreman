// KNOWN GAP until the macOS worker sandbox (docs/security.md "Known gap until the worker sandbox"): a claude-code
// worker runs unsandboxed as the daemon's user, with the daemon's home, so it can read the host-admin secret, open the
// ledger and mint itself a principal over loopback. This file pins that all three SUCCEED today, so nothing presents
// tokens or four-eyes as a security boundary against a worker. The sandbox ticket flips these assertions.
import { testHome, scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { ensureHostSecret } from '../src/security/hostSecret.ts';
import { authIsOn } from '../src/security/tokenAuth.ts';
import { workerEnv } from '../src/runners/cliRunners.ts';
import { claudeWorkerEnv } from '../src/runners/claudeIsolation.ts';

/**
 * What the probe does, as a worker could: everything it uses comes from its own environment (FOREMAN_HOME) except the
 * port, which a worker can guess (4100) or scan for on loopback. It reports what it read and what the mint answered.
 */
const PROBE = `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const home = process.env.FOREMAN_HOME;
const secret = fs.readFileSync(path.join(home, 'secrets', 'host-admin'), 'utf8').trim();
const db = new DatabaseSync(path.join(home, 'foreman.db'), { readOnly: true });
const principals = db.prepare('SELECT name FROM principals ORDER BY name').all().map((r) => r.name);
const tokenHashes = db.prepare('SELECT token_hash FROM api_tokens').all().length;
db.close();
const res = await fetch('http://127.0.0.1:' + process.argv[1] + '/api/tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-foreman-host-secret': secret },
  body: JSON.stringify({ name: 'worker-self' }),
});
process.stdout.write(JSON.stringify({ home, secret, principals, tokenHashes, mintStatus: res.status, minted: await res.json() }));
`;

interface ProbeResult {
  home: string;
  secret: string;
  principals: string[];
  tokenHashes: number;
  mintStatus: number;
  minted: { token: string; principal: { name: string } };
}

test(
  'KNOWN GAP until the worker sandbox: an unsandboxed claude-code worker reads the host-admin secret and the ledger, and mints itself a principal over loopback',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' },
  async (t) => {
    const store = new Store(config.dbPath);
    const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
    sched.pauseDispatch();
    const server = createServer(store, sched);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sched.stop();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;

    // The operator has turned auth on: one human with one token.
    const secret = ensureHostSecret(testHome);
    const alice = await fetch(`http://127.0.0.1:${port}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-foreman-host-secret': secret },
      body: JSON.stringify({ name: 'alice' }),
    });
    assert.equal(alice.status, 201);
    assert.equal(authIsOn(store), true);

    // Exactly the environment src/runners/cliRunners.ts gives a claude-code worker: the spec's env, then workerEnv.
    const env = { ...claudeWorkerEnv({ id: 't_gap' }), ...workerEnv({ testCmd: null }, 'r_gap') };
    assert.equal(env['FOREMAN_HOME'], testHome, 'the worker is told the daemon home');
    assert.ok(!Object.values(env).includes(secret), 'the secret is not in the environment; it is read from the file');

    const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE, String(port)], { env, cwd: scratchDir('foreman-gap-jail-') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    assert.equal(code, 0, stderr);
    const probe = JSON.parse(stdout) as ProbeResult;

    assert.equal(probe.secret, secret, 'GAP: the worker reads <FOREMAN_HOME>/secrets/host-admin');
    assert.deepEqual(probe.principals, ['alice'], 'GAP: the worker opens foreman.db and reads the principals');
    assert.equal(probe.tokenHashes, 1, 'GAP: the worker reads the token hashes');
    assert.equal(probe.mintStatus, 201, 'GAP: the worker mints over loopback with the secret, auth on and no bearer');
    assert.equal(probe.minted.principal.name, 'worker-self');
    assert.equal(store.humanPrincipalCount(), 2, 'GAP: the self-minted principal counts as a second human');
    const minted = store.eventsSince(0, 10_000).filter((e) => e.type === 'principal-minted');
    assert.deepEqual(minted.map((e) => (JSON.parse(e.message) as { name: string }).name), ['alice', 'worker-self'], 'the mint event is the only record');
  },
);

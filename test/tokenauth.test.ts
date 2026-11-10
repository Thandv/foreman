// The API's bearer-token check (src/security/tokenAuth.ts): off until the first principal exists, then a latch.
import { testHome, scratchDir, privateTmpdir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { runToken, verifySlotStats } from '../src/verify/slots.ts';
import { authenticate, authIsOn } from '../src/security/tokenAuth.ts';

privateTmpdir(); // the slot wrapper this runs keeps its saved output in the temp dir

const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'verify', 'testSlot.ts');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous freeze guard: nothing here asserts on wall time. */
async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Daemon {
  base: string;
  port: number;
  store: Store;
}

async function daemon(t: test.TestContext): Promise<Daemon> {
  const prev = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '8';
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    await until(() => verifySlotStats().active === 0 && verifySlotStats().waiting === 0, 'every slot to be given back');
    if (prev === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prev;
  });
  return { base: `http://127.0.0.1:${port}`, port, store };
}

/** A human principal with one token: the raw secret a caller holds, the token's id, and the principal's. */
function mint(store: Store, name = 'alice', expiresAt: number | null = null): { secret: string; tokenId: string; principalId: string } {
  const p = store.addPrincipal({ kind: 'human', name, createdBy: 'operator' });
  const secret = randomBytes(32).toString('base64url');
  const tokenId = store.addToken({ principalId: p.id, tokenHash: createHash('sha256').update(secret).digest('hex'), expiresAt, createdBy: 'operator' });
  return { secret, tokenId, principalId: p.id };
}

const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

/** GET /api/state, POST /api/tasks and GET /api/events with these headers: their status codes, and every body read. */
async function threeRoutes(base: string, headers: Record<string, string>): Promise<{ codes: number[]; bodies: string }> {
  const state = await fetch(`${base}/api/state`, { headers });
  const task = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hello', prompt: 'world', runner: 'echo' }),
  });
  const stop = new AbortController();
  const events = await fetch(`${base}/api/events`, { headers, signal: stop.signal });
  const bodies = (await state.text()) + (await task.text()) + (events.status === 200 ? '' : await events.text());
  stop.abort();
  return { codes: [state.status, task.status, events.status], bodies };
}

/** A raw request, for the headers fetch will not let a caller set (Host). */
function raw(port: number, opts: { method?: string; path: string; headers: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Asked { req: http.ClientRequest; status: () => number | null; text: () => string }

function askSlot(t: test.TestContext, port: number, headers: Record<string, string>): Asked {
  let status: number | null = null;
  let body = '';
  const req = http.request({ host: '127.0.0.1', port, path: '/api/verify-slot', method: 'POST', headers }, (res) => {
    status = res.statusCode ?? null;
    res.setEncoding('utf8').on('data', (c: string) => { body += c; });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  t.after(() => { req.destroy(); });
  return { req, status: () => status, text: () => body };
}

const granted = (a: Asked): boolean => a.status() === 200 && /granted/.test(a.text());
const answered = (a: Asked): boolean => a.status() !== null && a.status() !== 200 ? /\n$/.test(a.text()) : granted(a);
const runHeaders = (runId: string): Record<string, string> => ({ 'x-foreman-run': runId, 'x-foreman-run-token': runToken(runId) });

function runningRun(store: Store): string {
  const task = store.addTask({ title: 'w', prompt: 'p', kind: 'code', runner: 'echo' });
  return store.startRun(task.id).id;
}

// ------------------------------------------------------------------- auth off

test('pin: with no principal, GET /api/state, POST /api/tasks and GET /api/events need no token', async (t) => {
  const d = await daemon(t);
  assert.deepEqual((await threeRoutes(d.base, {})).codes, [200, 201, 200]);
  assert.deepEqual((await threeRoutes(d.base, bearer('not-a-token'))).codes, [200, 201, 200], 'a bearer is ignored while auth is off');
});

test('pin: with no principal, verify-slot is slotted with a run token, without one, and for a run that is not running', async (t) => {
  const d = await daemon(t);
  const live = askSlot(t, d.port, runHeaders(runningRun(d.store)));
  const bare = askSlot(t, d.port, {});
  const unknown = askSlot(t, d.port, runHeaders('r_not_in_ledger'));
  await until(() => granted(live) && granted(bare) && granted(unknown), 'all three requests to be slotted');
});

// -------------------------------------------------------------------- auth on

test('once a principal exists, a missing, invalid, revoked or expired bearer gets 401 on GET, POST and /api/events; a valid one passes', async (t) => {
  const d = await daemon(t);
  const good = mint(d.store, 'alice');
  const revoked = mint(d.store, 'bob');
  d.store.revokeToken(revoked.tokenId);
  const expired = mint(d.store, 'carol', Date.now() - 1);
  const disabled = mint(d.store, 'dave');
  d.store.disablePrincipal(disabled.principalId);

  for (const [what, headers] of [
    ['no bearer', {}],
    ['an unknown bearer', bearer(randomBytes(32).toString('base64url'))],
    ['a revoked token', bearer(revoked.secret)],
    ['an expired token', bearer(expired.secret)],
    ['a disabled principal\'s token', bearer(disabled.secret)],
    ['a non-Bearer scheme', { authorization: `Basic ${good.secret}` }],
  ] as const) {
    const r = await threeRoutes(d.base, headers);
    assert.deepEqual(r.codes, [401, 401, 401], what);
    for (const s of [good.secret, revoked.secret, expired.secret, disabled.secret]) assert.ok(!r.bodies.includes(s), `${what}: no token in an answer`);
  }
  assert.deepEqual((await threeRoutes(d.base, bearer(good.secret))).codes, [200, 201, 200]);
  assert.deepEqual((await threeRoutes(d.base, { authorization: `bearer ${good.secret}` })).codes, [200, 201, 200], 'the scheme is case-insensitive');
  const events = JSON.stringify(d.store.eventsSince(0));
  for (const s of [good.secret, revoked.secret, expired.secret, disabled.secret]) assert.ok(!events.includes(s), 'no token in an event');
});

test('auth is a latch: after the only token is revoked, and after it expires, GET /api/state is 401, never 200 as operator', async (t) => {
  const d = await daemon(t);
  const one = mint(d.store, 'alice');
  assert.equal((await fetch(`${d.base}/api/state`, { headers: bearer(one.secret) })).status, 200);
  d.store.revokeToken(one.tokenId);
  assert.equal((await fetch(`${d.base}/api/state`, { headers: bearer(one.secret) })).status, 401);
  assert.equal((await fetch(`${d.base}/api/state`)).status, 401);

  const d2 = await daemon(t);
  const later = mint(d2.store, 'alice', Date.now() + 3_600_000);
  assert.equal((await fetch(`${d2.base}/api/state`, { headers: bearer(later.secret) })).status, 200);
  // The clock passing the expiry, without waiting for it: the check reads the ledger on every request.
  d2.store.db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, later.tokenId);
  assert.equal((await fetch(`${d2.base}/api/state`, { headers: bearer(later.secret) })).status, 401);
  assert.equal((await fetch(`${d2.base}/api/state`)).status, 401);
});

test('authenticate checks expiry against the clock it is given, on every call', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.equal(authIsOn(store), false);
  const T0 = 1_700_000_000_000;
  const one = mint(store, 'alice', T0 + 1000);
  assert.equal(authIsOn(store), true);
  assert.equal(authenticate(store, bearer(one.secret), T0)?.id, one.principalId);
  assert.equal(authenticate(store, bearer(one.secret), T0 + 1000), null, 'expired at its expiry time');
  store.revokeToken(one.tokenId);
  assert.equal(authenticate(store, bearer(one.secret), T0), null, 'no cached answer: a revoke counts at once');
  assert.equal(authenticate(store, {}, T0), null);
  assert.equal(authenticate(store, { authorization: 'Bearer' }, T0), null);
});

test('with auth on, the Host and CSRF checks still answer first, and the board stays public', async (t) => {
  const d = await daemon(t);
  const one = mint(d.store);
  const rebound = await raw(d.port, { path: '/api/state', headers: { host: 'evil.example:4100', ...bearer(one.secret) } });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body, /DNS-rebinding/);
  for (const headers of [{}, bearer(one.secret)]) {
    const cross = await raw(d.port, { method: 'POST', path: '/api/tasks', headers: { ...headers, origin: 'http://evil.example' } });
    assert.equal(cross.status, 403);
    assert.match(cross.body, /cross-origin write refused/);
  }
  assert.equal((await fetch(`${d.base}/`)).status, 200, 'board static files need no token');
});

test('with auth on, verify-slot slots a running run\'s token and refuses a finished run, no token and a bearer alone with 401', async (t) => {
  const d = await daemon(t);
  const one = mint(d.store);
  const runId = runningRun(d.store);
  const finished = runningRun(d.store);
  d.store.endRun(finished, 'succeeded');

  const live = askSlot(t, d.port, runHeaders(runId));
  await until(() => granted(live), 'the running run to be slotted');
  for (const [what, headers] of [
    ['a finished run\'s valid token', runHeaders(finished)],
    ['no token', {}],
    ['a run id with a wrong token', { 'x-foreman-run': runId, 'x-foreman-run-token': 'f'.repeat(64) }],
    ['a bearer and no run token', bearer(one.secret)],
  ] as const) {
    const a = askSlot(t, d.port, headers);
    await until(() => answered(a), `the answer to ${what}`);
    assert.equal(a.status(), 401, what);
    assert.match(a.text(), /verify-slot refused: not authenticated/, what);
  }
});

// ------------------------------------------------------------- the wrapper

function wrapper(port: number, suite: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [WRAPPER], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      FOREMAN_HOME: testHome,
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_PORT: String(port),
      FOREMAN_WORKER_TEST_CMD: `node ${suite}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  return new Promise((r) => child.on('close', (code) => r({ code, stderr })));
}

test('a wrapper refused with 401 says so, runs its suite unslotted and exits with the suite\'s result', async (t) => {
  const d = await daemon(t);
  mint(d.store);
  const dir = scratchDir('foreman-authsuite-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pass = path.join(dir, 'pass.mjs');
  const fail = path.join(dir, 'fail.mjs');
  fs.writeFileSync(pass, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'ran'))}, '');\n`);
  fs.writeFileSync(fail, 'process.exit(1);\n');

  const passed = await wrapper(d.port, pass);
  assert.match(passed.stderr, /verify-slot refused: not authenticated/);
  assert.match(passed.stderr, /unslotted/);
  assert.equal(passed.code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'ran')), 'the suite ran');

  const failed = await wrapper(d.port, fail);
  assert.match(failed.stderr, /verify-slot refused: not authenticated/);
  assert.equal(failed.code, 1);
});

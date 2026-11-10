// Minting principals and tokens with the host-admin secret over loopback (src/security/mint.ts, POST /api/tokens).
import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { ensureHostSecret, HOST_SECRET_HEADER } from '../src/security/hostSecret.ts';
import { hostAdminMintAllowed } from '../src/security/mint.ts';
import { authenticate, authIsOn } from '../src/security/tokenAuth.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Daemon {
  base: string;
  port: number;
  store: Store;
  mint: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
}

async function daemon(t: test.TestContext): Promise<Daemon> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  sched.pauseDispatch();
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const base = `http://127.0.0.1:${port}`;
  const mint = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/api/tokens`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, port, store, mint };
}

const secretHeader = (): Record<string, string> => ({ [HOST_SECRET_HEADER]: ensureHostSecret(testHome) });
const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });
const mintEvents = (store: Store) => store.eventsSince(0, 10_000).filter((e) => e.type === 'principal-minted' || e.type === 'token-minted');

interface Minted {
  token: string;
  tokenId: string;
  principal: { id: string; name: string; kind: string };
  principalCreated: boolean;
  expiresAt: number | null;
}

// ------------------------------------------------------------------ pins

test('only POST /api/tokens mints: another method or a longer path is not a route', async (t) => {
  const { base, store } = await daemon(t);
  assert.equal((await fetch(`${base}/api/tokens`, { headers: secretHeader() })).status, 404);
  assert.equal((await fetch(`${base}/api/tokens/x`, { method: 'POST', headers: secretHeader(), body: '{}' })).status, 404);
  assert.equal(store.hasAnyPrincipal(), false);
});

// ------------------------------------------------------------- the mint

test('the host-admin secret over loopback creates a principal and a token that authenticates, and latches auth', async (t) => {
  const { base, store, mint } = await daemon(t);
  assert.equal((await fetch(`${base}/api/state`)).status, 200, 'auth is off before the first mint');
  const res = await mint({ name: 'alice' }, secretHeader());
  assert.equal(res.status, 201);
  const m = (await res.json()) as Minted;
  assert.equal(m.principal.name, 'alice');
  assert.equal(m.principal.kind, 'human');
  assert.equal(m.principalCreated, true);
  assert.equal(m.expiresAt, null);
  assert.match(m.token, /^\S{40,}$/);
  assert.equal(authIsOn(store), true);
  assert.equal(authenticate(store, bearer(m.token))?.id, m.principal.id);
  assert.equal((await fetch(`${base}/api/state`)).status, 401, 'auth is on after the first mint');
  assert.equal((await fetch(`${base}/api/state`, { headers: bearer(m.token) })).status, 200);
});

test('a second mint for the same name adds a token and no principal; it works with auth on and no bearer', async (t) => {
  const { store, mint } = await daemon(t);
  const first = (await (await mint({ name: 'alice' }, secretHeader())).json()) as Minted;
  const res = await mint({ name: 'alice' }, secretHeader());
  assert.equal(res.status, 201, 'the host-admin mint is the lockout recovery path');
  const second = (await res.json()) as Minted;
  assert.equal(second.principalCreated, false);
  assert.equal(second.principal.id, first.principal.id);
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.tokenId, first.tokenId);
  assert.equal(store.humanPrincipalCount(), 1);
  assert.equal(authenticate(store, bearer(first.token))?.id, first.principal.id);
  assert.equal(authenticate(store, bearer(second.token))?.id, first.principal.id);
});

test('a missing or wrong secret gets 401 and writes nothing, with auth off and with auth on', async (t) => {
  const { store, mint } = await daemon(t);
  const wrong = { [HOST_SECRET_HEADER]: 'f'.repeat(64) };
  for (const headers of [{}, wrong]) {
    const res = await mint({ name: 'mallory' }, headers);
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /[0-9a-f]{64}/);
  }
  assert.equal(store.hasAnyPrincipal(), false);
  assert.deepEqual(mintEvents(store), []);

  const alice = (await (await mint({ name: 'alice' }, secretHeader())).json()) as Minted;
  for (const headers of [{}, wrong, bearer(alice.token)]) {
    assert.equal((await mint({ name: 'mallory' }, headers)).status, 401, 'a bearer alone does not mint');
  }
  assert.equal(store.humanPrincipalCount(), 1);
  assert.equal(mintEvents(store).length, 1);
});

test('a reserved or bad name, or a bad kind or expiry, gets 400 and writes nothing', async (t) => {
  const { store, mint } = await daemon(t);
  for (const body of [
    { name: 'operator' }, { name: 'owner-model' }, { name: 'system' }, { name: 'Alice' }, { name: 'a b' }, { name: '' }, {}, { name: 7 },
    { name: 'alice', kind: 'robot' }, { name: 'alice', expiresInMs: 0 }, { name: 'alice', expiresInMs: -5 }, { name: 'alice', expiresInMs: '1d' },
  ]) {
    const res = await mint(body, secretHeader());
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(store.hasAnyPrincipal(), false);
  assert.deepEqual(mintEvents(store), []);
});

test('a mint for a disabled principal or under another kind gets 400 and adds no token', async (t) => {
  const { store, mint } = await daemon(t);
  const alice = (await (await mint({ name: 'alice' }, secretHeader())).json()) as Minted;
  assert.equal((await mint({ name: 'alice', kind: 'service' }, secretHeader())).status, 400);
  store.disablePrincipal(alice.principal.id);
  assert.equal((await mint({ name: 'alice' }, secretHeader())).status, 400);
  assert.equal(mintEvents(store).length, 1);
});

test('a service principal with an expiry: the token stops at its expiry', async (t) => {
  const { store, mint } = await daemon(t);
  const before = Date.now();
  const res = await mint({ name: 'ci', kind: 'service', expiresInMs: 60_000 }, secretHeader());
  assert.equal(res.status, 201);
  const m = (await res.json()) as Minted;
  assert.equal(m.principal.kind, 'service');
  assert.ok(m.expiresAt !== null && m.expiresAt >= before + 60_000 && m.expiresAt <= Date.now() + 60_000);
  assert.equal(authenticate(store, bearer(m.token), m.expiresAt - 1)?.id, m.principal.id);
  assert.equal(authenticate(store, bearer(m.token), m.expiresAt), null);
  assert.equal(store.humanPrincipalCount(), 0);
});

test('each mint emits exactly one event naming the principal, and the raw token is only in the response body', async (t) => {
  const { store, mint } = await daemon(t);
  const first = (await (await mint({ name: 'alice' }, secretHeader())).json()) as Minted;
  const second = (await (await mint({ name: 'alice' }, secretHeader())).json()) as Minted;
  const events = mintEvents(store);
  assert.deepEqual(events.map((e) => e.type), ['principal-minted', 'token-minted']);
  for (const [ev, m] of [[events[0]!, first], [events[1]!, second]] as const) {
    assert.equal(ev.taskId, null);
    assert.deepEqual(JSON.parse(ev.message), { name: 'alice', principalId: m.principal.id, kind: 'human', tokenId: m.tokenId, hostAdmin: true });
  }
  const everyEvent = JSON.stringify(store.eventsSince(0, 10_000));
  for (const m of [first, second]) assert.ok(!everyEvent.includes(m.token), 'no event holds a raw token');
  const raw = JSON.stringify(store.db.prepare('SELECT * FROM api_tokens').all());
  for (const m of [first, second]) assert.ok(!raw.includes(m.token), 'the ledger holds only the hash');
});

// ------------------------------------------------------------- the CLI

test('foreman token create --host-admin mints over the local daemon and prints the token once', async (t) => {
  const { store, port } = await daemon(t);
  ensureHostSecret(testHome);
  const child = spawn(process.execPath, [CLI, 'token', 'create', '--host-admin', '--name', 'ci', '--service', '--expires', '30d'], {
    env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, stderr);
  const token = stdout.trim();
  assert.doesNotMatch(token, /\s/, 'stdout is the token alone');
  const p = authenticate(store, bearer(token));
  assert.equal(p?.name, 'ci');
  assert.equal(p?.kind, 'service');
  assert.match(stderr, /ci/);
  assert.ok(!stderr.includes(token), 'the token is printed once');
});

test('foreman token create without --host-admin is refused before any request', async (t) => {
  const { store, port } = await daemon(t);
  const child = spawn(process.execPath, [CLI, 'token', 'create', '--name', 'ci'], {
    env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' },
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.notEqual(code, 0);
  assert.match(stderr, /--host-admin/);
  assert.equal(store.hasAnyPrincipal(), false);
});

// ------------------------------------------------------- the loopback check

test('only a loopback peer with the matching secret may mint: a remote address with the right secret may not', () => {
  const secret = secretHeader();
  const asking = (remoteAddress: string | undefined, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers });
  for (const addr of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(hostAdminMintAllowed(asking(addr, secret), testHome), true, addr);
    assert.equal(hostAdminMintAllowed(asking(addr, {}), testHome), false, `${addr} without the secret`);
  }
  for (const addr of ['192.0.2.7', '10.0.0.1', '::ffff:192.0.2.7', '2001:db8::1', '0.0.0.0', '128.0.0.1', undefined]) {
    assert.equal(hostAdminMintAllowed(asking(addr, secret), testHome), false, String(addr));
  }
});

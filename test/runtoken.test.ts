// The verify-slot lease and the run it names: only the run's own worker may claim it (a per-run token).
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { hasRunLease, verifySlotStats } from '../src/verify/slots.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Asked { req: http.ClientRequest; status: () => number | null; text: () => string }

/** An in-process daemon with room for every request a test opens, and a way to ask it for a slot as the wrapper does. */
async function daemon(t: test.TestContext): Promise<(headers: Record<string, string>) => Asked> {
  const prev = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '8';
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const open: http.ClientRequest[] = [];
  t.after(async () => {
    for (const req of open) req.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    await until(() => verifySlotStats().active === 0 && verifySlotStats().waiting === 0, 'every slot to be given back');
    if (prev === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prev;
  });
  return (headers) => {
    let status: number | null = null;
    let body = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/verify-slot', method: 'POST', headers }, (res) => {
      status = res.statusCode ?? null;
      res.setEncoding('utf8').on('data', (c: string) => { body += c; });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    open.push(req);
    return { req, status: () => status, text: () => body };
  };
}

const granted = (a: Asked): boolean => a.status() === 200 && /granted/.test(a.text());

test('pin: a request that names no run is slotted, and two of them at once are both slotted', async (t) => {
  const ask = await daemon(t);
  const a = ask({});
  const b = ask({});
  await until(() => granted(a) && granted(b), 'both anonymous requests to be granted');
});

test('pin: a run with a request open is refused busy on a second one, and may ask again once the first closes', async (t) => {
  const ask = await daemon(t);
  const run = { 'x-foreman-run': 'r_pin_owner', 'x-foreman-wrapper-pid': '4242' };
  const first = ask(run);
  await until(() => granted(first), 'the first request to be granted');
  assert.equal(hasRunLease('r_pin_owner'), true);
  const second = ask(run);
  await until(() => second.status() !== null && /\n$/.test(second.text()), 'the second answer');
  assert.equal(second.status(), 409);
  assert.match(second.text(), /^busy \d+ 4242/);
  first.req.destroy();
  await until(() => !hasRunLease('r_pin_owner'), 'the claim to end with its connection');
  const third = ask(run);
  await until(() => granted(third), 'the run to be slotted again');
});

test('a request with a wrong token cannot claim the run it names: no lease, and the run is not refused', async (t) => {
  const ask = await daemon(t);
  const spoof = ask({ 'x-foreman-run': 'r_victim', 'x-foreman-run-token': 'f'.repeat(64) });
  await until(() => granted(spoof), 'the spoofed request to be slotted, anonymously');
  assert.equal(hasRunLease('r_victim'), false, 'the spoofed request holds no claim on the run it named');
  const again = ask({ 'x-foreman-run': 'r_victim', 'x-foreman-run-token': 'not-a-token' });
  await until(() => granted(again), 'a second spoofed request to be slotted too');
});

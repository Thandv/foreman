// The verify-slot lease and the run it names: only the run's own worker may claim it (a per-run token).
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { workerEnv } from '../src/runners/cliRunners.ts';
import { hasRunLease, runToken, verifySlotStats } from '../src/verify/slots.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Asked { req: http.ClientRequest; status: () => number | null; text: () => string }

interface Daemon {
  ask: (headers: Record<string, string>) => Asked;
  /** Every slotQueued the handler told the scheduler, as `<run> <queued>`. */
  slotWaits: string[];
  events: () => string;
}

/** An in-process daemon with room for every request a test opens, and a way to ask it for a slot as the wrapper does. */
async function daemon(t: test.TestContext): Promise<Daemon> {
  const prev = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '8';
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const slotWaits: string[] = [];
  const realSlotQueued = sched.slotQueued.bind(sched);
  sched.slotQueued = (runId, queued) => {
    slotWaits.push(`${runId} ${queued}`);
    realSlotQueued(runId, queued);
  };
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
  const ask = (headers: Record<string, string>): Asked => {
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
  return { ask, slotWaits, events: () => JSON.stringify(store.eventsSince(0)) };
}

const granted = (a: Asked): boolean => a.status() === 200 && /granted/.test(a.text());

test('pin: a request that names no run is slotted, and two of them at once are both slotted', async (t) => {
  const { ask, slotWaits } = await daemon(t);
  const a = ask({});
  const b = ask({});
  await until(() => granted(a) && granted(b), 'both anonymous requests to be granted');
  assert.deepEqual(slotWaits, [], 'no run named: no run\'s wait is recorded');
});

test('pin: a run with a request open is refused busy on a second one, and may ask again once the first closes', async (t) => {
  const { ask, slotWaits, events } = await daemon(t);
  const run = { 'x-foreman-run': 'r_pin_owner', 'x-foreman-run-token': runToken('r_pin_owner'), 'x-foreman-wrapper-pid': '4242' };
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
  assert.ok(slotWaits.includes('r_pin_owner true'), 'the run\'s slot wait is told to the scheduler, as before');
  assert.doesNotMatch(events(), new RegExp(runToken('r_pin_owner')), 'the token is in no event');
});

test('a request with a wrong token cannot claim the run it names: no lease, and the run is not refused', async (t) => {
  const { ask, slotWaits } = await daemon(t);
  const spoof = ask({ 'x-foreman-run': 'r_victim', 'x-foreman-run-token': 'f'.repeat(64) });
  await until(() => granted(spoof), 'the spoofed request to be slotted, anonymously');
  assert.equal(hasRunLease('r_victim'), false, 'the spoofed request holds no claim on the run it named');
  const again = ask({ 'x-foreman-run': 'r_victim', 'x-foreman-run-token': 'not-a-token' });
  await until(() => granted(again), 'a second spoofed request to be slotted too');
  assert.deepEqual(slotWaits, [], 'no slot wait is recorded against the run it named');
  const owner = ask({ 'x-foreman-run': 'r_victim', 'x-foreman-run-token': runToken('r_victim') });
  await until(() => granted(owner), 'the run itself to be slotted, unhindered');
  assert.equal(hasRunLease('r_victim'), true);
});

test('a request that names a run with no token at all is exactly an anonymous one, even while the run holds a claim', async (t) => {
  const { ask, slotWaits } = await daemon(t);
  const owner = ask({ 'x-foreman-run': 'r_held', 'x-foreman-run-token': runToken('r_held') });
  await until(() => granted(owner), 'the run\'s own request to be granted');
  slotWaits.length = 0;
  const bare = ask({ 'x-foreman-run': 'r_held' });
  await until(() => granted(bare), 'the token-less request to be slotted, not refused busy');
  const other = ask({ 'x-foreman-run': 'r_free' });
  await until(() => granted(other), 'another token-less request to be slotted');
  assert.equal(hasRunLease('r_free'), false, 'a run id alone claims nothing');
  assert.deepEqual(slotWaits, []);
});

test('the worker session carries its run\'s token beside the run id, and only with a run', () => {
  const env = workerEnv({ testCmd: 'npm test' }, 'r_tok');
  assert.equal(env['FOREMAN_RUN_TOKEN'], runToken('r_tok'));
  assert.match(env['FOREMAN_RUN_TOKEN']!, /^[0-9a-f]{64}$/);
  assert.notEqual(runToken('r_tok'), runToken('r_tok2'), 'one token per run');
  assert.equal('FOREMAN_RUN_TOKEN' in workerEnv({ testCmd: 'npm test' }), false);
});

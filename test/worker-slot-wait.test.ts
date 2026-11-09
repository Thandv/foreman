// A worker's own suite run waiting for a test slot (POST /api/verify-slot -> Scheduler.slotQueued), as a number on its run.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { RunClock } from '../src/runClock.ts';
import { echoRunner } from '../src/runners/echo.ts';
import { acquireVerifySlot, runToken, verifySlotStats } from '../src/verify/slots.ts';
import { FakeTime } from './fakeclock.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous freeze guard: nothing here asserts on wall time. */
async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test('pin: a named lease that waits leaves its run with only the log line, no number for the wait', { timeout: 180_000 }, async (t) => {
  const prevCap = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = '1';
  const time = new FakeTime();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    verifyEnabled: false,
    maxWorkers: 1,
    now: time.now,
    runClock: (budgetMs, onExpire) => new RunClock(budgetMs, onExpire, time.now, time),
  });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const realRun = echoRunner.run;
  t.after(async () => {
    echoRunner.run = realRun;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    if (prevCap === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prevCap;
  });
  /** What the wrapper does: POST naming the run, and read lines until told. */
  const ask = (headers: Record<string, string>): { req: http.ClientRequest; text: () => string } => {
    let body = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/verify-slot', method: 'POST', headers }, (res) => {
      res.setEncoding('utf8').on('data', (c: string) => { body += c; });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    return { req, text: () => body };
  };
  echoRunner.run = async (ctx) => {
    ctx.stage('work');
    // Every slot is taken by someone else's suite: this run's wrapper queues for 1 s.
    const other = await acquireVerifySlot();
    const named = ask({ 'x-foreman-run': ctx.runId, 'x-foreman-run-token': runToken(ctx.runId) });
    await until(() => verifySlotStats().waiting === 1 && /queued\n/.test(named.text()), 'the named request to queue');
    time.advance(1_000);
    other.release();
    await until(() => /granted/.test(named.text()), 'the grant');
    named.req.destroy();
    await until(() => verifySlotStats().active === 0, 'the lease to be released');
    return { ok: true, summary: 'done', exitCode: 0 };
  };
  const task = store.addTask({ title: 'waits for a slot', prompt: 'x', runner: 'echo', maxAttempts: 1 });
  await sched.drain(120_000);
  assert.equal(store.getTask(task.id)!.status, 'awaiting-approval', store.getTask(task.id)!.error ?? '');
  const lines = store.eventsForTask(task.id).map((e) => e.message);
  assert.ok(lines.some((m) => /the worker's suite run stopped waiting for a test slot after \d+ s/.test(m)), 'the wait is logged');
  const columns = (store.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!columns.includes('worker_slot_wait_ms'), 'and nothing on the run sums it');
});

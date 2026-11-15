import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler, TICK_STAGES } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { collectMetrics, toProm, type Metrics } from '../src/metrics.ts';

process.env['FOREMAN_PREWARM'] = 'off';

const MIN = 60_000;
const NOW = 1_700_000_000_000;

/**
 * A ledger with something in every measured place: tasks in three statuses, two tickets parked at the gate in one repo
 * and one in another, two runs whose gate waits ended (5 and 15 minutes), and a repo red for 42 minutes.
 */
function seed(store: Store, now: number): void {
  store.addTask({ title: 'q', prompt: 'p' });
  const park = (repo: string, ageMs: number): void => {
    const t = store.addTask({ title: 'parked', prompt: 'p', repo });
    store.setStatus(t.id, 'awaiting-approval');
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now - ageMs, t.id);
  };
  park('/repos/a', 10 * MIN);
  park('/repos/a', 30 * MIN);
  park('/repos/b', 2 * MIN);
  for (const waitMs of [5 * MIN, 15 * MIN]) {
    const t = store.addTask({ title: 'decided', prompt: 'p' });
    const run = store.startRun(t.id);
    store.setRunStage(run.id, t.id, 'gate');
    store.setStatus(t.id, 'done');
    const reached = now - 60 * MIN;
    store.db.prepare("UPDATE events SET ts = ? WHERE run_id = ? AND stage = 'gate'").run(reached, run.id);
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(reached + waitMs, t.id);
  }
  store.markRepoRed('/repos/red', { head: 'abc', taskId: 't_x', testCmd: 'npm test', reason: 'FAIL', since: now - 42 * MIN });
}

test('collectMetrics reports what the ledger holds: statuses, gate waits, gate ages per repo, red minutes', () => {
  const store = new Store(':memory:');
  try {
    seed(store, NOW);
    const m = collectMetrics(store, new Map([['dispatch', 3], ['runDueSchedules', 1]]), NOW);
    assert.equal(m.tasksByStatus.queued, 1);
    assert.equal(m.tasksByStatus['awaiting-approval'], 3);
    assert.equal(m.tasksByStatus.done, 2);
    assert.deepEqual(m.gateWait, { samples: 2, p50Ms: 5 * MIN, p90Ms: 15 * MIN });
    assert.deepEqual(m.awaitingApprovalAgeP95Ms, { '/repos/a': 30 * MIN, '/repos/b': 2 * MIN });
    assert.deepEqual(m.redRepoMinutes, { '/repos/red': 42 });
    assert.equal(m.verifySlotWaiters, 0);
    assert.deepEqual(Object.keys(m.tickStageMs), ['runDueSchedules', 'dispatch'], 'stages in tick order, whatever order they were timed in');
  } finally {
    store.close();
  }
});

test('the tick stage list is the order the tick runs, and one tick times every stage in it', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => NOW });
  try {
    await sched.tick();
    assert.deepEqual([...sched.tickStageMs().keys()], [...TICK_STAGES]);
    for (const ms of sched.tickStageMs().values()) assert.ok(ms >= 0);
    assert.deepEqual(Object.keys(collectMetrics(store, sched.tickStageMs(), NOW).tickStageMs), [...TICK_STAGES]);
  } finally {
    await sched.stop();
    store.close();
  }
});

function get(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    }).on('error', reject);
  });
}

test('GET /api/metrics serves JSON and Prometheus text from a seeded ledger, and writes nothing', async (t) => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const port = (server.address() as AddressInfo).port;
  await sched.tick();
  seed(store, Date.now());
  const changes = (): number => Number((store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  const before = changes();

  const asJson = await get(port, '/api/metrics');
  assert.equal(asJson.status, 200);
  assert.match(asJson.type, /application\/json/);
  const m = JSON.parse(asJson.body) as Metrics;
  assert.equal(m.tasksByStatus['awaiting-approval'], 3);
  assert.deepEqual(Object.keys(m.tickStageMs), [...TICK_STAGES]);
  assert.equal(m.gateWait.p90Ms, 15 * MIN);
  assert.ok(m.awaitingApprovalAgeP95Ms['/repos/a']! >= 30 * MIN);
  assert.ok(m.redRepoMinutes['/repos/red']! >= 42);
  assert.ok(m.eventLoopLagP99Ms === null || m.eventLoopLagP99Ms >= 0);

  const prom = await get(port, '/api/metrics?format=prom');
  assert.equal(prom.status, 200);
  assert.match(prom.type, /^text\/plain; version=0\.0\.4/);
  const lines = prom.body.split('\n');
  assert.ok(lines.includes('# TYPE foreman_tasks gauge'));
  assert.ok(lines.includes('foreman_tasks{status="awaiting-approval"} 3'));
  assert.ok(lines.includes('foreman_verify_slot_waiters 0'));
  assert.ok(lines.includes(`foreman_gate_wait_ms{quantile="0.9"} ${15 * MIN}`));
  assert.ok(lines.includes('foreman_gate_wait_samples 2'));
  assert.ok(lines.some((l) => /^foreman_awaiting_approval_age_p95_ms\{repo="\/repos\/b"\} \d+$/.test(l)));
  assert.ok(lines.some((l) => /^foreman_red_repo_minutes\{repo="\/repos\/red"\} \d+$/.test(l)));
  assert.deepEqual(
    lines.filter((l) => l.startsWith('foreman_tick_stage_ms{')).map((l) => /stage="([^"]+)"/.exec(l)![1]),
    [...TICK_STAGES],
  );

  assert.equal((await get(port, '/api/metrics?format=xml')).status, 400);
  assert.equal(changes(), before, 'the route performs no writes');
});

test('Prometheus label values are escaped', () => {
  const store = new Store(':memory:');
  try {
    store.markRepoRed('/repos/we"ird\\name\nx', { head: 'h', taskId: 't', testCmd: null, reason: 'r', since: NOW - MIN });
    const prom = toProm(collectMetrics(store, new Map(), NOW));
    assert.ok(prom.split('\n').includes('foreman_red_repo_minutes{repo="/repos/we\\"ird\\\\name\\nx"} 1'), prom);
  } finally {
    store.close();
  }
});

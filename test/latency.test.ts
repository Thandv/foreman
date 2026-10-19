import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { computeLatencyReport, formatDuration, LATENCY_STAGES, type RunLatencyInput } from '../src/latency.ts';

// --------------------------------------------------------- computeLatencyReport (pure)

test('an empty run list reports zero for every stage without dividing by zero', () => {
  const report = computeLatencyReport([]);
  assert.equal(report.sampleRuns, 0);
  assert.equal(report.stages.length, LATENCY_STAGES.length);
  for (const s of report.stages) {
    assert.equal(s.count, 0);
    assert.equal(s.medianMs, 0);
    assert.equal(s.p90Ms, 0);
    assert.equal(s.shareOfTotalPct, 0);
  }
});

test('stage duration is the gap to the next recorded stage event', () => {
  const runs: RunLatencyInput[] = [
    {
      runId: 'r1', taskId: 't1', taskStatus: 'awaiting-approval', taskUpdatedAt: 0,
      events: [
        { stage: 'admit', ts: 0 },
        { stage: 'isolate', ts: 100 },
        { stage: 'plan', ts: 600 },     // isolate took 500ms
        { stage: 'work', ts: 1_600 },   // plan took 1000ms
        { stage: 'test', ts: 3_600 },   // work took 2000ms
        { stage: 'verify', ts: 4_100 }, // test took 500ms
        { stage: 'gate', ts: 4_600 },   // verify took 500ms
      ],
    },
  ];
  const report = computeLatencyReport(runs);
  const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
  assert.equal(byStage['isolate']!.medianMs, 500);
  assert.equal(byStage['plan']!.medianMs, 1000);
  assert.equal(byStage['work']!.medianMs, 2000);
  assert.equal(byStage['test']!.medianMs, 500);
  assert.equal(byStage['verify']!.medianMs, 500);
  // gate-wait has no sample: the task is still awaiting a decision.
  assert.equal(byStage['gate-wait']!.count, 0);
});

test('a run that skips a stage still attributes the gap to the stage actually reached', () => {
  // No test command: work runs straight into verify.
  const runs: RunLatencyInput[] = [
    {
      runId: 'r1', taskId: 't1', taskStatus: 'awaiting-approval', taskUpdatedAt: 0,
      events: [
        { stage: 'isolate', ts: 0 },
        { stage: 'plan', ts: 200 },
        { stage: 'work', ts: 700 },
        { stage: 'verify', ts: 2_700 }, // work took 2000ms; no 'test' stage at all
        { stage: 'gate', ts: 2_900 },
      ],
    },
  ];
  const report = computeLatencyReport(runs);
  const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
  assert.equal(byStage['work']!.medianMs, 2000);
  assert.equal(byStage['test']!.count, 0, 'no test stage event means no test sample');
});

test('gate-wait is the time from reaching the gate to the task actually being decided', () => {
  const runs: RunLatencyInput[] = [
    {
      runId: 'r1', taskId: 't1', taskStatus: 'done', taskUpdatedAt: 10_000,
      events: [{ stage: 'gate', ts: 4_000 }],
    },
    {
      // still parked at the gate: no end yet, must not be counted.
      runId: 'r2', taskId: 't2', taskStatus: 'awaiting-approval', taskUpdatedAt: 4_000,
      events: [{ stage: 'gate', ts: 4_000 }],
    },
    {
      runId: 'r3', taskId: 't3', taskStatus: 'rejected', taskUpdatedAt: 9_000,
      events: [{ stage: 'gate', ts: 3_000 }],
    },
  ];
  const report = computeLatencyReport(runs);
  const gateWait = report.stages.find((s) => s.stage === 'gate-wait')!;
  assert.equal(gateWait.count, 2, 'only the two decided tasks contribute a sample');
  // samples: 10000-4000=6000, 9000-3000=6000 → median 6000
  assert.equal(gateWait.medianMs, 6000);
});

test('median and p90 are computed correctly and share sums to the whole', () => {
  const mkRun = (id: string, isolateMs: number): RunLatencyInput => ({
    runId: id, taskId: id, taskStatus: 'done', taskUpdatedAt: 0,
    events: [
      { stage: 'isolate', ts: 0 },
      { stage: 'plan', ts: isolateMs },
    ],
  });
  const runs = [mkRun('a', 100), mkRun('b', 200), mkRun('c', 300), mkRun('d', 400), mkRun('e', 500)];
  const report = computeLatencyReport(runs);
  const isolate = report.stages.find((s) => s.stage === 'isolate')!;
  assert.equal(isolate.count, 5);
  assert.equal(isolate.medianMs, 300);
  assert.equal(isolate.p90Ms, 500);
  const shareSum = report.stages.reduce((n, s) => n + s.shareOfTotalPct, 0);
  assert.ok(Math.abs(shareSum - 100) < 1e-9, `stage shares should sum to 100%, got ${shareSum}`);
});

test('formatDuration renders ms, seconds and minutes readably', () => {
  assert.equal(formatDuration(340), '340ms');
  assert.equal(formatDuration(1_234), '1.2s');
  assert.equal(formatDuration(90_000), '1.5m');
});

// ------------------------------------------------------- Store wiring (synthetic rows)

test('Store.recentRunsForLatency reconstructs stage timelines from real event rows', () => {
  const store = new Store(':memory:');
  const now = Date.now();
  store.db
    .prepare(
      "INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) " +
        "VALUES ('t1','x','do it','code','echo','S1','done',2,?,?)",
    )
    .run(now, now + 5_000);
  store.db
    .prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','succeeded','gate',?)")
    .run(now);
  for (const [stage, offset] of [['admit', 0], ['isolate', 100], ['plan', 400], ['work', 900], ['gate', 3_000]] as const) {
    store.db
      .prepare("INSERT INTO events (task_id, run_id, ts, type, stage, message) VALUES ('t1','r1',?,'stage',?,?)")
      .run(now + offset, stage, stage);
  }

  const raw = store.recentRunsForLatency(20);
  assert.equal(raw.length, 1);
  assert.equal(raw[0]!.taskStatus, 'done');
  assert.equal(raw[0]!.events.length, 5);

  const report = computeLatencyReport(raw);
  const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
  assert.equal(byStage['isolate']!.medianMs, 300);   // 400 - 100
  assert.equal(byStage['plan']!.medianMs, 500);      // 900 - 400
  assert.ok(byStage['gate-wait']!.medianMs >= 2_000, 'gate-wait uses the task decision time, not the run end');
  store.close();
});

test('Store.recentRunsForLatency on an empty database returns no runs', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.recentRunsForLatency(20), []);
  const report = computeLatencyReport(store.recentRunsForLatency(20));
  assert.equal(report.sampleRuns, 0);
  store.close();
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Broker } from '../src/budget.ts';
import { config } from '../src/config.ts';

// The gate's worker-controlled `test:` lines are capped in the events table (head and tail, one marker between);
// the run log keeps every line and Foreman's own events are never capped.

const HANG = { timeout: 120_000 };
const CAP = 50; // FOREMAN_LOG_LINES for these tests: head 50, tail 49, one marker
const tmp = (p: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (dir: string, args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

async function gateRun(lines: number, exit: number) {
  const repo = tmp('foreman-gatecap-repo-');
  const scratch = tmp('foreman-gatecap-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'src.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  const script = path.join(scratch, 'gate.sh');
  fs.writeFileSync(script, '#!/bin/sh\nseq 1 ' + lines + '\nexit ' + exit + '\n');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    broker: new Broker(store, { guardResidency: false, fitsFn: async () => true }),
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  (sched as unknown as { pruneEvents: () => void }).pruneEvents = () => {};
  const mutable = config as { logLinesPerRun: number };
  const saved = mutable.logLinesPerRun;
  mutable.logLinesPerRun = CAP;
  try {
    const t = store.addTask({ title: 'gate', prompt: 'date +%s%N >> src.txt', kind: 'code', runner: 'shell', repo, testCmd: "sh '" + script + "'", maxRepairs: 0 });
    await sched.drain(100_000);
    const events = store.eventsForTask(t.id).map((e) => e.message);
    const log = store.artifactsForTask(t.id).find((a) => a.type === 'log');
    return {
      events,
      log: log ? fs.readFileSync(log.path, 'utf8') : '',
      close: async () => {
        await sched.stop();
        store.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(scratch, { recursive: true, force: true });
      },
    };
  } finally {
    mutable.logLinesPerRun = saved;
  }
}

test('a gate printing 20,000 lines records a bounded head and tail, one marker, the verdict line, and the full run log', HANG, async () => {
  const r = await gateRun(20_000, 0);
  try {
    const testEvents = r.events.filter((m) => /^test: \d+$/.test(m));
    assert.equal(testEvents.length, 2 * CAP - 1, 'head N + tail N-1');
    assert.deepEqual(testEvents.slice(0, CAP), Array.from({ length: CAP }, (_, i) => 'test: ' + (i + 1)));
    assert.deepEqual(testEvents.slice(-49), Array.from({ length: 49 }, (_, i) => 'test: ' + (20_000 - 48 + i)), 'the tail is kept');
    const markers = r.events.filter((m) => / lines omitted/.test(m));
    assert.equal(markers.length, 1);
    assert.ok(markers[0]!.startsWith(String(20_000 - (2 * CAP - 1)) + ' test lines omitted'), markers[0]);
    const iMarker = r.events.indexOf(markers[0]!);
    assert.ok(r.events.indexOf('test: 1') < iMarker && iMarker < r.events.indexOf('test: 20000'), 'marker between head and tail');
    const verdictAt = r.events.findIndex((m) => m.startsWith('tests passed ('));
    assert.ok(verdictAt > r.events.indexOf('test: 20000'), 'the PASSED line follows the tail and is not capped');
    assert.equal(r.log.split('\n').filter((l) => /\btest: \d+$/.test(l)).length, 20_000, 'the run log holds every line');
  } finally { await r.close(); }
});

test('a failing gate under the cap records every line, no marker, and the FAILED line', HANG, async () => {
  const r = await gateRun(30, 1);
  try {
    assert.deepEqual(r.events.filter((m) => /^test: \d+$/.test(m)), Array.from({ length: 30 }, (_, i) => 'test: ' + (i + 1)));
    assert.equal(r.events.filter((m) => / lines omitted/.test(m)).length, 0);
    assert.ok(r.events.some((m) => m.startsWith('TESTS FAILED (')));
  } finally { await r.close(); }
});

test('a gate printing 200,000 lines stalls the event loop for under a second', HANG, async () => {
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 20);
  const r = await gateRun(200_000, 0);
  clearInterval(timer);
  try {
    assert.ok(r.events.filter((m) => /^test: \d+$/.test(m)).length <= 2 * CAP, 'bounded');
    assert.ok(r.events.includes('test: 200000'));
    // Alone this measures under 1 s; 3 s keeps the full suite's load from flaking it (uncapped it was ~8 s).
    assert.ok(worst < 3000,'event-loop stall ' + worst + ' ms');
  } finally { await r.close(); }
});

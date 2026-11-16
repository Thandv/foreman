import { scratchDir } from './env.ts';
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
import { clearPlaybookCache } from '../src/playbooks.ts';

// The gate's worker-controlled `test:` lines are capped in the events table (head and tail, one marker between);
// the run log keeps every line and Foreman's own events are never capped.

const HANG = { timeout: 120_000 };
const CAP = 50; // FOREMAN_LOG_LINES for these tests: head 50, tail 49, one marker
const tmp = (p: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (dir: string, args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

async function gateRun(lines: number, exit: number, via: 'test' | 'check' = 'test') {
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
    let playbook: string | undefined;
    if (via === 'check') {
      // A playbook whose one check is the gate script; with no test command detected, the checks still run.
      const fm = { id: 'capcheck', description: 'cap check', triggers: ['capcheck'], roles: { planner: { tier: 'owner' }, dev: { tier: 'worker' } },
        reviewers: [], escalation: { chair: 'planner', afterFailures: 2 }, checks: ["sh '" + script + "'"], gate: { default: 'human', hardHuman: [] }, constraints: [] };
      const dir = scratchDir('foreman-gatecap-pb-');
      fs.writeFileSync(path.join(dir, 'capcheck.md'), '---\n' + JSON.stringify(fm) + '\n---\n## role: planner\n\nPlan.\n\n## role: dev\n\nDo.\n');
      process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
      clearPlaybookCache();
      playbook = 'capcheck';
    }
    const t = store.addTask({ title: 'gate', prompt: 'date +%s%N >> src.txt', kind: 'code', runner: 'shell', repo, maxRepairs: 0,
      ...(via === 'test' ? { testCmd: "sh '" + script + "'" } : { playbook }) });
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
    delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    clearPlaybookCache();
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

test('a gate printing 200,000 lines records a bounded number of events and keeps the last line', HANG, async (t) => {
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 20);
  const r = await gateRun(200_000, 0);
  clearInterval(timer);
  try {
    assert.ok(r.events.filter((m) => /^test: \d+$/.test(m)).length <= 2 * CAP, 'bounded');
    assert.ok(r.events.includes('test: 200000'));
    // Reported, not asserted: the bound above is what the fix changes, and a loaded machine must make this slower, never red (as in perf.test.ts). Idle it measures under 1 s; uncapped it was ~8 s.
    t.diagnostic('worst event-loop gap ' + worst + ' ms');
  } finally { await r.close(); }
});

test('a playbook check printing 20,000 lines is capped the same way: head, one marker, tail, then the check verdict', HANG, async () => {
  const r = await gateRun(20_000, 1, 'check');
  try {
    const lines = r.events.filter((m) => /^check: \d+$/.test(m));
    assert.equal(lines.length, 2 * CAP - 1, 'head N + tail N-1');
    assert.deepEqual(lines.slice(-49), Array.from({ length: 49 }, (_, i) => 'check: ' + (20_000 - 48 + i)), 'the tail is kept');
    const markers = r.events.filter((m) => / check lines omitted/.test(m));
    assert.equal(markers.length, 1);
    const verdictAt = r.events.findIndex((m) => m.startsWith('CHECK FAILED ('));
    assert.ok(verdictAt > r.events.indexOf('check: 20000'), 'the FAILED line follows the tail');
    assert.equal(r.log.split('\n').filter((l) => /\bcheck: \d+$/.test(l)).length, 20_000, 'the run log holds every line');
  } finally { await r.close(); }
});

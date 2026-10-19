import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { councilShareOf, finishedRound, Scheduler, type SchedulerOptions } from '../src/scheduler.ts';

/** Scheduler with the council stubbed, so pipeline tests need no model server. */
function scheduler(store: Store, opts: SchedulerOptions = {}): Scheduler {
  return new Scheduler(store, { tickMs: 5, verifyEnabled: false, ...opts });
}

function fixtureRepo(dirty: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  if (dirty) fs.writeFileSync(path.join(dir, 'README.md'), 'uncommitted\n');
  return dir;
}

test('a successful run parks at the human gate with a log artifact', async () => {
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 2 });
  const t = store.addTask({ title: 'ok', prompt: 'do the thing', runner: 'echo' });
  await sched.drain(20_000);
  const after = store.getTask(t.id)!;
  assert.equal(after.status, 'awaiting-approval');
  const run = store.latestRun(t.id)!;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.stage, 'gate');
  assert.equal(run.progress, 1);
  assert.ok(run.tokensOut > 0, 'usage should be metered');
  const artifacts = store.artifactsForTask(t.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.type, 'log');
  assert.ok(fs.existsSync(artifacts[0]!.path));
  store.close();
});

test('failed work gets one repair round, then fails its dependents', async () => {
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 2 });
  const bad = store.addTask({ title: 'bad', prompt: 'please fail', runner: 'echo', maxRepairs: 1 });
  const dependent = store.addTask({ title: 'after', prompt: 'ok', runner: 'echo', deps: [bad.id] });
  await sched.drain(20_000);
  const failed = store.getTask(bad.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.repairs, 1, 'exactly one repair round');
  assert.equal(store.runsForTask(bad.id).length, 2, 'original run plus the repair run');
  assert.equal(store.getTask(dependent.id)!.status, 'failed');
  const verdicts = store.verdictsForTask(bad.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === 'fail'));
  store.close();
});

test('the repair round carries the critique into the worker brief', async () => {
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1 });
  const t = store.addTask({ title: 'bad', prompt: 'please fail', runner: 'echo', maxRepairs: 1 });
  await sched.drain(20_000);
  const notes = store.getTask(t.id)!.repairNotes;
  assert.match(notes ?? '', /worker itself failed/);
  store.close();
});

test('infrastructure failures still use the attempt budget, not a repair round', async () => {
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1 });
  const t = store.addTask({
    title: 'missing repo', prompt: 'true', kind: 'code', runner: 'shell',
    repo: '/nonexistent/definitely-not-here', maxAttempts: 2,
  });
  await sched.drain(20_000);
  const after = store.getTask(t.id)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, 2, 'both attempts used');
  assert.equal(after.repairs, 0, 'no repair round for an environment failure');
  store.close();
});

test('the pool never exceeds maxWorkers', async () => {
  process.env['FOREMAN_ECHO_STEP_MS'] = '40';
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 2 });
  for (let i = 0; i < 6; i++) store.addTask({ title: `t${i}`, prompt: 'x', runner: 'echo' });
  let peak = 0;
  const probe = setInterval(() => {
    peak = Math.max(peak, sched.activeCount);
  }, 5);
  await sched.drain(30_000);
  clearInterval(probe);
  process.env['FOREMAN_ECHO_STEP_MS'] = '5';
  assert.ok(peak > 1, `expected real parallelism, saw peak ${peak}`);
  assert.ok(peak <= 2, `pool overran maxWorkers: peak ${peak}`);
  assert.equal(store.stats()['awaiting-approval'], 6);
  store.close();
});

test('cancel aborts a running task and stops it being retried', async () => {
  process.env['FOREMAN_ECHO_STEP_MS'] = '80';
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1 });
  const t = store.addTask({ title: 'long', prompt: 'x', runner: 'echo', maxAttempts: 3 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 60));
  store.cancel(t.id);
  await new Promise((r) => setTimeout(r, 300));
  process.env['FOREMAN_ECHO_STEP_MS'] = '5';
  assert.equal(store.getTask(t.id)!.status, 'canceled');
  assert.equal(store.latestRun(t.id)!.status, 'canceled');
  assert.equal(sched.activeCount, 0);
  await sched.stop();
  store.close();
});

test('a code task gets a worktree jail and its changes come back as a diff artifact', async () => {
  const repo = fixtureRepo(false);
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1 });
  const t = store.addTask({
    title: 'touch a file',
    prompt: 'printf "changed\\n" > README.md && printf "new\\n" > added.txt',
    kind: 'code',
    runner: 'shell',
    repo,
  });
  await sched.drain(30_000);
  const after = store.getTask(t.id)!;
  assert.equal(after.status, 'awaiting-approval', after.error ?? '');
  const run = store.latestRun(t.id)!;
  assert.match(run.branch!, new RegExp(`^foreman/${t.id}-r_`), 'branch is unique per run');
  assert.ok(run.worktreePath && !run.worktreePath.startsWith(repo), 'jail must live outside the repo');

  const diff = store.artifactsForTask(t.id).find((a) => a.type === 'diff');
  assert.ok(diff, 'expected a diff artifact');
  const text = fs.readFileSync(diff.path, 'utf8');
  assert.match(text, /README\.md/);
  assert.match(text, /added\.txt/);

  // The operator's checkout must be untouched.
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(repo, 'added.txt')), false);
  store.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a dirty operator checkout holds the ticket instead of failing it, and releases it once clean', async () => {
  const repo = fixtureRepo(true);
  let now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1, now: () => now });
  const settle = async (cond: () => boolean, what: string): Promise<void> => {
    const until = Date.now() + 60_000;
    while (!cond()) {
      if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
      await sched.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    const t = store.addTask({ title: 'nope', prompt: 'true', kind: 'code', runner: 'shell', repo, maxAttempts: 3 });
    await sched.tick();
    await settle(() => store.getTask(t.id)!.status === 'queued' && sched.activeCount === 0, 'the dirty run to settle');
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'queued', 'held, not failed');
    assert.equal(after.attempts, 0, 'the attempt is given back');
    assert.match(after.error ?? '', /uncommitted changes/);
    assert.ok(
      store.eventsForTask(t.id).some((e) => e.type === 'warning' && /README\.md/.test(e.message)),
      'an event names the dirty file',
    );
    // Held: further ticks claim nothing for the repo, even once the backoff
    // passes, while the checkout is still dirty — no spin.
    for (let i = 0; i < 5; i++) await sched.tick();
    const holds = (sched as unknown as { dirtyHolds: Map<string, { probes: number; probing: boolean }> }).dirtyHolds;
    assert.ok(holds instanceof Map, 'the scheduler keeps its dirty holds in a Map (this test reads it)');
    const probesBefore = holds.get(path.resolve(repo))?.probes ?? 0;
    now += 31_000;
    // The probe is a git child that finishes on its own time and stamps its next due time from the clock when it
    // does. Wait for its answer before the clock moves again, or a late answer schedules the next probe in the
    // future of a clock nobody advances any more (the hang this test had under load).
    await settle(() => {
      const hold = holds.get(path.resolve(repo));
      return !!hold && hold.probes > probesBefore && !hold.probing;
    }, 'the probe to find the checkout still dirty');
    assert.equal(store.runsForTask(t.id).length, 1, 'not re-run against a dirty checkout');
    assert.equal(store.getTask(t.id)!.status, 'queued');

    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: repo });
    now += 10 * 60_000;
    await settle(() => store.runsForTask(t.id).length >= 2, 'the clean checkout to be dispatched');
    assert.equal(store.getTask(t.id)!.attempts, 1, 'the dispatched run is its first attempt');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a run that times out is aborted rather than left running', async () => {
  process.env['FOREMAN_ECHO_STEP_MS'] = '500';
  const store = new Store(':memory:');
  const sched = scheduler(store, { maxWorkers: 1, taskTimeoutMs: 60 });
  const t = store.addTask({ title: 'slow', prompt: 'x', runner: 'echo', maxAttempts: 1 });
  await sched.tick();
  await new Promise((r) => setTimeout(r, 900));
  process.env['FOREMAN_ECHO_STEP_MS'] = '5';
  assert.equal(sched.activeCount, 0);
  // Out of time is a failed attempt, not a cancel: nobody canceled it (test/deadline.test.ts has the rest).
  assert.equal(store.getTask(t.id)!.status, 'failed');
  assert.match(store.getTask(t.id)!.error ?? '', /^run deadline \(0 min\) reached during /);
  await sched.stop();
  store.close();
});

test('the local council may not spend the whole deadline the crew chain needs', () => {
  const now = Date.now();
  // Advisory and slow; the reviewer that actually reads the work comes after it
  // and inherits the remainder.
  const share = councilShareOf(now + 600_000, 0.4);
  assert.ok(share > 0 && share <= 600_000 * 0.4 + 1, `expected ~240s, got ${share}`);

  // A floor, so a nearly-spent deadline still lets the council try.
  assert.equal(councilShareOf(now + 10_000, 0.4), 30_000);
  // And a ceiling: it never gets the whole thing.
  assert.ok(councilShareOf(now + 600_000, 5) < 600_000);
  // An already-blown deadline does not produce a negative timeout.
  assert.ok(councilShareOf(now - 5_000) > 0);
});

test('a council that runs out of time keeps the last round it finished, if anyone in it answered', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'x', prompt: 'y', runner: 'echo' });
    const run = store.startRun(t.id);
    const op = (error?: string) => ({ model: 'm', provider: 'ollama', local: true, verdict: 'pass' as const, confidence: 0.9, critique: 'ok', costUsd: 0, latencyMs: 1, ...(error ? { error } : {}) });
    assert.equal(finishedRound(store, t.id, run.id), null, 'nothing finished: the caller records that nobody could');

    const rung0 = store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'split', disagreement: false, council: [op(), op('unparseable reply: x')], chairSummary: 'a seat answered nothing usable' });
    assert.equal(finishedRound(store, t.id, run.id)?.id, rung0.id, 'the survivor read it: that round is kept');

    store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'pass', disagreement: false, council: [], source: 'crew' });
    assert.equal(finishedRound(store, t.id, run.id)?.id, rung0.id, "a crew row is not the council's round");

    store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'split', disagreement: false, council: [op('down'), op('down')] });
    assert.equal(finishedRound(store, t.id, run.id), null, 'the newest round heard nobody: no stale row is passed off as current');

    // The fast tier's one seat is triage: its FAIL means "ask the full council",
    // so a council that then ran out of time has no round to keep.
    store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'fail', disagreement: false, council: [{ ...op(), verdict: 'fail' }] });
    assert.equal(finishedRound(store, t.id, run.id), null, 'a one-seat triage row is never the council verdict');
  } finally {
    store.close();
  }
});

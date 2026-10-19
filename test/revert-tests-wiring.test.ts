import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.ts';
import { collectDebrief } from '../src/debrief.ts';
import { hardHumanReason, reviewHolds } from '../src/gate.ts';
import { Store, type NewTask } from '../src/queue.ts';
import { RunClock } from '../src/runClock.ts';
import { Scheduler, type VerifyArgs } from '../src/scheduler.ts';
import type { Task } from '../src/types.ts';
import { readRevertTests } from '../src/verify/revertTests.ts';

/**
 * The per-test revert check in the scheduler: off unless switched on; on, a code ticket whose tests passed gets the
 * table in its reviewer's note, on the run, in the owner gate's prompt and in the debrief — and NO repair round, no
 * hold and no failed stage from it.
 */

// A `node --test` started from inside this file would otherwise think it is a nested run and execute nothing.
delete process.env['NODE_TEST_CONTEXT'];

const T = { timeout: 600_000 };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const HEAD = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as x from '../src/x.js';\n";
const SRC_AFTER = 'export const double = (n) => n + n;\nexport const triple = (n) => 3 * n;\n';
/** One test that fails without the change and one that holds anyway, in the same file. */
const MIXED = `${HEAD}test('triples', () => assert.equal(x.triple?.(2), 6));\ntest('still doubles', () => assert.equal(x.double(2), 4));\n`;

function fixtureRepo(t: TestContext): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rtw-repo-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  for (const [rel, body] of Object.entries({
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test' } }),
    '.gitignore': 'node_modules/\n',
    'src/x.js': 'export const double = (n) => n + n;\n',
    'test/base.test.js': `${HEAD}test('double', () => assert.equal(x.double(2), 4));\n`,
  })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

/** A shell ticket's command that writes these files (the stand-in for a worker). */
const writes = (files: Record<string, string>): string =>
  Object.entries(files)
    .map(([rel, body]) => `mkdir -p '${path.dirname(rel)}' && cat > '${rel}' <<'FOREMAN_EOF'\n${body.replace(/\n$/, '')}\nFOREMAN_EOF`)
    .join('\n');

interface Rig { store: Store; sched: Scheduler; reviews: string[]; add: (prompt: string, over?: Partial<NewTask>) => Task }

/** Every wait a run's clock was told of, in order, and whether a scratch tree of the check was on disk at that moment. */
const waits: Array<{ key: string; open: boolean; checking: boolean }> = [];
const checking = (): boolean => fs.existsSync(config.workRoot) && fs.readdirSync(config.workRoot).some((n) => n.startsWith('revert-tests-'));

class WatchedClock extends RunClock {
  override pause(key: string): void {
    waits.push({ key, open: true, checking: checking() });
    super.pause(key);
  }
  override resume(key: string): void {
    waits.push({ key, open: false, checking: checking() });
    super.resume(key);
  }
}

function rig(t: TestContext, repo: string, revertTests: boolean | undefined): Rig {
  const store = new Store(':memory:');
  const reviews: string[] = [];
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    ...(revertTests === undefined ? {} : { revertTests }),
    runClock: (budgetMs, onExpire) => new WatchedClock(budgetMs, onExpire),
    verify: async (args: VerifyArgs) => {
      reviews.push(args.evidence.logTail ?? '');
      return store.addVerdict({
        runId: args.runId, taskId: args.task.id, verdict: 'pass', disagreement: false, critique: 'read',
        council: [{ model: 'local-0', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: 'read', costUsd: 0, latencyMs: 5 }],
      });
    },
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  return {
    store, sched, reviews,
    add: (prompt, over = {}) => store.addTask({ title: 'ticket', kind: 'code', runner: 'shell', repo, testCmd: 'node --test', prompt, ...over }),
  };
}

/** The owner model, as a stand-in CLI that keeps the prompt it was given and holds. */
function ownerStub(t: TestContext): { prompt: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rtw-cli-'));
  const bin = path.join(dir, 'claude');
  const promptFile = path.join(dir, 'prompt');
  const reply = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01,
    result: JSON.stringify({ decision: 'hold', rationale: 'the owner was asked' }),
  });
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$2" > '${promptFile}'\ncat <<'EOF'\n${reply}\nEOF\n`, { mode: 0o755 });
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  t.after(() => {
    delete process.env['FOREMAN_CLAUDE_BIN'];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { prompt: () => (fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '') };
}

const realSetTimeout = globalThis.setTimeout;
const pause = (ms: number): Promise<void> => new Promise((r) => void realSetTimeout(r, ms));

async function settle(r: Rig, until: () => boolean, ms = 300_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await r.sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await pause(10);
  }
}

const parked = (r: Rig, id: string) => (): boolean =>
  !['queued', 'ready', 'running', 'verifying'].includes(r.store.getTask(id)!.status) && !r.sched.activeCount && !r.sched.verifyingCount;

test('on: the reviewer gets the per-test table, the run keeps it, the owner gate and the debrief see it — and nothing is repaired or held for it', T, async (t) => {
  const stub = ownerStub(t);
  const repo = fixtureRepo(t);
  const r = rig(t, repo, true);
  const task = r.add(writes({ 'src/x.js': SRC_AFTER, 'test/new.test.js': MIXED }), { gate: 'owner' });
  await settle(r, () => parked(r, task.id)() && r.store.eventsForTask(task.id, 800).some((e) => e.message.startsWith('owner-gate:')));

  const after = r.store.getTask(task.id)!;
  assert.equal(after.status, 'awaiting-approval', after.error ?? '');
  assert.equal(after.preReviewRepairs ?? 0, 0, 'no repair round');
  assert.equal(r.reviews.length, 1, 'the reviewer was called, once');
  assert.match(r.reviews[0]!, /FOREMAN REVERT CHECK \(a reviewer aid; it decides nothing\)/);
  assert.match(r.reviews[0]!, /\[PASSES without the change\] test\/new\.test\.js:5 "still doubles" \(added\)/);
  assert.match(r.reviews[0]!, /\[fails without the change\] test\/new\.test\.js:4 "triples" \(added\)/);

  const run = r.store.latestRun(task.id)!;
  assert.equal(run.testsPassed, true, 'the test stage is not failed by it');
  const row = r.store.artifactsForTask(task.id).find((a) => a.type === 'revert-tests' && a.runId === run.id)!;
  assert.equal(row.summary, 'revert check: 1 fail, 1 pass, 0 could not run without the src change');
  assert.deepEqual(readRevertTests(row.path)?.tests.map((x) => [x.name, x.outcome]), [['triples', 'fails-without-change'], ['still doubles', 'passes-without-change']]);

  // The hold reasons are what they would be without it: none of them is the check's.
  const why = hardHumanReason(after, run, reviewHolds(r.store, task.id));
  assert.doesNotMatch(why ?? '', /revert|without the change/i);
  assert.match(stub.prompt(), /FOREMAN REVERT CHECK[\s\S]*"still doubles"/, 'the owner gate is shown the table');

  // The check's time is not the run's: the clock was stopped before its scratch tree existed and started again after.
  const opened = waits.findIndex((w) => w.key === 'revert-check' && w.open);
  const closed = waits.findIndex((w) => w.key === 'revert-check' && !w.open);
  assert.ok(opened >= 0 && closed > opened, JSON.stringify(waits));
  assert.equal(waits[opened]!.checking, false);
  assert.ok(waits.slice(opened + 1, closed).some((w) => w.checking), 'the check ran while it was stopped (its slot waits are inside)');

  const debriefRun = collectDebrief(r.store, task.id).tickets[0]!.runs.at(-1)!;
  assert.deepEqual(debriefRun.revertTests, { status: 'ran', fails: 1, passes: 1, couldNotRun: 0, passing: ['test/new.test.js:5 still doubles'] });
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /revert-tests-/, 'the scratch worktree is gone');
});

test('off (the default): no check runs, no note, no artifact', T, async (t) => {
  const repo = fixtureRepo(t);
  const r = rig(t, repo, undefined);
  const task = r.add(writes({ 'src/x.js': SRC_AFTER, 'test/new.test.js': MIXED }));
  await settle(r, parked(r, task.id));
  assert.equal(r.reviews.length, 1);
  assert.doesNotMatch(r.reviews[0]!, /REVERT CHECK/);
  assert.equal(r.store.artifactsForTask(task.id).some((a) => a.type === 'revert-tests'), false);
});

test('on, but the tests failed: the check does not run', T, async (t) => {
  const repo = fixtureRepo(t);
  const r = rig(t, repo, true);
  const red = MIXED.replace("x.triple?.(2), 6", "x.triple?.(2), 7");
  const task = r.add(writes({ 'src/x.js': SRC_AFTER, 'test/new.test.js': red }));
  await settle(r, () => r.store.runsForTask(task.id).some((run) => run.status !== 'running') && !r.sched.activeCount && !r.sched.verifyingCount);
  assert.equal(r.store.latestRun(task.id)!.testsPassed, false);
  assert.equal(r.store.artifactsForTask(task.id).some((a) => a.type === 'revert-tests'), false);
});

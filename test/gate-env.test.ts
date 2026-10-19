import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler, type SchedulerOptions } from '../src/scheduler.ts';
import { applyApproval, hardHumanReason } from '../src/gate.ts';
import { runTests, type TestResult } from '../src/verify/tests.ts';
import {
  behindLine, behindMain, failingTestFiles, gateTimeout, nothingToChangeNote, timedOutTwiceNote, unfinishedTests,
} from '../src/verify/gateOutcome.ts';
import type { Run, Task } from '../src/types.ts';

// The colour switches the daemon inherits, the gate timeout, a jail behind main, and "nothing to change"
// (trial findings F3, F30, F31, F42). Every scheduler test drives a real run with the shell runner as the worker
// and a stand-in test command; nothing here waits on a wall clock except as a hang guard.

const HANG = { timeout: 120_000 };

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A repo with a source file and two test files, committed. */
function fixtureRepo(): string {
  const dir = tmp('foreman-gateenv-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '// a\n');
  fs.writeFileSync(path.join(dir, 'test', 'b.test.js'), '// b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

interface Rig {
  store: Store;
  sched: Scheduler;
  repo: string;
  scratch: string;
  /** How many reviewers were asked. */
  reviews: () => number;
  done: () => void;
}

/** A scheduler whose reviewer is a stub that passes and counts, so "no reviewer was called" can be told from "it passed". */
function rig(opts: SchedulerOptions = {}): Rig {
  const repo = fixtureRepo();
  const scratch = tmp('foreman-gateenv-');
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => {
      reviews++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
    ...opts,
  });
  return {
    store, sched, repo, scratch,
    reviews: () => reviews,
    done: () => {
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/**
 * A test command driven by a counter file: its n-th call does what line n of `plan` says.
 *  timeout     prints a passing test and ends `verify: TIMEOUT after 7s` (exit 124), npm's notices after it
 *  interrupted the same, with node:test's "Interrupted while running:" list before it
 *  hang        sleeps until killed
 *  fail:<rel>  one failing TAP test naming <rel> in the jail (exit 1)
 *  pass        exit 0
 */
function gateScript(scratch: string, plan: string[]): { cmd: string; calls: () => number } {
  const counter = path.join(scratch, 'calls');
  const planFile = path.join(scratch, 'plan');
  const script = path.join(scratch, 'gate.sh');
  fs.writeFileSync(planFile, plan.join('\n') + '\n');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `n=$(cat '${counter}' 2>/dev/null || echo 0)`,
    'n=$((n+1))',
    `echo "$n" > '${counter}'`,
    `mode=$(sed -n "\${n}p" '${planFile}')`,
    'case "$mode" in',
    '  timeout) echo "ok 1 - a passing test"; echo "verify: TIMEOUT after 7s"; echo "npm notice"; echo "npm notice New major version of npm available"; exit 124 ;;',
    '  interrupted) echo "✔ a passing test (1ms)"; echo "Interrupted while running:"; echo "⚠ test/a.test.js (test/a.test.js:1:1)"; echo "⚠ test/b.test.js (test/b.test.js:1:1)"; echo "verify: TIMEOUT after 7s"; exit 124 ;;',
    '  hang) echo "ok 1 - a passing test"; exec sleep 600 ;;',
    '  fail:*) echo "not ok 1 - ${mode#fail:}"; echo "  ---"; echo "  location: \'$PWD/${mode#fail:}:1:1\'"; echo "  ..."; echo "verify: FAIL (tests exited 1)"; exit 1 ;;',
    '  pass) echo "ok 1 - a passing test"; echo "verify: PASS"; exit 0 ;;',
    '  *) echo "gate.sh: no plan for call $n"; exit 3 ;;',
    'esac',
    '',
  ].join('\n'));
  return {
    cmd: `sh '${script}'`,
    calls: () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim()) : 0),
  };
}

const WORK = 'printf "changed\\n" > src.txt';
const logLines = (store: Store, taskId: string): string[] => store.eventsForTask(taskId).map((e) => e.message);

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- F3: colour switches ---------------------------------------------------------------------------------------------

/** A command whose CHILD process prints the number 5 with console.log: coloured when FORCE_COLOR reaches it. */
const CHILD_PRINTS_5 = `'${process.execPath}' -e "require('node:child_process').execFileSync(process.execPath, ['-e', 'console.log(5)'], { stdio: 'inherit' })"`;

test('F3: with FORCE_COLOR=1 in the daemon, a test command whose child prints console.log(5) produces the bare 5', HANG, async () => {
  const dir = tmp('foreman-gateenv-colour-');
  try {
    const result = await withEnv({ FORCE_COLOR: '1', CLICOLOR_FORCE: '1' }, () => runTests(dir, CHILD_PRINTS_5, new AbortController().signal));
    assert.equal(result.passed, true, result.output);
    assert.equal(result.output, '5');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: a test command sees none of the colour switches the daemon inherited, and one named in FOREMAN_TEST_KEEP_ENV is passed on', HANG, async () => {
  const dir = tmp('foreman-gateenv-colour-');
  const show = 'echo "F=[${FORCE_COLOR-unset}] N=[${NO_COLOR-unset}] C=[${CLICOLOR-unset}] CF=[${CLICOLOR_FORCE-unset}] D=[${NODE_DISABLE_COLORS-unset}] CT=[${COLORTERM-unset}]"';
  const all = { FORCE_COLOR: '3', NO_COLOR: '1', CLICOLOR: '1', CLICOLOR_FORCE: '1', NODE_DISABLE_COLORS: '1', COLORTERM: 'truecolor' };
  try {
    const scrubbed = await withEnv(all, () => runTests(dir, show, new AbortController().signal));
    assert.equal(scrubbed.output, 'F=[unset] N=[unset] C=[unset] CF=[unset] D=[unset] CT=[unset]');
    const kept = await withEnv({ ...all, FOREMAN_TEST_KEEP_ENV: 'NO_COLOR' }, () => runTests(dir, show, new AbortController().signal));
    assert.equal(kept.output, 'F=[unset] N=[1] C=[unset] CF=[unset] D=[unset] CT=[unset]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: a shell ticket\'s command gets the same colour environment, and still the rest of the daemon\'s', HANG, async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const t = await withEnv({ FORCE_COLOR: '1', FOREMAN_GATEENV_PLAIN: 'kept' }, async () => {
      const task = store.addTask({ title: 'colour', prompt: `${CHILD_PRINTS_5} && echo "plain=$FOREMAN_GATEENV_PLAIN"`, runner: 'shell' });
      await sched.drain(60_000);
      return task;
    });
    const lines = logLines(store, t.id);
    assert.ok(lines.includes('5'), `expected a bare 5 in the run's log, got: ${JSON.stringify(lines)}`);
    assert.ok(lines.includes('plain=kept'), 'an ordinary variable of the daemon still reaches the command');
  } finally {
    store.close();
  }
});

// --- F30: a gate timeout ---------------------------------------------------------------------------------------------

test('F30: timeout then pass — the gate is run once more, the work goes on to review, nothing is charged', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['timeout', 'pass']);
    const t = r.store.addTask({ title: 'slow gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 1 });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(gate.calls(), 2, 'one re-run');
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.equal(after.repairs, 0);
    assert.equal(after.attempts, 1);
    assert.equal(r.store.runsForTask(t.id).length, 1);
    assert.equal(r.store.latestRun(t.id)!.testsPassed, true);
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['pass'], 'the reviewer saw it; no fail verdict was written');
    const noted = r.store.eventsForTask(t.id).filter((e) => e.message === 'first gate run timed out, second passed');
    assert.ok(noted.some((e) => e.type === 'warning' && e.runId === r.store.latestRun(t.id)!.id), 'the note is on the run, in the timeline');
  } finally {
    r.done();
  }
});

test('F30: timeout twice — parked for a person with the note, no repair round, no verdict, no reviewer', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['timeout', 'interrupted', 'pass']);
    const t = r.store.addTask({ title: 'stalled gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 1 });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(gate.calls(), 2, 'at most one re-run per run');
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.match(after.error ?? '', /^gate timed out twice \(7 s each\); not charged to the worker/);
    assert.match(after.error ?? '', /started and not finished: test\/a\.test\.js, test\/b\.test\.js/);
    assert.match(after.error ?? '', /verify: TIMEOUT after 7s/, 'the end of the output is on the gate item');
    assert.equal(after.repairs, 0, 'no repair round');
    assert.equal(after.attempts, 1);
    assert.equal(r.store.runsForTask(t.id).length, 1);
    assert.equal(r.store.verdictsForTask(t.id).length, 0, 'no fail verdict');
    assert.equal(r.reviews(), 0, 'no reviewer called');
    const run = r.store.latestRun(t.id)!;
    assert.equal(run.testsPassed, false, 'a gate that never finished did not pass');
    assert.ok(hardHumanReason(after, run), 'the owner gate holds it');
  } finally {
    r.done();
  }
});

test('F30: timeout then a failing test — a failure as today', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['timeout', 'fail:test/b.test.js']);
    const t = r.store.addTask({ title: 'then red', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0 });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(gate.calls(), 2);
    assert.equal(after.status, 'failed');
    const verdicts = r.store.verdictsForTask(t.id);
    assert.deepEqual(verdicts.map((v) => v.verdict), ['fail']);
    assert.match(verdicts[0]!.critique ?? '', /the project's own tests failed[\s\S]*not ok 1 - test\/b\.test\.js/);
    assert.equal(r.store.latestRun(t.id)!.testsPassed, false);
  } finally {
    r.done();
  }
});

test('F30: a failing test is not re-run, and a pass is not re-run', HANG, async () => {
  const r = rig();
  try {
    const red = gateScript(r.scratch, ['fail:test/b.test.js', 'pass']);
    const t = r.store.addTask({ title: 'red', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: red.cmd, maxRepairs: 0 });
    await r.sched.drain(60_000);
    assert.equal(red.calls(), 1, 'a real failure is not run again');
    assert.equal(r.store.getTask(t.id)!.status, 'failed');
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['fail']);
  } finally {
    r.done();
  }
  const g = rig();
  try {
    const green = gateScript(g.scratch, ['pass', 'pass']);
    const t = g.store.addTask({ title: 'green', prompt: WORK, kind: 'code', runner: 'shell', repo: g.repo, testCmd: green.cmd });
    await g.sched.drain(60_000);
    assert.equal(green.calls(), 1);
    assert.equal(g.store.getTask(t.id)!.status, 'awaiting-approval');
    assert.ok(!logLines(g.store, t.id).some((l) => /timed out/.test(l)));
  } finally {
    g.done();
  }
});

test('F30: a command Foreman itself kills at FOREMAN_TEST_TIMEOUT_MIN is a timeout too: re-run once, and the pass stands', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['hang', 'pass']);
    // 0.005 min = 300 ms: the bound under test, not an assertion about how long anything took.
    const t = await withEnv({ FOREMAN_TEST_TIMEOUT_MIN: '0.005' }, async () => {
      const task = r.store.addTask({ title: 'hung gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 1 });
      await r.sched.drain(100_000);
      return task;
    });
    const after = r.store.getTask(t.id)!;
    assert.equal(gate.calls(), 2);
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.equal(after.repairs, 0);
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['pass']);
    assert.ok(logLines(r.store, t.id).includes('first gate run timed out, second passed'));
  } finally {
    r.done();
  }
});

const red = (output: string, extra: Partial<TestResult> = {}): TestResult => ({ ran: true, passed: false, cmd: 'x', output, ...extra });

test('F30: what counts as a gate timeout, and what does not', () => {
  assert.deepEqual(gateTimeout(red('ok 1 - a\nverify: TIMEOUT after 1200s\nnpm notice\nnpm notice New major version')), { seconds: 1200, by: 'command' });
  assert.deepEqual(gateTimeout(red('\x1b[31mverify: TIMEOUT after 20 min\x1b[39m\nforeman: this ran sandboxed (FOREMAN_SANDBOX=tests)')), { seconds: 1200, by: 'command' });
  assert.deepEqual(gateTimeout(red('TIMEOUT')), { seconds: null, by: 'command' });
  // Foreman's own kill, with what the dying suite printed after it.
  assert.deepEqual(
    gateTimeout(red('ok 1 - a\n✖ test/a.test.js (killed)\nforeman: test command timed out', { killedAfterSec: 1800, outputBeforeKill: 'ok 1 - a' })),
    { seconds: 1800, by: 'foreman' },
  );
  // A failing test named: a failure, whatever the last line says.
  assert.equal(gateTimeout(red('not ok 3 - parses a header\nverify: TIMEOUT after 1200s')), null);
  assert.equal(gateTimeout(red('✖ parses a header (2ms)\nverify: TIMEOUT after 1200s')), null);
  assert.equal(gateTimeout(red('not ok 1 - x', { killedAfterSec: 1800, outputBeforeKill: 'not ok 1 - x' })), null);
  // The word somewhere else is not the command's last word.
  assert.equal(gateTimeout(red('test: handles a TIMEOUT from the server\nverify: FAIL (tests exited 1)')), null);
  assert.equal(gateTimeout(red('verify: TIMEOUT after 5s\nverify: FAIL (typecheck exited 2)')), null);
  assert.equal(gateTimeout(red('the request timeout was 30s')), null);
  assert.equal(gateTimeout({ ran: true, passed: true, cmd: 'x', output: 'verify: TIMEOUT after 5s' }), null);
  // A skipped or todo TAP line is not a failing test.
  assert.deepEqual(gateTimeout(red('not ok 2 - later # TODO not yet\nverify: TIMEOUT after 9s')), { seconds: 9, by: 'command' });
});

test('F30: the tests a cut-short run had not finished are named when the output says, and "cannot tell" otherwise', () => {
  const spec = '✔ a (1ms)\nInterrupted while running:\n⚠ test/preview.test.ts (test/preview.test.ts:1:1)\n⚠ test/pty.test.ts (test/pty.test.ts:1:1)\nverify: TIMEOUT after 1200s';
  assert.deepEqual(unfinishedTests(spec), ['test/preview.test.ts', 'test/pty.test.ts']);
  const tap = 'TAP version 13\n# Subtest: test/a.test.js\nok 1 - test/a.test.js\n# Subtest: test/b.test.js\n    # Subtest: inner\n    ok 1 - inner';
  assert.deepEqual(unfinishedTests(tap), ['test/b.test.js']);
  assert.equal(unfinishedTests('typecheck…\ntests…\nverify: TIMEOUT after 1200s'), null);
  const t = { seconds: 1200, by: 'command' as const };
  assert.match(timedOutTwiceNote(t, t, spec, 1000), /^gate timed out twice \(1200 s each\); not charged to the worker — started and not finished: test\/preview\.test\.ts, test\/pty\.test\.ts\./);
  assert.match(timedOutTwiceNote(t, { seconds: 1800, by: 'foreman' }, 'tests…\nverify: TIMEOUT after 1200s', 1000), /^gate timed out twice \(1200 s, then 1800 s\); not charged to the worker — cannot tell which test did not finish\./);
  assert.ok(timedOutTwiceNote(t, t, `${'x'.repeat(5000)}\n${spec}`, 1000).length <= 1000);
});

// --- F31: a jail behind main -----------------------------------------------------------------------------------------

/** A worker's command: do the ticket's work, and (standing in for another ticket landing meanwhile) commit `files` on main. */
function workWhileMainMoves(repo: string, files: Record<string, string>): string {
  const writes = Object.entries(files).map(([rel, text]) => `printf '${text}\\n' > '${path.join(repo, rel)}'`).join(' && ');
  return `${WORK} && ${writes} && git -C '${repo}' add -A && git -C '${repo}' commit -qm 'main moves'`;
}

const BEHIND = /^jail is 1 commit behind main; 1 of them change test files: test\/a\.test\.js/;

test('F31: behind main with test changes, and the failure is in a file main changed — parked with the note, no repair round', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['fail:test/a.test.js', 'pass']);
    const t = r.store.addTask({
      title: 'stale jail', prompt: workWhileMainMoves(r.repo, { 'test/a.test.js': '// a, as main now has it' }),
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 1,
    });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.match(after.error ?? '', BEHIND);
    assert.match(after.error ?? '', /the failing tests may be ones main has since changed: compare before repairing/);
    assert.equal(after.repairs, 0, 'no repair round spent');
    assert.equal(gate.calls(), 1);
    assert.equal(r.store.runsForTask(t.id).length, 1);
    assert.equal(r.store.verdictsForTask(t.id).length, 0);
    assert.equal(r.reviews(), 0);
    const run = r.store.latestRun(t.id)!;
    assert.equal(run.testsPassed, false, 'the checks did fail, and the run says so');
    assert.ok(hardHumanReason(after, run), 'the owner gate holds it');
    assert.ok(logLines(r.store, t.id).some((l) => BEHIND.test(l)), 'and the line was logged before the tests ran');
  } finally {
    r.done();
  }
});

test('F31: behind main with test changes, but the failure is in a file main did not change — a normal repair, with the note first', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['fail:test/b.test.js', 'pass']);
    const t = r.store.addTask({
      title: 'own failure', prompt: workWhileMainMoves(r.repo, { 'test/a.test.js': '// a, as main now has it' }),
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0,
    });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'failed');
    const verdicts = r.store.verdictsForTask(t.id);
    assert.deepEqual(verdicts.map((v) => v.verdict), ['fail']);
    const critique = verdicts[0]!.critique ?? '';
    assert.match(critique, BEHIND, 'the failure note starts with the line');
    assert.match(critique.split('\n')[0]!, /; the failing tests may be ones main has since changed: compare before repairing$/);
    assert.match(critique, /the project's own tests failed[\s\S]*not ok 1 - test\/b\.test\.js/);
    assert.match(after.error ?? '', BEHIND, 'and so does what the gate shows for the failed ticket');
  } finally {
    r.done();
  }
});

test('F31: a repair round is what a failure in an unchanged file gets, and its notes to the worker start with the line', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['fail:test/b.test.js', 'pass']);
    const t = r.store.addTask({
      title: 'repaired', prompt: `test -f '${path.join(r.scratch, 'moved')}' && ${WORK} || (touch '${path.join(r.scratch, 'moved')}' && ${workWhileMainMoves(r.repo, { 'test/a.test.js': '// a, as main now has it' })})`,
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 1,
    });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.repairs, 1, 'the repair round was spent as today');
    assert.equal(gate.calls(), 2);
    assert.match(after.repairNotes ?? '', BEHIND);
    assert.equal(after.status, 'awaiting-approval');
  } finally {
    r.done();
  }
});

test('F31: not behind — no line, and a failure is a failure as today', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['fail:test/a.test.js', 'pass']);
    const t = r.store.addTask({ title: 'current jail', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0 });
    await r.sched.drain(60_000);
    assert.equal(r.store.getTask(t.id)!.status, 'failed');
    assert.ok(!logLines(r.store, t.id).some((l) => /behind main/.test(l)));
    assert.doesNotMatch(r.store.verdictsForTask(t.id)[0]!.critique ?? '', /behind main/);
  } finally {
    r.done();
  }
});

test('F31: behind and passing — the log line only', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['pass']);
    const t = r.store.addTask({
      title: 'stale but green', prompt: workWhileMainMoves(r.repo, { 'test/a.test.js': '// a, as main now has it' }),
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd,
    });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval');
    assert.doesNotMatch(after.error ?? '', /behind main/, 'nothing about it on the gate item');
    assert.equal(logLines(r.store, t.id).filter((l) => BEHIND.test(l)).length, 1);
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['pass']);
  } finally {
    r.done();
  }
});

test('F31: behind with no test change says so without a path, and a failure then carries no note', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['fail:test/a.test.js']);
    const t = r.store.addTask({
      title: 'main moved elsewhere', prompt: workWhileMainMoves(r.repo, { 'other.txt': 'unrelated' }),
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0,
    });
    await r.sched.drain(60_000);
    assert.ok(logLines(r.store, t.id).includes('jail is 1 commit behind main; 0 of them change test files'));
    assert.equal(r.store.getTask(t.id)!.status, 'failed');
    assert.doesNotMatch(r.store.verdictsForTask(t.id)[0]!.critique ?? '', /behind main/);
  } finally {
    r.done();
  }
});

test('F31: what main changed is counted per commit, and the gate\'s own script and skip lists count as test support', HANG, async () => {
  const repo = fixtureRepo();
  const jailDir = tmp('foreman-gateenv-jail-');
  fs.rmSync(jailDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.writeFileSync(path.join(repo, 'scripts', 'verify.sh'), 'exit 0\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { verify: 'bash scripts/verify.sh' } }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'gate script');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-q', '-b', 'jail', jailDir, base);
    const jail = { dir: jailDir, repo, branch: 'jail', baseCommit: base };
    assert.equal(await behindMain(jail, 'npm run verify --silent'), null, 'not behind');
    const commit = (rel: string, text: string): void => {
      fs.writeFileSync(path.join(repo, rel), text);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', `change ${rel}`);
    };
    commit('src.txt', 'one\n');
    commit('scripts/verify.sh', 'exit 1\n');
    commit('test-skips.txt', 'a\n');
    commit('test/b.test.js', '// b2\n');
    commit('test/b.test.js', '// b3\n');
    const behind = (await behindMain(jail, 'npm run verify --silent'))!;
    assert.deepEqual(behind, { commits: 5, testCommits: 4, testPaths: ['scripts/verify.sh', 'test-skips.txt', 'test/b.test.js'] });
    assert.equal(behindLine(behind), 'jail is 5 commits behind main; 4 of them change test files: scripts/verify.sh, test-skips.txt, test/b.test.js');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'read-only: the real repo is as it was');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(jailDir, { recursive: true, force: true });
  }
});

test('F31: failing test files are named from TAP and spec output, and not at all when the output names none', () => {
  const jail = '/tmp/jail-x';
  assert.deepEqual(failingTestFiles(`ok 1 - fine\nnot ok 2 - test/a.test.js\n  location: '${jail}/test/a.test.js:3:1'\nok 3 - test/b.test.js`, jail), ['test/a.test.js']);
  assert.deepEqual(
    failingTestFiles(`✔ fine (1ms)\n✖ failing tests:\n\ntest at test/sub/c.test.ts:10:3\n✖ parses (2ms)\n  at file://${jail}/src/x.ts:1:1`, jail),
    ['test/sub/c.test.ts'],
  );
  assert.equal(failingTestFiles('ok 1 - test/a.test.js\nverify: FAIL (typecheck exited 2)', jail), null);
  assert.equal(failingTestFiles('not ok 1 - parses a header', jail), null, 'a failing test with no file named');
  assert.equal(failingTestFiles('not ok 1 - x\n  at /somewhere/else/test/z.test.js:1:1', jail), null, 'a path outside the jail is not its test file');
});

// --- F42: nothing to change ------------------------------------------------------------------------------------------

test('F42: a code run that changes nothing skips the tests and every reviewer and parks with the note', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['pass', 'pass']);
    const t = r.store.addTask({ title: 'already done', prompt: 'echo "the work is already on main"', kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    const run = r.store.latestRun(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.equal(after.error, 'no change produced — approve to close as "nothing to change", or reject with what is missing. Worker said: shell command succeeded (1 lines)');
    assert.equal(r.store.verdictsForTask(t.id).filter((v) => v.runId === run.id).length, 0, 'zero rows in verdicts for the run');
    assert.equal(r.reviews(), 0, 'no reviewer called');
    assert.equal(gate.calls(), 0, 'no test command run');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.testsPassed, null);
    assert.ok(!r.store.artifactsForTask(t.id).some((a) => a.type === 'diff'));
    assert.ok(hardHumanReason(after, run), 'a person decides: the owner gate holds it');
  } finally {
    r.done();
  }
});

test('F42: approving it closes the ticket as "nothing to change" and merges nothing', HANG, async () => {
  const r = rig();
  try {
    const head = git(r.repo, 'rev-parse', 'HEAD');
    const t = r.store.addTask({ title: 'already done', prompt: 'true', kind: 'code', runner: 'shell', repo: r.repo });
    await r.sched.drain(60_000);
    assert.equal(r.store.getTask(t.id)!.status, 'awaiting-approval');
    const out = await applyApproval(r.store, t.id, {});
    assert.equal(out.task.status, 'done');
    assert.deepEqual({ merged: out.merge.merged, reason: out.merge.reason }, { merged: false, reason: 'closed: nothing to change' });
    assert.equal(git(r.repo, 'rev-parse', 'HEAD'), head, 'main did not move');
    assert.ok(logLines(r.store, t.id).includes('merge: closed: nothing to change'));
  } finally {
    r.done();
  }
});

test('F42: a worktree that gained a change after the park is not closed as "nothing to change": the landing refuses it', HANG, async () => {
  const r = rig();
  try {
    const head = git(r.repo, 'rev-parse', 'HEAD');
    const t = r.store.addTask({ title: 'already done', prompt: 'true', kind: 'code', runner: 'shell', repo: r.repo });
    await r.sched.drain(60_000);
    assert.equal(r.store.getTask(t.id)!.status, 'awaiting-approval');
    fs.writeFileSync(path.join(r.store.latestRun(t.id)!.worktreePath!, 'late.txt'), 'written after the park\n');
    const out = await applyApproval(r.store, t.id, {});
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^work changed after review/);
    assert.equal(out.task.status, 'awaiting-approval', 'not marked done');
    assert.equal(git(r.repo, 'rev-parse', 'HEAD'), head);
  } finally {
    r.done();
  }
});

test('F42: a worker\'s summary is cut to its last 600 characters on the gate item', () => {
  const note = nothingToChangeNote(`${'a'.repeat(900)}END`);
  assert.ok(note.startsWith('no change produced — approve to close as "nothing to change", or reject with what is missing. Worker said: a'));
  assert.equal(note.split('Worker said: ')[1]!.length, 600);
  assert.ok(note.endsWith('END'));
});

test('F42: a run that changed something is reviewed and tested as before', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, ['pass']);
    const t = r.store.addTask({ title: 'real change', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd });
    await r.sched.drain(60_000);
    assert.doesNotMatch(r.store.getTask(t.id)!.error ?? '', /no change produced/);
    assert.ok(r.store.artifactsForTask(t.id).some((a) => a.type === 'diff'));
    assert.equal(gate.calls(), 1);
    assert.equal(r.reviews(), 1);
  } finally {
    r.done();
  }
});

test('the three parks for a person stay a person\'s even when a verdict is written on the run afterwards', () => {
  const task = (error: string): Task => ({ gate: 'owner', sensitivity: 'S0', allowCore: false, playbook: null, repo: null, error } as unknown as Task);
  // What a re-review of the parked item would leave: a clean run with a pass on it.
  const run = { status: 'succeeded', testsPassed: null, verdict: 'pass' } as unknown as Run;
  const selfRoot = '/nonexistent/foreman';
  assert.equal(hardHumanReason(task(''), run, { selfRoot }), null, 'the rig: without a park note this run is the owner gate\'s');
  assert.match(
    hardHumanReason(task('no change produced — approve to close as "nothing to change", or reject with what is missing. Worker said: done'), run, { selfRoot }) ?? '',
    /produced no change/,
  );
  assert.match(hardHumanReason(task('core-guard: touches src/gate.ts | gate timed out twice (1200 s each); not charged to the worker — cannot tell'), run, { selfRoot }) ?? '', /timed out twice/);
  assert.match(
    hardHumanReason(task('the diff changed since the earlier approval — it needs approving again; jail is 2 commits behind main; 1 of them change test files: test/a.test.js'), run, { selfRoot }) ?? '',
    /main has changed/,
  );
});

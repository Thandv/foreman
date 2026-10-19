import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { hardHumanReason, reviewHolds } from '../src/gate.ts';
import { behindMain, gateTimeout, namesFailingTest, testCommandFiles } from '../src/verify/gateOutcome.ts';
import type { Run, Task } from '../src/types.ts';
import { runTests } from '../src/verify/tests.ts';

// Review round 2 on the gate-timeout / behind-main parks (test/gate-env.test.ts, test/gate-env-r1.test.ts): a red
// test that had scrolled out of the kept output when the run was cut short, a fetch from a remote the repo's
// config names, and a jail whose package.json is not a file. Then four things round 1's on-top says of itself that
// no test held (each survived as a mutant): "no change" is said of a code ticket only, it renames no older hold, the
// run clock starts again after the re-run, and a failure line counts at the start of a line only.

const HANG = { timeout: 120_000 };
const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const never = (): AbortSignal => new AbortController().signal;

/** A suite of `passing` green lines, the first of them preceded by `first` (a red test, or nothing), ending as `end` says. */
function longSuite(dir: string, first: string, passing: number, end: string): string {
  const script = path.join(dir, `suite-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(script, [
    first ? `echo "${first}"` : ':',
    `i=0; while [ $i -lt ${passing} ]; do echo "✔ passing $i (1ms)"; i=$((i+1)); done`,
    end,
    '',
  ].join('\n'));
  return `sh '${script}'`;
}
const SAYS_TIMEOUT = 'echo "verify: TIMEOUT after 7s"; exit 124';

test('a red test that scrolled out of the kept output is still a failure when the run then says TIMEOUT', HANG, async () => {
  const dir = tmp('foreman-gateenv-r2-');
  try {
    // 450 lines after the red one: the 400 kept lines no longer hold it.
    const red = await runTests(dir, longSuite(dir, '✖ a real failing test (3ms)', 450, SAYS_TIMEOUT), never());
    assert.doesNotMatch(red.output, /a real failing test/, 'the rig: the red line is not in the kept output');
    assert.equal(red.namedFailure, true);
    assert.equal(gateTimeout(red), null, 'a run that named a failing test is a failure, whatever its last line says');
    // The same suite with no red test is the timeout it says it is.
    const green = await runTests(dir, longSuite(dir, '', 450, SAYS_TIMEOUT), never());
    assert.equal(green.namedFailure, undefined);
    assert.deepEqual(gateTimeout(green), { seconds: 7, by: 'command' });
    // A passing run carries no such mark, whatever it printed on the way.
    const passed = await runTests(dir, longSuite(dir, '✖ printed by a test of a reporter', 5, 'exit 0'), never());
    assert.equal(passed.passed, true);
    assert.equal(passed.namedFailure, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same when Foreman itself kills the run at its bound: a red test printed long before the hang is a failure', HANG, async () => {
  const dir = tmp('foreman-gateenv-r2-');
  const before = process.env['FOREMAN_TEST_TIMEOUT_MIN'];
  process.env['FOREMAN_TEST_TIMEOUT_MIN'] = String(3 / 60);
  try {
    const red = await runTests(dir, longSuite(dir, '✖ a real failing test (3ms)', 450, 'exec sleep 60'), never());
    assert.equal(red.killedAfterSec, 3, 'the rig: Foreman killed it');
    assert.doesNotMatch(red.outputBeforeKill ?? '', /a real failing test/, 'the rig: the red line is not in the kept output');
    assert.equal(gateTimeout(red), null);
    const green = await runTests(dir, longSuite(dir, '', 450, 'exec sleep 60'), never());
    assert.deepEqual(gateTimeout(green), { seconds: 3, by: 'foreman' });
    // What a dying suite prints after the kill is still the kill's doing (test/gate-env-r1.test.ts), not a named failure.
    const dying = await runTests(dir, 'trap \'echo "✖ test/a.test.js (cancelled)"; exit 1\' TERM; echo "ok 1 - a"; sleep 600 & wait', never());
    assert.match(dying.output, /cancelled/, 'the rig: the line was printed, after the kill');
    assert.deepEqual(gateTimeout(dying), { seconds: 3, by: 'foreman' });
  } finally {
    if (before === undefined) delete process.env['FOREMAN_TEST_TIMEOUT_MIN'];
    else process.env['FOREMAN_TEST_TIMEOUT_MIN'] = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: a ticket whose suite fails a test early and then runs out of time is repaired, not parked as a timeout', HANG, async () => {
  const repo = tmp('foreman-gateenv-r2-repo-');
  const scratch = tmp('foreman-gateenv-r2-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'src.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => {
      reviews++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const counter = path.join(scratch, 'calls');
    const cmd = `echo x >> '${counter}'; ${longSuite(scratch, '✖ a real failing test (3ms)', 450, SAYS_TIMEOUT)}`;
    const t = store.addTask({ title: 'red and slow', prompt: 'date +%s%N >> src.txt', kind: 'code', runner: 'shell', repo, testCmd: cmd, maxRepairs: 0, maxAttempts: 1 });
    await sched.drain(60_000);
    const task = store.getTask(t.id)!;
    const run = store.latestRun(t.id)!;
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'a failure is not run again');
    assert.equal(task.status, 'failed', 'no repair round was allowed here, so the failure ends the ticket');
    assert.doesNotMatch(task.error ?? '', /timed out twice/);
    assert.equal(run.verdict, 'fail');
    assert.equal(run.testsPassed, false);
    assert.equal(reviews, 0);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('behindMain does not fetch a missing object from a remote the repo\'s config names', HANG, async () => {
  const dir = tmp('foreman-gateenv-r2-repo-');
  const scratch = tmp('foreman-gateenv-r2-');
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '// a\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const jailDir = path.join(scratch, 'jail');
    git(dir, ['worktree', 'add', '-q', '-b', 'jail', jailDir, base]);
    fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '// b\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'main changes a test']);
    const jail = { dir: jailDir, repo: dir, branch: 'jail', baseCommit: base };
    assert.deepEqual((await behindMain(jail, 'node --test'))?.testPaths, ['test/a.test.js'], 'the rig: main is ahead by a test change');

    // What a jail can write: the shared config, and (with the sandbox off) the shared object store.
    const marker = path.join(scratch, 'ran');
    const program = path.join(scratch, 'helper.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    for (const [key, value] of [
      ['remote.evil.url', `ext::${program} %S`], ['remote.evil.promisor', 'true'], ['remote.evil.partialclonefilter', 'blob:none'],
      ['protocol.ext.allow', 'always'], ['extensions.partialClone', 'evil'],
    ]) git(jailDir, ['config', key!, value!]);
    const tree = git(dir, ['rev-parse', 'HEAD:test']);
    fs.rmSync(path.join(dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    // The rig: a plain git that needs the tree does start the program.
    spawnSync('git', ['log', '--name-only', '--format=%H', `${base}..HEAD`], { cwd: dir, timeout: 60_000, killSignal: 'SIGKILL' });
    assert.ok(fs.existsSync(marker), 'the rig: git fetches the missing tree by running the program the config names');
    fs.rmSync(marker);

    await assert.rejects(behindMain(jail, 'node --test'), 'git cannot say, and the caller logs that');
    assert.ok(!fs.existsSync(marker), 'no program named by the repo\'s config was run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the test command\'s files are read from a jail whose package.json is a FIFO without waiting on it', HANG, (t) => {
  const dir = tmp('foreman-gateenv-r2-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { verify: 'bash scripts/verify.sh' } }));
  assert.deepEqual(testCommandFiles(dir, 'npm run verify'), ['scripts/verify.sh'], 'the rig: a real package.json names the gate script');

  fs.rmSync(path.join(dir, 'package.json'));
  execFileSync('/usr/bin/mkfifo', [path.join(dir, 'package.json')]);
  // In a child, killed at a bound: a read of the FIFO never returns, and would take this whole file with it.
  const url = new URL('../src/verify/gateOutcome.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { testCommandFiles } = await import(${JSON.stringify(url)}); console.log(JSON.stringify(testCommandFiles(${JSON.stringify(dir)}, 'npm run verify')));`,
  ], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  assert.equal(child.signal, null, 'the read came back (it was not killed at the 30 s bound)');
  assert.equal(child.stdout.trim(), '[]', child.stderr.slice(-300));
});

function fixtureRepo(): string {
  const repo = tmp('foreman-gateenv-r2-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'src.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

test('a reviewed ticket of another kind that changes nothing in its repo is not held as "no change"', HANG, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    for (const kind of ['writing', 'general', 'research'] as const) {
      const t = store.addTask({ title: `a ${kind} ticket`, prompt: 'echo "a report, and no file"', kind, runner: 'shell', repo, mergeOnApprove: false });
      await sched.drain(60_000);
      const task = store.getTask(t.id)!;
      assert.equal(store.latestRun(t.id)!.verdict, 'pass', `the rig: the ${kind} run was reviewed`);
      assert.equal(reviewHolds(store, t.id).noChange, false, kind);
      assert.equal(hardHumanReason({ ...task, gate: 'owner' }, store.latestRun(t.id), { ...reviewHolds(store, t.id), selfRoot: '/nonexistent/foreman' }), null, kind);
    }
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('the recorded "no change" hold renames none of the older holds: a run that failed, or was never reviewed, still says so', () => {
  const task = { id: 't', kind: 'code', repo: '/r', sensitivity: 'S0', gate: 'owner', error: null, playbook: null, allowCore: false } as unknown as Task;
  const run = (over: Partial<Run>): Run => ({ id: 'r', status: 'succeeded', testsPassed: null, verdict: 'pass', ...over }) as unknown as Run;
  const opts = { noChange: true, selfRoot: '/nonexistent/foreman' };
  assert.equal(hardHumanReason(task, run({ status: 'failed' }), opts), "the run ended 'failed', not in a clean pass");
  assert.equal(hardHumanReason(task, run({ testsPassed: false }), opts), 'the checks failed');
  assert.equal(hardHumanReason(task, run({ verdict: null }), opts), 'no review verdict was recorded — there is no green result to sign off');
  assert.match(hardHumanReason(task, run({}), opts) ?? '', /^the run produced no change/);
});

test('the run clock starts again after the re-run: a reviewer that never answers is still ended by the run deadline', HANG, async () => {
  const repo = fixtureRepo();
  const scratch = tmp('foreman-gateenv-r2-');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1, taskTimeoutMs: 5_000,
    verify: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('the review was cut short')), { once: true })),
  });
  try {
    // The first gate run says TIMEOUT at once, the second passes at once; then the review hangs.
    const counter = path.join(scratch, 'calls');
    const cmd = `echo x >> '${counter}'; if [ "$(wc -l < '${counter}')" -eq 1 ]; then echo "verify: TIMEOUT after 7s"; exit 124; fi; echo "ok 1 - a"`;
    const t = store.addTask({ title: 'stuck review', prompt: 'date +%s%N >> src.txt', kind: 'code', runner: 'shell', repo, testCmd: cmd, maxAttempts: 1 });
    // The bound: 5 s of run time against a wait that, with the clock left stopped, never ends (25 s here).
    await sched.drain(25_000).catch(() => {});
    const task = store.getTask(t.id)!;
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2, 'the rig: the gate was run twice');
    assert.ok(store.eventsForTask(t.id).some((e) => /first gate run timed out, second passed/.test(e.message)), 'the rig: and the second run passed');
    assert.ok(store.eventsForTask(t.id).some((e) => /the review was cut short/.test(e.message)), `the deadline never ended the review: still ${task.status} after 25 s`);
    assert.equal(task.status, 'awaiting-approval', 'and the work reaches the gate marked as unread');
    assert.match(task.error ?? '', /^UNREVIEWED/);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a passing test whose title quotes a failure line is not a failing test', () => {
  for (const line of [
    '✔ renders "✖ adds (1ms)" for a failed test (2ms)', 'ok 4 - prints "not ok 1 - x" when a test fails', '✔ reports error TS2322: Type mismatch (1ms)',
    '✔ the summary says "verify: FAIL (tests exited 1)" (3ms)', 'ok 7 - shows 2 failing in red',
  ]) assert.equal(namesFailingTest(line), false, line);
  for (const line of ['✖ adds (1ms)', '  ✖ adds (1ms)', 'not ok 1 - x', 'verify: FAIL (tests exited 1)', 'src/a.ts(3,1): error TS2322: Type mismatch']) {
    assert.equal(namesFailingTest(line), true, line);
  }
});

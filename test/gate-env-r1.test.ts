import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler, type SchedulerOptions } from '../src/scheduler.ts';
import { Broker } from '../src/budget.ts';
import { hardHumanReason, reviewHolds } from '../src/gate.ts';
import { collectDebrief, classifyFailure } from '../src/debrief.ts';
import { behindMain, failuresAllChangedOnMain, gateTimeout, namesFailingTest } from '../src/verify/gateOutcome.ts';
import type { TestResult } from '../src/verify/tests.ts';
import type { Task } from '../src/types.ts';
import { HandFiredDeadline } from './fakeclock.ts';

// Review round 1 on the gate-timeout / behind-main / nothing-to-change parks (test/gate-env.test.ts). What each test
// here holds is a path the first round left open: a hold that lived only in the park note, a `git log` that ran a
// program the repo's config names, a TIMEOUT line over a suite that had failed, a re-run charged to the run deadline,
// a "main changed it" park for a test file the ticket itself broke, and a debrief that no longer saw a gate timeout.

const HANG = { timeout: 120_000 };
const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (dir: string, args: string[], input?: string): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }).trim();

function fixtureRepo(): string {
  const dir = tmp('foreman-gateenv-r1-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), '// a\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

interface Rig { store: Store; sched: Scheduler; repo: string; scratch: string; reviews: () => number; done: () => Promise<void> }

/** A scheduler whose reviewer is a stub: its first answer is provisional when `provisionalFirst`, every other a plain pass. */
function rig(opts: SchedulerOptions & { provisionalFirst?: boolean } = {}): Rig {
  const repo = fixtureRepo();
  const scratch = tmp('foreman-gateenv-r1-');
  const store = new Store(':memory:');
  let reviews = 0;
  const { provisionalFirst, ...rest } = opts;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    broker: new Broker(store, { guardResidency: false, fitsFn: async () => true }),
    verify: async ({ task, runId }) => {
      reviews++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: Boolean(provisionalFirst) && reviews === 1 });
    },
    ...rest,
  });
  return {
    store, sched, repo, scratch,
    reviews: () => reviews,
    done: async () => {
      await sched.stop();
      store.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** A test command whose n-th call runs the n-th list of shell lines. */
function gateScript(scratch: string, plan: string[][]): { cmd: string; calls: () => number } {
  const counter = path.join(scratch, 'calls');
  const script = path.join(scratch, 'gate.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `n=$(cat '${counter}' 2>/dev/null || echo 0)`,
    'n=$((n+1))',
    `echo "$n" > '${counter}'`,
    'case "$n" in',
    ...plan.map((lines, i) => `  ${i + 1}) ${lines.join('; ')} ;;`),
    '  *) echo "gate.sh: no plan for call $n"; exit 3 ;;',
    'esac',
    '',
  ].join('\n'));
  return { cmd: `sh '${script}'`, calls: () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim()) : 0) };
}

const TIMEOUT = ['echo "ok 1 - a passing test"', 'echo "verify: TIMEOUT after 7s"', 'exit 124'];
const PASS = ['echo "ok 1 - a passing test"', 'exit 0'];
const WORK = 'date +%s%N >> src.txt';

/** The scheduler's own ticks with the provisional re-check switched on, as a daemon left idle would run them. */
async function idleTicks(sched: Scheduler): Promise<void> {
  process.env['FOREMAN_RECHECK_MS'] = '0';
  try {
    for (let i = 0; i < 8; i++) {
      await sched.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    delete process.env['FOREMAN_RECHECK_MS'];
  }
}

/** What the owner gate asks before any model call, of this ticket as one that opted in to the owner gate. */
const ownerHold = (store: Store, task: Task): string | null =>
  hardHumanReason({ ...task, gate: 'owner' }, store.latestRun(task.id), { ...reviewHolds(store, task.id), selfRoot: '/nonexistent/foreman' });

// The tickets below are created with the gate left to the human, so no scheduler here can ever call an owner model;
// the hold is asked of the same ticket as an opted-in one (ownerHold).

test('a gate that timed out twice stays a person\'s after a re-check has written a pass and cleared the park note', HANG, async () => {
  for (const mergeOnApprove of [false, true]) {
    const r = rig({ provisionalFirst: true });
    try {
      // Run 1 is reviewed by stepped-down models (provisional) and sent back; run 2's gate times out twice.
      const gate = gateScript(r.scratch, [PASS, TIMEOUT, TIMEOUT]);
      const t = r.store.addTask({ title: 'stalled gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, mergeOnApprove });
      await r.sched.drain(60_000);
      r.store.retry(t.id, 'one more thing');
      await r.sched.drain(60_000);
      const parked = r.store.getTask(t.id)!;
      assert.match(parked.error ?? '', /^gate timed out twice/);
      assert.equal(r.store.latestRun(t.id)!.testsPassed, false, 'a gate that never finished did not pass, and the run says so');
      // The task's newest verdict is still run 1's provisional one. The idle re-check used to pick the ticket up on
      // that and review run 2; it no longer does (the follow-ups batch): the run's checks did not pass, so it waits.
      await idleTicks(r.sched);
      assert.equal(r.store.latestRun(t.id)!.verdict, null, 'the idle re-check did not review the parked run');
      assert.equal(r.reviews(), 1, 'no reviewer was called for it');
      assert.match(r.store.getTask(t.id)!.error ?? '', /^gate timed out twice/);
      assert.equal(r.store.getTask(t.id)!.repairs, 0);
      // A pass can still be written on it — a person asks for a re-review — and the note can still go.
      await r.sched.reverify(t.id);
      r.store.setStatus(t.id, 'awaiting-approval', null);
      await idleTicks(r.sched);
      const later = r.store.getTask(t.id)!;
      const run = r.store.latestRun(t.id)!;
      assert.equal(run.verdict, 'pass', 'the rig: a re-review wrote a pass on the run whose gate never finished');
      assert.doesNotMatch(later.error ?? '', /timed out/, 'the rig: and the note that held it is gone');
      assert.equal(later.status, 'awaiting-approval');
      assert.equal(ownerHold(r.store, later), 'the checks failed', `mergeOnApprove=${mergeOnApprove}`);
    } finally {
      await r.done();
    }
  }
});

test('a run that changed nothing stays a person\'s after a re-check has written a pass and cleared the park note', HANG, async () => {
  const r = rig({ provisionalFirst: true });
  try {
    const marker = path.join(r.scratch, 'second');
    // Run 1 changes a file and is reviewed provisionally; sent back, run 2 changes nothing.
    const t = r.store.addTask({
      title: 'already done', prompt: `test -f '${marker}' || (touch '${marker}' && ${WORK})`,
      kind: 'code', runner: 'shell', repo: r.repo, mergeOnApprove: false,
    });
    await r.sched.drain(60_000);
    r.store.retry(t.id);
    r.store.db.prepare('UPDATE tasks SET carry_run = NULL WHERE id = ?').run(t.id);
    await r.sched.drain(60_000);
    const parked = r.store.getTask(t.id)!;
    assert.match(parked.error ?? '', /^no change produced/);
    // Not picked up by the idle re-check on run 1's provisional verdict (the follow-ups batch); a person's
    // re-review still writes a pass on it, and the note can still go.
    await idleTicks(r.sched);
    assert.equal(r.store.latestRun(t.id)!.verdict, null, 'the idle re-check did not review the run that changed nothing');
    assert.equal(r.reviews(), 1);
    await r.sched.reverify(t.id);
    r.store.setStatus(t.id, 'awaiting-approval', null);
    await idleTicks(r.sched);
    const later = r.store.getTask(t.id)!;
    assert.equal(r.store.latestRun(t.id)!.verdict, 'pass', 'the rig: a pass was written on the run, from its summary alone');
    assert.doesNotMatch(later.error ?? '', /no change produced/, 'the rig: and the note is gone');
    assert.match(ownerHold(r.store, later) ?? '', /^the run produced no change/);
  } finally {
    await r.done();
  }
});

test('reviewHolds: "no change" is a code ticket in a repo whose latest run recorded no diff, and nothing else', HANG, async () => {
  const r = rig();
  try {
    const changed = r.store.addTask({ title: 'changed', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, mergeOnApprove: false });
    await r.sched.drain(60_000);
    assert.equal(reviewHolds(r.store, changed.id).noChange, false);
    assert.equal(ownerHold(r.store, r.store.getTask(changed.id)!), null, 'a reviewed change on a ticket that does not land is still the owner gate\'s');
    const prose = r.store.addTask({ title: 'prose', prompt: 'echo hello', kind: 'general', runner: 'shell' });
    await r.sched.drain(60_000);
    assert.equal(reviewHolds(r.store, prose.id).noChange, false, 'a ticket with no repo has no diff to miss');
  } finally {
    await r.done();
  }
});

test('behindMain does not run the program the repo\'s config names for signatures', HANG, async () => {
  const repo = fixtureRepo();
  const scratch = tmp('foreman-gateenv-r1-');
  const jailDir = path.join(scratch, 'jail');
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['worktree', 'add', '-q', '-b', 'jail', jailDir, base]);
    // Main moves by one commit that carries a signature header, as a signed commit or a landed branch can.
    fs.writeFileSync(path.join(repo, 'test', 'a.test.js'), '// a, on main\n');
    git(repo, ['add', '-A']);
    const tree = git(repo, ['write-tree']);
    const who = 'Test <test@example.com> 1700000000 +0000';
    const commit = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'],
      `tree ${tree}\nparent ${base}\nauthor ${who}\ncommitter ${who}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n`);
    git(repo, ['reset', '-q', '--hard', commit]);
    // What a worker can write from its jail: the repo's own config.
    const marker = path.join(scratch, 'ran');
    const program = path.join(scratch, 'gpg.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(jailDir, ['config', 'log.showSignature', 'true']);
    git(jailDir, ['config', 'gpg.program', program]);
    // The rig: with that config, a plain `git log` over the same range does start the program.
    git(repo, ['log', '--format=%H', `${base}..HEAD`]);
    assert.ok(fs.existsSync(marker), 'the rig: git log runs gpg.program for this commit under this config');
    fs.rmSync(marker);
    const behind = await behindMain({ dir: jailDir, repo, branch: 'jail', baseCommit: base }, 'node --test');
    assert.deepEqual(behind, { commits: 1, testCommits: 1, testPaths: ['test/a.test.js'] });
    assert.ok(!fs.existsSync(marker), 'behindMain started the program the repo config names as gpg.program');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

const red = (output: string, extra: Partial<TestResult> = {}): TestResult => ({ ran: true, passed: false, cmd: 'x', output, ...extra });

const FAILURES: Array<[string, string]> = [
  ['pytest', 'FAILED tests/test_x.py::test_adds - AssertionError: 1 != 2\n1 failed, 3 passed in 0.10s'],
  ['pytest summary bar', '=========== 2 failed, 1 passed in 1.20s ==========='],
  ['cargo', 'test tests::adds ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored'],
  ['go', '--- FAIL: TestAdds (0.00s)\nFAIL\nexit status 1'],
  ['jest', 'FAIL src/a.test.js\n  ● adds\nTests:       1 failed, 2 passed, 3 total'],
  ['vitest', ' × adds 2ms\n Test Files  1 failed (1)'],
  ['mocha', '  1) adds\n\n  1 failing'],
  ['tsc', 'src/a.ts(1,1): error TS2322: Type \'string\' is not assignable to type \'number\'.'],
  ['node:test closing count, the ✖ lines scrolled out', 'ℹ tests 9\nℹ pass 6\nℹ fail 3'],
  ['node:test TAP closing count', '# tests 9\n# pass 6\n# fail 3'],
  ['a gate script\'s own verdict', 'verify: FAIL (tests exited 1)'],
];

test('a TIMEOUT line never turns a run that says it failed into a gate timeout, in any of the common runners', () => {
  for (const [runner, output] of FAILURES) {
    assert.equal(namesFailingTest(output), true, runner);
    assert.equal(gateTimeout(red(`${output}\nverify: TIMEOUT after 1200s\nnpm notice`)), null, `${runner}: said by the command`);
    assert.equal(gateTimeout(red(`${output}\nforeman: test command timed out`, { killedAfterSec: 1800, outputBeforeKill: output })), null, `${runner}: killed by Foreman`);
  }
  // The symmetric half: a run that timed out and says nothing of a failure is still a timeout.
  const passing = [
    '✔ a passing test (1ms)\n✔ FAIL is shown in red when a check fails (2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0',
    'tests/test_x.py ....\n4 passed in 0.10s',
    'test tests::adds ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored',
    '--- PASS: TestAdds (0.00s)\nPASS\nok  \tpkg\t0.2s',
    'PASS src/a.test.js\nTests:       3 passed, 3 total',
    '  3 passing (12ms)',
    'typecheck…\ntests…\nInterrupted while running:\n⚠ test/pty.test.ts (test/pty.test.ts:1:1)',
    '# tests 9\n# pass 9\n# fail 0\nok 4 - reports error TS2322: lines of the compiler # SKIP needs tsc',
    '✔ reports error TS2322: bad (1ms)\n✔ the summary says 3 failed, 1 passed in 0.5s (1ms)\n✔ prints FAILED tests/x.py and --- FAIL: TestA (0ms)',
  ];
  for (const output of passing) {
    assert.equal(namesFailingTest(output), false, output);
    assert.deepEqual(gateTimeout(red(`${output}\nverify: TIMEOUT after 1200s`)), { seconds: 1200, by: 'command' }, output);
  }
});

test('a real failure under a TIMEOUT line is repaired as a failure: no re-run, a fail verdict, the checks recorded as failed', HANG, async () => {
  const r = rig();
  try {
    const failed = ['echo "FAILED tests/test_x.py::test_adds - AssertionError"', 'echo "1 failed, 3 passed in 0.10s"', 'echo "verify: TIMEOUT after 1s"', 'exit 1'];
    const gate = gateScript(r.scratch, [failed, failed]);
    const t = r.store.addTask({ title: 'red', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0 });
    await r.sched.drain(60_000);
    assert.equal(gate.calls(), 1, 'a failure is not run again');
    assert.equal(r.store.getTask(t.id)!.status, 'failed');
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['fail']);
    assert.equal(r.store.latestRun(t.id)!.testsPassed, false);
  } finally {
    await r.done();
  }
});

test('the re-run of a timed-out gate is not charged to the run deadline', HANG, async () => {
  // The run has 6 s. Its first gate run "times out" at once; the second takes 7 s and passes. Charged to the run,
  // the deadline comes during the second run (7 s > 6 s, whatever the machine is doing) and the attempt is lost.
  const r = rig({ taskTimeoutMs: 6_000 });
  try {
    const gate = gateScript(r.scratch, [TIMEOUT, ['echo "ok 1 - a passing test"', 'sleep 7', 'exit 0']]);
    const t = r.store.addTask({ title: 'slow gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxAttempts: 1 });
    await r.sched.drain(100_000);
    const after = r.store.getTask(t.id)!;
    const run = r.store.latestRun(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.equal(gate.calls(), 2);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.testsPassed, true);
    assert.equal(after.attempts, 1);
    assert.ok(!r.store.eventsForTask(t.id).some((e) => /run deadline/.test(e.message)));
  } finally {
    await r.done();
  }
});

test('the first gate run is still the run\'s own time: only the re-run stops the clock', HANG, async () => {
  // A run whose one gate run is still going when its deadline comes (fired by hand, once the gate has begun): the
  // deadline comes during it, as before.
  const deadline = new HandFiredDeadline();
  const r = rig({ runClock: deadline.clock });
  try {
    const gate = gateScript(r.scratch, [['echo "ok 1 - a passing test"', 'sleep 60', 'exit 0'], PASS]);
    const t = r.store.addTask({ title: 'slow first run', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxAttempts: 1 });
    const drained = r.sched.drain(100_000);
    // The gate script writes its call count as it starts.
    while (!fs.existsSync(path.join(r.scratch, 'calls'))) await new Promise((res) => setTimeout(res, 10));
    deadline.expire();
    await drained;
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'failed');
    assert.match(after.error ?? '', /run deadline \([\d.]+ min\) reached during test/);
    assert.equal(gate.calls(), 1);
  } finally {
    await r.done();
  }
});

test('a failing test file the ticket itself changed is the ticket\'s to repair, even when main changed it too', HANG, async () => {
  const behind = { commits: 1, testCommits: 1, testPaths: ['test/a.test.js'] };
  const output = 'not ok 1 - test/a.test.js\n  ---\n  location: \'/jail/test/a.test.js:1:1\'\n  ...';
  assert.equal(failuresAllChangedOnMain(output, '/jail', behind), true);
  assert.equal(failuresAllChangedOnMain(output, '/jail', behind, ['src.txt']), true, 'the ticket changed something else');
  assert.equal(failuresAllChangedOnMain(output, '/jail', behind, ['test/a.test.js']), false, 'the ticket changed the failing file');

  const r = rig();
  try {
    const fail = ['echo "not ok 1 - test/a.test.js"', 'echo "  ---"', 'echo "  location: \'$PWD/test/a.test.js:1:1\'"', 'echo "  ..."', 'exit 1'];
    const gate = gateScript(r.scratch, [fail, PASS]);
    const mainMoves = `printf '// a, on main\\n' > '${path.join(r.repo, 'test', 'a.test.js')}' && git -C '${r.repo}' commit -qam 'main moves'`;
    const t = r.store.addTask({
      title: 'breaks a test', prompt: `echo 'throw new Error("broken")' > test/a.test.js && ${mainMoves}`,
      kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0,
    });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'failed', 'not parked as "main changed it"');
    const verdicts = r.store.verdictsForTask(t.id);
    assert.deepEqual(verdicts.map((v) => v.verdict), ['fail']);
    assert.match(verdicts[0]!.critique ?? '', /^jail is 1 commit behind main; 1 of them change test files: test\/a\.test\.js/, 'the note still leads the failure');
  } finally {
    await r.done();
  }
});

test('the debrief counts a gate timeout from the scheduler\'s own notes: timed out twice, and timed out then passed', HANG, async () => {
  assert.deepEqual(
    [classifyFailure('gate timed out twice (1200 s each); not charged to the worker — cannot tell')?.cause, classifyFailure('gate timed out twice (1200 s, then 1800 s); not charged')?.n],
    ['gate-timeout', 1200],
  );
  assert.equal(classifyFailure('gate timed out twice (time not stated each); not charged to the worker')?.cause, 'gate-timeout');
  assert.equal(classifyFailure('first gate run timed out, second passed')?.cause, 'gate-timeout');
  assert.equal(classifyFailure('the project\'s own tests failed (npm test):\nverify: TIMEOUT after 1200s')?.cause, 'gate-timeout', 'the older wording, in a fail verdict');

  const r = rig();
  try {
    const twice = gateScript(r.scratch, [TIMEOUT, TIMEOUT]);
    const a = r.store.addTask({ title: 'twice', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: twice.cmd });
    await r.sched.drain(60_000);
    const one = collectDebrief(r.store, a.id).tickets[0]!;
    assert.deepEqual(one.failures.map((f) => [f.cause, f.n, f.runId]), [['gate-timeout', 7, r.store.latestRun(a.id)!.id]]);
    assert.equal(one.runs[0]!.status, 'succeeded', 'the rig: the run that met the timeout ended succeeded, so only the note says it');
    assert.ok(!one.landing.notes.some((n) => /timed out/.test(n)), 'a test-stage note is not a landing note');

    fs.rmSync(path.join(r.scratch, 'calls'));
    const once = gateScript(r.scratch, [TIMEOUT, PASS]);
    const b = r.store.addTask({ title: 'once', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: once.cmd });
    await r.sched.drain(60_000);
    const doc = collectDebrief(r.store, b.id);
    assert.deepEqual(doc.tickets[0]!.failures.map((f) => f.cause), ['gate-timeout']);
    assert.ok(doc.signals.some((s) => s.kind === 'failure:gate-timeout'), JSON.stringify(doc.signals.map((s) => s.kind)));
  } finally {
    await r.done();
  }
});

// --- conditions of the first round that no test of its own held (each survived its mutant) -----------------------------

test('only a CODE ticket parks as "nothing to change": another kind in a repo that changes nothing is still tested and reviewed', HANG, async () => {
  const r = rig();
  try {
    const gate = gateScript(r.scratch, [PASS]);
    const t = r.store.addTask({ title: 'a report', prompt: 'echo "the report: nothing is wrong"', kind: 'general', runner: 'shell', repo: r.repo, testCmd: gate.cmd });
    await r.sched.drain(60_000);
    const after = r.store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.doesNotMatch(after.error ?? '', /no change produced/);
    assert.equal(gate.calls(), 1, 'its test command ran');
    assert.equal(r.reviews(), 1, 'and a reviewer read its report');
  } finally {
    await r.done();
  }
});

test('"closed: nothing to change" is said only of a run with no diff whose branch the landing found empty', HANG, async () => {
  const { applyApproval } = await import('../src/gate.ts');
  // A run that changed nothing on a ticket that does not land: the reason is the landing's own.
  const a = rig();
  try {
    const t = a.store.addTask({ title: 'no landing', prompt: 'true', kind: 'code', runner: 'shell', repo: a.repo, mergeOnApprove: false });
    await a.sched.drain(60_000);
    assert.match(a.store.getTask(t.id)!.error ?? '', /^no change produced/);
    const out = await applyApproval(a.store, t.id, {});
    assert.match(out.merge.reason, /^merge-on-approve disabled/);
    assert.equal(out.task.status, 'done');
  } finally {
    await a.done();
  }
  // A run that DID change something, whose commit a person has already taken into main by hand: the landing finds
  // nothing ahead, and that is not "nothing to change".
  const b = rig();
  try {
    const t = b.store.addTask({ title: 'landed by hand', prompt: WORK, kind: 'code', runner: 'shell', repo: b.repo });
    await b.sched.drain(60_000);
    const run = b.store.latestRun(t.id)!;
    assert.ok(b.store.artifactsForTask(t.id).some((x) => x.type === 'diff' && x.runId === run.id));
    git(run.worktreePath!, ['add', '-A']);
    git(run.worktreePath!, ['-c', 'user.email=p@example.com', '-c', 'user.name=Person', 'commit', '-qm', 'by hand']);
    git(b.repo, ['merge', '-q', '--ff-only', run.branch!]);
    const out = await applyApproval(b.store, t.id, {});
    assert.equal(out.merge.merged, false);
    assert.equal(out.merge.reason, 'branch has no commits ahead of HEAD');
  } finally {
    await b.done();
  }
});

test('one failing test file main did not change is enough for a normal repair', () => {
  const behind = { commits: 2, testCommits: 1, testPaths: ['test/a.test.js'] };
  const both = 'not ok 1 - test/a.test.js\n  ---\n  location: \'/jail/test/a.test.js:1:1\'\n  ...\nnot ok 2 - test/b.test.js\n  ---\n  location: \'/jail/test/b.test.js:1:1\'\n  ...';
  assert.equal(failuresAllChangedOnMain(both, '/jail', behind), false);
  assert.equal(failuresAllChangedOnMain(both, '/jail', { ...behind, testPaths: ['test/a.test.js', 'test/b.test.js'] }), true);
});

test('what a suite prints while Foreman is killing it at the bound does not make the timeout a failing test', HANG, async () => {
  const r = rig();
  const before = process.env['FOREMAN_TEST_TIMEOUT_MIN'];
  try {
    // node:test reports the tests it was cut off in as failed (✖) when it is told to stop; so does this stand-in.
    const dying = ['echo "ok 1 - a passing test"', 'trap \'echo "✖ test/a.test.js (cancelled)"; exit 1\' TERM', 'sleep 600 & wait'];
    const gate = gateScript(r.scratch, [dying, PASS]);
    process.env['FOREMAN_TEST_TIMEOUT_MIN'] = '0.005'; // 300 ms: the bound under test
    const t = r.store.addTask({ title: 'killed gate', prompt: WORK, kind: 'code', runner: 'shell', repo: r.repo, testCmd: gate.cmd, maxRepairs: 0 });
    await r.sched.drain(100_000);
    const after = r.store.getTask(t.id)!;
    assert.ok(r.store.eventsForTask(t.id).some((e) => e.message === 'test: ✖ test/a.test.js (cancelled)'), 'the rig: the dying suite did print a ✖ line');
    assert.equal(gate.calls(), 2, 'a timeout: run once more');
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.deepEqual(r.store.verdictsForTask(t.id).map((v) => v.verdict), ['pass']);
  } finally {
    if (before === undefined) delete process.env['FOREMAN_TEST_TIMEOUT_MIN'];
    else process.env['FOREMAN_TEST_TIMEOUT_MIN'] = before;
    await r.done();
  }
});

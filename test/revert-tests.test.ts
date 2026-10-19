import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { onOff } from '../src/config.ts';
import { jailTree } from '../src/isolate.ts';
import {
  parseTap, readRevertTests, recordRevertTests, revertTestsApplies, revertTestsCheck, revertTestsNote, revertTestsPath,
  type RevertRunResult, type RevertTestsOptions, type RevertTestsResult,
} from '../src/verify/revertTests.ts';
import { runTests } from '../src/verify/tests.ts';
import { Store } from '../src/queue.ts';
import * as sbx from '../src/security/sandbox.ts';

/**
 * The per-test revert check (src/verify/revertTests.ts), on fixture repos with real `node --test` runs at the base:
 * which tests a diff adds or changes, what each does with the src change put back, and that the check decides
 * nothing it was not asked to and fails to `could-not-run`, never to a clean result.
 */

// A `node --test` started from inside this file would otherwise think it is a nested run and execute nothing.
delete process.env['NODE_TEST_CONTEXT'];

const T = { timeout: 300_000 };
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const HEAD = "import test, { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as x from '../src/x.js';\n";
const SRC_BASE = 'export const double = (n) => n + n;\n';
const SRC_AFTER = 'export const double = (n) => n + n;\nexport const triple = (n) => 3 * n;\nexport const ready = true;\n';

interface Fixture { root: string; repo: string; jail: string; base: string; workRoot: string }

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function fixture(t: TestContext, base: Record<string, string> = {}, script = 'node --test "test/*.test.js"'): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  write(repo, {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: script } }),
    '.gitignore': 'node_modules/\n',
    'README.md': '# fixture\n',
    'src/x.js': SRC_BASE,
    ...base,
  });
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  return { root, repo, jail, base: sh(repo, 'rev-parse', 'HEAD').trim(), workRoot: path.join(root, 'work') };
}

/** A runner like the scheduler's: the real test command, every line kept. */
const realRun = (calls: string[] = [], limits: number[] = []) => async (dir: string, cmd: string, timeoutMs: number): Promise<RevertRunResult> => {
  calls.push(cmd);
  limits.push(timeoutMs);
  const lines: string[] = [];
  const r = await runTests(dir, cmd, new AbortController().signal, (l) => lines.push(l), undefined, { timeoutMs });
  return { passed: r.passed, timedOut: r.killedAfterSec !== undefined, refused: r.refused === true, output: lines.join('\n') };
};

async function check(f: Fixture, change: Record<string, string>, over: Partial<RevertTestsOptions> = {}): Promise<RevertTestsResult> {
  write(f.jail, change);
  const tree = await jailTree(f.jail);
  const res = await revertTestsCheck({ repo: f.repo, base: f.base, tree, workRoot: f.workRoot, runId: 'r1', run: realRun(), ...over });
  assert.ok(res, 'not aborted');
  return res;
}

const row = (r: RevertTestsResult, name: string) => {
  const hit = r.tests.filter((t) => t.name === name);
  assert.equal(hit.length, 1, `one row named ${JSON.stringify(name)} in ${JSON.stringify(r.tests.map((t) => t.name))}`);
  return hit[0]!;
};

const noScratch = (f: Fixture): void => {
  assert.doesNotMatch(sh(f.repo, 'worktree', 'list'), /revert-tests-/, 'the scratch worktree is gone from git');
  assert.deepEqual(fs.existsSync(f.workRoot) ? fs.readdirSync(f.workRoot) : [], [], 'and from disk');
};

// ------------------------------------------------------------------ per test, not per file

test('one meaningful and one vacuous new test in the SAME file are reported apart: the vacuous one passes without the change', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/new.test.js': `${HEAD}test('triples', () => assert.equal(x.triple?.(2), 6));\ntest('still doubles', () => assert.equal(x.double(2), 4));\n`,
  });
  assert.equal(res.status, 'ran');
  assert.equal(res.tests.length, 2);
  const real = row(res, 'triples');
  assert.equal(real.outcome, 'fails-without-change');
  assert.match(real.detail, /6|undefined|triple/, 'with its first failure line');
  assert.equal(real.change, 'added');
  assert.equal(real.line, 4);
  const vacuous = row(res, 'still doubles');
  assert.equal(vacuous.outcome, 'passes-without-change');
  assert.equal(vacuous.detail, '');
  noScratch(f);
});

test('only the tests the diff adds or changes are run: an untouched neighbour gets no row, a changed one does', T, async (t) => {
  const f = fixture(t, {
    'test/a.test.js': `${HEAD}test('kept as it was', () => assert.equal(x.double(1), 2));\ntest('edited', () => assert.equal(x.double(3), 6));\n`,
  });
  const calls: string[] = [];
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('kept as it was', () => assert.equal(x.double(1), 2));\ntest('edited', () => assert.equal(x.triple?.(3), 9));\n`,
  }, { run: realRun(calls) });
  assert.deepEqual(res.tests.map((r) => [r.name, r.change, r.outcome]), [['edited', 'changed', 'fails-without-change']]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /--test-name-pattern='\^edited\$'/, 'filtered to the changed test');
});

test('a renamed test counts as changed, and says it was renamed', T, async (t) => {
  const f = fixture(t, {
    'test/a.test.js': `${HEAD}test('old name', () => {\n  assert.equal(x.double(2), 4);\n});\n`,
  });
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('new name', () => {\n  assert.equal(x.double(2), 4);\n});\n`,
  });
  assert.deepEqual(res.tests.map((r) => [r.name, r.change, r.outcome]), [['new name', 'renamed', 'passes-without-change']]);
});

test('a subtest added to an existing test is its own row, run through its parent', T, async (t) => {
  const f = fixture(t, {
    'test/a.test.js': `${HEAD}test('parent', async (t) => {\n  await t.test('old sub', () => assert.equal(x.double(1), 2));\n});\n`,
  });
  const calls: string[] = [];
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('parent', async (t) => {\n  await t.test('old sub', () => assert.equal(x.double(1), 2));\n  await t.test('new sub', () => assert.equal(x.triple?.(1), 3));\n});\n`,
  }, { run: realRun(calls) });
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]), [['parent > new sub', 'fails-without-change']]);
  assert.match(calls[0]!, /--test-name-pattern='\^parent\$'/, 'the parent is what the filter names');
});

test('describe-nested names, and every case a changed table generates, one row each', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}describe('maths (x)', () => {\n  it('triples', () => assert.equal(x.triple?.(2), 6));\n});\nfor (const n of [1, 2]) {\n  test(\`doubles \${n}\`, () => assert.equal(x.double(n), n * 2));\n}\n`,
  });
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]).sort(), [
    ['doubles 1', 'passes-without-change'],
    ['doubles 2', 'passes-without-change'],
    ['maths (x) > triples', 'fails-without-change'],
  ]);
});

test('a filter that misses a test node names differently is retried once, unfiltered, and the test still gets its row', T, async (t) => {
  const f = fixture(t);
  const calls: string[] = [];
  // A name with a newline in it: the filter's `.*` does not cross it in node's own matching.
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}for (const s of ['x\\ny']) test(\`multi \${s}\`, () => assert.equal(x.triple?.(1), 3));\n`,
  }, { run: realRun(calls) });
  assert.equal(calls.length, 2, 'filtered, then once more without the filter');
  assert.doesNotMatch(calls[1]!, /--test-name-pattern/);
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]), [['multi x\ny', 'fails-without-change']]);
});

// ------------------------------------------------------------------ could not run

test('a file that does not load at the base: every changed test in it could not run, with the load error', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { triple } from '../src/x.js';\ntest('one', () => assert.equal(triple(1), 3));\ntest('two', () => assert.equal(triple(2), 6));\n",
  });
  assert.equal(res.status, 'ran');
  assert.deepEqual(res.tests.map((r) => r.outcome), ['could-not-run', 'could-not-run']);
  for (const r of res.tests) assert.match(r.detail, /^the file did not load at the base: SyntaxError: .*triple/);
});

test('a test that hangs at the base is cut at the per-test bound and could not run; the file run is bounded too', T, async (t) => {
  const f = fixture(t);
  const limits: number[] = [];
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('waits for ready', async () => { while (!x.ready) await new Promise((r) => setTimeout(r, 50)); });\ntest('triples', () => assert.equal(x.triple?.(2), 6));\n`,
  }, { run: realRun([], limits), perTestMs: 1_500, loadMs: 20_000 });
  assert.match(row(res, 'waits for ready').detail, /^timed out at the base/);
  assert.equal(row(res, 'waits for ready').outcome, 'could-not-run');
  assert.equal(row(res, 'triples').outcome, 'fails-without-change', 'the rest of the file still ran');
  assert.deepEqual(limits, [20_000 + 2 * 1_500], 'the file run: its load plus the per-test bound per changed test');
});

test('a file that hangs at the base outside any test is killed at its bound, and its tests could not run', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}if (!x.ready) setInterval(() => {}, 1000);\nawait new Promise((r) => { if (x.ready) r(); });\ntest('after the wait', () => assert.ok(x.ready));\n`,
  }, { perTestMs: 1_000, loadMs: 1_000 });
  assert.deepEqual(res.tests.map((r) => r.outcome), ['could-not-run']);
  assert.match(res.tests[0]!.detail, /killed at its time bound|did not load|did not report/);
});

// ------------------------------------------------------------------ F4: fail closed, never clean

test('F4: a runner that throws makes every changed test could-not-run, and the status is never ran', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('one', () => assert.equal(x.triple?.(1), 3));\ntest('two', () => assert.ok(true));\n`,
  }, { run: async () => { throw new Error('slot table exploded'); } });
  assert.equal(res.status, 'could-not-run');
  assert.match(res.reason, /slot table exploded/);
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]), [['one', 'could-not-run'], ['two', 'could-not-run']]);
  assert.ok(res.tests.every((r) => /slot table exploded/.test(r.detail)));
  noScratch(f);
});

test('F4: a sandbox that refuses, a missing base, and a git error are could-not-run too', T, async (t) => {
  const f = fixture(t);
  const change = { 'src/x.js': SRC_AFTER, 'test/a.test.js': `${HEAD}test('one', () => assert.equal(x.triple?.(1), 3));\n` };
  const refused = await check(f, change, { run: async () => ({ passed: false, timedOut: false, refused: true, output: 'foreman: sandbox-exec is missing' }) });
  assert.equal(refused.status, 'could-not-run');
  assert.deepEqual(refused.tests.map((r) => r.outcome), ['could-not-run']);
  assert.match(refused.tests[0]!.detail, /sandbox refused the command: foreman: sandbox-exec is missing/);
  const tree = await jailTree(f.jail);
  const noBase = await revertTestsCheck({ repo: f.repo, base: null, tree, workRoot: f.workRoot, runId: 'r2', run: realRun() });
  assert.equal(noBase?.status, 'could-not-run');
  const badBase = await revertTestsCheck({ repo: f.repo, base: 'f'.repeat(40), tree, workRoot: f.workRoot, runId: 'r3', run: realRun() });
  assert.equal(badBase?.status, 'could-not-run');
  noScratch(f);
});

test('an abort concludes nothing: null, and the scratch tree is gone', T, async (t) => {
  const f = fixture(t);
  const ctl = new AbortController();
  const res = await revertTestsCheck({
    repo: f.repo, base: f.base, tree: await (async () => { write(f.jail, { 'src/x.js': SRC_AFTER, 'test/a.test.js': `${HEAD}test('one', () => {});\n` }); return jailTree(f.jail); })(),
    workRoot: f.workRoot, runId: 'r1', signal: ctl.signal,
    run: async () => { ctl.abort(); return { passed: false, timedOut: false, output: '' }; },
  });
  assert.equal(res, null);
  noScratch(f);
});

// ------------------------------------------------------------------ F5, F6, F2

test('F5: test files come from the reviewed tree, not from what the live jail holds afterwards', T, async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': SRC_AFTER, 'test/a.test.js': `${HEAD}test('triples', () => assert.equal(x.triple?.(2), 6));\n` });
  const tree = await jailTree(f.jail);
  // After the tree was taken, the jail's copy is rewritten to something that passes anywhere.
  write(f.jail, { 'test/a.test.js': `${HEAD}test('triples', () => assert.ok(true));\n` });
  const res = await revertTestsCheck({ repo: f.repo, base: f.base, tree, workRoot: f.workRoot, runId: 'r1', run: realRun() });
  assert.deepEqual(res?.tests.map((r) => r.outcome), ['fails-without-change']);
});

test('F6: the budget counts the time commands ran, not the time they waited for a verify slot', T, async (t) => {
  const f = fixture(t);
  let clock = 0;
  const ran: string[] = [];
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('a', () => {});\n`,
    'test/b.test.js': `${HEAD}test('b', () => {});\n`,
  }, {
    now: () => clock,
    budgetMs: 10_000,
    run: async (_dir, cmd) => {
      ran.push(cmd);
      // 20 minutes queued for a slot, then one second of running.
      clock += 20 * 60_000 + 1_000;
      const name = /a\.test/.test(cmd) ? 'a' : 'b';
      return { passed: true, timedOut: false, waitedMs: 20 * 60_000, output: `TAP version 13\n# Subtest: ${name}\nok 1 - ${name}\n1..1\n` };
    },
  });
  assert.equal(ran.length, 2, 'the second file still ran');
  assert.deepEqual(res.tests.map((r) => r.outcome), ['passes-without-change', 'passes-without-change']);
  assert.equal(res.runMs, 2_000);
});

test('F6: once the run-time budget is spent, the files left could not run, and say why', T, async (t) => {
  const f = fixture(t);
  let clock = 0;
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('a', () => {});\n`,
    'test/b.test.js': `${HEAD}test('b', () => {});\n`,
  }, {
    now: () => clock,
    budgetMs: 5_000,
    run: async () => { clock += 6_000; return { passed: true, timedOut: false, output: 'TAP version 13\nok 1 - a\n1..1\n' }; },
  });
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]), [['a', 'passes-without-change'], ['b', 'could-not-run']]);
  assert.match(res.tests[1]!.detail, /budget was spent/);
});

test('F2: Kiln\'s test script (spec to stdout and a skip reporter to a file) is run with TAP in their place, and read', T, async (t) => {
  const kiln = 'node --test --test-timeout=180000 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/skip-reporter.mjs --test-reporter-destination=test-skips.log "test/*.test.js"';
  const f = fixture(t, {}, kiln);
  const calls: string[] = [];
  const res = await check(f, {
    'src/x.js': SRC_AFTER,
    'test/a.test.js': `${HEAD}test('triples', () => assert.equal(x.triple?.(2), 6));\ntest('doubles', () => assert.equal(x.double(2), 4));\n`,
  }, { run: realRun(calls) });
  assert.deepEqual(res.tests.map((r) => [r.name, r.outcome]), [['triples', 'fails-without-change'], ['doubles', 'passes-without-change']]);
  assert.doesNotMatch(calls[0]!, /spec|skip-reporter|180000/, 'the script\'s reporters and timeout are not passed on');
  assert.match(calls[0]!, /--test-reporter=tap --test-reporter-destination=stdout --test-timeout=60000 --test-force-exit/);
});

// ------------------------------------------------------------------ B1: no hook from the repo

test('B1: a hook planted in the repo\'s .git/hooks is not run by the check\'s git calls', T, async (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, 'hook-ran');
  const hooks = path.join(f.repo, '.git', 'hooks');
  for (const name of ['post-checkout', 'reference-transaction', 'post-index-change']) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho "$0" >> '${marker}'\n`, { mode: 0o755 });
  }
  // The planted hooks do fire for a plain git call: without this the test could pass on a hook that never runs.
  const probe = path.join(f.root, 'probe');
  sh(f.repo, 'worktree', 'add', '-q', '--detach', probe, f.base);
  assert.equal(fs.existsSync(marker), true, 'a plain `git worktree add` runs the planted hook');
  sh(f.repo, 'worktree', 'remove', '--force', probe);
  fs.rmSync(marker);
  write(f.jail, { 'src/x.js': SRC_AFTER, 'test/a.test.js': `${HEAD}test('triples', () => assert.equal(x.triple?.(2), 6));\n` });
  const tree = sh(f.jail, '-c', 'core.hooksPath=/dev/null', 'add', '-A') + sh(f.jail, '-c', 'core.hooksPath=/dev/null', 'write-tree').trim();
  fs.rmSync(marker, { force: true });
  const res = await revertTestsCheck({ repo: f.repo, base: f.base, tree: tree.trim(), workRoot: f.workRoot, runId: 'r1', run: realRun() });
  assert.deepEqual(res?.tests.map((r) => r.outcome), ['fails-without-change'], 'the check got as far as running the test');
  assert.equal(fs.existsSync(marker), false, `a hook ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
});

// ------------------------------------------------------------------ when it says nothing

test('n/a, and no command is run: a test-only diff, a docs-only diff, and a diff whose test-side change is in no test', T, async (t) => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['test-only', { 'test/a.test.js': `${HEAD}test('a', () => {});\n` }, /^test-only/],
    ['docs and tests', { 'README.md': '# changed\n', 'test/a.test.js': `${HEAD}test('a', () => {});\n` }, /documentation only/],
    ['helper only', { 'src/x.js': SRC_AFTER, 'test/helpers.js': 'export const h = 1;\n' }, /adds or changes no test/],
    ['src only', { 'src/x.js': SRC_AFTER }, /adds or changes no test/],
  ];
  for (const [label, change, why] of cases) {
    const f = fixture(t);
    let ran = 0;
    const res = await check(f, change, { run: async () => { ran++; return { passed: true, timedOut: false, output: '' }; } });
    assert.equal(res.status, 'n/a', label);
    assert.match(res.reason, why, label);
    assert.equal(ran, 0, `${label}: nothing ran`);
    assert.equal(revertTestsNote(res), null, `${label}: nothing to tell the reviewer`);
  }
});

test('the test script must be `node --test`: any other gives could-not-run for every changed test', T, async (t) => {
  const f = fixture(t, {}, 'jest');
  const res = await check(f, { 'src/x.js': SRC_AFTER, 'test/a.test.js': `${HEAD}test('a', () => {});\n` });
  assert.equal(res.status, 'could-not-run');
  assert.deepEqual(res.tests.map((r) => r.outcome), ['could-not-run']);
  assert.match(res.reason, /not `node --test`/);
});

test('revertTestsApplies: only code tickets in a repo, with a diff and a tree, whose tests ran and passed, switched on, not stopped', () => {
  const ok = { enabled: true, kind: 'code', repo: '/r', workerOk: true, testsRan: true, testsPassed: true, diff: 'diff --git', tree: 'abc', aborted: false };
  assert.equal(revertTestsApplies(ok), true);
  for (const [key, value] of [
    ['enabled', false], ['kind', 'writing'], ['kind', 'research'], ['kind', 'general'], ['repo', null], ['workerOk', false],
    ['testsRan', false], ['testsPassed', false], ['diff', '  \n'], ['tree', null], ['aborted', true],
  ] as const) {
    assert.equal(revertTestsApplies({ ...ok, [key]: value }), false, `${key}=${String(value)}`);
  }
});

test('FOREMAN_REVERT_TESTS: off unless on; anything else throws', () => {
  for (const raw of [undefined, '', '  ', 'off', 'OFF', ' Off ']) assert.equal(onOff('FOREMAN_REVERT_TESTS', raw), false, String(raw));
  for (const raw of ['on', 'ON', ' On ']) assert.equal(onOff('FOREMAN_REVERT_TESTS', raw), true, raw);
  for (const raw of ['1', 'true', 'yes', 'o n']) assert.throws(() => onOff('FOREMAN_REVERT_TESTS', raw), /FOREMAN_REVERT_TESTS must be on or off/, raw);
});

// ------------------------------------------------------------------ the note and the record

test('the note is neutral, lists the passing tests first, and is bounded', () => {
  const res: RevertTestsResult = {
    version: 1, status: 'ran', reason: '', runMs: 1, runs: 1, unattributed: [{ file: 'test/a.test.js', lines: 3 }],
    tests: [
      { file: 'test/a.test.js', name: 'real', line: 4, change: 'added', outcome: 'fails-without-change', detail: 'expected 6, got undefined' },
      { file: 'test/a.test.js', name: 'pin', line: 9, change: 'changed', outcome: 'passes-without-change', detail: '' },
    ],
  };
  const note = revertTestsNote(res)!;
  assert.match(note, /^FOREMAN REVERT CHECK \(a reviewer aid; it decides nothing\)/);
  assert.match(note, /passes without the src change: 1 — either it does not test the change, or it pins behaviour that must not change; the reviewer decides which/);
  assert.match(note, /test\/a\.test\.js: 3 changed line\(s\) in no test/);
  assert.ok(note.indexOf('"pin"') < note.indexOf('"real"'), 'the passing row first');
  assert.match(note, /\[fails without the change\] test\/a\.test\.js:4 "real" \(added\) — expected 6, got undefined/);
  const many = { ...res, tests: Array.from({ length: 400 }, (_v, k) => ({ ...res.tests[1]!, name: `pin ${k}` })) };
  const cut = revertTestsNote(many)!;
  assert.ok(cut.length <= 6_000, String(cut.length));
  assert.match(cut, /FOREMAN cut \d+ more row\(s\)/);
});

test('recordRevertTests stores the JSON file and an artifact row that holds nothing; it reads back', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.addTask({ title: 't', prompt: 'p', kind: 'code' });
  const run = store.startRun(task.id);
  const res: RevertTestsResult = {
    version: 1, status: 'ran', reason: '1 changed test(s)', runMs: 1, runs: 1, unattributed: [],
    tests: [{ file: 'test/a.test.js', name: 'pin', line: 9, change: 'added', outcome: 'passes-without-change', detail: '' }],
  };
  recordRevertTests(store, run.id, task.id, res);
  const row = store.artifactsForTask(task.id).find((a) => a.type === 'revert-tests')!;
  assert.equal(row.path, revertTestsPath(run.id));
  assert.equal(row.summary, 'revert check: 0 fail, 1 pass, 0 could not run without the src change');
  assert.deepEqual(readRevertTests(row.path), res);
  fs.writeFileSync(row.path, '{"not":"it"}');
  assert.equal(readRevertTests(row.path), null, 'a file that is not the shape reads as nothing');
});

test('parseTap: nesting, directives, a block-scalar error, escaped names', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: suite \\# one',
    '    # Subtest: inner',
    '    not ok 1 - inner',
    '      ---',
    "      type: 'test'",
    "      location: '/x/test/a.test.js:7:3'",
    "      failureType: 'testCodeFailure'",
    '      error: |-',
    '        boom',
    '        second',
    '      ...',
    '    # Subtest: skipped',
    '    ok 2 - skipped # SKIP',
    '    1..2',
    'not ok 1 - suite \\# one',
    '  ---',
    "  type: 'suite'",
    '  ...',
    '# tests 2',
  ].join('\n');
  const { results, comments } = parseTap(tap);
  assert.deepEqual(results.map((r) => [r.path.join(' > '), r.ok, r.directive, r.type]), [
    ['suite # one > inner', false, null, 'test'],
    ['suite # one > skipped', true, 'SKIP', null],
    ['suite # one', false, null, 'suite'],
  ]);
  assert.deepEqual([results[0]!.line, results[0]!.col, results[0]!.error, results[0]!.failureType], [7, 3, 'boom', 'testCodeFailure']);
  assert.ok(comments.includes('tests 2'));
});

// ------------------------------------------------------------------ the runner's two new answers (verify/tests.ts)

test('runTests: a shorter per-command limit kills the command and says so; a longer one is not honoured; a refused sandbox says refused', T, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const slow = await runTests(dir, 'sleep 60', signal, undefined, undefined, { timeoutMs: 500 });
  assert.equal(slow.passed, false);
  assert.notEqual(slow.killedAfterSec, undefined, 'killed at its limit');
  assert.match(slow.output, /foreman: the command timed out after [01] s and was killed/);
  const quick = await runTests(dir, 'true', signal, undefined, undefined, { timeoutMs: 120_000 });
  assert.deepEqual([quick.passed, quick.killedAfterSec, quick.refused ?? false], [true, undefined, false]);
  const red = await runTests(dir, 'false', signal);
  assert.deepEqual([red.passed, red.killedAfterSec, red.refused ?? false], [false, undefined, false], 'a red run is neither');
  process.env['FOREMAN_TEST_TIMEOUT_MIN'] = '0.01';
  const capped = await runTests(dir, 'sleep 60', signal, undefined, undefined, { timeoutMs: 3_600_000 });
  delete process.env['FOREMAN_TEST_TIMEOUT_MIN'];
  assert.notEqual(capped.killedAfterSec, undefined);
  assert.match(capped.output, /FOREMAN_TEST_TIMEOUT_MIN/, 'the longer limit was not used');

  sbx._setSandboxSeamsForTest({ exec: path.join(dir, 'no-such-sandbox-exec') });
  process.env['FOREMAN_SANDBOX'] = 'tests';
  t.after(() => {
    process.env['FOREMAN_SANDBOX'] = 'off';
    sbx._setSandboxSeamsForTest(null);
  });
  const marker = path.join(dir, 'ran');
  const refused = await runTests(dir, `touch '${marker}'`, signal);
  assert.equal(refused.refused, true);
  assert.equal(refused.passed, false);
  assert.equal(fs.existsSync(marker), false, 'nothing ran');
});

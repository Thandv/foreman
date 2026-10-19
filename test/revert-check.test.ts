import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { ChangedFile } from '../src/isolate.ts';
import { appliesOnMain, perFileTestCmd, revertCheck, typecheckCmd, type RevertCheckResult } from '../src/verify/revertCheck.ts';

type Run = (dir: string, cmd: string, timeoutMs: number) => Promise<{ passed: boolean; timedOut: boolean; output: string }>;

const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }),
  '.gitignore': 'node_modules/\n',
  'README.md': '# fixture\n',
  'src/x.js': "export const greet = () => 'hello';\n",
  'test/old.test.js': "import test from 'node:test';\ntest('old', () => {});\n",
};

interface Fixture {
  repo: string;
  jail: string;
  workRoot: string;
  base: string;
}

/** A repo with one commit, and a jail (a detached worktree at that commit) for the work to be done in. */
function fixture(t: TestContext, baseFiles: Record<string, string> = BASE_FILES, prepare?: (repo: string, root: string) => void): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revert-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  write(repo, baseFiles);
  prepare?.(repo, root);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  return { repo, jail, workRoot: path.join(root, 'work'), base: sh(repo, 'rev-parse', 'HEAD').trim() };
}

/**
 * Runs the command for real. The whole process group is killed on timeout: `sh -c` and the `node --test` under it
 * would otherwise outlive a kill aimed at the shell alone.
 */
const realRun: Run = (dir, cmd, timeoutMs) =>
  new Promise((resolve) => {
    // Without NODE_TEST_CONTEXT, or the nested `node --test` thinks it is recursing and runs nothing.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const child = spawn('/bin/sh', ['-c', cmd], { cwd: dir, env, detached: true, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, timedOut, output });
    });
  });

const neverRun: Run = async () => {
  throw new Error('nothing should be run for this diff');
};

/**
 * One revertCheck call with acceptance item 5 checked around it: the scratch worktree is gone from disk and from
 * `git worktree list`, and the jail's `git status --porcelain` is what it was.
 */
async function checked(
  f: Fixture,
  changed: ChangedFile[],
  run: Run,
  extra: { perFileTimeoutMs?: number; totalBudgetMs?: number } = {},
): Promise<RevertCheckResult> {
  const before = sh(f.jail, 'status', '--porcelain');
  const res = await revertCheck({ repo: f.repo, jailDir: f.jail, base: f.base, changed, workRoot: f.workRoot, runId: 'r1', run, ...extra });
  assert.equal(fs.existsSync(path.join(f.workRoot, 'revert-r1')), false, 'the scratch directory is gone');
  // The exact entry, not /revert-r1/: the fixture's own temp name is `foreman-revert-` plus six random characters,
  // and one in 3,844 of those starts `r1` (about one run of this file in fifty failed on that alone).
  const registered = sh(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  assert.equal(registered.includes(`worktree ${path.join(f.workRoot, 'revert-r1')}`), false, 'the scratch worktree is unregistered');
  assert.equal(sh(f.jail, 'status', '--porcelain'), before, 'the jail is untouched');
  return res;
}

const NEW_SRC = "export const greet = () => 'hello, world';\n";
const SRC_AND_TEST: ChangedFile[] = [
  { path: 'src/x.js', from: null, status: 'modified' },
  { path: 'test/x.test.js', from: null, status: 'added' },
];
const testAsserting = (expected: string): string =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/x.js';\ntest('greet', () => assert.equal(greet(), '${expected}'));\n`;

// ------------------------------------------------------------- revertCheck

test('a new test that already holds at base is a gap, and it is run in the reverted tree, not the jail', async (t) => {
  const f = fixture(t);
  // True at base and FALSE in the jail: had the test been run in the jail it would fail, and read as a pass.
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello') });
  const dirs: string[] = [];
  const res = await checked(f, SRC_AND_TEST, (dir, cmd, ms) => {
    dirs.push(dir);
    return realRun(dir, cmd, ms);
  });
  assert.equal(res.status, 'gap');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'passes-without-change' }]);
  assert.match(res.reason, /test\/x\.test\.js/);
  assert.deepEqual(dirs, [path.join(f.workRoot, 'revert-r1')]);
});

test('a test that asserts the new behaviour fails without the change: pass', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, SRC_AND_TEST, realRun);
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'fails-without-change' }]);
  // An assertion was reached and failed: that is not a load error.
  assert.equal('loadErrors' in res, false);
  assert.equal(res.reason, '1 changed test file fails without the change');
});

// ------------------------------------------- a test that never got to run

const BARE_SCRIPT = (script: string): Record<string, string> => ({
  ...BASE_FILES,
  'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: script } }),
});
const VACUOUS = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { added } from '../src/x.js';\ntest('v', () => assert.equal(1, 1));\n";

test('a test that only fails to load without the change is named in loadErrors, and is not a gap', async (t) => {
  const f = fixture(t, BARE_SCRIPT('node --test'));
  // The assertion holds anywhere; the only thing the old tree lacks is the export it imports.
  write(f.jail, { 'src/x.js': `${BASE_FILES['src/x.js']}export const added = 1;\n`, 'test/x.test.js': VACUOUS });
  let output = '';
  const res = await checked(f, SRC_AND_TEST, async (dir, cmd, ms) => {
    const ran = await realRun(dir, cmd, ms);
    output = ran.output;
    return ran;
  });
  assert.match(output, /does not provide an export named 'added'/);
  assert.equal(res.status, 'pass', 'the status table is unchanged: a new export is a legitimate cause');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'fails-without-change' }]);
  assert.deepEqual(res.loadErrors, ['test/x.test.js']);
  assert.match(res.reason, /no test ran .* in: test\/x\.test\.js/);
});

test('a syntax error, a missing module and a file node will not start on are load errors too', async (t) => {
  const f = fixture(t, BARE_SCRIPT('node --test'));
  write(f.jail, {
    'src/x.js': NEW_SRC,
    'src/added.js': 'export const added = 1;\n',
    'test/syntax.test.js': "import test from 'node:test';\ntest('s', () => {\n",
    'test/missing.test.js': "import test from 'node:test';\nimport { added } from '../src/added.js';\ntest('m', () => { added; });\n",
    '-v.test.js': "import test from 'node:test';\ntest('dash', () => { throw new Error('never reached'); });\n",
    'test/real.test.js': testAsserting('hello, world'),
  });
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'src/added.js', from: null, status: 'added' },
    { path: 'test/syntax.test.js', from: null, status: 'added' },
    { path: 'test/missing.test.js', from: null, status: 'added' },
    { path: '-v.test.js', from: null, status: 'added' },
    { path: 'test/real.test.js', from: null, status: 'added' },
  ];
  const outputs: Record<string, string> = {};
  const res = await checked(f, changed, async (dir, cmd, ms) => {
    const ran = await realRun(dir, cmd, ms);
    outputs[cmd] = ran.output;
    return ran;
  });
  assert.match(outputs['node --test test/syntax.test.js'] ?? '', /SyntaxError/);
  assert.match(outputs['node --test test/missing.test.js'] ?? '', /ERR_MODULE_NOT_FOUND/);
  assert.match(outputs['node --test -v.test.js'] ?? '', /bad option/);
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.files.map((x) => x.outcome), Array(4).fill('fails-without-change'));
  // The file with a real failing assertion is the one that is NOT listed.
  assert.deepEqual(res.loadErrors, ['test/syntax.test.js', 'test/missing.test.js', '-v.test.js']);
  assert.match(res.reason, /^4 changed test files fail without the change; no test ran .* in: test\/syntax\.test\.js, test\/missing\.test\.js, -v\.test\.js$/);
});

test('load errors are read off a TAP report as well', async (t) => {
  const tap = fixture(t, BARE_SCRIPT('node --test --test-reporter=tap'));
  write(tap.jail, { 'src/x.js': `${BASE_FILES['src/x.js']}export const added = 1;\n`, 'test/x.test.js': VACUOUS, 'test/real.test.js': testAsserting('changed') });
  const changed: ChangedFile[] = [...SRC_AND_TEST, { path: 'test/real.test.js', from: null, status: 'added' }];
  const res = await checked(tap, changed, realRun);
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.loadErrors, ['test/x.test.js']);
});

test('a failed run with a summary but no test, or with no summary, is a load error; a file-named failure needs the runner\'s whole-file mark', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const withOutput = (output: string): Promise<RevertCheckResult> => checked(f, SRC_AND_TEST, async () => ({ passed: false, timedOut: false, output }));
  const ONE = 'ℹ tests 1\nℹ fail 1\n';
  assert.deepEqual((await withOutput('ℹ tests 0\nℹ fail 0\n')).loadErrors, ['test/x.test.js']);
  assert.deepEqual((await withOutput('node: bad option: --nope\n')).loadErrors, ['test/x.test.js']);
  assert.deepEqual(
    (await withOutput(`\u001b[31m✖ ${path.join(f.workRoot, 'revert-r1', 'test/x.test.js')} \u001b[90m(41.5ms)\u001b[39m\n  \u001b[32m'test failed'\u001b[39m\n${ONE}`)).loadErrors,
    ['test/x.test.js'],
    'colour codes, an absolute name, and the whole-file error line',
  );
  assert.deepEqual(
    (await withOutput(`${ONE}test at test/x.test.js:1:1\n✖ test/x.test.js (1.7ms)\n  SyntaxError: Unexpected end of input\n`)).loadErrors,
    ['test/x.test.js'],
    'a failure located at the top of the file, as --test-isolation=none prints it',
  );
  assert.equal('loadErrors' in await withOutput(`✖ test/x.test.js (1.2ms)\n${ONE}`), false, 'the file name alone is only a test that was named after its file');
  assert.equal('loadErrors' in await withOutput(`${ONE}test at test/x.test.js:4:1\n✖ test/x.test.js (1.2ms)\n  'test failed'\n`), false, 'a located test is not the file, whatever it threw');
  assert.equal('loadErrors' in await withOutput(`✖ greet (1.2ms)\n  'test failed'\n${ONE}`), false, 'one failing test with a name of its own ran');
  assert.equal('loadErrors' in await withOutput("✖ test/x.test.js (1.2ms)\n  'test failed'\n✖ greet (1ms)\nℹ tests 2\nℹ fail 2\n"), false, 'a test ran before the file failed');
  // A file that passes or times out is never a load error, and never an unknown, whatever its output says.
  for (const output of ['node: bad option\n', '']) {
    const passing = await checked(f, SRC_AND_TEST, async () => ({ passed: true, timedOut: false, output }));
    assert.equal(passing.status, 'gap');
    assert.equal('loadErrors' in passing || 'loadUnknown' in passing, false);
    const slow = await checked(f, SRC_AND_TEST, async () => ({ passed: false, timedOut: true, output }));
    assert.equal(slow.status, 'inconclusive');
    assert.equal('loadErrors' in slow || 'loadUnknown' in slow, false);
  }
});

// ----------------------------- a real failing test that is named after its file

const NAMED_AFTER_FILE: Record<string, string> = {
  'test/x.test.js': testAsserting('hello, world').replace("'greet'", "'test/x.test.js'"),
  'test/dot.test.js': testAsserting('hello, world').replace("'greet'", "'./test/dot.test.js'"),
  'test/desc.test.js': "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/x.js';\ndescribe('test/desc.test.js', () => { it('inner', () => assert.equal(greet(), 'hello, world')); });\n",
  // Throws the very string the runner uses for a file that failed as a whole.
  'test/thrown.test.js': "import test from 'node:test';\nimport { greet } from '../src/x.js';\ntest('test/thrown.test.js', () => { if (greet() !== 'hello, world') throw 'test failed'; });\n",
};

for (const flags of ['', ' --test-reporter=tap', ' --test-isolation=none', ' --test-isolation=none --test-reporter=tap']) {
  test(`a failing test named after its file ran, and only the file that did not load is a load error (node --test${flags})`, async (t) => {
    const f = fixture(t, BARE_SCRIPT(`node --test${flags} "test/*.test.js"`));
    write(f.jail, { 'src/x.js': `${NEW_SRC}export const added = 1;\n`, ...NAMED_AFTER_FILE, 'test/load.test.js': VACUOUS });
    const changed: ChangedFile[] = [
      { path: 'src/x.js', from: null, status: 'modified' },
      ...[...Object.keys(NAMED_AFTER_FILE), 'test/load.test.js'].map((p): ChangedFile => ({ path: p, from: null, status: 'added' })),
    ];
    const res = await checked(f, changed, realRun);
    assert.equal(res.status, 'pass');
    assert.deepEqual(res.files.map((x) => x.outcome), Array(5).fill('fails-without-change'));
    assert.deepEqual(res.loadErrors, ['test/load.test.js']);
    assert.equal('loadUnknown' in res, false);
    assert.match(res.reason, /^5 changed test files fail without the change; no test ran .* in: test\/load\.test\.js$/);
  });
}

// ------------------------------------------- when the report cannot be read

for (const [flags, why] of [
  ['--test-reporter=dot', 'the test reporter is not spec or tap'],
  ['--test-reporter=junit', 'the test reporter is not spec or tap'],
  ['--test-reporter junit', 'the test reporter is not spec or tap'],
  ['--test-reporter=spec --test-reporter-destination=report.txt', 'the run printed nothing'],
] as const) {
  test(`a file that fails to load under ${flags} is named in loadUnknown, with the reason said`, async (t) => {
    const f = fixture(t, BARE_SCRIPT(`node --test ${flags}`));
    write(f.jail, { 'src/x.js': `${BASE_FILES['src/x.js']}export const added = 1;\n`, 'test/x.test.js': VACUOUS });
    const res = await checked(f, SRC_AND_TEST, realRun);
    assert.equal(res.status, 'pass', 'the status table is unchanged');
    assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'fails-without-change' }]);
    assert.equal('loadErrors' in res, false, 'nothing is guessed from a report that cannot be read');
    assert.deepEqual(res.loadUnknown, ['test/x.test.js']);
    assert.equal(res.reason, `1 changed test file fails without the change; cannot tell whether any test ran (${why}) in: test/x.test.js`);
  });
}

test('a report that goes to a file is not read off whatever else the run printed', async (t) => {
  const f = fixture(t, BARE_SCRIPT('node --test --test-reporter-destination=report.txt --test-reporter=spec'));
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  // With the report elsewhere, a stray line and no `tests N` summary would have read as "node did not start".
  const res = await checked(f, SRC_AND_TEST, async () => ({ passed: false, timedOut: false, output: '(node:1) ExperimentalWarning: something\n' }));
  assert.equal(res.status, 'pass');
  assert.equal('loadErrors' in res, false);
  assert.deepEqual(res.loadUnknown, ['test/x.test.js']);
  assert.match(res.reason, /; cannot tell whether any test ran \(the test report is written to a file\) in: test\/x\.test\.js$/);
});

test('a failed run that printed nothing is named in loadUnknown, beside the load errors that could be read', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world'), 'test/y.test.js': testAsserting('hello, world'), 'test/z.test.js': testAsserting('hello, world') });
  const changed: ChangedFile[] = [...SRC_AND_TEST, { path: 'test/y.test.js', from: null, status: 'added' }, { path: 'test/z.test.js', from: null, status: 'added' }];
  const res = await checked(f, changed, async (_dir, cmd) => ({
    passed: false,
    timedOut: false,
    output: cmd.includes('x.test.js') ? '' : cmd.includes('y.test.js') ? ' \n' : 'node: bad option\n',
  }));
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.loadUnknown, ['test/x.test.js', 'test/y.test.js']);
  assert.deepEqual(res.loadErrors, ['test/z.test.js']);
  assert.equal(
    res.reason,
    '3 changed test files fail without the change; no test ran (the file did not load without the change) in: test/z.test.js; cannot tell whether any test ran (the run printed nothing) in: test/x.test.js, test/y.test.js',
  );
});

test('a failing test under a reporter that can be read leaves no loadUnknown behind', async (t) => {
  const f = fixture(t, BARE_SCRIPT('node --test --test-reporter=spec --test-reporter-destination=stdout'));
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, SRC_AND_TEST, realRun);
  assert.deepEqual(res, { status: 'pass', reason: '1 changed test file fails without the change', files: [{ file: 'test/x.test.js', outcome: 'fails-without-change' }] });
});

for (const [what, thrown] of [['null', null], ['undefined', undefined], ['a string', 'the runner fell over'], ['an object with no message', {}]] as const) {
  test(`a run that rejects with ${what} is inconclusive, not a throw, and the scratch tree is still removed`, async (t) => {
    const f = fixture(t);
    write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
    const res = await checked(f, SRC_AND_TEST, () => Promise.reject(thrown));
    assert.equal(res.status, 'inconclusive');
    assert.match(res.reason, /^revert check could not run: \S/);
    if (typeof thrown === 'string') assert.match(res.reason, /the runner fell over/);
    assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'not-run' }]);
  });
}

// --------------------------------------------- code that looks like documentation

const VACUOUS_TEST = "import test from 'node:test';\ntest('vacuous', () => {});\n";

// ------------------------------------- a report that lost its summary was cut, not unloadable

/** The run as Foreman's own test stage keeps it (src/verify/tests.ts): the last 400 lines. */
const tailRun = (keep: number, seen: string[]): Run => async (dir, cmd, ms) => {
  const ran = await realRun(dir, cmd, ms);
  const output = ran.output.split('\n').slice(-keep).join('\n');
  seen.push(output);
  return { ...ran, output };
};

test('many really failing tests whose report lost its summary to a 400-line tail are not called a load error', async (t) => {
  const f = fixture(t);
  const many = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/x.js';\n${
    Array.from({ length: 30 }, (_, i) => `test('greet ${i}', () => assert.equal(greet(), 'hello, world'));`).join('\n')}\n`;
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': many });
  const seen: string[] = [];
  const res = await checked(f, SRC_AND_TEST, tailRun(400, seen));
  assert.doesNotMatch(seen[0] ?? '', /^ℹ tests \d+/m, 'the fixture is long enough for the summary to be gone');
  assert.equal(res.status, 'pass', 'the status table is unchanged');
  assert.equal('loadErrors' in res, false, '30 tests ran and failed: the file loaded');
  assert.deepEqual(res.loadUnknown, ['test/x.test.js']);
  assert.match(res.reason, /; cannot tell whether any test ran \(the test report has no summary: .*\) in: test\/x\.test\.js$/);
  // The same file with its whole report is read as before: nothing to say.
  const whole = await checked(f, SRC_AND_TEST, realRun);
  assert.equal('loadErrors' in whole || 'loadUnknown' in whole, false);
});

test('a summary-less report is a load error only when it is short and shows no sign of a test', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const withOutput = (output: string): Promise<RevertCheckResult> => checked(f, SRC_AND_TEST, async () => ({ passed: false, timedOut: false, output }));
  for (const [what, output] of [
    ['the end of one long assertion diff', `${'+   { i: 1 },\n'.repeat(20)}      at TestContext.<anonymous> (file:///r/test/x.test.js:4:25)\n      at Test.run (node:internal/test_runner/test:1201:25)\n`],
    ['the head of a TAP report', 'TAP version 13\n# Subtest: greet\nnot ok 1 - greet\n  ---\n'],
    ['the end of a spec list of failures', 'test at test/x.test.js:9:1\n\u001b[31m✖ greet 5 \u001b[90m(0.1ms)\u001b[39m\n  AssertionError\n'],
    ['a dot report, in colour', 'X\n\nFailed tests:\n\n\u001b[31m✖ greet (0.5ms)\u001b[39m\n'],
    ['more lines than node prints when it refuses to start', 'line\n'.repeat(61)],
  ] as const) {
    const res = await withOutput(output);
    assert.equal('loadErrors' in res, false, what);
    assert.deepEqual(res.loadUnknown, ['test/x.test.js'], what);
  }
  // The other side: node or the shell refusing to start is still "no test ran".
  for (const output of ['node: bad option: --nope\n', '/bin/sh: -c: line 0: syntax error near unexpected token `)\'\n', 'line\n'.repeat(59)]) {
    const res = await withOutput(output);
    assert.deepEqual(res.loadErrors, ['test/x.test.js'], output.slice(0, 30));
    assert.equal('loadUnknown' in res, false);
  }
});

test('a run that rejects with an Error whose message is not a string is inconclusive, not a throw', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, SRC_AND_TEST, () => Promise.reject(Object.assign(new Error('x'), { message: 123 })));
  assert.equal(res.status, 'inconclusive');
  assert.match(res.reason, /^revert check could not run: 123$/);
});

// ------------------------------------------------ round-3 lines no test held in place

test('the whole-file mark is line 1 column 1, the TAP error line counts where there is no location, and stderr is still a printed report', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const withOutput = (output: unknown): Promise<RevertCheckResult> => checked(f, SRC_AND_TEST, async () => ({ passed: false, timedOut: false, output: output as string }));
  const ONE = 'ℹ tests 1\nℹ fail 1\n';
  // A test can start on line 1 (a CommonJS file that begins `require('node:test')('<its own path>', …)` is located at 1:21).
  assert.equal('loadErrors' in await withOutput(`${ONE}test at test/x.test.js:1:21\n✖ test/x.test.js (1.2ms)\n  Error: real\n`), false);
  const tap = (lines: string[]): string => `TAP version 13\nnot ok 1 - test/x.test.js\n  ---\n${lines.map((l) => `  ${l}\n`).join('')}  ...\n1..1\n# tests 1\n# fail 1\n`;
  assert.deepEqual((await withOutput(tap(['duration_ms: 1', "error: 'test failed'", "code: 'ERR_TEST_FAILURE'"]))).loadErrors, ['test/x.test.js']);
  assert.equal('loadErrors' in await withOutput(tap(['duration_ms: 1', "error: 'boom'", "code: 'ERR_TEST_FAILURE'"])), false);
  // A runner that hands back no output at all has printed nothing; that is said, it is not a crash.
  const silent = await withOutput(undefined);
  assert.equal(silent.status, 'pass');
  assert.deepEqual(silent.loadUnknown, ['test/x.test.js']);

  const err = fixture(t, BARE_SCRIPT('node --test --test-reporter=spec --test-reporter-destination=stderr'));
  write(err.jail, { 'src/x.js': `${BASE_FILES['src/x.js']}export const added = 1;\n`, 'test/x.test.js': VACUOUS });
  const res = await checked(err, SRC_AND_TEST, realRun);
  assert.deepEqual(res.loadErrors, ['test/x.test.js']);
  assert.equal('loadUnknown' in res, false);
});

test('a file that did not load is still named when another file timed out', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world'), 'test/y.test.js': testAsserting('hello, world') });
  const res = await checked(f, [...SRC_AND_TEST, { path: 'test/y.test.js', from: null, status: 'added' }], async (_dir, cmd) => (
    cmd.includes('x.test.js') ? { passed: false, timedOut: true, output: '' } : { passed: false, timedOut: false, output: 'node: bad option\n' }
  ));
  assert.equal(res.status, 'inconclusive');
  assert.deepEqual(res.loadErrors, ['test/y.test.js']);
  assert.match(res.reason, /^timed out without the change: test\/x\.test\.js; no test ran .* in: test\/y\.test\.js$/);
});

for (const hidden of ['docs/Build.JS', 'docs/conf.PY']) {
  test(`${hidden} beside a vacuous test is code whatever the case of its extension: a gap`, async (t) => {
    const f = fixture(t);
    write(f.jail, { [hidden]: 'x = 1\n', 'test/x.test.js': VACUOUS_TEST });
    const res = await checked(f, [{ path: hidden, from: null, status: 'added' }, { path: 'test/x.test.js', from: null, status: 'added' }], realRun);
    assert.equal(res.status, 'gap');
  });
}

// --------------------------------------------- a rename away from a source path

for (const to of ['docs/x.md', 'NOTES.txt', 'test/helpers/x.js']) {
  test(`src/x.js renamed to ${to} beside a vacuous test is a change to revert: the test is run, and is a gap`, async (t) => {
    const f = fixture(t);
    fs.rmSync(path.join(f.jail, 'src/x.js'));
    write(f.jail, { [to]: BASE_FILES['src/x.js']!, 'test/x.test.js': VACUOUS_TEST });
    const res = await checked(f, [{ path: to, from: 'src/x.js', status: 'renamed' }, { path: 'test/x.test.js', from: null, status: 'added' }], realRun);
    assert.equal(res.status, 'gap');
    assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'passes-without-change' }]);
  });
}

test('a rename with documentation or tests on both sides is still nothing to revert, and nothing is run', async (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.jail, 'README.md'), path.join(f.jail, 'GUIDE.md'));
  fs.renameSync(path.join(f.jail, 'test/old.test.js'), path.join(f.jail, 'test/older.test.js'));
  write(f.jail, { 'test/x.test.js': VACUOUS_TEST });
  const docs: ChangedFile = { path: 'GUIDE.md', from: 'README.md', status: 'renamed' };
  const tests: ChangedFile = { path: 'test/older.test.js', from: 'test/old.test.js', status: 'renamed' };
  const added: ChangedFile = { path: 'test/x.test.js', from: null, status: 'added' };
  assert.match((await checked(f, [docs], neverRun)).reason, /^docs-only/);
  assert.match((await checked(f, [tests, added], neverRun)).reason, /^test-only: the diff has no non-test file/);
  assert.match((await checked(f, [docs, tests, added], neverRun)).reason, /^test-only: besides tests/);
});

for (const hidden of [
  'docs/build.js', 'docs/conf.py', 'CMakeLists.txt', 'requirements.txt', 'src/prompt.txt',
  'docs/Makefile', 'docs/deploy.sh', 'docs/site.yaml', 'docs/book.toml', 'docs/data.json', 'docs/FindX.cmake',
  'requirements-dev.txt', 'constraints.txt', 'sub/CMakeLists.txt',
  'lib/notes.md', 'bin/usage.txt', 'scripts/steps.md', 'prompts/system.md', 'skills/review/SKILL.md', 'agents/reviewer.md', 'packages/a/src/prompt.md',
]) {
  test(`${hidden} beside a vacuous test is not documentation: the test is run, and is a gap`, async (t) => {
    const f = fixture(t);
    write(f.jail, { [hidden]: 'x = 1\n', 'test/x.test.js': VACUOUS_TEST });
    const res = await checked(f, [{ path: hidden, from: null, status: 'added' }, { path: 'test/x.test.js', from: null, status: 'added' }], realRun);
    assert.equal(res.status, 'gap');
    assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'passes-without-change' }]);
  });
}

for (const doc of ['docs/guide.md', 'NOTES.txt', 'CHANGES.rst', 'docs/img/shot.png']) {
  test(`${doc} beside a test is still documentation: n/a test-only, and nothing is run`, async (t) => {
    const f = fixture(t);
    write(f.jail, { [doc]: 'words\n', 'test/x.test.js': VACUOUS_TEST });
    const res = await checked(f, [{ path: doc, from: null, status: 'added' }, { path: 'test/x.test.js', from: null, status: 'added' }], neverRun);
    assert.equal(res.status, 'n/a');
    assert.match(res.reason, /^test-only/);
    assert.equal(fs.existsSync(f.workRoot), false, 'no scratch tree was made for it');
  });
}

test('code under docs/ alone is not a docs-only diff', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'docs/build.js': 'x = 1\n', 'src/prompt.txt': 'be brief\n' });
  const res = await checked(f, [{ path: 'docs/build.js', from: null, status: 'added' }, { path: 'src/prompt.txt', from: null, status: 'added' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /^no test in the diff/);
});

test('a load error beside a file that passes without the change is still a gap, and both are named', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello'), 'test/y.test.js': testAsserting('hello') });
  const changed: ChangedFile[] = [...SRC_AND_TEST, { path: 'test/y.test.js', from: null, status: 'added' }];
  const res = await checked(f, changed, async (_dir, cmd) => (cmd.includes('x.test.js')
    ? { passed: true, timedOut: false, output: '' }
    : { passed: false, timedOut: false, output: 'node: bad option\n' }));
  assert.equal(res.status, 'gap');
  assert.deepEqual(res.loadErrors, ['test/y.test.js']);
  assert.match(res.reason, /^passes without the change: test\/x\.test\.js; no test ran .* in: test\/y\.test\.js$/);
});

// ------------------------------------------------- nothing to revert at all

test('tests beside documentation are n/a test-only: there is nothing to revert, and nothing is run', async (t) => {
  const f = fixture(t);
  // The test holds at base: run, it would have been reported as a gap.
  write(f.jail, { 'README.md': '# fixture, revised\n', 'test/x.test.js': testAsserting('hello') });
  const res = await checked(f, [{ path: 'README.md', from: null, status: 'modified' }, { path: 'test/x.test.js', from: null, status: 'added' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /^test-only/);
  assert.deepEqual(res.files, []);
  assert.equal(fs.existsSync(f.workRoot), false, 'no scratch tree was made for it');
});

test('a test that was only renamed beside a src change is not a gap by itself', async (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.jail, 'test/old.test.js'), path.join(f.jail, 'test/renamed.test.js'));
  write(f.jail, { 'src/x.js': NEW_SRC });
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'test/renamed.test.js', from: 'test/old.test.js', status: 'renamed' },
  ];
  const res = await checked(f, changed, neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /no test in the diff: .*renamed/);
});

test('a test that was renamed AND changed is still run, and is a gap when it holds at base', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.jail, 'test/old.test.js'));
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/renamed.test.js': `${BASE_FILES['test/old.test.js']}test('second', () => {});\n` });
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'test/renamed.test.js', from: 'test/old.test.js', status: 'renamed' },
  ];
  const res = await checked(f, changed, realRun);
  assert.equal(res.status, 'gap');
  assert.deepEqual(res.files, [{ file: 'test/renamed.test.js', outcome: 'passes-without-change' }]);
});

// ------------------------------------------------ dependencies and quoting

test('the reverted tree gets the repo\'s gitignored node_modules, so a test that imports from it runs', async (t) => {
  const f = fixture(t);
  write(f.repo, {
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }),
    'node_modules/dep/index.js': "export const dep = 'linked';\n",
  });
  assert.equal(sh(f.repo, 'status', '--porcelain'), '', 'node_modules is ignored, so no worktree carries it');
  write(f.jail, {
    'src/x.js': NEW_SRC,
    'test/x.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dep } from 'dep';\ntest('dep', () => assert.equal(dep, 'linked'));\n",
  });
  let linked = false;
  const res = await checked(f, SRC_AND_TEST, (dir, cmd, ms) => {
    linked = fs.existsSync(path.join(dir, 'node_modules/dep/index.js'));
    return realRun(dir, cmd, ms);
  });
  assert.equal(linked, true);
  // Without the dependency the import fails and this reads as "fails without the change".
  assert.equal(res.status, 'gap');
  assert.equal('loadErrors' in res, false);
});

test('no install is attempted for the reverted tree, even with a lockfile and nothing to link', async (t) => {
  const lock = JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } });
  // `node_modules` without the slash: the directory does not exist here, and a directory-only pattern would not
  // match a path that is not there, which stops provisionDeps before it gets as far as an install.
  const f = fixture(t, { ...BASE_FILES, '.gitignore': 'node_modules\n', 'package-lock.json': lock });
  // An `npm` that only records that it was called, first on PATH for the length of this test.
  const bin = path.join(path.dirname(f.repo), 'bin');
  const marker = path.join(path.dirname(f.repo), 'npm-was-called');
  write(bin, { npm: `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n` });
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => { process.env['PATH'] = oldPath; });
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  let modules = true;
  const res = await checked(f, SRC_AND_TEST, (dir, cmd, ms) => {
    modules = fs.existsSync(path.join(dir, 'node_modules'));
    return realRun(dir, cmd, ms);
  });
  assert.equal(fs.existsSync(marker), false, 'npm was not run');
  assert.equal(modules, false);
  assert.equal(res.status, 'pass');
});

test('a test file with a space and a quote in its name is run as one file', async (t) => {
  const f = fixture(t);
  const name = "test/it's a.test.js";
  write(f.jail, { 'src/x.js': NEW_SRC, [name]: testAsserting('hello') });
  const cmds: string[] = [];
  const res = await checked(f, [{ path: 'src/x.js', from: null, status: 'modified' }, { path: name, from: null, status: 'added' }], (dir, cmd, ms) => {
    cmds.push(cmd);
    return realRun(dir, cmd, ms);
  });
  assert.deepEqual(cmds, [`node --test 'test/it'\\''s a.test.js'`]);
  // It holds at base, and only a command that reaches the file can find that out.
  assert.equal(res.status, 'gap');
  assert.deepEqual(res.files, [{ file: name, outcome: 'passes-without-change' }]);
});

// ------------------------------------------- writes stay in the scratch tree

/** A base tree whose `tests` is a committed symlink to a directory outside the repo, with one file in it. */
function fixtureWithOutsideLink(t: TestContext): Fixture & { outside: string } {
  let outside = '';
  const f = fixture(t, BASE_FILES, (repo, root) => {
    outside = path.join(root, 'outside');
    write(outside, { 'a.test.js': 'outside the repo\n' });
    fs.symlinkSync(outside, path.join(repo, 'tests'));
  });
  return { ...f, outside };
}

test('a test copied under a committed symlink that leaves the tree is refused, not written through', async (t) => {
  const f = fixtureWithOutsideLink(t);
  // The diff replaces the link with a real directory. The link's own path is not test-side, so it stays at base.
  fs.rmSync(path.join(f.jail, 'tests'));
  write(f.jail, { 'src/x.js': NEW_SRC, 'tests/a.test.js': testAsserting('hello, world'), 'tests/new.test.js': testAsserting('hello, world') });
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'tests', from: null, status: 'deleted' },
    { path: 'tests/a.test.js', from: null, status: 'added' },
    { path: 'tests/new.test.js', from: null, status: 'added' },
  ];
  const res = await checked(f, changed, neverRun);
  assert.equal(res.status, 'inconclusive');
  assert.match(res.reason, /tests\/a\.test\.js resolves outside the scratch worktree/);
  assert.deepEqual(fs.readdirSync(f.outside), ['a.test.js']);
  assert.equal(fs.readFileSync(path.join(f.outside, 'a.test.js'), 'utf8'), 'outside the repo\n');
});

test('a deleted test under a committed symlink that leaves the tree is refused, not deleted through', async (t) => {
  const f = fixtureWithOutsideLink(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const changed: ChangedFile[] = [...SRC_AND_TEST, { path: 'tests/a.test.js', from: null, status: 'deleted' }];
  const res = await checked(f, changed, neverRun);
  assert.equal(res.status, 'inconclusive');
  assert.match(res.reason, /tests\/a\.test\.js resolves outside the scratch worktree/);
  assert.equal(fs.readFileSync(path.join(f.outside, 'a.test.js'), 'utf8'), 'outside the repo\n');
});

test('a symlink that stays inside the tree is no reason to refuse', async (t) => {
  const f = fixture(t, BARE_SCRIPT('node --test'), (repo) => fs.symlinkSync('test', path.join(repo, 'spec')));
  write(f.jail, { 'src/x.js': NEW_SRC, 'spec/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, [{ path: 'src/x.js', from: null, status: 'modified' }, { path: 'spec/x.test.js', from: null, status: 'added' }], realRun);
  assert.equal(res.status, 'pass');
  assert.deepEqual(res.files, [{ file: 'spec/x.test.js', outcome: 'fails-without-change' }]);
});

// ------------------------------------------------------------ n/a and the rest

test('a test-only diff is n/a and says test-only', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'test/x.test.js': testAsserting('hello') });
  const res = await checked(f, [{ path: 'test/x.test.js', from: null, status: 'added' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /test-only/);
  assert.deepEqual(res.files, []);
});

test('a README-only diff is n/a and says docs-only', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'README.md': '# fixture, revised\n' });
  const res = await checked(f, [{ path: 'README.md', from: null, status: 'modified' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /docs-only/);
  const docs = await checked(f, [{ path: 'docs/guide.html', from: null, status: 'added' }, { path: 'notes.txt', from: null, status: 'added' }], neverRun);
  assert.match(docs.reason, /docs-only/);
});

test('a diff with no test file is n/a and says so', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC });
  const res = await checked(f, [{ path: 'src/x.js', from: null, status: 'modified' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /no test in the diff/);
  // A deleted test proves nothing about the change either.
  fs.rmSync(path.join(f.jail, 'test/old.test.js'));
  const deleted = await checked(f, [{ path: 'src/x.js', from: null, status: 'modified' }, { path: 'test/old.test.js', from: null, status: 'deleted' }], neverRun);
  assert.equal(deleted.status, 'n/a');
  assert.match(deleted.reason, /no test in the diff/);
});

test('a test that sleeps past the per-file timeout is inconclusive, never a gap', async (t) => {
  const f = fixture(t);
  write(f.jail, {
    'src/x.js': NEW_SRC,
    'test/x.test.js': "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 30_000)); });\n",
  });
  const started = Date.now();
  const res = await checked(f, SRC_AND_TEST, realRun, { perFileTimeoutMs: 1_500 });
  assert.equal(res.status, 'inconclusive');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'timeout' }]);
  assert.match(res.reason, /timed out/);
  assert.ok(Date.now() - started < 20_000, 'the run was cut off at the timeout, not waited out');
});

test('a timed-out run is a timeout whatever exit status came with it, and gets the per-file limit', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello') });
  const limits: number[] = [];
  const res = await checked(f, SRC_AND_TEST, async (_dir, _cmd, ms) => {
    limits.push(ms);
    return { passed: true, timedOut: true, output: '' };
  }, { perFileTimeoutMs: 4_000 });
  assert.equal(res.status, 'inconclusive');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'timeout' }]);
  assert.deepEqual(limits, [4_000]);
});

test('one file passing without the change is a gap even when another timed out', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello'), 'test/y.test.js': testAsserting('hello') });
  const changed: ChangedFile[] = [...SRC_AND_TEST, { path: 'test/y.test.js', from: null, status: 'added' }];
  const res = await checked(f, changed, async (_dir, cmd) => ({ passed: true, timedOut: cmd.includes('x.test.js'), output: '' }));
  assert.equal(res.status, 'gap');
  assert.deepEqual(res.files, [
    { file: 'test/x.test.js', outcome: 'timeout' },
    { file: 'test/y.test.js', outcome: 'passes-without-change' },
  ]);
});

test('files the total budget never reached are not-run, and the result is inconclusive', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, SRC_AND_TEST, neverRun, { totalBudgetMs: 0 });
  assert.equal(res.status, 'inconclusive');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'not-run' }]);
  assert.match(res.reason, /budget ran out/);
});

test('a test script that is not node --test is skipped, with nothing run', async (t) => {
  const f = fixture(t, { ...BASE_FILES, 'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'vitest run' } }) });
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello, world') });
  const res = await checked(f, SRC_AND_TEST, neverRun);
  assert.equal(res.status, 'skipped');
  assert.deepEqual(res.files, [{ file: 'test/x.test.js', outcome: 'not-run' }]);
});

test('the reverted tree carries the test side of the diff only: helpers copied, deleted and renamed-from tests gone', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.jail, 'test/old.test.js'));
  write(f.jail, {
    'src/x.js': NEW_SRC,
    'src/added.js': 'export const added = 1;\n',
    'test/helper.js': "export const expected = 'hello, world';\n",
    'test/renamed.test.js': "import test from 'node:test';\ntest('old', () => {});\n",
    'test/x.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/x.js';\nimport { expected } from './helper.js';\ntest('greet', () => assert.equal(greet(), expected));\n",
  });
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'src/added.js', from: null, status: 'added' },
    { path: 'test/helper.js', from: null, status: 'added' },
    { path: 'test/renamed.test.js', from: 'test/old.test.js', status: 'renamed' },
    { path: 'test/x.test.js', from: null, status: 'added' },
  ];
  let seen: Record<string, boolean | string> = {};
  const ran: string[] = [];
  const res = await checked(f, changed, (dir, cmd, ms) => {
    ran.push(cmd);
    seen = {
      src: fs.readFileSync(path.join(dir, 'src/x.js'), 'utf8'),
      added: fs.existsSync(path.join(dir, 'src/added.js')),
      helper: fs.existsSync(path.join(dir, 'test/helper.js')),
      old: fs.existsSync(path.join(dir, 'test/old.test.js')),
      renamed: fs.existsSync(path.join(dir, 'test/renamed.test.js')),
    };
    return cmd.includes('x.test.js') ? realRun(dir, cmd, ms) : Promise.resolve({ passed: false, timedOut: false, output: '' });
  });
  assert.deepEqual(seen, { src: BASE_FILES['src/x.js'], added: false, helper: true, old: false, renamed: true });
  // test/helper.js is on the test side but is not a file the test script runs, and test/renamed.test.js was moved
  // with its content unchanged: both are carried over, neither is run.
  assert.deepEqual(ran, ['node --test test/x.test.js']);
  assert.equal(res.status, 'pass', 'the helper import resolved in the reverted tree, and the assertion failed on the old source');
});

test('a changed helper under test/ alone is not a test in the diff', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/helper.js': 'export const h = 1;\n' });
  const res = await checked(f, [{ path: 'src/x.js', from: null, status: 'modified' }, { path: 'test/helper.js', from: null, status: 'added' }], neverRun);
  assert.equal(res.status, 'n/a');
  assert.match(res.reason, /no test in the diff/);
});

test('a scratch directory that already exists is left alone and the check is inconclusive', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello') });
  const taken = path.join(f.workRoot, 'revert-r1');
  write(taken, { 'keep.txt': 'not ours\n' });
  const res = await revertCheck({ repo: f.repo, jailDir: f.jail, base: f.base, changed: SRC_AND_TEST, workRoot: f.workRoot, runId: 'r1', run: neverRun });
  assert.equal(res.status, 'inconclusive');
  assert.equal(fs.readFileSync(path.join(taken, 'keep.txt'), 'utf8'), 'not ours\n');
});

test('the runner is required: a call wired without one is a type error and throws at once, for any diff, instead of running something unsandboxed', async (t) => {
  const f = fixture(t);
  write(f.jail, { 'src/x.js': NEW_SRC, 'test/x.test.js': testAsserting('hello') });
  const opts = { repo: f.repo, jailDir: f.jail, base: f.base, workRoot: f.workRoot, runId: 'r1' };
  // @ts-expect-error `run` is not optional: there is no built-in runner to fall back to
  await assert.rejects(revertCheck({ ...opts, changed: SRC_AND_TEST }), /revertCheck needs a runner/);
  // Also for a diff that never reaches a test (it used to answer n/a without looking at the runner).
  // @ts-expect-error as above
  await assert.rejects(revertCheck({ ...opts, changed: [] }), /revertCheck needs a runner/);
  assert.equal(fs.existsSync(path.join(f.workRoot, 'revert-r1')), false, 'nothing was set up');
});

// ---------------------------------------------------------- perFileTestCmd

test('perFileTestCmd keeps the node flags of the test script and aims it at one file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revert-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const withScript = (script: string | null): string | null => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(script === null ? {} : { scripts: { test: script } }));
    return perFileTestCmd(dir, 'test/a.test.ts');
  };
  assert.equal(withScript('node --test --test-timeout=180000 "test/*.test.ts"'), 'node --test-timeout=180000 --test test/a.test.ts');
  assert.equal(withScript('node --experimental-strip-types --test'), 'node --experimental-strip-types --test test/a.test.ts');
  assert.equal(withScript('node --test --test-reporter spec test/'), 'node --test-reporter spec --test test/a.test.ts');
  assert.equal(perFileTestCmd(dir, "test/it's a.test.ts"), `node --test-reporter spec --test 'test/it'\\''s a.test.ts'`);
  assert.equal(perFileTestCmd(dir, 'test/$(x);y.test.ts'), `node --test-reporter spec --test 'test/$(x);y.test.ts'`);
  assert.equal(withScript('vitest run'), null);
  assert.equal(withScript('npm run build && node --test'), null);
  assert.equal(withScript('node scripts/test.js'), null);
  assert.equal(withScript('node --test-timeout=5 run.js'), null, 'a flag that merely starts with --test is not the runner');
  assert.equal(withScript(null), null);
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
  assert.equal(perFileTestCmd(dir, 'test/a.test.ts'), null);
  fs.rmSync(path.join(dir, 'package.json'));
  assert.equal(perFileTestCmd(dir, 'test/a.test.ts'), null);
});

// ----------------------------------------------------------- appliesOnMain

/** The jail's tree with `files` written over it, as a tree object; the jail's index is restored afterwards. */
function treeWith(f: Fixture, files: Record<string, string>): string {
  write(f.jail, files);
  sh(f.jail, 'add', '-A');
  const tree = sh(f.jail, 'write-tree').trim();
  sh(f.jail, 'reset', '-q');
  return tree;
}

function advanceMain(f: Fixture, files: Record<string, string>): string {
  write(f.repo, files);
  sh(f.repo, 'add', '-A');
  sh(f.repo, 'commit', '-qm', 'main moved');
  return sh(f.repo, 'rev-parse', 'HEAD').trim();
}

const repoState = (f: Fixture): string => [
  sh(f.repo, 'for-each-ref'),
  sh(f.repo, 'status', '--porcelain=v2', '--branch'),
  sh(f.repo, 'worktree', 'list', '--porcelain'),
].join('\n--\n');

test('appliesOnMain: main moved with an overlapping edit is a conflict naming the file, and nothing in the repo moves', async (t) => {
  const f = fixture(t);
  const tree = treeWith(f, { 'src/x.js': NEW_SRC });
  const head = advanceMain(f, { 'src/x.js': "export const greet = () => 'goodbye';\n" });
  const before = repoState(f);
  const res = await appliesOnMain({ repo: f.repo, base: f.base, tree });
  assert.equal(res.status, 'conflict');
  assert.equal(res.head, head);
  assert.deepEqual(res.conflicted, ['src/x.js']);
  assert.equal(res.mergedTree, undefined);
  assert.equal(repoState(f), before);
  assert.equal(fs.readFileSync(path.join(f.repo, 'src/x.js'), 'utf8'), "export const greet = () => 'goodbye';\n", 'nothing was checked out');
});

test('appliesOnMain: main moved with a non-overlapping edit is clean, with the merged tree, and nothing in the repo moves', async (t) => {
  const f = fixture(t);
  const tree = treeWith(f, { 'src/x.js': NEW_SRC });
  const head = advanceMain(f, { 'src/other.js': 'export const other = 1;\n' });
  const before = repoState(f);
  const res = await appliesOnMain({ repo: f.repo, base: f.base, tree });
  assert.equal(res.status, 'clean');
  assert.equal(res.head, head);
  assert.deepEqual(res.conflicted, []);
  assert.equal(repoState(f), before);
  // The merged tree holds both sides.
  assert.equal(sh(f.repo, 'show', `${res.mergedTree}:src/x.js`), NEW_SRC);
  assert.equal(sh(f.repo, 'show', `${res.mergedTree}:src/other.js`), 'export const other = 1;\n');
});

test('appliesOnMain: HEAD still at the base is same-base', async (t) => {
  const f = fixture(t);
  const tree = treeWith(f, { 'src/x.js': NEW_SRC });
  const before = repoState(f);
  const objects = sh(f.repo, 'count-objects', '-v');
  const res = await appliesOnMain({ repo: f.repo, base: f.base, tree });
  assert.deepEqual(res, { status: 'same-base', head: f.base, conflicted: [] });
  assert.equal(repoState(f), before);
  assert.equal(sh(f.repo, 'count-objects', '-v'), objects, 'no commit was made for a question with a known answer');
});

// ------------------------------------------------------------ typecheckCmd

test('typecheckCmd: tsc when there is a tsconfig and the gate does not already typecheck', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revert-tsc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(typecheckCmd(dir, 'npm test --silent'), null, 'no tsconfig.json');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  assert.equal(typecheckCmd(dir, 'npm test --silent'), 'npx tsc --noEmit');
  assert.equal(typecheckCmd(dir, null), 'npx tsc --noEmit');
  assert.equal(typecheckCmd(dir, 'npm run verify --silent'), null);
  assert.equal(typecheckCmd(dir, 'npx tsc --noEmit && npm test'), null);
});

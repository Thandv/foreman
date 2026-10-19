import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChangedFile } from '../src/isolate.ts';
import { revertCheck } from '../src/verify/revertCheck.ts';

/**
 * A test script with more than one reporter. The report is read when the only reporter that prints is spec or tap
 * (Kiln: spec to stdout, a skip list to a file); every other arrangement stays "cannot tell". The runner is a
 * stand-in that returns a canned report, so what is tested is which reports are read, not node's output.
 */

const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const KILN = '--test-timeout=180000 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/skip-reporter.mjs --test-reporter-destination=test-skips.log';
const CHANGED: ChangedFile[] = [
  { path: 'src/x.js', from: null, status: 'modified' },
  { path: 'test/x.test.js', from: null, status: 'added' },
];
/** spec, one real test failing in a file that loaded. */
const RAN = '✖ greets the world (1.2ms)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n\n✖ failing tests:\n\ntest at test/x.test.js:4:1\n✖ greets the world (1.2ms)\n  AssertionError: no\n';
/** spec, the file did not load: one failure named after the file, located at its top. */
const DID_NOT_LOAD = '✖ test/x.test.js (30ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1\n\n✖ failing tests:\n\ntest at test/x.test.js:1:1\n✖ test/x.test.js (30ms)\n  \'test failed\'\n';

async function check(t: TestContext, flags: string, output: string): Promise<{ res: Awaited<ReturnType<typeof revertCheck>>; cmd: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revert-reporters-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: `node --test ${flags} "test/*.test.js"` } }));
  fs.writeFileSync(path.join(repo, 'src/x.js'), "export const greet = () => 'hello';\n");
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  fs.writeFileSync(path.join(jail, 'src/x.js'), "export const greet = () => 'hello, world';\n");
  fs.mkdirSync(path.join(jail, 'test'));
  fs.writeFileSync(path.join(jail, 'test/x.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
  let cmd = '';
  const res = await revertCheck({
    repo, jailDir: jail, base: sh(repo, 'rev-parse', 'HEAD').trim(), changed: CHANGED, workRoot: path.join(root, 'work'), runId: 'r1',
    run: async (_dir, c) => { cmd = c; return { passed: false, timedOut: false, output }; },
  });
  return { res, cmd };
}

test('spec to stdout beside a second reporter written to a file (Kiln\'s test script): the report is read', async (t) => {
  const ran = await check(t, KILN, RAN);
  assert.equal(ran.res.status, 'pass');
  assert.equal('loadUnknown' in ran.res, false, 'a test ran and failed: nothing is unknown');
  assert.equal('loadErrors' in ran.res, false);
  assert.equal(ran.res.reason, '1 changed test file fails without the change');
  assert.equal(ran.cmd, `node ${KILN} --test test/x.test.js`, 'the file is run with the script\'s own flags');

  const unloaded = await check(t, KILN, DID_NOT_LOAD);
  assert.equal(unloaded.res.status, 'pass');
  assert.deepEqual(unloaded.res.loadErrors, ['test/x.test.js'], 'and a file that did not load is still told apart');
  assert.equal('loadUnknown' in unloaded.res, false);
});

for (const [flags, why] of [
  ['--test-reporter=junit --test-reporter-destination=stdout --test-reporter=spec --test-reporter-destination=spec.txt', 'the test reporter is not spec or tap'],
  ['--test-reporter=spec --test-reporter-destination=a.txt --test-reporter=tap --test-reporter-destination=b.txt', 'the test report is written to a file'],
  ['--test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=stderr', 'more than one test reporter prints its report'],
  ['--test-reporter=spec --test-reporter-destination=stdout --test-reporter=dot --test-reporter-destination=stdout', 'more than one test reporter prints its report'],
  // Not paired one to one: node refuses to start on this, so nothing is read off it.
  ['--test-reporter=spec --test-reporter=./r.mjs --test-reporter-destination=stdout', 'the test reporter is not spec or tap'],
] as const) {
  test(`several reporters, not readable (${why}): ${flags}`, async (t) => {
    const { res } = await check(t, flags, RAN);
    assert.equal(res.status, 'pass', 'the status is the outcome\'s, as before');
    assert.deepEqual(res.loadUnknown, ['test/x.test.js']);
    assert.equal('loadErrors' in res, false);
    assert.equal(res.reason, `1 changed test file fails without the change; cannot tell whether any test ran (${why}) in: test/x.test.js`);
  });
}

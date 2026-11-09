import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxSkipProblems } from '../scripts/ci/sandbox-not-skipped.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'ci', 'sandbox-not-skipped.ts');

/** The script over `output` saved to a file, as the macOS CI job runs it. */
function run(output: string): { status: number | null; text: string } {
  const file = path.join(scratchDir('foreman-ci-skip-'), 'node-test.txt');
  fs.writeFileSync(file, output);
  const r = spawnSync(process.execPath, [script, file], { cwd: root, encoding: 'utf8' });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
}

const summary = (skipped: number): string[] =>
  [`ℹ tests 4`, 'ℹ suites 0', `ℹ pass ${4 - skipped}`, 'ℹ fail 0', 'ℹ cancelled 0', `ℹ skipped ${skipped}`, 'ℹ todo 0', 'ℹ duration_ms 12.5'];

// What the spec reporter prints when test/sandbox.test.ts finds no usable sandbox-exec (colour codes and all).
const SKIPPED_SANDBOX = [
  '✔ the switch: unset is tests (1.2ms)',
  '\x1b[90m﹣ attack: a test command cannot write the home \x1b[90m(0.05ms)\x1b[39m # the sandbox cannot be exercised here: this suite is already running inside a sandbox\x1b[39m',
  '✔ a server on 127.0.0.1:0 answers its own client (3.1ms)',
  '✔ temp files, the home dir and the user name (0.4ms)',
  ...summary(1),
].join('\n');

const NONE_SKIPPED = [
  '✔ the switch: unset is tests (1.2ms)',
  '✔ attack: a test command cannot write the home (812.3ms)',
  '✔ a server on 127.0.0.1:0 answers its own client (3.1ms)',
  '✔ temp files, the home dir and the user name (0.4ms)',
  ...summary(0),
].join('\n');

test('a skipped sandbox test fails the script, naming the test and the reason', () => {
  const r = run(SKIPPED_SANDBOX);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /attack: a test command cannot write the home/);
  assert.match(r.text, /already running inside a sandbox/);
});

test('a run with 0 skipped passes', () => {
  const r = run(NONE_SKIPPED);
  assert.equal(r.status, 0, r.text);
});

test('a skip with a reason that is not the sandbox is not a sandbox skip', () => {
  const out = NONE_SKIPPED.replace('✔ temp files, the home dir and the user name (0.4ms)', '﹣ chmod 000 refuses a manifest (0.1ms) # root reads any directory')
    .replace('ℹ skipped 0', 'ℹ skipped 1');
  assert.deepEqual(sandboxSkipProblems(out), []);
});

test('the TAP reporter\'s skip line is read too', () => {
  const tap = ['ok 1 - the switch', 'ok 2 - attack: a jail # SKIP the sandbox cannot be exercised here: sandbox-exec missing', '# tests 2', '# skipped 1'].join('\n');
  assert.equal(sandboxSkipProblems(tap).length, 1);
});

test('fails closed: no summary (the suite did not run), or more skips counted than could be read', () => {
  assert.equal(run('').status, 1);
  assert.match(sandboxSkipProblems('✔ one (1ms)\n')[0] ?? '', /no "skipped" count/);
  const unread = NONE_SKIPPED.replace('ℹ skipped 0', 'ℹ skipped 2');
  assert.match(sandboxSkipProblems(unread)[0] ?? '', /2 skipped/);
});

test('a missing or unreadable output file fails with a usage line, not a pass', () => {
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

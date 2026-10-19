import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERIFY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify.sh');

/**
 * A throwaway project running a copy of scripts/verify.sh: the compiler the
 * script runs, `node_modules/.bin/tsgo`, is a stub (exit `tscStatus`; the
 * typecheck is not what is under test) — or absent, given `tsgo: false` — and
 * `npm test` runs `suite` — or, given `npm`, a stub npm with that shell body.
 * `tsc` and `npx` are always there and always exit 0: nothing may reach them.
 */
function runVerify(suite: string, opts: { npm?: string; tscStatus?: number; tsgo?: boolean; tmpdir?: string; env?: Record<string, string> } = {}): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verifysh-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(VERIFY, path.join(dir, 'scripts', 'verify.sh'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test suite.test.mjs' } }));
    fs.writeFileSync(path.join(dir, 'suite.test.mjs'), suite);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const local = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(local, { recursive: true });
    const stub = (name: string, body: string, at = bin): void => {
      fs.writeFileSync(path.join(at, name), `#!/bin/bash\n${body}\n`);
      fs.chmodSync(path.join(at, name), 0o755);
    };
    if (opts.tsgo !== false) stub('tsgo', `exit ${opts.tscStatus ?? 0}`, local);
    stub('tsc', 'echo FELL-BACK-TO-TSC\nexit 0', local);
    stub('tsc', 'echo FELL-BACK-TO-TSC\nexit 0');
    stub('npx', 'echo WENT-THROUGH-NPX\nexit 0');
    if (opts.npm !== undefined) stub('npm', opts.npm);
    // Without NODE_TEST_CONTEXT, or the nested `node --test` thinks it is recursing and runs nothing.
    // Colour settings are the caller's to choose: the suite itself may run with FORCE_COLOR set.
    const { NODE_TEST_CONTEXT: _ctx, FORCE_COLOR: _fc, NO_COLOR: _nc, ...env } = process.env;
    const r = spawnSync('bash', [path.join(dir, 'scripts', 'verify.sh')], {
      encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${process.env['PATH']}`, ...(opts.tmpdir ? { TMPDIR: opts.tmpdir } : {}), ...(opts.env ?? {}) },
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('verify.sh shows a failing test\'s assertion, not just the summary, and keeps the suite\'s exit status', () => {
  // The marked failure comes first; four more after it push it far past any short tail.
  const failing = Array.from({ length: 5 }, (_, i) =>
    `test('failure ${i}', () => { assert.equal(${i}, -1, ${JSON.stringify(i === 0 ? 'FIRST-FAILURE-MARKER' : `other failure ${i}`)}); });`,
  ).join('\n');
  const passing = Array.from({ length: 40 }, (_, i) => `test('passes ${i}', () => {});`).join('\n');
  const r = runVerify(`import test from 'node:test';\nimport assert from 'node:assert/strict';\n${failing}\n${passing}\n`);
  assert.equal(r.status, 1, 'the suite\'s own failing status');
  assert.match(r.out, /FIRST-FAILURE-MARKER/);
});

const lastLine = (out: string): string => out.trimEnd().split('\n').pop() ?? '';

test('verify.sh on a passing suite exits 0 with its counts and ends on "verify: PASS"', () => {
  const r = runVerify(`import test from 'node:test';\ntest('ok', () => {});\n`);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pass 1/);
  assert.equal(lastLine(r.out), 'verify: PASS');
});

test('verify.sh on a passing suite with a failing TODO test says PASS and does not end on that test\'s assertion', () => {
  // The operator ran a green verify and read it as a failure: the runner prints a TODO test's assertion in full at the
  // very end of a passing run, and the old 12-line tail was that stack trace with no word that the suite had passed.
  const suite =
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\n` +
    `test('ok', () => {});\n` +
    `test('a known gap', { todo: true }, () => { assert.deepEqual({ a: ['KNOWN-GAP-MARKER'] }, { a: [] }); });\n`;
  const r = runVerify(suite);
  assert.equal(r.status, 0, r.out);
  assert.equal(lastLine(r.out), 'verify: PASS');
  assert.match(r.out, /1 known-gap test\(s\) are marked TODO/);
  assert.match(r.out, /todo 1/);
  assert.doesNotMatch(r.out, /ERR_ASSERTION|KNOWN-GAP-MARKER/, 'a passing run does not print a TODO test\'s assertion');
});

test('verify.sh ends a failing run on "verify: FAIL" naming the step and its status', () => {
  const fail = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('no', () => assert.equal(1, 2));\n`;
  const tests = runVerify(fail);
  assert.equal(tests.status, 1);
  assert.equal(lastLine(tests.out), 'verify: FAIL (tests exited 1)');
  const tsc = runVerify(fail, { tscStatus: 2 });
  assert.equal(tsc.status, 2);
  assert.equal(lastLine(tsc.out), 'verify: FAIL (typecheck exited 2)');
  assert.doesNotMatch(tsc.out, /tests…/, 'the suite does not run after a failed typecheck');
});

test('verify.sh fails the typecheck step when the native compiler is not installed, and does not fall back to tsc', () => {
  // A passing suite, and a tsc and an npx that would both say yes: only the missing compiler can fail this run.
  const r = runVerify(`import test from 'node:test';\ntest('ok', () => {});\n`, { tsgo: false });
  // Non-zero, whichever the shell gives a path that is not there: 127 from bash 5, 1 from macOS's 3.2 under `||`.
  assert.ok(r.status === 127 || r.status === 1, r.out);
  // The shell's complaint is on stderr, which runVerify appends: the verdict is stdout's last line, not the last of both.
  assert.ok(r.out.split('\n').includes(`verify: FAIL (typecheck exited ${r.status})`), r.out);
  assert.match(r.out, /tsgo/, 'the output names what is missing');
  assert.doesNotMatch(r.out, /FELL-BACK-TO-TSC|WENT-THROUGH-NPX/);
  assert.doesNotMatch(r.out, /tests…/, 'the suite does not run after a failed typecheck');
});

test('verify.sh prints the failing blocks last, so the last 40 lines carry the assertion', () => {
  // A suite whose failure comes early and is followed by plenty of other output.
  const noise = Array.from({ length: 120 }, (_, i) => `echo "ok ${i + 2} - noise ${i}"`).join('\n');
  const r = runVerify('', { npm: `echo "not ok 1 - the broken one"\necho "  ---"\necho "  error: 'EARLY-FAILURE-MARKER'"\necho "  ..."\n${noise}\nexit 1` });
  assert.equal(r.status, 1);
  assert.match(r.out.trimEnd().split('\n').slice(-40).join('\n'), /EARLY-FAILURE-MARKER/);
});

test('verify.sh exits with the failing step\'s own status in every case', () => {
  const pass = `import test from 'node:test';\ntest('ok', () => {});\n`;
  const fail = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('no', () => assert.equal(1, 2));\n`;
  const matrix: Array<[string, () => { status: number | null }, number]> = [
    ['failing test', () => runVerify(fail), 1],
    ['tsc fails', () => runVerify(pass, { tscStatus: 2 }), 2],
    ['suite SIGKILLed', () => runVerify('', { npm: 'echo started\nkill -KILL $$' }), 137],
    ['suite SIGTERMed', () => runVerify('', { npm: 'echo started\nkill -TERM $$' }), 143],
    ['no trailing newline, exit 3', () => runVerify('', { npm: "printf 'no newline'\nexit 3" }), 3],
    ['mktemp fails', () => runVerify(pass, { tmpdir: '/nonexistent/foreman-verify-tmp' }), 1],
    ['pass', () => runVerify(pass), 0],
  ];
  for (const [name, run, want] of matrix) assert.equal(run().status, want, name);
});

test('verify.sh prints the counts and the TODO note when the runner colours its output', () => {
  // Inside a Foreman test run FORCE_COLOR is set, every count line starts with an escape sequence, and the first
  // version of the verdict line printed "verify: PASS" with no counts: this suite then failed its own gate.
  const suite =
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\n` +
    `test('ok', () => {});\ntest('a known gap', { todo: true }, () => { assert.equal(1, 2); });\n`;
  const r = runVerify(suite, { env: { FORCE_COLOR: '1' } });
  assert.equal(r.status, 0, r.out);
  // ℹ from the spec reporter (Node 23+ by default), # from TAP (Node 22 with no TTY): either, but bare.
  assert.match(r.out, /^(ℹ|#) pass 1$/m, 'the count line is printed without its colour codes');
  assert.doesNotMatch(r.out, /\x1b\[/, 'no colour code reaches the summary');
  assert.match(r.out, /1 known-gap test\(s\) are marked TODO/);
  assert.equal(lastLine(r.out), 'verify: PASS');
});

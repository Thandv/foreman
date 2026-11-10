import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, effectiveConfig } from '../src/config.ts';
import { shellBrief, TARGETED_BRIEF } from '../src/scheduler.ts';
import { testSlotCommand, workerShellAllowlist, workerShellDenylist } from '../src/runners/cliRunners.ts';
import { readWorkerSuite } from '../src/verify/workerSuite.ts';

// FOREMAN_WORKER_SUITE (docs/configuration.md): the claude worker's tools, its shell brief and the worker-suite line,
// pinned byte for byte as they were before the setting existed. The default must leave every one of them unchanged.

const W = testSlotCommand();

const ALLOWED = ['--allowedTools', `Bash(${W}:*)`, 'Bash(npm run:*)', 'Bash(npx tsc:*)', 'Bash(node --test:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const DENIED = ['--disallowedTools', 'Bash(npm test:*)', 'Bash(npm t:*)', 'Bash(npm run test:*)', 'Bash(npm run verify:*)',
  'WebSearch', 'WebFetch'];

const BRIEF =
  '\n---\nSHELL: this session is headless and nobody can approve a command. These run without approval: ' +
  `${W}, npm run, npx tsc, node --test, git status, git diff, git log, git show (plus read-only inspection). ` +
  'Anything else — a bare interpreter, compiler or script — is refused. To run another tool, add a script to ' +
  'package.json and run it with `npm run <script>`; that script is part of your diff and is reviewed. ' +
  `Run the FULL test suite only as \`${W}\` (it waits for a shared test slot, runs this ticket's test command and ` +
  'exits with its result; append `-- npm run <script>` for another suite script). Run it in the FOREGROUND with the ' +
  'longest Bash timeout: never with run_in_background, and never end your turn while a test run is still going. A ' +
  'single targeted test file may be run directly with `node --test <file>`. These are refused when run directly — use ' +
  'the wrapper: npm test, npm t, npm run test, npm run verify. Run the full suite through the wrapper ONCE, alone, at ' +
  'the end — never start two suite runs at once; while iterating use `node --test <one file>`. The wrapper saves the ' +
  'full output to a file and prints its path on its last line: to see more of a run, read that file (or run the ' +
  'wrapper with `--saved`), do not run the suite again. Run the suite yourself before you finish and report its ' +
  'result. Acceptance items only a person can check (live in a browser or app, visual, marked "(operator)") are run ' +
  'by the operator at the gate: build for them, but do not try to run or report them.';

const NONE_LINE = 'the worker never ran the suite';

for (const testCmd of ['npm run verify', null]) {
  test(`unset, the worker's tools, brief and worker-suite line are as pinned (testCmd ${testCmd})`, () => {
    assert.equal(process.env['FOREMAN_WORKER_SUITE'], undefined);
    assert.deepEqual(workerShellAllowlist({ testCmd }), ALLOWED);
    assert.deepEqual(workerShellDenylist({ testCmd }), DENIED);
    assert.equal(shellBrief({ runner: 'claude-code', testCmd }), BRIEF);
    assert.equal(shellBrief({ runner: 'codex-cli', testCmd }), '');
    assert.equal(readWorkerSuite(null, 'r_1', null).line, NONE_LINE);
    assert.equal(readWorkerSuite(scratchDir('foreman-wsp-'), 'r_1', null).line, NONE_LINE);
  });
}

function targeted(t: test.TestContext): void {
  process.env['FOREMAN_WORKER_SUITE'] = 'targeted';
  t.after(() => delete process.env['FOREMAN_WORKER_SUITE']);
}

for (const testCmd of ['npm run verify', null]) {
  test(`targeted: the same tools, a brief for targeted runs only, and the policy on the worker-suite line (testCmd ${testCmd})`, (t) => {
    targeted(t);
    assert.equal(config.workerSuite, 'targeted');
    // Advisory: the wrapper stays allowed, so a full run the worker still makes takes a verify slot.
    assert.deepEqual(workerShellAllowlist({ testCmd }), ALLOWED);
    assert.deepEqual(workerShellDenylist({ testCmd }), DENIED);
    const brief = shellBrief({ runner: 'claude-code', testCmd });
    assert.ok(brief.includes(TARGETED_BRIEF), 'targeted runs only, and the gate runs the full suite');
    assert.ok(brief.includes(`Only if you must run the whole suite, use \`${W}\``), 'the wrapper is the only route for a full run');
    assert.ok(brief.includes('use the wrapper: npm test, npm t, npm run test, npm run verify. '));
    assert.doesNotMatch(brief, /Run the suite yourself before you finish|ONCE, alone, at the end|Run the FULL test suite/);
    assert.ok(brief.startsWith(BRIEF.slice(0, BRIEF.indexOf('Run the FULL'))), 'what runs without approval is unchanged');
    assert.ok(brief.endsWith(BRIEF.slice(BRIEF.indexOf('Acceptance items'))), 'the operator line is unchanged');
    assert.equal(shellBrief({ runner: 'codex-cli', testCmd }), `\n---\nTESTS: ${TARGETED_BRIEF}`, 'codex: the brief only');
    for (const runner of ['api', 'shell', 'echo'] as const) assert.equal(shellBrief({ runner, testCmd }), '');
    assert.equal(readWorkerSuite(null, 'r_1', null).line, 'worker suite: not run (FOREMAN_WORKER_SUITE=targeted)');
  });
}

test('targeted: a worker run through the wrapper that did happen is reported as before', (t) => {
  targeted(t);
  const out = scratchDir('foreman-wsp-');
  const log = path.join(out, 'r_1-1-1.log');
  fs.writeFileSync(log, 'some output\n');
  fs.writeFileSync(log.replace(/\.log$/, '.result'), 'testSlot: npm test PASSED\n');
  assert.match(readWorkerSuite(out, 'r_1', null).line, /^worker suite: PASSED at .* \(advisory, written by worker-side code\)$/);
});

test('targeted without the wrapper allowed: targeted runs, in the foreground', (t) => {
  targeted(t);
  process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'] = 'Bash(make:*)';
  t.after(() => delete process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS']);
  const brief = shellBrief({ runner: 'claude-code', testCmd: 'make test' });
  assert.ok(brief.includes(`${TARGETED_BRIEF}Run them in the foreground before you finish. `));
  assert.doesNotMatch(brief, /wrapper/);
});

test('FOREMAN_WORKER_SUITE: anything but targeted is full, and config --effective lists it', (t) => {
  t.after(() => delete process.env['FOREMAN_WORKER_SUITE']);
  for (const [raw, want] of [[' Targeted ', 'targeted'], ['full', 'full'], ['', 'full'], ['bogus', 'full']] as const) {
    process.env['FOREMAN_WORKER_SUITE'] = raw;
    assert.equal(config.workerSuite, want, JSON.stringify(raw));
  }
  delete process.env['FOREMAN_WORKER_SUITE'];
  assert.deepEqual(effectiveConfig().knobs.find((k) => k.name === 'FOREMAN_WORKER_SUITE'), { name: 'FOREMAN_WORKER_SUITE', value: 'full', source: 'default' });
  process.env['FOREMAN_WORKER_SUITE'] = 'targeted';
  assert.deepEqual(effectiveConfig().knobs.find((k) => k.name === 'FOREMAN_WORKER_SUITE'), { name: 'FOREMAN_WORKER_SUITE', value: 'targeted', source: 'env' });
});

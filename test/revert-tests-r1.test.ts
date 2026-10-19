import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerGate, ownerGateBatch } from '../src/gate.ts';
import { jailTree } from '../src/isolate.ts';
import { clearPlaybookCache } from '../src/playbooks.ts';
import { Store } from '../src/queue.ts';
import type { Run, Task } from '../src/types.ts';
import { findTests, namePatternFor } from '../src/verify/testNames.ts';
import { recordRevertTests, revertTestsCheck, type RevertRunResult, type RevertTestsResult } from '../src/verify/revertTests.ts';
import { runTests } from '../src/verify/tests.ts';

/**
 * Review r1 of the per-test revert check: what a worker can put in the repo's git directory or in its test names
 * must not run a program in the daemon or hold its event loop; one name used twice is attributed call by call; and
 * the table reaches the owner model in a batch too, which can still approve over a test that passes without the change.
 */

delete process.env['NODE_TEST_CONTEXT'];
const T = { timeout: 300_000 };
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const H = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a, b } from '../src/a.js';\n";

interface Fx { root: string; repo: string; jail: string; base: string; workRoot: string }

function fixture(t: TestContext, baseTest: string | null = null): Fx {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt1-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\nexport const b = 0;\n');
  if (baseTest !== null) {
    fs.mkdirSync(path.join(repo, 'test'));
    fs.writeFileSync(path.join(repo, 'test/a.test.js'), H + baseTest);
  }
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  return { root, repo, jail, base: sh(repo, 'rev-parse', 'HEAD').trim(), workRoot: path.join(root, 'work') };
}

const run = async (dir: string, cmd: string, timeoutMs: number): Promise<RevertRunResult> => {
  const lines: string[] = [];
  const r = await runTests(dir, cmd, new AbortController().signal, (l) => lines.push(l), undefined, { timeoutMs });
  return { passed: r.passed, timedOut: r.killedAfterSec !== undefined, refused: r.refused === true, output: lines.join('\n') };
};

/** `b` is 0 at the base and 1 after: a test of `b === 1` fails without the change, one of `a === 1` passes anyway. */
async function check(f: Fx, testFile: string, afterTree?: () => void): Promise<RevertTestsResult> {
  fs.writeFileSync(path.join(f.jail, 'src/a.js'), 'export const a = 1;\nexport const b = 1;\n');
  fs.mkdirSync(path.join(f.jail, 'test'), { recursive: true });
  fs.writeFileSync(path.join(f.jail, 'test/a.test.js'), H + testFile);
  const tree = await jailTree(f.jail);
  afterTree?.();
  const res = await revertTestsCheck({ repo: f.repo, base: f.base, tree, workRoot: f.workRoot, runId: 'r1', run });
  assert.ok(res);
  return res;
}

const rows = (r: RevertTestsResult): string[] => r.tests.map((x) => `${x.line} ${x.name} ${x.outcome}`);

test('a filter driver the worker names in the repo\'s config and info/attributes is not run by the checkout at the base', T, async (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, 'FILTER-RAN');
  const prog = path.join(f.root, 'filter.sh');
  fs.writeFileSync(prog, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  // What a worker outside the sandbox can write: its jail's git directory is the repo's. Written after the reviewed
  // tree is taken, because taking it (jailTree's `git add -A`) runs a clean filter too — on main, not this check's.
  const plant = (): void => {
    sh(f.jail, 'config', 'filter.evil.smudge', prog);
    sh(f.jail, 'config', 'filter.Also.Dotted.process', prog);
    fs.mkdirSync(path.join(f.repo, '.git/info'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, '.git/info/attributes'), '*.js filter=evil\n*.json filter=Also.Dotted\n');
  };
  const res = await check(f, "test('real', () => assert.equal(b, 1));\n", plant);
  assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  assert.deepEqual(rows(res), ['4 real fails-without-change'], 'and the check still ran');
});

test('one name used twice: each call gets its own result, whichever comes first; a new vacuous test named like an old one is not hidden', T, async (t) => {
  const meaningfulFirst = await check(fixture(t), "test('same', () => assert.equal(b, 1));\ntest('same', () => assert.equal(a, 1));\n");
  assert.deepEqual(rows(meaningfulFirst), ['4 same fails-without-change', '5 same passes-without-change']);
  const vacuousFirst = await check(fixture(t), "test('same', () => assert.equal(a, 1));\ntest('same', () => assert.equal(b, 1));\n");
  assert.deepEqual(rows(vacuousFirst), ['4 same passes-without-change', '5 same fails-without-change']);
  const collides = await check(fixture(t, "test('old', () => assert.equal(a, 1));\n"), "test('old', () => assert.equal(a, 1));\ntest('old', () => assert.ok(true));\n");
  assert.deepEqual(rows(collides), ['5 old passes-without-change']);
});

test('a template name with two holes or more has no pattern (it would backtrack without end on a name it misses)', () => {
  const one = findTests('test(`a ${x} b`, () => {});');
  assert.equal(one[0]!.namePattern, 'a .* b', 'one hole: a pattern, linear to match');
  const two = findTests('test(`a${x}a${y}b`, () => {});\ntest(`${"a".repeat(25)}`, () => {});');
  assert.equal(two[0]!.namePattern, null);
  assert.equal(namePatternFor(two, 0), null, 'so the file runs unfiltered');
});

test('the daemon\'s event loop is not held by a worker\'s test names (25-hole template, a 40-character name)', T, () => {
  // In a child: the regex this guards against blocks the event loop, so no timer here could fire.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt1-redos-')), 'child.ts');
  fs.writeFileSync(child, `
import ${JSON.stringify(path.join(here, 'env.ts'))};
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { jailTree } from ${JSON.stringify(path.join(here, '../src/isolate.ts'))};
import { revertTestsCheck } from ${JSON.stringify(path.join(here, '../src/verify/revertTests.ts'))};
import { runTests } from ${JSON.stringify(path.join(here, '../src/verify/tests.ts'))};
delete process.env.NODE_TEST_CONTEXT;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt1-redos-fx-')));
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const repo = path.join(root, 'repo'); const jail = path.join(root, 'jail');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }));
fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\\n');
g(repo, 'init', '-q', '-b', 'main'); g(repo, 'add', '-A'); g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
g(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
fs.writeFileSync(path.join(jail, 'src/a.js'), 'export const a = 2;\\n');
fs.mkdirSync(path.join(jail, 'test'));
fs.writeFileSync(path.join(jail, 'test/a.test.js'), "import test from 'node:test';\\nconst v = 'dyn';\\n" +
  'test(\`' + 'a\${1}'.repeat(25) + 'b\`, () => {});\\ntest(v, () => {});\\ntest(\\'' + 'a'.repeat(40) + "', () => {});\\n");
const res = await revertTestsCheck({ repo, base: g(repo, 'rev-parse', 'HEAD').trim(), tree: await jailTree(jail), workRoot: path.join(root, 'work'), runId: 'r1',
  run: async (dir, cmd, timeoutMs) => { const lines = []; const r = await runTests(dir, cmd, new AbortController().signal, (l) => lines.push(l), undefined, { timeoutMs }); return { passed: r.passed, timedOut: false, output: lines.join('\\n') }; } });
fs.rmSync(root, { recursive: true, force: true });
console.log('ROWS ' + JSON.stringify(res.tests.map((t) => t.outcome)));
`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env } });
  fs.rmSync(path.dirname(child), { recursive: true, force: true });
  // Before the fix this name took about 5 s x 3.3^4 (some ten minutes) in one regex test; after it, about a second in all.
  assert.equal(r.signal, null, `killed at the 60 s guard after ${Date.now() - started} ms: the event loop was held`);
  assert.match(r.stdout, /ROWS \["passes-without-change","passes-without-change","passes-without-change"\]/, r.stderr);
});

// ------------------------------------------------------------------ the owner model, single and batched

const AUTO = `---\n${JSON.stringify({
  id: 'auto', description: 'Autonomous delivery.', triggers: ['auto'],
  roles: { planner: { tier: 'owner' }, dev: { tier: 'worker' } }, reviewers: [],
  escalation: { chair: 'planner', afterFailures: 2 }, checks: [], gate: { default: 'owner', hardHuman: ['S2', 'budget', 'allowCore'] }, constraints: [],
}, null, 2)}\n---\n## role: planner\n\nYou plan.\n\n## role: dev\n\nYou build.\n`;

function ownerRig(t: TestContext, reply: string): { store: Store; prompts: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt1-owner-'));
  fs.writeFileSync(path.join(dir, 'auto.md'), AUTO);
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  clearPlaybookCache();
  const log = path.join(dir, 'prompts');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(path.join(dir, 'reply'), reply);
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\ncat '${path.join(dir, 'reply')}'\n`, { mode: 0o755 });
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const store = new Store(':memory:');
  t.after(() => {
    delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    delete process.env['FOREMAN_CLAUDE_BIN'];
    clearPlaybookCache();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, prompts: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

const PASSING: RevertTestsResult = {
  version: 1, status: 'ran', reason: '1 changed test(s)', unattributed: [], runMs: 5, runs: 1,
  tests: [{ file: 'test/a.test.js', name: 'still doubles', line: 5, change: 'added', outcome: 'passes-without-change', detail: '' }],
};

/** A ticket parked green, reviewed, with a stored per-test table in which a new test passes without the change. */
function parkedWithTable(store: Store, title: string, parentId?: string): { task: Task; run: Run } {
  const task = store.addTask({ title, prompt: 'p', kind: 'code', runner: 'echo', acceptance: 'a', playbook: 'auto', role: 'dev', ...(parentId ? { parentId } : {}) });
  const run = store.startRun(task.id);
  store.setTestsPassed(run.id, true);
  store.addVerdict({
    runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, critique: 'fine',
    council: [{ model: 'local-0', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: 'fine', costUsd: 0, latencyMs: 5 }],
  });
  recordRevertTests(store, run.id, task.id, PASSING);
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, run: store.getRun(run.id)! };
}

const envelope = (result: unknown): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: JSON.stringify(result) });

test('owner gate: a test that passes without the change is shown to the owner model and holds nothing — it approves', T, async (t) => {
  const r = ownerRig(t, envelope({ decision: 'approve', rationale: 'in scope' }));
  const { task, run } = parkedWithTable(r.store, 'one');
  const decision = await ownerGate({ task, run, store: r.store });
  assert.equal(decision, 'approved', JSON.stringify(r.store.eventsForTask(task.id).map((e) => e.message)));
  assert.match(r.prompts(), /FOREMAN REVERT CHECK[\s\S]*\[PASSES without the change\] test\/a\.test\.js:5 "still doubles"/);
});

test('owner gate, batched: every ticket\'s table is in the batch prompt, and the batch can approve them', T, async (t) => {
  const r = ownerRig(t, '');
  const epic = r.store.addTask({ title: 'epic', prompt: 'e', runner: 'echo', playbook: 'auto', isEpic: true });
  const items = ['one', 'two'].map((n) => parkedWithTable(r.store, n, epic.id));
  const ids = items.map((i) => i.task.id);
  fs.writeFileSync(path.join(process.env['FOREMAN_PLAYBOOKS_DIR']!, 'reply'), envelope({ decisions: ids.map((id) => ({ id, decision: 'approve', rationale: 'ok' })) }));
  const out = await ownerGateBatch({ items: items.map(({ task, run }) => ({ task, run })), store: r.store });
  assert.deepEqual(ids.map((id) => out.get(id)), ['approved', 'approved']);
  assert.equal((r.prompts().match(/FOREMAN REVERT CHECK/g) ?? []).length, 2, r.prompts().slice(0, 2000));
});

// ------------------------------------------------------------------ in the scheduler: a check that could not run

test('scheduler: a check that could not run as a whole fails, repairs and holds nothing; the reviewer is told', T, async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rt1-sched-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  // The package's own test script is not `node --test`, so the check cannot run one file; the ticket's command is.
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', type: 'module', scripts: { test: 'echo not node test' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\nexport const b = 0;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  const { Scheduler } = await import('../src/scheduler.ts');
  const store = new Store(':memory:');
  const reviews: string[] = [];
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1, revertTests: true,
    verify: async (args) => {
      reviews.push(args.evidence.logTail ?? '');
      return store.addVerdict({
        runId: args.runId, taskId: args.task.id, verdict: 'pass', disagreement: false, critique: 'read',
        council: [{ model: 'local-0', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: 'read', costUsd: 0, latencyMs: 5 }],
      });
    },
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const body = `${H}test('real', () => assert.equal(b, 1));`;
  const prompt = `cat > src/a.js <<'EOF'\nexport const a = 1;\nexport const b = 1;\nEOF\nmkdir -p test && cat > test/a.test.js <<'EOF'\n${body}\nEOF`;
  const task = store.addTask({ title: 'ticket', kind: 'code', runner: 'shell', repo, testCmd: 'node --test', prompt });
  const deadline = Date.now() + 240_000;
  while (['queued', 'ready', 'running', 'verifying'].includes(store.getTask(task.id)!.status) || sched.activeCount || sched.verifyingCount) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
  const after = store.getTask(task.id)!;
  const run = store.latestRun(task.id)!;
  assert.equal(after.status, 'awaiting-approval', after.error ?? '');
  assert.equal(run.testsPassed, true, 'the test stage stands');
  assert.equal(store.runsForTask(task.id).length, 1, 'no repair round');
  assert.equal(reviews.length, 1);
  assert.match(reviews[0]!, /FOREMAN REVERT CHECK[\s\S]*the check could not run: the test script is not `node --test`[\s\S]*could not run: 1/);
  const row = store.artifactsForTask(task.id).find((a) => a.type === 'revert-tests')!;
  assert.match(row.summary ?? '', /^revert check could-not-run: /);
});

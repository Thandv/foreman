import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, onOff } from '../src/config.ts';
import { jailTree } from '../src/isolate.ts';
import {
  mutantsCheck, mutantsFor, mutantsNote, pickMutants, readMutants, recordMutants, storedMutantsNote,
  type MutantsOptions, type MutantsResult,
} from '../src/verify/mutants.ts';
import type { RevertRunResult } from '../src/verify/revertTests.ts';
import { runTests } from '../src/verify/tests.ts';
import { Store } from '../src/queue.ts';

/**
 * The mutation check on changed lines (src/verify/mutants.ts): small, line-local mutants of the source lines a diff
 * changes, each run against the test files the diff adds or changes. A reviewer aid: it reports which mutants the
 * tests kill and which survive, and decides nothing. Real `node --test` runs on fixture repos.
 */

// A `node --test` started from inside this file would otherwise think it is a nested run and execute nothing.
delete process.env['NODE_TEST_CONTEXT'];

const T = { timeout: 300_000 };
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

interface Fixture { root: string; repo: string; jail: string; base: string; workRoot: string }

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function fixture(t: TestContext, base: Record<string, string> = {}, script = 'node --test "test/*.test.js"'): Fixture {
  const root = fs.realpathSync(scratchDir('foreman-mut-'));
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
    'src/x.js': 'export const one = 1;\n',
    ...base,
  });
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  return { root, repo, jail, base: sh(repo, 'rev-parse', 'HEAD').trim(), workRoot: path.join(root, 'work') };
}

const realRun = (calls: string[] = []) => async (dir: string, cmd: string, timeoutMs: number): Promise<RevertRunResult> => {
  calls.push(cmd);
  const lines: string[] = [];
  const r = await runTests(dir, cmd, new AbortController().signal, (l) => lines.push(l), undefined, { timeoutMs });
  return { passed: r.passed, timedOut: r.killedAfterSec !== undefined, refused: r.refused === true, output: lines.join('\n') };
};

async function check(f: Fixture, change: Record<string, string>, over: Partial<MutantsOptions> = {}): Promise<MutantsResult> {
  write(f.jail, change);
  const tree = await jailTree(f.jail);
  const res = await mutantsCheck({ repo: f.repo, base: f.base, tree, workRoot: f.workRoot, runId: 'r1', run: realRun(), ...over });
  assert.ok(res, 'not aborted');
  return res;
}

const noScratch = (f: Fixture): void => {
  assert.doesNotMatch(sh(f.repo, 'worktree', 'list'), /mutants-/, 'the scratch worktree is gone from git');
  assert.deepEqual(fs.existsSync(f.workRoot) ? fs.readdirSync(f.workRoot) : [], [], 'and from disk');
};

// The ticket's change: a clamp with a boundary, a guard and a side effect.
const SRC = [
  'export const one = 1;',
  'export const log = [];',
  'export function clamp(n, lo, hi) {',
  '  if (n < lo) return lo;',
  '  if (n > hi && hi !== null) return hi;',
  "  log.push('clamped');",
  '  return n;',
  '}',
  '',
].join('\n');
const HEAD = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp, log } from '../src/x.js';\n";

// ------------------------------------------------------------------ which mutants

test('mutants are made only on the given lines, with the fixed operator set', () => {
  const ms = mutantsFor(SRC, [4, 5, 6]);
  const seen = ms.map((m) => `${m.line}:${m.op}:${m.from}->${m.to}`);
  assert.deepEqual(seen, [
    '4:relational:<-><=',
    '5:relational:>->>=',
    '5:logical:&&->||',
    '5:equality:!==->===',
    '6:delete-statement:log.push(\'clamped\');->',
  ]);
  assert.deepEqual(mutantsFor(SRC, [1, 2, 3, 7, 8]), [], 'declarations, returns and braces are left alone');
});

test('operators inside strings, comments, imports and arrows are not mutated', () => {
  const src = [
    "import { a } from './a.js';",
    "const s = 'a < b && c === d';",
    'const f = (x) => x; // a < b && true',
    '/* a === b */',
    ' * x || y',
    'const t = `${a} < ${b}`;',
    'const ok = a === b && flag === true;',
  ].join('\n');
  const seen = mutantsFor(src, [1, 2, 3, 4, 5, 6, 7]).map((m) => `${m.line}:${m.from}->${m.to}`);
  assert.deepEqual(seen, ['7:===->!==', '7:&&->||', '7:===->!==', '7:true->false']);
});

test('a statement is only deleted when it stands alone: never a continuation line or the tail of a wrapped call', () => {
  const src = [
    'const ok =',
    '  a === b;',
    'first(',
    '  second(arg));',
    'done();',
    'x = compute(y);',
  ].join('\n');
  const deletes = mutantsFor(src, [2, 4, 5, 6]).filter((m) => m.op === 'delete-statement').map((m) => m.line);
  assert.deepEqual(deletes, [5, 6], 'line 2 continues an assignment and line 4 closes a call opened above');
});

test('operators inside multi-line templates and block comments, and inline block comments, are not mutated', () => {
  const src = [
    'const t = `first',
    '  a < b && c',
    '  last`;',
    '/*',
    '  x === y',
    '*/',
    'go(a /* p && q */ || b);',
  ].join('\n');
  const seen = mutantsFor(src, [1, 2, 3, 4, 5, 6, 7]).map((m) => `${m.line}:${m.from}->${m.to}`);
  assert.deepEqual(seen, ['7:||->&&', "7:go(a /* p && q */ || b);->"]);
});

test('pickMutants keeps all under the cap and spreads deterministically over it', () => {
  const ms = Array.from({ length: 10 }, (_, i) => ({ line: i + 1, col: 0, op: 'logical' as const, from: '&&', to: '||' }));
  assert.equal(pickMutants(ms, 20).length, 10);
  const picked = pickMutants(ms, 4).map((m) => m.line);
  assert.deepEqual(picked, [1, 3, 6, 8]);
  assert.deepEqual(pickMutants(ms, 4), pickMutants(ms, 4), 'the same input picks the same mutants');
});

// ------------------------------------------------------------------ running them

test('a weak test lets mutants survive; a strong one kills them; the scratch tree is removed', T, async (t) => {
  const f = fixture(t);
  const weak = await check(f, {
    'src/x.js': SRC,
    'test/clamp.test.js': `${HEAD}test('clamps', () => assert.equal(typeof clamp(5, 0, 10), 'number'));\n`,
  });
  assert.equal(weak.status, 'ran', weak.reason);
  assert.equal(weak.mutants.length, 5);
  assert.ok(weak.mutants.every((m) => m.outcome === 'survived'), JSON.stringify(weak.mutants));
  noScratch(f);

  const f2 = fixture(t);
  const strong = await check(f2, {
    'src/x.js': SRC,
    'test/clamp.test.js': `${HEAD}test('clamps', () => {\n` +
      '  assert.equal(clamp(-1, 0, 10), 0);\n  assert.equal(clamp(0, 0, 10), 0);\n  assert.equal(clamp(11, 0, 10), 10);\n' +
      '  assert.equal(clamp(10, 0, 10), 10);\n  assert.equal(clamp(11, 0, null), 11);\n  assert.equal(clamp(5, 0, 10), 5);\n' +
      "  assert.deepEqual(log, ['clamped', 'clamped', 'clamped', 'clamped']);\n});\n",
  });
  assert.equal(strong.status, 'ran', strong.reason);
  assert.ok(strong.mutants.length === 5 && strong.mutants.every((m) => m.outcome === 'killed'), JSON.stringify(strong.mutants));
  noScratch(f2);
});

test('the reviewed tree is never written: mutants run in a scratch tree only', T, async (t) => {
  const f = fixture(t);
  await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('clamps', () => assert.ok(clamp(1, 0, 2)));\n` });
  assert.equal(fs.readFileSync(path.join(f.jail, 'src/x.js'), 'utf8'), SRC);
});

test('at most maxMutants are run, and one command runs per mutant plus one before any', T, async (t) => {
  const f = fixture(t);
  const calls: string[] = [];
  const res = await check(f, {
    'src/x.js': SRC,
    'test/clamp.test.js': `${HEAD}test('clamps', () => assert.ok(clamp(1, 0, 2)));\n`,
  }, { maxMutants: 2, run: realRun(calls) });
  assert.equal(res.mutants.length, 2);
  assert.equal(res.candidates, 5);
  assert.equal(calls.length, 3, 'one clean run, then one per mutant');
  assert.match(calls[0]!, /test\/clamp\.test\.js/, 'the changed test file is what runs');
});

test('a mutant that hangs is could-not-run, never killed', T, async (t) => {
  const f = fixture(t);
  let calls = 0;
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('c', () => assert.ok(clamp(1, 0, 2)));\n` }, {
    maxMutants: 2,
    run: async () => (calls++ === 0
      ? { passed: true, timedOut: false, output: 'ok' }
      : { passed: false, timedOut: true, output: 'killed at its bound' }),
  });
  assert.equal(res.status, 'ran');
  assert.deepEqual(res.mutants.map((m) => [m.outcome, m.detail]), [
    ['could-not-run', 'timed out with the mutant in place'], ['could-not-run', 'timed out with the mutant in place'],
  ]);
  noScratch(f);
});

test('the run-time budget bounds the check: mutants past it are not run, and each run is bounded by what is left', T, async (t) => {
  const f = fixture(t);
  let clock = 0;
  const limits: number[] = [];
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('c', () => assert.ok(clamp(1, 0, 2)));\n` }, {
    budgetMs: 300_000,
    perRunMs: 250_000,
    now: () => clock,
    run: async (_dir, _cmd, timeoutMs) => {
      limits.push(timeoutMs);
      clock += 200_000;
      return { passed: true, timedOut: false, output: 'ok' };
    },
  });
  assert.equal(res.status, 'ran');
  assert.equal(res.runs, 2, 'the clean run and one mutant; then the budget is spent');
  assert.deepEqual(limits, [250_000, 100_000], 'the mutant run gets only the 100 s left');
  assert.equal(res.mutants[0]!.outcome, 'survived');
  assert.ok(res.mutants.slice(1).every((m) => m.outcome === 'could-not-run' && /budget was spent/.test(m.detail)), JSON.stringify(res.mutants));
  noScratch(f);
});

test('a source that is a symlink is never mutated: nothing outside the scratch tree is written', T, async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'victim');
  fs.mkdirSync(outside);
  const victim = path.join(outside, 'true.js');
  fs.writeFileSync(victim, 'export const kept = 1;\n');
  fs.symlinkSync(victim, path.join(f.jail, 'src', 'link.js'));
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('c', () => assert.ok(clamp(1, 0, 2)));\n` });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'export const kept = 1;\n', 'the link target is untouched');
  assert.ok(res.mutants.every((m) => m.file === 'src/x.js'), JSON.stringify(res.mutants.map((m) => m.file)));
  noScratch(f);
});

test('a test that swaps the mutated file for a symlink cannot make the restore write outside the scratch tree', T, async (t) => {
  const f = fixture(t);
  const victim = path.join(f.root, 'victim.js');
  fs.writeFileSync(victim, 'export const kept = 1;\n');
  // The worker's test sees the first mutant (`n < lo` gone) and replaces the source with a link to an outside file.
  const swap = `${HEAD}import fs from 'node:fs';\n` +
    "const p = new URL('../src/x.js', import.meta.url).pathname;\n" +
    `if (!fs.readFileSync(p, 'utf8').includes('n < lo')) { fs.rmSync(p); fs.symlinkSync(${JSON.stringify(victim)}, p); }\n` +
    "test('c', () => assert.ok(clamp));\n";
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': swap });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'export const kept = 1;\n', 'the outside file is untouched');
  assert.ok(fs.lstatSync(victim).isFile());
  assert.ok(res.status === 'ran' || res.status === 'could-not-run', res.reason);
  noScratch(f);
});

test('a test that swaps its whole scratch tree for a link cannot make the daemon write outside it', T, async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
  // On the first mutant (`n < lo` gone) the worker's test replaces the tree it runs in with a link to an outside directory.
  const swap = `${HEAD}import fs from 'node:fs';\nimport path from 'node:path';\n` +
    "const root = path.resolve(new URL('..', import.meta.url).pathname);\n" +
    `if (!fs.readFileSync(path.join(root, 'src/x.js'), 'utf8').includes('n < lo')) { fs.rmSync(root, { recursive: true, force: true }); fs.symlinkSync(${JSON.stringify(outside)}, root); }\n` +
    "test('c', () => assert.ok(clamp));\n";
  await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': swap });
  assert.deepEqual(fs.readdirSync(path.join(outside, 'src')), [], 'nothing was written into the outside directory');
  assert.doesNotMatch(sh(f.repo, 'worktree', 'list'), /mutants-/);
});

test('a regex literal does not throw the masking off: later lines are still read as code', () => {
  const src = [
    'const re = /[`]/;',
    'const re2 = /a\\/*/;',
    'const ok = a === b;',
    'const t = `x < y`;',
  ].join('\n');
  const seen = mutantsFor(src, [1, 2, 3, 4]).map((m) => `${m.line}:${m.from}->${m.to}`);
  assert.deepEqual(seen, ['3:===->!==']);
});

test('tests that fail before any mutant make the check could-not-run, never a clean result', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('red', () => assert.equal(clamp(1, 0, 2), 99));\n` });
  assert.equal(res.status, 'could-not-run');
  assert.match(res.reason, /do not pass/);
  assert.ok(res.mutants.every((m) => m.outcome === 'could-not-run'));
  noScratch(f);
});

test('n/a when the diff changes no source, or no test file to run', T, async (t) => {
  const f = fixture(t);
  const docs = await check(f, { 'README.md': '# hi\n', 'test/a.test.js': `${HEAD}test('a', () => {});\n` });
  assert.equal(docs.status, 'n/a');
  const f2 = fixture(t);
  const noTests = await check(f2, { 'src/x.js': SRC });
  assert.equal(noTests.status, 'n/a');
  assert.match(noTests.reason, /no test file/);
});

test('a runner that throws, or a refused sandbox, is could-not-run', T, async (t) => {
  const f = fixture(t);
  const res = await check(f, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('c', () => assert.ok(clamp(1, 0, 2)));\n` }, {
    run: async () => ({ passed: false, timedOut: false, refused: true, output: 'no sandbox' }),
  });
  assert.equal(res.status, 'could-not-run');
  assert.match(res.reason, /sandbox refused/);
  noScratch(f);
});

test('an aborted check returns null and leaves nothing behind', T, async (t) => {
  const f = fixture(t);
  const ac = new AbortController();
  write(f.jail, { 'src/x.js': SRC, 'test/clamp.test.js': `${HEAD}test('c', () => assert.ok(clamp(1, 0, 2)));\n` });
  const tree = await jailTree(f.jail);
  const res = await mutantsCheck({
    repo: f.repo, base: f.base, tree, workRoot: f.workRoot, runId: 'r1', signal: ac.signal,
    run: async (dir, cmd, ms) => { ac.abort(); return realRun()(dir, cmd, ms); },
  });
  assert.equal(res, null);
  noScratch(f);
});

// ------------------------------------------------------------------ what the reviewer sees

test('the note decides nothing and lists survivors first', () => {
  const r: MutantsResult = {
    version: 1, status: 'ran', reason: 'x', candidates: 3, testFiles: ['test/a.test.js'], runMs: 10, runs: 3,
    mutants: [
      { file: 'src/a.js', line: 2, op: 'logical', from: '&&', to: '||', text: 'if (a && b) go();', outcome: 'killed', detail: '' },
      { file: 'src/a.js', line: 5, op: 'relational', from: '<', to: '<=', text: 'if (n < lo) return lo;', outcome: 'survived', detail: '' },
    ],
  };
  const note = mutantsNote(r)!;
  assert.match(note, /decides nothing/);
  assert.match(note, /- survived: 1/);
  assert.ok(note.indexOf('[SURVIVED] src/a.js:5') < note.indexOf('[killed] src/a.js:2'));
  assert.equal(mutantsNote({ ...r, status: 'n/a', mutants: [] }), null);
});

test('the result is stored as an artifact and read back for a re-review or the owner gate', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.addTask({ title: 'T', prompt: 'p', kind: 'code', runner: 'claude-code' });
  const run = store.startRun(task.id);
  const r: MutantsResult = { version: 1, status: 'ran', reason: '1 mutant', candidates: 1, testFiles: [], runMs: 1, runs: 2,
    mutants: [{ file: 'src/a.js', line: 1, op: 'logical', from: '&&', to: '||', text: 'a && b;', outcome: 'survived', detail: '' }] };
  recordMutants(store, run.id, task.id, r);
  const row = store.artifactsForTask(task.id).find((a) => a.type === 'mutants');
  assert.ok(row);
  assert.deepEqual(readMutants(row.path), r);
  assert.match(storedMutantsNote(store, store.getRun(run.id)) ?? '', /SURVIVED/);
});

test('FOREMAN_MUTANTS is off unless on', () => {
  assert.equal(onOff('FOREMAN_MUTANTS', undefined), false);
  assert.equal(onOff('FOREMAN_MUTANTS', 'on'), true);
  assert.equal(config.mutants, false, 'off by default');
});

import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepJails } from '../src/archive.ts';
import { applyApproval, landedTreeOf } from '../src/gate.ts';
import { createJail, jailBase, type Jail } from '../src/isolate.ts';
import { checkMain } from '../src/postMerge.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { changedPaths } from '../src/security/coreGuard.ts';
import type { ChangedFile } from '../src/isolate.ts';
import { appliesOnMain, revertCheck } from '../src/verify/revertCheck.ts';
import { hermeticGitEnv } from './helpers/git.ts';

/**
 * The daemon-side git calls outside isolate.ts — the landing (merge.ts), the core guard's listing, the post-merge
 * check, the jail sweep, the scheduler's dirty-checkout probe, the revert check — read the config and
 * info/attributes a worker can write from its jail. A filter, merge driver or gpg.program named there must not run
 * in the daemon; and with every one of them switched off, the tree that lands is the tree that was reviewed.
 */

const T = { timeout: 180_000 };
const C = ['-c', 'user.email=t@e.x', '-c', 'user.name=T', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false'];
/** The running test's git environment (no system config, a scratch global one); tests in a file run one at a time. */
let genv: NodeJS.ProcessEnv = process.env;
/** A git for building fixtures, never with a planted driver in play (no attribute names one yet, or it is pinned off). */
const g = (cwd: string, ...a: string[]): string => execFileSync('git', [...C, ...a], { cwd, env: genv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Fx { root: string; repo: string; marks: string; prog: string }

function fixture(t: TestContext, files: Record<string, string> = { 'a.txt': 'one\n' }): Fx {
  genv = hermeticGitEnv(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-landdrv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@e.x');
  g(repo, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'base');
  const marks = path.join(root, 'marks');
  const prog = path.join(root, 'evil.sh');
  // Leaves a mark; as a clean or smudge filter it passes its input through, as anything else it reads nothing.
  fs.writeFileSync(prog, `#!/bin/sh\necho "$1" >> '${marks}'\ncase "$1" in clean*|smudge*) cat ;; esac\nexit 0\n`, { mode: 0o755 });
  return { root, repo, marks, prog };
}

const fired = (f: Fx): string[] => (fs.existsSync(f.marks) ? fs.readFileSync(f.marks, 'utf8').split('\n').filter(Boolean) : []);
/** What a worker writes from its jail, which shares the repo's config and git directory. */
const plantShell = (f: Fx): string =>
  `git config filter.evil.clean '${f.prog} clean'; git config filter.evil.smudge '${f.prog} smudge'; ` +
  `git config merge.evm.driver '${f.prog} merge-driver'; git config commit.gpgSign true; git config gpg.program '${f.prog}'; ` +
  `printf '* filter=evil merge=evm\\n' >> "$(git rev-parse --git-common-dir)/info/attributes"`;
const plant = (f: Fx, attrs = '* filter=evil merge=evm\n'): void => {
  execFileSync('sh', ['-c', plantShell(f).replace(/printf .*$/, ':')], { cwd: f.repo });
  fs.mkdirSync(path.join(f.repo, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(f.repo, '.git', 'info', 'attributes'), attrs);
};
const touchEdit = (file: string, content: string): void => {
  fs.writeFileSync(file, content);
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
};

/** A shell ticket the scheduler runs and parks; its worker plants every driver, then edits a.txt and adds new.txt. */
async function parkedPlanted(f: Fx) {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const t = store.addTask({
    title: 'ticket', prompt: `${plantShell(f)}; printf 'TICKET\\n' > a.txt; printf 'new\\n' > new.txt`, kind: 'code', runner: 'shell',
    repo: f.repo, testCmd: 'test -f a.txt', maxAttempts: 1,
  });
  await sched.drain(60_000);
  return { store, sched, task: store.getTask(t.id)!, run: store.latestRun(t.id)!, done: async () => { await sched.stop(); store.close(); } };
}

test('a ticket whose worker planted a filter and gpg.program is parked, landed and checked on main with none of them run, and lands byte for byte the tree that was reviewed', T, async (t) => {
  const f = fixture(t);
  const p = await parkedPlanted(f);
  try {
    assert.equal(p.task.status, 'awaiting-approval', p.task.error ?? '');
    assert.match(g(f.repo, 'config', 'gpg.program'), /evil\.sh$/, 'the worker did plant them');
    assert.deepEqual(fired(f), [], 'the run, its diff, its tree and the core guard ran none of them');
    const out = await applyApproval(p.store, p.task.id, {});
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.doesNotMatch(out.merge.reason, /MAIN IS RED|could not/);
    assert.deepEqual(fired(f), [], 'the landing (status, add, commit, merge) and the post-merge check ran none of them');
    assert.equal(g(f.repo, 'rev-parse', 'HEAD^2^{tree}'), p.run.reviewedTree, 'what merged is the tree that was reviewed');
    assert.equal(g(f.repo, 'cat-file', 'blob', 'HEAD:a.txt'), 'TICKET', 'the filtered file landed as the bytes the worker wrote');
    assert.equal(g(f.repo, 'cat-file', '-p', 'HEAD').includes('gpgsig'), false, 'the merge is not signed');
    assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'TICKET\n');
  } finally {
    await p.done();
  }
});

test('a merge driver the worker planted is not run when the landing merges a file both sides changed; git\'s own line merge lands it', T, async (t) => {
  const f = fixture(t, { 'c.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' });
  const store = new Store(':memory:');
  try {
    process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
    const task = store.addTask({ title: 'm', prompt: 'p', kind: 'code', runner: 'echo', repo: f.repo });
    const run = store.startRun(task.id);
    const jail = await createJail(task, run.id);
    fs.writeFileSync(path.join(jail.dir, 'c.txt'), 'L1\nl2\nl3\nl4\nl5\nl6\n');
    g(jail.dir, 'commit', '-qam', 'ticket');
    store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch, reviewedTree: g(jail.dir, 'rev-parse', 'HEAD^{tree}') });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(task.id, 'awaiting-approval');
    fs.writeFileSync(path.join(f.repo, 'c.txt'), 'l1\nl2\nl3\nl4\nl5\nL6\n');
    g(f.repo, 'commit', '-qam', 'main moved');
    const head = g(f.repo, 'rev-parse', 'HEAD');
    plant(f, 'c.txt merge=evm\n');
    const out = await applyApproval(store, task.id, {});
    assert.deepEqual(fired(f), []);
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(g(f.repo, 'rev-parse', 'HEAD^1'), head);
    assert.equal(g(f.repo, 'cat-file', 'blob', 'HEAD:c.txt'), 'L1\nl2\nl3\nl4\nl5\nL6');
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
});

test('the core guard\'s listing of a jail against its base runs no clean filter, here or in a submodule', T, async (t) => {
  const f = fixture(t);
  const jail: Jail = await createJail({ id: 't_cg', repo: f.repo, baseRef: null } as never, 'r_cg');
  plant(f);
  touchEdit(path.join(jail.dir, 'a.txt'), 'two\n');
  assert.deepEqual(await changedPaths(jail.dir, await jailBase(jail)), ['a.txt']);
  assert.deepEqual(fired(f), []);
});

test('the post-merge check checks out main with no smudge filter run', T, async (t) => {
  const f = fixture(t);
  plant(f);
  let seen = '';
  const res = await checkMain(f.repo, 'true', undefined, async (wt) => {
    seen = fs.readFileSync(path.join(wt, 'a.txt'), 'utf8');
    return { passed: true, output: '' };
  });
  assert.equal(res.ok, true);
  assert.equal(seen, 'one\n');
  assert.deepEqual(fired(f), []);
});

test('the jail sweep\'s dirty check runs no clean filter', T, async (t) => {
  const f = fixture(t);
  const store = new Store(':memory:');
  try {
    const task = store.addTask({ title: 'old', prompt: 'p', kind: 'code', runner: 'echo', repo: f.repo });
    const run = store.startRun(task.id);
    const jail = await createJail(task, run.id);
    store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(task.id, 'done');
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 10 * 86_400_000, task.id);
    plant(f);
    touchEdit(path.join(jail.dir, 'a.txt'), 'two\n');
    const out = await sweepJails(store, { retainDays: 3 });
    assert.deepEqual(out.keptDirty, [jail.dir]);
    assert.deepEqual(fired(f), []);
  } finally {
    store.close();
  }
});

test('the scheduler\'s probe of a held dirty checkout runs no clean filter', T, async (t) => {
  const f = fixture(t);
  plant(f);
  touchEdit(path.join(f.repo, 'a.txt'), 'one\n'); // same bytes, old time: git hashes it to tell
  let now = 1_700_000_000_000;
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, now: () => now });
  const holds = sched['dirtyHolds'] as Map<string, unknown>;
  try {
    sched['holdDirtyRepo'](f.repo, 'a.txt');
    now += 31_000;
    await sched.tick();
    const until = Date.now() + 60_000;
    while (holds.has(path.resolve(f.repo)) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(holds.has(path.resolve(f.repo)), false, 'the clean checkout is released');
    assert.deepEqual(fired(f), []);
  } finally {
    await sched.stop();
    store.close();
  }
});

test('the revert check runs no filter or merge driver: not on its checkout at the base, its hash of a renamed file, or its merge onto main', T, async (t) => {
  const f = fixture(t, { 'src/x.js': "export const greet = () => 'hello';\n", 'r.js': 'export const r = 1;\n' } as Record<string, string>);
  const jail = path.join(f.root, 'jail');
  g(f.repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  const base = g(f.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(jail, 'src/x.js'), "export const greet = () => 'hello, world';\n");
  fs.mkdirSync(path.join(jail, 'test'));
  fs.writeFileSync(path.join(jail, 'test/x.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
  fs.renameSync(path.join(jail, 'r.js'), path.join(jail, 'test/r.test.js'));
  const changed: ChangedFile[] = [
    { path: 'src/x.js', from: null, status: 'modified' },
    { path: 'test/x.test.js', from: null, status: 'added' },
    { path: 'test/r.test.js', from: 'r.js', status: 'renamed' },
  ];
  g(jail, 'add', '-A');
  const tree = g(jail, 'write-tree');
  fs.writeFileSync(path.join(f.repo, 'src/x.js'), "export const greet = () => 'hello';\n// main\n");
  g(f.repo, 'commit', '-qam', 'main moved');
  plant(f);
  await revertCheck({
    repo: f.repo, jailDir: jail, base, changed, workRoot: path.join(f.root, 'work'), runId: 'r1',
    run: async () => ({ passed: false, timedOut: false, output: 'ℹ tests 1\nℹ fail 1\n' }),
  });
  const applies = await appliesOnMain({ repo: f.repo, base, tree });
  assert.deepEqual(fired(f), []);
  // Both sides changed x.js's one line and the next: git's own line merge, in the driver's place, calls it a conflict.
  assert.equal(applies.status, 'conflict');
});

test('reading back the tree a landing merged runs no gpg.program, though the config asks for signatures to be shown', T, async (t) => {
  const f = fixture(t);
  const base = g(f.repo, 'rev-parse', 'HEAD');
  const tree = g(f.repo, 'rev-parse', 'HEAD^{tree}');
  // A signed merge commit with the landing's subject, on HEAD's first-parent line.
  const body = `tree ${tree}\nparent ${base}\nparent ${base}\nauthor t <t@e.x> 1 +0000\ncommitter t <t@e.x> 1 +0000\n` +
    'gpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\nforeman: ticket (t_signed)\n';
  const merge = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.repo, env: genv, input: body, encoding: 'utf8' }).trim();
  g(f.repo, 'update-ref', 'refs/heads/main', merge);
  g(f.repo, 'config', 'gpg.program', f.prog);
  g(f.repo, 'config', 'log.showSignature', 'true');
  assert.equal(await landedTreeOf(f.repo, 't_signed'), tree);
  assert.deepEqual(fired(f), []);
});

test('no lazy fetch in the core guard\'s listing or the landing: a planted promisor remote\'s uploadpack is not run', T, async (t) => {
  const f = fixture(t);
  const store = new Store(':memory:');
  try {
    process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
    const task = store.addTask({ title: 'm', prompt: 'p', kind: 'code', runner: 'echo', repo: f.repo });
    const run = store.startRun(task.id);
    const jail = await createJail(task, run.id);
    fs.writeFileSync(path.join(jail.dir, 'new.txt'), 'brand new\n');
    g(jail.dir, 'add', '-A');
    g(jail.dir, 'commit', '-qm', 'ticket');
    store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch, reviewedTree: g(jail.dir, 'rev-parse', 'HEAD^{tree}') });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(task.id, 'awaiting-approval');
    for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', f.repo],
      ['remote.origin.promisor', 'true'], ['remote.origin.uploadpack', `${f.prog} uploadpack`]] as const) g(jail.dir, 'config', k, v);
    const oid = g(jail.dir, 'rev-parse', 'HEAD:new.txt');
    fs.rmSync(path.join(f.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    const out = await applyApproval(store, task.id, {});
    assert.equal(out.merge.merged, false, 'the object is gone: the merge cannot be made');
    // The core guard compares trees only; drop the tree it reads.
    const tree = g(jail.dir, 'rev-parse', 'HEAD^{tree}');
    fs.rmSync(path.join(f.repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    await assert.rejects(changedPaths(jail.dir, await jailBase(jail), 'HEAD'));
    assert.deepEqual(fired(f), []);
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
});

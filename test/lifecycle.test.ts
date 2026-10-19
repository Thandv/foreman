import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { sweepJails } from '../src/archive.ts';
import { createJail } from '../src/isolate.ts';
import { ApprovalTracker, applyApproval, pruneStaleMainWorktrees, ShuttingDownError } from '../src/gate.ts';
import type { MainCheck } from '../src/postMerge.ts';
import { Tracer } from '../src/trace.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { TaskStatus } from '../src/types.ts';

const DAY = 86_400_000;
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(files: Record<string, string> = { 'a.txt': 'one\n' }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-life-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** Real worktree paths registered in `dir`, resolved. */
const worktrees = (dir: string): string[] =>
  git(dir, 'worktree', 'list', '--porcelain').split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));

// ---------------------------------------------------------------- C1 jails

/** git reports worktrees by resolved path; the test home may sit behind a symlink (/var → /private/var). */
const real = (p: string): string => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));

/** A task with one run whose jail is a real worktree, closed `agoDays` ago with `status`. */
async function jailedTask(store: Store, dir: string, status: TaskStatus, agoDays: number) {
  const task = store.addTask({ title: `${status} ${agoDays}d`, prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
  const run = store.startRun(task.id);
  const jail = await createJail(task, run.id);
  store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, status);
  store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - agoDays * DAY, task.id);
  return { task, run, jail };
}

test('the jail sweep reclaims an old done task and nothing a retry or reopen still needs', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const oldDone = await jailedTask(store, dir, 'done', 10);
    const recentDone = await jailedTask(store, dir, 'done', 1);
    const oldFailed = await jailedTask(store, dir, 'failed', 10);
    const parked = await jailedTask(store, dir, 'awaiting-approval', 10);
    // A registration whose directory is already gone (another done task's).
    const vanished = await jailedTask(store, dir, 'queued', 0);
    fs.rmSync(vanished.jail.dir, { recursive: true, force: true });
    store.setStatus(vanished.task.id, 'done');
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 10 * DAY, vanished.task.id);

    const before = worktrees(dir);
    assert.ok(before.includes(real(oldDone.jail.dir)) && before.includes(real(vanished.jail.dir)), 'precondition: both registered');

    const out = await sweepJails(store, { retainDays: 3 });

    assert.deepEqual(out.removed, [oldDone.jail.dir]);
    assert.equal(fs.existsSync(oldDone.jail.dir), false, 'old done jail removed');
    const registered = worktrees(dir);
    assert.ok(!registered.includes(real(oldDone.jail.dir)), 'its worktree registration is gone');
    assert.ok(!registered.includes(real(vanished.jail.dir)), 'a registration whose dir vanished is pruned');
    for (const kept of [recentDone, oldFailed, parked]) {
      assert.ok(fs.existsSync(kept.jail.dir), `${kept.task.title} keeps its dir`);
      assert.ok(registered.includes(real(kept.jail.dir)), `${kept.task.title} keeps its registration`);
    }
    // Branches are left alone, including the reclaimed one's.
    assert.ok(git(dir, 'branch', '--list', oldDone.jail.branch!).length > 0);
  } finally {
    store.close();
  }
});

test('the jail sweep keeps a dirty worktree of a done task\'s last run (unlanded work)', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const left = await jailedTask(store, dir, 'done', 10);
    fs.writeFileSync(path.join(left.jail.dir, 'work.txt'), 'never merged\n');
    const out = await sweepJails(store, { retainDays: 3 });
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.keptDirty, [left.jail.dir]);
    assert.ok(fs.existsSync(path.join(left.jail.dir, 'work.txt')));
  } finally {
    store.close();
  }
});

test('a resumed repair sharing an older run\'s worktree: the dirty check holds whichever row names the dir', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const first = await jailedTask(store, dir, 'done', 10);
    // The repair run reused the first run's jail (scheduler.ts reuseJail).
    const again = store.startRun(first.task.id);
    store.setRunMeta(again.id, { worktreePath: first.jail.dir, branch: first.jail.branch });
    store.endRun(again.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 10 * DAY, first.task.id);
    fs.writeFileSync(path.join(first.jail.dir, 'work.txt'), 'never merged\n');
    const out = await sweepJails(store, { retainDays: 3 });
    assert.ok(fs.existsSync(path.join(first.jail.dir, 'work.txt')), 'the uncommitted work survives');
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.keptDirty, [first.jail.dir], 'reported once');
  } finally {
    store.close();
  }
});

test('a last-run worktree git cannot read is kept, not taken for clean', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const left = await jailedTask(store, dir, 'done', 10);
    fs.writeFileSync(path.join(left.jail.dir, 'work.txt'), 'never merged\n');
    // The repo moved: the worktree's .git points at a gitdir that is gone.
    fs.writeFileSync(path.join(left.jail.dir, '.git'), 'gitdir: /nonexistent/foreman/worktrees/x\n');
    const out = await sweepJails(store, { retainDays: 3 });
    assert.ok(fs.existsSync(path.join(left.jail.dir, 'work.txt')));
    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.keptUnreadable, [left.jail.dir]);
  } finally {
    store.close();
  }
});

test('the sweep never touches a task whose merge is landing, nor one done less than a day ago even at retain 0', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const fresh = await jailedTask(store, dir, 'done', 0);
    const landing = await jailedTask(store, dir, 'done', 10);
    store.beginLanding(landing.task.id);
    const out = await sweepJails(store, { retainDays: 0 });
    assert.deepEqual(out.removed, []);
    assert.ok(fs.existsSync(fresh.jail.dir), 'retain is clamped to a day');
    assert.ok(fs.existsSync(landing.jail.dir), 'a landing merge keeps its worktree');
    store.endLanding(landing.task.id);
    assert.deepEqual((await sweepJails(store, { retainDays: 0 })).removed, [landing.jail.dir], 'swept once landed');
  } finally {
    store.close();
  }
});

test('the sweep removes nothing outside the work root, no unarchived rejected task, and at most `limit` dirs', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-outside-'));
  try {
    // A run row pointing outside the work root (no repo, so no git check stands in front of the guard).
    const loose = store.addTask({ title: 'loose', prompt: 'p', runner: 'echo' });
    const run = store.startRun(loose.id);
    store.setRunMeta(run.id, { worktreePath: outside });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(loose.id, 'done');
    // Both oldest, so they come before the limit is reached.
    store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 13 * DAY, loose.id);
    const rejected = await jailedTask(store, dir, 'rejected', 13);
    const done = [await jailedTask(store, dir, 'done', 12), await jailedTask(store, dir, 'done', 11), await jailedTask(store, dir, 'done', 10)];
    const out = await sweepJails(store, { retainDays: 3, limit: 2 });
    assert.ok(fs.existsSync(outside), 'a path outside the work root is never removed');
    assert.ok(fs.existsSync(rejected.jail.dir), 'a rejected task that was not archived keeps its worktree');
    assert.equal(out.removed.length, 2, 'the limit bounds one sweep');
    assert.deepEqual(out.removed, [done[0]!.jail.dir, done[1]!.jail.dir]);
  } finally {
    store.close();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C2 shutdown

/** A ticket parked at the gate whose run left `branch` carrying a change. */
function parkedOnBranch(store: Store, dir: string, branch: string) {
  git(dir, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, `${branch}.txt`), 'x\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', branch);
  git(dir, 'checkout', '-q', '-');
  const task = store.addTask({ title: branch, prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch, worktreePath: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
}

/** What checkMain would leave registered: a detached foreman-main-* worktree. */
function addMainWorktree(dir: string): string {
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'life-'))), `foreman-main-${process.pid}`);
  git(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  return wt;
}

test('a shutdown during a post-merge check interrupts it, records that, and removes its worktree', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  const dir = repo();
  const store = new Store(':memory:');
  const tracker = new ApprovalTracker();
  try {
    const t = parkedOnBranch(store, dir, 'ticket');
    let mainWt = '';
    let entered!: () => void;
    const inCheck = new Promise<void>((r) => { entered = r; });
    // A check that never finishes and ignores its signal: the worst case.
    const blocking = (repoDir: string): Promise<MainCheck> => {
      mainWt = addMainWorktree(repoDir);
      entered();
      return new Promise<MainCheck>(() => {});
    };
    const approval = applyApproval(store, t.id, { tracker, mainCheck: blocking });
    await inCheck;
    assert.ok(worktrees(dir).includes(mainWt), 'precondition: the check worktree is registered');

    const stuck = await tracker.shutdown(30_000);
    assert.equal(stuck, 0, 'the approval settled within the cap');
    const out = await approval;
    assert.equal(out.merge.merged, true, 'the merge itself was not undone');
    assert.match(out.merge.reason, /interrupted/);
    assert.ok(!worktrees(dir).includes(mainWt), 'the check worktree is unregistered');
    assert.equal(fs.existsSync(mainWt), false, 'and its directory removed');
    const held = store.repoRed(dir);
    assert.equal(held?.reason, 'post-merge check interrupted — untested', 'an untested HEAD holds dependents like a red one');
    assert.equal(held?.head, git(dir, 'rev-parse', 'HEAD'), 'at the merged HEAD');
    assert.ok((held?.nextCheckAt ?? Infinity) <= Date.now(), 'due for its re-check at once');
    const events = store.eventsForTask(t.id).map((e) => `${e.type}: ${e.message}`).join('\n');
    assert.match(events, /warning: main check after merging .* interrupted by a daemon shutdown/);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), false);

    // Once shutting down, a new approval is refused before it changes anything.
    const next = parkedOnBranch(store, dir, 'second');
    await assert.rejects(applyApproval(store, next.id, { tracker, mainCheck: blocking }), ShuttingDownError);
    assert.equal(store.getTask(next.id)!.status, 'awaiting-approval');
  } finally {
    store.close();
  }
});

test('startup prunes a stale foreman-main-* worktree a crash left registered', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    store.addTask({ title: 't', prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
    const stale = addMainWorktree(dir);
    const ordinary = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'life-'))), 'keep-me');
    git(dir, 'worktree', 'add', '-q', '--detach', ordinary, 'HEAD');

    const removed = await pruneStaleMainWorktrees(store);
    assert.deepEqual(removed, [stale]);
    assert.ok(!worktrees(dir).includes(stale));
    assert.equal(fs.existsSync(stale), false);
    assert.ok(worktrees(dir).includes(ordinary), 'other worktrees are untouched');
  } finally {
    store.close();
  }
});

test('the main-worktree prune leaves a live process\'s foreman-main-<pid>-* check alone', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  const live = spawn('sleep', ['60'], { stdio: 'ignore' });
  const dead = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  try {
    store.addTask({ title: 't', prompt: 'p', kind: 'code', runner: 'echo', repo: dir });
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'life-')));
    const theirs = path.join(base, `foreman-main-${live.pid}-abc123`);
    const orphan = path.join(base, `foreman-main-${dead.pid}-def456`);
    for (const wt of [theirs, orphan]) git(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const removed = await pruneStaleMainWorktrees(store);
    assert.deepEqual(removed, [orphan], 'only the dead process\'s');
    assert.ok(worktrees(dir).includes(theirs), 'another live daemon\'s running check is untouched');
  } finally {
    live.kill('SIGKILL');
    store.close();
  }
});

test('a paused scheduler claims nothing (a shutdown before its approvals drain)', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const t = store.addTask({ title: 'late', prompt: 'x', runner: 'echo' });
    sched.pauseDispatch();
    for (let i = 0; i < 5; i++) await sched.tick();
    assert.equal(store.latestRun(t.id), null, 'not dispatched while paused');
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    await sched.stop();
    store.close();
  }
});

// ---------------------------------------------------------------- C3 traces

function traceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-traces-'));
}
const lines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

test('trace files roll over at midnight by the write-time clock', () => {
  const dir = traceDir();
  const store = new Store(':memory:');
  let now = Date.parse('2026-10-09T23:59:58Z');
  const tracer = new Tracer(store, { dir, now: () => now, flushMs: 3_600_000 });
  tracer.start();
  store.record({ type: 'log', message: 'before midnight' });
  now = Date.parse('2026-10-10T00:00:02Z');
  store.record({ type: 'log', message: 'after midnight' });
  assert.equal(tracer.path, path.join(dir, '2026-10-10.jsonl'));
  tracer.stop();
  const day1 = lines(path.join(dir, '2026-10-09.jsonl'));
  const day2 = lines(path.join(dir, '2026-10-10.jsonl'));
  assert.deepEqual(day1.map((l) => JSON.parse(l).message), ['before midnight']);
  assert.deepEqual(day2.map((l) => JSON.parse(l).message), ['after midnight']);
  store.close();
});

test('trace retention deletes daily files past the window, at start and at rollover', () => {
  const dir = traceDir();
  for (const f of ['2026-09-01.jsonl', '2026-09-25.jsonl', '2026-09-30.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x\n');
  const store = new Store(':memory:');
  let now = Date.parse('2026-10-09T12:00:00Z');
  const tracer = new Tracer(store, { dir, now: () => now, retainDays: 14 });
  tracer.start();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-09-25.jsonl', '2026-09-30.jsonl', 'notes.txt']);
  now = Date.parse('2026-10-10T00:00:01Z');
  store.record({ type: 'log', message: 'new day' });
  tracer.stop();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-09-30.jsonl', '2026-10-10.jsonl', 'notes.txt']);
  store.close();
});

test('buffered trace lines are all written on stop', () => {
  const dir = traceDir();
  const store = new Store(':memory:');
  const now = Date.parse('2026-10-10T08:00:00Z');
  const tracer = new Tracer(store, { dir, now: () => now, flushMs: 3_600_000, flushBytes: 1 << 30 });
  tracer.start();
  for (let i = 0; i < 500; i++) store.record({ type: 'log', message: `line ${i}` });
  const file = path.join(dir, '2026-10-10.jsonl');
  assert.equal(lines(file).length, 0, 'batched: nothing appended per event');
  tracer.stop();
  const got = lines(file).map((l) => JSON.parse(l).message);
  assert.equal(got.length, 500);
  assert.equal(got[499], 'line 499');
  store.close();
});

test('a trace error or warning is written at once, not on the next flush', () => {
  const dir = traceDir();
  const store = new Store(':memory:');
  const now = Date.parse('2026-10-10T08:00:00Z');
  const tracer = new Tracer(store, { dir, now: () => now, flushMs: 3_600_000, flushBytes: 1 << 30 });
  tracer.start();
  try {
    store.record({ type: 'log', message: 'routine' });
    store.record({ type: 'error', message: 'about to crash' });
    const got = lines(path.join(dir, '2026-10-10.jsonl')).map((l) => JSON.parse(l).message);
    assert.deepEqual(got, ['routine', 'about to crash'], 'the error, and what was buffered before it');
  } finally {
    tracer.stop();
    store.close();
  }
});

test('buffered trace lines survive the process exiting without a stop, and the flush timer does not hold it open', async () => {
  const dir = traceDir();
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const script =
    `import { Store } from ${JSON.stringify(path.join(src, 'queue.ts'))};` +
    `import { Tracer } from ${JSON.stringify(path.join(src, 'trace.ts'))};` +
    `const store = new Store(':memory:');` +
    `const tracer = new Tracer(store, { dir: ${JSON.stringify(dir)}, flushMs: 3_600_000, flushBytes: 1 << 30 });` +
    `tracer.start();` +
    `store.record({ type: 'log', message: 'last words' });`; // and nothing else: the loop must drain and exit
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, FOREMAN_HOME: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const exited = await Promise.race([
    new Promise<number | null>((r) => child.on('exit', (c) => r(c))),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), 60_000).unref()),
  ]);
  if (exited === 'hung') child.kill('SIGKILL');
  assert.equal(exited, 0, `the process exited on its own: ${stderr}`);
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  assert.ok(file, 'a trace file was written');
  assert.ok(lines(path.join(dir, file!)).some((l) => JSON.parse(l).message === 'last words'));
});

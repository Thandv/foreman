import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { createHash } from 'node:crypto';
import { applyApproval } from '../src/gate.ts';
import { Scheduler } from '../src/scheduler.ts';
import { mergeApproved } from '../src/merge.ts';
import { jailTree } from '../src/isolate.ts';
import { createServer } from '../src/server.ts';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-landing-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A ticket parked at the gate whose run left `branch` carrying `change`. */
function parkedOnBranch(store: Store, dir: string, branch: string, change: Record<string, string>) {
  git(dir, 'checkout', '-q', '-b', branch);
  for (const [f, body] of Object.entries(change)) fs.writeFileSync(path.join(dir, f), body);
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

test('an approval whose merge conflicts goes back to the gate, and its dependent stays blocked', async () => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo({ 'a.txt': 'one\n' });
  const store = new Store(':memory:');
  try {
    const t = parkedOnBranch(store, dir, 'ticket', { 'a.txt': 'TICKET\n' });
    const child = store.addTask({ title: 'next', prompt: 'p', runner: 'echo', deps: [t.id] });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'MAIN\n'); git(dir, 'commit', '-qam', 'main moved');

    const out = await applyApproval(store, t.id, {});
    assert.equal(out.merge.merged, false);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', 'not done: its work is not on main');
    assert.match(store.getTask(t.id)!.error ?? '', /not landed: merge conflict/);
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'blocked');

    // The operator lands it by hand, then approves again: nothing left to merge, so it is done.
    git(dir, 'merge', '-q', '-X', 'theirs', '--no-edit', 'ticket');
    await applyApproval(store, t.id, {});
    assert.equal(store.getTask(t.id)!.status, 'done');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued');
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
});

test('a merge that turns main red holds its dependents until main is green again', async () => {
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'test ! -f BROKEN' } });
  const dir = repo({ 'package.json': pkg });
  const store = new Store(':memory:');
  try {
    // Its own branch would pass a check that looked only at it; together with main it is red.
    const t = parkedOnBranch(store, dir, 'ticket', { 'BROKEN': 'x\n' });
    const child = store.addTask({ title: 'next', prompt: 'p', runner: 'echo', repo: dir, deps: [t.id] });
    const out = await applyApproval(store, t.id, {});
    assert.equal(out.merge.merged, true);
    assert.match(out.merge.reason, /MAIN IS RED/);
    assert.ok(store.repoRed(dir), 'the repo is marked red');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'blocked', 'not cut from a red main');
    store.clearRepoRed(dir);
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued', 'released once green');
  } finally {
    store.close();
  }
});

test('once someone fixes a red main, the scheduler re-checks it and releases what it held', async () => {
  const { Scheduler } = await import('../src/scheduler.ts');
  process.env['FOREMAN_REDCHECK_MS'] = '50';
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'test ! -f BROKEN' } });
  const dir = repo({ 'package.json': pkg });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 20, maxWorkers: 1, verifyEnabled: false });
  try {
    const t = parkedOnBranch(store, dir, 'ticket', { 'BROKEN': 'x\n' });
    await applyApproval(store, t.id, {});
    assert.ok(store.repoRed(dir));
    // The operator fixes main: HEAD moves and the tests pass again.
    git(dir, 'rm', '-q', 'BROKEN'); git(dir, 'commit', '-qm', 'fix main');
    const until = Date.now() + 60_000;
    while (store.repoRed(dir) && Date.now() < until) {
      await sched.tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(store.repoRed(dir), null, 'a passing re-check on the new HEAD clears it');
  } finally {
    delete process.env['FOREMAN_REDCHECK_MS'];
    await sched.stop();
    store.close();
  }
});

/** A repo whose test command counts its runs in `counter` and fails the first `failFirst` of them. */
function flakyRepo(counter: string, failFirst: number): string {
  const script = `echo run >> '${counter}'; n=$(wc -l < '${counter}' | tr -d ' ');` +
    `if [ "$n" -le ${failFirst} ]; then echo "FAIL-RUN-$n"; exit 1; fi; echo "PASS-RUN-$n"`;
  return repo({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: script } }) });
}
const counterFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-flake-')), 'runs');
const runsIn = (counter: string): number => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
const eventText = (store: Store, id: string): string => store.eventsForTask(id).map((e) => e.message).join('\n---\n');

test('a main check that fails once and passes on the immediate re-run does not mark the repo red', async () => {
  const counter = counterFile();
  const dir = flakyRepo(counter, 1);
  const store = new Store(':memory:');
  try {
    const t = parkedOnBranch(store, dir, 'ticket', { 'x.txt': 'x\n' });
    const child = store.addTask({ title: 'next', prompt: 'p', runner: 'echo', repo: dir, deps: [t.id] });
    const out = await applyApproval(store, t.id, {});
    assert.equal(out.merge.merged, true);
    assert.doesNotMatch(out.merge.reason, /MAIN IS RED/);
    assert.equal(store.repoRed(dir), null, 'a flake is not red');
    assert.equal(runsIn(counter), 2);
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued', 'dependents are not held');
    const text = eventText(store, t.id);
    assert.match(text, /FAIL-RUN-1/, 'the first run tail is recorded');
    assert.match(text, /PASS-RUN-2/, 'the second run tail is recorded');
  } finally {
    store.close();
  }
});

test('a main check that fails twice marks the repo red and records both tails', async () => {
  const counter = counterFile();
  const dir = flakyRepo(counter, 99);
  const store = new Store(':memory:');
  try {
    const t = parkedOnBranch(store, dir, 'ticket', { 'x.txt': 'x\n' });
    const out = await applyApproval(store, t.id, {});
    assert.match(out.merge.reason, /MAIN IS RED/);
    assert.ok(store.repoRed(dir), 'two failures mark the repo red');
    assert.equal(runsIn(counter), 2);
    const text = eventText(store, t.id);
    assert.match(text, /FAIL-RUN-1/);
    assert.match(text, /FAIL-RUN-2/);
  } finally {
    store.close();
  }
});

test('a passing first main check runs the command exactly once', async () => {
  const counter = counterFile();
  const dir = flakyRepo(counter, 0);
  const store = new Store(':memory:');
  try {
    const t = parkedOnBranch(store, dir, 'ticket', { 'x.txt': 'x\n' });
    await applyApproval(store, t.id, {});
    assert.equal(store.repoRed(dir), null);
    assert.equal(runsIn(counter), 1);
  } finally {
    store.close();
  }
});

test('the main-check re-run sees the same HEAD as the first run', async () => {
  const { checkMain } = await import('../src/postMerge.ts');
  const dir = repo({ 'a.txt': 'one\n' });
  const seen: string[] = [];
  const outputs = ['first boom', 'second boom'];
  const result = await checkMain(dir, 'fake', undefined, async (wt) => {
    seen.push(git(wt, 'rev-parse', 'HEAD'));
    return { passed: false, output: outputs[seen.length - 1]! };
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'both runs see the same HEAD');
  assert.equal(seen[0], git(dir, 'rev-parse', 'HEAD'));
  assert.equal(result.head, seen[0]);
  assert.equal(result.ok, false);
  assert.equal(result.firstTail, 'first boom');
  assert.equal(result.tail, 'second boom');
});

// ------------------------------------------------ the reviewed tree (FA1)
//
// The landing merges the tree the run's reviewers were shown, or nothing. These
// tickets are parked by the scheduler itself, so the tree on the run row is the
// one it recorded with the diff artifact.

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const eventsOf = (store: Store, id: string): string[] => store.eventsForTask(id).map((e) => e.message);

/** A shell ticket the scheduler ran and parked: it rewrites a.txt and adds new.txt. */
async function reviewed(opts: { testCmd?: string; files?: Record<string, string>; prompt?: string } = {}) {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo({ 'a.txt': 'one\n', ...(opts.files ?? {}) });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const t = store.addTask({
    title: 'ticket', prompt: opts.prompt ?? "printf 'TICKET\\n' > a.txt; printf 'new\\n' > new.txt", kind: 'code', runner: 'shell',
    repo: dir, testCmd: opts.testCmd ?? 'test -f a.txt', maxAttempts: 1,
  });
  await sched.drain(30_000);
  const task = store.getTask(t.id)!;
  const run = store.latestRun(t.id)!;
  const done = async (): Promise<void> => {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    await sched.stop();
    store.close();
  };
  return { dir, store, sched, task, run, jail: run.worktreePath!, head: git(dir, 'rev-parse', 'HEAD'), done };
}

/** Nothing landed and nothing was decided: main, the branch, the ticket and the run are where review left them. */
function assertStillParked(f: Awaited<ReturnType<typeof reviewed>>, out: Awaited<ReturnType<typeof applyApproval>>, reason: RegExp): void {
  assert.equal(out.merge.merged, false, out.merge.reason);
  assert.match(out.merge.reason, reason);
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), f.head, 'main is unchanged');
  const now = f.store.getTask(f.task.id)!;
  assert.equal(now.status, 'awaiting-approval');
  assert.match(now.error ?? '', reason, 'the ticket says why');
  assert.equal(git(f.dir, 'rev-parse', f.run.branch!), f.run.baseCommit, 'the unreviewed work was not committed to the branch');
  const row = f.store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(f.run.id) as Record<string, unknown>;
  assert.equal(row['decision'] ?? null, null, 'no approval was recorded for the run');
}

test('a file written to the worktree after the diff was collected blocks the landing, and the ticket stays parked naming it', async () => {
  const f = await reviewed();
  try {
    assert.equal(f.task.status, 'awaiting-approval', f.task.error ?? '');
    assert.match(f.run.reviewedTree ?? '', /^[0-9a-f]{40}$/);
    const child = f.store.addTask({ title: 'next', prompt: 'p', runner: 'echo', deps: [f.task.id] });
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'nobody reviewed this\n');

    const out = await applyApproval(f.store, f.task.id, {});
    assertStillParked(f, out, /work changed after review: late\.txt \(added since review\)/);
    assert.match(out.merge.reason, /add it to \.gitignore and retry; otherwise reject and retry so it is reviewed again/);
    assert.equal(fs.existsSync(path.join(f.dir, 'late.txt')), false);
    f.store.reconcileBlocked();
    assert.equal(f.store.getTask(child.id)!.status, 'blocked', 'no dependent is released');
    assert.ok(eventsOf(f.store, f.task.id).some((m) => /^merge: work changed after review: late\.txt/.test(m)));

    // Taking the file away again makes it the reviewed tree, and it lands.
    fs.rmSync(path.join(f.jail, 'late.txt'));
    const again = await applyApproval(f.store, f.task.id, {});
    assert.equal(again.merge.merged, true, again.merge.reason);
  } finally {
    await f.done();
  }
});

test('a reviewed file modified after review blocks the landing', async () => {
  const f = await reviewed();
  try {
    fs.writeFileSync(path.join(f.jail, 'a.txt'), 'TICKET\nand a line nobody read\n');
    assertStillParked(f, await applyApproval(f.store, f.task.id, {}), /work changed after review: a\.txt \(changed since review\)/);
    assert.equal(git(f.dir, 'show', 'HEAD:a.txt'), 'one');
  } finally {
    await f.done();
  }
});

test('a reviewed file deleted after review blocks the landing', async () => {
  const f = await reviewed();
  try {
    fs.rmSync(path.join(f.jail, 'new.txt'));
    assertStillParked(f, await applyApproval(f.store, f.task.id, {}), /work changed after review: new\.txt \(deleted since review\)/);
  } finally {
    await f.done();
  }
});

test('an approved run nobody touched lands the reviewed tree, with nothing said about it', async () => {
  const f = await reviewed();
  try {
    const out = await applyApproval(f.store, f.task.id, {});
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.match(out.merge.reason, /^merged 1 commit\(s\) from foreman\//);
    assert.equal(out.merge.note, undefined);
    assert.equal(f.store.getTask(f.task.id)!.status, 'done');
    assert.equal(git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), f.run.reviewedTree, 'what merged is the tree that was recorded');
    assert.equal(git(f.dir, 'show', 'HEAD:new.txt'), 'new');
    assert.equal(eventsOf(f.store, f.task.id).some((m) => /reviewed tree|as-is/.test(m)), false);
  } finally {
    await f.done();
  }
});

test('a file git ignores is in neither tree: written after review, it does not block the landing', async () => {
  const f = await reviewed({ files: { '.gitignore': 'build/\n' } });
  try {
    fs.mkdirSync(path.join(f.jail, 'build'));
    fs.writeFileSync(path.join(f.jail, 'build', 'out.bin'), 'generated\n');
    const out = await applyApproval(f.store, f.task.id, {});
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(fs.existsSync(path.join(f.dir, 'build')), false);
  } finally {
    await f.done();
  }
});

test('a file the test run writes that git does not ignore blocks the landing, and the reason says what to do', async () => {
  const f = await reviewed({ testCmd: "test -f a.txt && printf 'report\\n' > test-report.txt" });
  try {
    assert.equal(f.task.status, 'awaiting-approval', f.task.error ?? '');
    const out = await applyApproval(f.store, f.task.id, {});
    assertStillParked(f, out, /work changed after review: test-report\.txt \(added since review\)/);
    assert.match(out.merge.reason, /If the test run writes the file, add it to \.gitignore and retry/);
  } finally {
    await f.done();
  }
});

test('a run with no reviewed tree lands on a person\'s approval, with a note in its events', async () => {
  const f = await reviewed();
  try {
    // A ticket parked before trees were recorded: the column is NULL.
    f.store.setRunMeta(f.run.id, { reviewedTree: null });
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'there is no tree to compare this with\n');
    const out = await applyApproval(f.store, f.task.id, {});
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(f.store.getTask(f.task.id)!.status, 'done');
    assert.ok(
      eventsOf(f.store, f.task.id).includes("no reviewed tree recorded for this run (parked before this check existed); landed on a person's approval"),
      eventsOf(f.store, f.task.id).join('\n'),
    );
  } finally {
    await f.done();
  }
});

test('the owner gate never lands a run with no reviewed tree, and never lands as-is', async () => {
  const f = await reviewed();
  try {
    f.store.setRunMeta(f.run.id, { reviewedTree: null });
    const none = await applyApproval(f.store, f.task.id, { source: 'owner-gate' });
    assertStillParked(f, none, /no reviewed tree was recorded for this run \(parked before this check existed\), so the owner gate does not land it: a person approves it/);

    // With a tree on record and a late file, naming the tree is a person's escape only.
    f.store.setRunMeta(f.run.id, { reviewedTree: f.run.reviewedTree });
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'late\n');
    const refused = await applyApproval(f.store, f.task.id, {});
    const now = /--as-is ([0-9a-f]{40})$/.exec(refused.merge.reason)?.[1] ?? '';
    assert.match(now, /^[0-9a-f]{40}$/, refused.merge.reason);
    const owner = await applyApproval(f.store, f.task.id, { source: 'owner-gate', acceptTree: now });
    assertStillParked(f, owner, /work changed after review: late\.txt/);
  } finally {
    await f.done();
  }
});

test('--as-is lands changed work only when a person names the exact tree, and records it', async () => {
  const f = await reviewed();
  try {
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'the operator wrote this by hand\n');
    const refused = await applyApproval(f.store, f.task.id, {});
    const now = /--as-is ([0-9a-f]{40})$/.exec(refused.merge.reason)?.[1] ?? '';
    assert.match(now, /^[0-9a-f]{40}$/, `the refusal prints the tree to name: ${refused.merge.reason}`);
    assert.match(refused.merge.reason, new RegExp(`foreman approve ${f.task.id} --as-is ${now}$`));

    // The reviewed tree, a prefix of the right one, and nonsense are all the wrong sha.
    for (const wrong of [f.run.reviewedTree!, now.slice(0, 12), 'HEAD', '']) {
      assertStillParked(f, await applyApproval(f.store, f.task.id, { acceptTree: wrong }), /--as-is names tree .*, but the tree that would land is [0-9a-f]{40}; nothing was landed/);
    }

    const out = await applyApproval(f.store, f.task.id, { acceptTree: now });
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), now, 'the tree that landed is the one that was named');
    assert.equal(git(f.dir, 'show', 'HEAD:late.txt'), 'the operator wrote this by hand');
    assert.ok(
      eventsOf(f.store, f.task.id).includes(`landed as-is on a person's word: tree ${now} (reviewed tree: ${f.run.reviewedTree})`),
      eventsOf(f.store, f.task.id).join('\n'),
    );
  } finally {
    await f.done();
  }
});

test('a file written between the check and the commit is caught on the commit itself', async () => {
  const f = await reviewed();
  try {
    // mergeApproved is handed an approved task, as approve() hands it one.
    const task = { ...f.task, status: 'done' as const };
    const out = await mergeApproved(task, f.run, {
      beforeCommit: () => fs.writeFileSync(path.join(f.jail, 'racing.txt'), 'written after the check passed\n'),
    });
    assert.equal(out.merged, false);
    assert.match(out.reason, /work changed after review: racing\.txt \(added since review\)/);
    assert.equal(git(f.dir, 'rev-parse', 'HEAD'), f.head);
  } finally {
    await f.done();
  }
});

test('config the jail can write neither changes the tree nor runs anything while it is computed', async () => {
  const f = await reviewed();
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-markers-'));
  try {
    const before = await jailTree(f.jail);
    assert.equal(before, f.run.reviewedTree, 'the tree the scheduler recorded is the tree of the parked worktree');

    const monitor = path.join(markers, 'fsmonitor.sh');
    fs.writeFileSync(monitor, `#!/bin/sh\necho ran > "${markers}/fsmonitor-ran"\nprintf '\\0'\n`);
    fs.chmodSync(monitor, 0o755);
    const hooks = path.join(markers, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-index-change'), `#!/bin/sh\necho ran > "${markers}/hook-ran"\n`);
    fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
    git(f.jail, 'config', 'core.quotePath', 'false');
    git(f.jail, 'config', 'color.ui', 'always');
    git(f.jail, 'config', 'core.fsmonitor', monitor);
    git(f.jail, 'config', 'core.hooksPath', hooks);
    const common = path.resolve(f.jail, git(f.jail, 'rev-parse', '--git-common-dir'));
    fs.mkdirSync(path.join(common, 'info'), { recursive: true });
    fs.writeFileSync(path.join(common, 'info', 'attributes'), '* -diff\n');
    // The config is live: git itself runs both programs when it writes an index here.
    execFileSync('git', ['status', '--porcelain'], { cwd: f.jail, stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(markers, 'hook-ran')) || fs.existsSync(path.join(markers, 'fsmonitor-ran')), 'precondition: the planted programs do run under plain git');
    fs.rmSync(path.join(markers, 'hook-ran'), { force: true });
    fs.rmSync(path.join(markers, 'fsmonitor-ran'), { force: true });

    assert.equal(await jailTree(f.jail), before, 'the same content is the same tree whatever the config says');
    assert.deepEqual(fs.readdirSync(markers).filter((n) => n.endsWith('-ran')), [], 'nothing the jail configured ran');

    // And the comparison still sees a late file through all of it.
    fs.writeFileSync(path.join(f.jail, 'caf\u00e9 late.txt'), 'late\n');
    assert.notEqual(await jailTree(f.jail), before);
    assert.deepEqual(fs.readdirSync(markers).filter((n) => n.endsWith('-ran')), []);
    git(f.jail, 'config', '--unset', 'core.fsmonitor');
    git(f.jail, 'config', '--unset', 'core.hooksPath');
    const out = await applyApproval(f.store, f.task.id, {});
    assertStillParked(f, out, /work changed after review: caf\u00e9 late\.txt \(added since review\)/);
  } finally {
    await f.done();
    fs.rmSync(markers, { recursive: true, force: true });
  }
});

test('recording the tree leaves the worktree and its index byte-identical', async () => {
  const dir = repo({ 'a.txt': 'one\n', 'gone.txt': 'x\n', 'staged.txt': 'x\n' });
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
  fs.writeFileSync(path.join(dir, 'intent.txt'), 'i\n'); git(dir, 'add', '-N', 'intent.txt');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n'); git(dir, 'add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'modified, not staged\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  const index = path.join(dir, '.git', 'index');
  const snapshot = (): string[] => [
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }),
    execFileSync('git', ['ls-files', '-s'], { cwd: dir, encoding: 'utf8' }),
    fs.readdirSync(dir).sort().join(','),
  ];
  const before = snapshot();
  const sum = sha256(index);

  const tree = await jailTree(dir);
  assert.equal(sha256(index), sum, '.git/index is the same bytes');
  assert.deepEqual(snapshot(), before);

  // And it is the tree `git add -A` + commit makes of that worktree.
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'landed');
  assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.deepEqual(git(dir, 'ls-tree', '-r', '--name-only', tree).split('\n'), ['a.txt', 'intent.txt', 'staged.txt', 'untracked.txt']);
});

test('the recorded tree is what the review diff showed and the landing commits, for an entry the index hides from git', async () => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    const dir = repo({ 'a.txt': 'one\n' });
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged: what git diff shows\n'); git(dir, 'add', 'a.txt');
    git(dir, 'update-index', flag, 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'on disk: what git diff does not show\n');
    assert.match(git(dir, 'diff', base), /\+staged: what git diff shows/, 'precondition: the review diff shows the staged content');

    const tree = await jailTree(dir);
    assert.equal(git(dir, 'cat-file', '-p', `${tree}:a.txt`), 'staged: what git diff shows', flag);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'landed');
    assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), tree, `${flag}: the landing commits the recorded tree`);

    // The flag cleared afterwards (a process the worker left behind): the hidden content is a different tree.
    git(dir, 'update-index', flag.replace('--', '--no-'), 'a.txt');
    assert.notEqual(await jailTree(dir), tree, flag);
  }
});

test('the approve endpoint takes the tree to land as-is from a person, and refuses without it', async () => {
  const f = await reviewed();
  const server = createServer(f.store, f.sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/${f.task.id}/approve`;
  const post = async (body: unknown): Promise<{ status: string; merge: { merged: boolean; reason: string } }> =>
    (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as never;
  try {
    fs.writeFileSync(path.join(f.jail, 'late.txt'), 'by hand\n');
    const refused = await post({});
    assert.equal(refused.merge.merged, false);
    assert.equal(refused.status, 'awaiting-approval');
    const now = /--as-is ([0-9a-f]{40})$/.exec(refused.merge.reason)?.[1] ?? '';
    assert.match(now, /^[0-9a-f]{40}$/, refused.merge.reason);
    for (const wrong of [f.run.reviewedTree, true, { sha: now }]) {
      const out = await post({ acceptTree: wrong });
      assert.equal(out.merge.merged, false, JSON.stringify(wrong));
      assert.equal(out.status, 'awaiting-approval');
    }
    assert.equal(git(f.dir, 'rev-parse', 'HEAD'), f.head);

    const out = await post({ acceptTree: now });
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(out.status, 'done');
    assert.equal(git(f.dir, 'rev-parse', 'HEAD^2^{tree}'), now);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.done();
  }
});

test('a worktree that changes while its diff is being collected is not parked: there is no one tree to review', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-collect-'));
  const pid = path.join(out, 'pid');
  // The worker leaves a process behind that goes on writing to the worktree. (A post-index-change hook under
  // the worker's own core.hooksPath used to stand in for it here; Foreman's git no longer runs one — phase2.)
  // The loop is long so a slow machine still collects inside it; the test stops it. It makes its own session
  // and the worker waits for that before it exits: what a command leaves in its own session or group is ended
  // when it exits (proctree.ts LeftoverReaper), and an unsampled setsid leftover is the one that escapes.
  const loop = 'i=0; while [ $i -lt 20000 ]; do echo written-during-collection >> late.txt; i=$((i+1)); sleep 0.005; done';
  const writer = `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "/bin/sh", "-c", $ARGV[1]' "${pid}" '${loop}' >/dev/null 2>&1 & while [ ! -s "${pid}" ]; do sleep 0.05; done`;
  const f = await reviewed({ prompt: `printf 'TICKET\\n' > a.txt; printf 'new\\n' > new.txt; ${writer}` });
  try {
    assert.equal(f.task.status, 'failed', `${f.task.status}: ${f.task.error ?? ''}`);
    assert.match(eventsOf(f.store, f.task.id).join('\n'), /the worktree changed while its diff was being collected/);
    assert.equal(f.run.reviewedTree ?? null, null, 'no tree was recorded for it');
  } finally {
    try { process.kill(-Number(fs.readFileSync(pid, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
    await f.done();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a DB created without runs.reviewed_tree migrates, reads null, and opens again unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tree-db-'));
  const file = path.join(dir, 'f.db');
  const columns = (): string[] => {
    const raw = new DatabaseSync(file);
    try {
      return (raw.prepare('PRAGMA table_info(runs)').all() as Array<Record<string, unknown>>).map((c) => `${String(c['name'])} ${String(c['type'])} notnull=${String(c['notnull'])}`);
    } finally {
      raw.close();
    }
  };
  try {
    const first = new Store(file);
    const task = first.addTask({ title: 't', prompt: 'p', runner: 'echo' });
    const runId = first.startRun(task.id).id;
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE runs DROP COLUMN reviewed_tree');
    raw.close();
    const without = columns();
    assert.equal(without.some((c) => c.startsWith('reviewed_tree')), false);

    const second = new Store(file);
    assert.equal(second.getRun(runId)!.reviewedTree, null, 'a run parked before the column existed has no tree');
    second.setRunMeta(runId, { reviewedTree: 'a'.repeat(40) });
    second.close();
    const migrated = columns();
    assert.deepEqual(migrated, [...without, 'reviewed_tree TEXT notnull=0'], 'one nullable column, nothing else');

    const third = new Store(file);
    assert.equal(third.getRun(runId)!.reviewedTree, 'a'.repeat(40));
    third.close();
    assert.deepEqual(columns(), migrated, 'opening again changes nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

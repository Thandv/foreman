import './env.ts';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BudgetExceeded } from '../src/budget.ts';
import { config } from '../src/config.ts';
import { leadWithCoreGuard, Store } from '../src/queue.ts';
import { applyApproval, hardHumanReason, ownerGate, ownerGateBatch } from '../src/gate.ts';
import { changedFiles, createJail, diffJail, jailChanges, jailTree, reuseJail, showBaseFile, type Jail } from '../src/isolate.ts';
import { mergeApproved } from '../src/merge.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';
import { briefFor, coreGuardBrief, Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { admit } from '../src/security/admit.ts';
import * as coreGuard from '../src/security/coreGuard.ts';
import { changedPaths, coreRefusal, isProtectedPath, isSelfTask, PROTECTED_PATHS } from '../src/security/coreGuard.ts';
import { probeTask } from '../src/types.ts';
import type { Run, Task, Verdict } from '../src/types.ts';

// Every test here stands a throwaway repo in for Foreman (the `selfRoot` each
// guard takes), so nothing touches the checkout the suite runs from.

// No test inherits a repository identity another one cached.
const clearIdentities = (): void => { coreGuard.clearRepoIdentityCache?.(); };
beforeEach(clearIdentities);

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const BASE: Record<string, string> = {
  'README.md': 'base\n',
  'src/app.ts': 'export const app = 1;\n',
  'src/lock.ts': 'export const lock = 1;\n',
  'src/security/admit.ts': 'export const admit = 1;\n',
};

function repo(files: Record<string, string> = BASE): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  write(dir, files);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
}

const rm = (...dirs: string[]): void => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

/** A ticket parked at the gate on a green run whose jail is a real worktree of `dir`. */
async function parked(store: Store, dir: string, over: Partial<Parameters<Store['addTask']>[0]> = {}): Promise<{ task: Task; run: Run; jail: Jail }> {
  const task = store.addTask({ title: 'a ticket', prompt: 'p', kind: 'code', runner: 'echo', repo: dir, gate: 'owner', ...over });
  const run = store.startRun(task.id);
  const jail = await createJail(task, run.id);
  store.setRunMeta(run.id, { worktreePath: jail.dir, branch: jail.branch });
  store.setTestsPassed(run.id, true);
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, run: store.getRun(run.id)!, jail };
}

/** The diff a run records: the owner gate signs off a landing only when one exists (gate.ts, hardHumanReason). */
function recordDiff(store: Store, task: Task, run: Run, dir: string): void {
  const diffPath = path.join(dir, `${run.id}.diff`);
  fs.writeFileSync(diffPath, 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n');
  store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: 'diff' });
}

/** The tree a run records with its diff: the owner gate lands a run only when one is on record (merge.ts). */
async function recordTree(store: Store, run: Run, jail: Jail): Promise<void> {
  run.reviewedTree = await jailTree(jail.dir);
  store.setRunMeta(run.id, { reviewedTree: run.reviewedTree });
}

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const store = new Store(':memory:');
  try {
    await fn(store);
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    store.close();
  }
}

const passing = (store: Store) => async ({ task, runId }: { task: Task; runId: string }) =>
  store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });

// ------------------------------------------------------- H1: the landing check

test('landing: a protected edit the worker COMMITTED inside its jail is refused, and approving again never marks it done', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/lock.ts': 'export const lock = 2;\n', 'src/app.ts': 'export const app = 2;\n' });
    git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'hidden from git diff HEAD');
    assert.equal(git(jail.dir, 'diff', 'HEAD'), '', 'precondition: the old check saw nothing');

    for (const attempt of ['first', 'second']) {
      const out = await applyApproval(store, task.id, { selfRoot: dir });
      assert.equal(out.merge.merged, false, attempt);
      assert.match(out.merge.reason, /^core change refused: /, attempt);
      assert.match(out.merge.reason, /src\/lock\.ts/, attempt);
      assert.doesNotMatch(out.merge.reason, /src\/app\.ts/, 'only the protected path is named');
      const now = store.getTask(task.id)!;
      assert.equal(now.status, 'awaiting-approval', `${attempt} approval: not done`);
      assert.match(now.error ?? '', /not landed: core change refused/);
      assert.doesNotMatch(now.error ?? '', /approve again/, 'another approval cannot help, so the note does not ask for one');
    }
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), BASE['src/app.ts'], 'nothing of the branch landed');
  });
  rm(dir);
});

test('landing: a protected file written in the worktree AFTER the run (a test command) is refused', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    // The run's check has been and gone; mergeApproved commits whatever is there now.
    write(jail.dir, { 'src/security/late.ts': 'export const late = 1;\n', 'docs.md': 'ordinary\n' });
    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: .*src\/security\/late\.ts/);
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.equal(fs.existsSync(path.join(dir, 'src/security/late.ts')), false);
    assert.equal(fs.existsSync(path.join(dir, 'docs.md')), false);
  });
  rm(dir);
});

test('landing: the same core change lands with allowCore, and on a repo that is not Foreman', async () => {
  const dir = repo();
  const other = repo();
  await withStore(async (store) => {
    const allowed = await parked(store, dir, { allowCore: true });
    write(allowed.jail.dir, { 'src/lock.ts': 'export const lock = 3;\n' });
    const first = await applyApproval(store, allowed.task.id, { selfRoot: dir });
    assert.equal(first.merge.merged, true, first.merge.reason);
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), 'export const lock = 3;\n');
    assert.equal(store.getTask(allowed.task.id)!.status, 'done');

    // `other` has the same file names but is somebody else's repo.
    const foreign = await parked(store, other);
    write(foreign.jail.dir, { 'src/lock.ts': 'export const lock = 4;\n' });
    const second = await applyApproval(store, foreign.task.id, { selfRoot: dir });
    assert.equal(second.merge.merged, true, second.merge.reason);
    assert.equal(fs.readFileSync(path.join(other, 'src/lock.ts'), 'utf8'), 'export const lock = 4;\n');
  });
  rm(dir, other);
});

test('landing: an ordinary change to Foreman still lands', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/app.ts': 'export const app = 5;\n' });
    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(store.getTask(task.id)!.status, 'done');
  });
  rm(dir);
});

test('landing: renaming a protected file out of its path, or an ordinary file into one, is refused', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const out = await parked(store, dir);
    git(out.jail.dir, 'mv', 'src/lock.ts', 'src/moved.ts');
    const movedOut = await applyApproval(store, out.task.id, { selfRoot: dir });
    assert.equal(movedOut.merge.merged, false);
    assert.match(movedOut.merge.reason, /^core change refused: .*\(src\/lock\.ts\)/, 'the path that went is the one named');

    const into = await parked(store, dir);
    git(into.jail.dir, 'mv', 'src/app.ts', 'src/security/app.ts');
    git(into.jail.dir, 'commit', '-qm', 'moved in');
    const movedIn = await applyApproval(store, into.task.id, { selfRoot: dir });
    assert.equal(movedIn.merge.merged, false);
    assert.match(movedIn.merge.reason, /^core change refused: .*\(src\/security\/app\.ts\)/);

    assert.ok(fs.existsSync(path.join(dir, 'src/lock.ts')) && fs.existsSync(path.join(dir, 'src/app.ts')));
  });
  rm(dir);
});

test('landing: a path with a space and a non-ASCII letter is listed as it is, and refused under a protected path', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const odd = 'src/security/capí tulo uno.ts';
    const { task, run, jail } = await parked(store, dir);
    write(jail.dir, { [odd]: 'x\n', 'notes/añ o.md': 'y\n' });
    git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'odd names');
    assert.deepEqual(
      (await changedPaths(dir, git(dir, 'rev-parse', 'HEAD'), run.branch!)).sort(),
      ['notes/añ o.md', odd].sort(),
    );
    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.ok(out.merge.reason.includes(`(${odd})`), out.merge.reason);
  });
  rm(dir);
});

for (const key of ['diff.noprefix', 'diff.mnemonicPrefix']) {
  test(`landing: with ${key}=true in the repo config the refusal still happens`, async () => {
    const dir = repo();
    git(dir, 'config', key, 'true');
    await withStore(async (store) => {
      const { task, jail } = await parked(store, dir);
      write(jail.dir, { 'src/lock.ts': 'export const lock = 6;\n' });
      assert.doesNotMatch(git(jail.dir, 'diff', 'HEAD'), /^\+\+\+ b\//m, 'precondition: plain patch headers carry no b/ prefix');
      const out = await applyApproval(store, task.id, { selfRoot: dir });
      assert.equal(out.merge.merged, false);
      assert.match(out.merge.reason, /^core change refused: .*src\/lock\.ts/);
    });
    rm(dir);
  });
}

test('landing fails closed: a branch that is ahead with no path listed, or that cannot be listed, is refused', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const empty = await parked(store, dir);
    git(empty.jail.dir, 'commit', '-q', '--allow-empty', '-m', 'nothing listed');
    const first = await mergeApproved(store.decide(empty.task.id, true), empty.run, { selfRoot: dir });
    assert.equal(first.merged, false);
    assert.match(first.reason, /^core change refused: .*listed no path/);

    // Unrelated history: there is no merge base to list from.
    const orphan = await parked(store, dir);
    git(orphan.jail.dir, 'checkout', '-q', '--orphan', 'elsewhere');
    git(orphan.jail.dir, 'commit', '-qm', 'no shared history');
    git(orphan.jail.dir, 'branch', '-f', orphan.run.branch!, 'elsewhere');
    const second = await mergeApproved(store.decide(orphan.task.id, true), orphan.run, { selfRoot: dir });
    assert.equal(second.merged, false);
    assert.match(second.reason, /^core change refused: .*could not be listed/);
  });
  rm(dir);
});

test('the protected-path test ignores letter-case and matches a directory entry without its slash', () => {
  assert.equal(isProtectedPath('SRC/Lock.ts'), true);
  assert.equal(isProtectedPath('src/security'), true, 'the directory replaced by a file or a symlink');
  assert.equal(isProtectedPath('src/security/deep/x.ts'), true);
  assert.equal(isProtectedPath('src/securityx.ts'), false);
  assert.equal(isProtectedPath('src/cli.ts'), false);
  // Spellings this disk opens as the same file: U+017F for s, and an invisible joiner.
  assert.equal(isProtectedPath('\u017frc/lock.ts'), true);
  assert.equal(isProtectedPath('src/\u017fecurity/evil.ts'), true);
  assert.equal(isProtectedPath('src/lo\u200dck.ts'), true);
  assert.equal(isProtectedPath('src/l\u00f6ck.ts'), false, 'a different letter is a different file');
  assert.match(coreRefusal(['a.txt', 'src/merge.ts'], true) ?? '', /^core change refused: .*\(src\/merge\.ts\)/);
  assert.equal(coreRefusal(['a.txt'], true), null);
  assert.equal(coreRefusal([], false), null, 'no change, nothing to refuse');
});

// ------------------------------------------- H2: the run's check and the review diff

test('the review diff contains what the worker committed inside the jail, in a/ b/ form whatever the repo config', async () => {
  const dir = repo();
  git(dir, 'config', 'diff.noprefix', 'true');
  const task = probeTask({ id: 'rd1', repo: dir, kind: 'code' });
  const jail = await createJail(task, 'r_rd1');
  write(jail.dir, { 'src/app.ts': 'export const app = "committed";\n' });
  git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'committed in the jail');
  write(jail.dir, { 'README.md': 'uncommitted\n', 'new.txt': 'untracked\n' });

  const diff = await diffJail(jail);
  assert.match(diff, /^\+export const app = "committed";$/m, 'the committed change is in the review diff');
  assert.match(diff, /^\+uncommitted$/m);
  assert.match(diff, /^\+untracked$/m);
  assert.match(diff, /^\+\+\+ b\/src\/app\.ts$/m, 'prefixed headers despite diff.noprefix');

  // A later round that re-opens the same worktree measures from the same commit.
  const again = await reuseJail(task, jail.dir, jail.branch, jail.baseCommit);
  assert.ok(again);
  assert.equal(again.baseCommit, git(dir, 'rev-parse', 'HEAD'), 'the reused handle carries the base its caller kept');
  assert.match(await diffJail(again), /^\+export const app = "committed";$/m);
  assert.deepEqual((await jailChanges(again)).paths.sort(), ['README.md', 'new.txt', 'src/app.ts']);
  rm(dir);
});

test('a jail cut from an unmerged draft is measured from that draft, also when a later round reuses it', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'draft');
  write(dir, { 'draft.txt': 'the draft this ticket reviews\n' });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'draft'); git(dir, 'checkout', '-q', '-');
  const task = probeTask({ id: 'rd2', repo: dir, kind: 'code', baseRef: 'draft' });
  const jail = await createJail(task, 'r_rd2');
  write(jail.dir, { 'fix.txt': 'the fix\n' });
  git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'fix on the draft');

  const again = await reuseJail(task, jail.dir, jail.branch, jail.baseCommit);
  assert.ok(again);
  for (const j of [jail, again]) {
    const diff = await diffJail(j);
    assert.match(diff, /^\+the fix$/m);
    assert.doesNotMatch(diff, /the draft this ticket reviews/, 'the draft is the base, not part of this run');
    assert.deepEqual((await jailChanges(j)).paths, ['fix.txt']);
  }
  rm(dir);
});

test('the run check refuses a self-task whose worker committed a protected edit in the jail; it is never parked', async () => {
  const dir = repo();
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5, selfRoot: dir,
    verify: async (args) => { reviews++; return passing(store)(args); },
  });
  try {
    // The path is assembled in the shell so the brief does not name it.
    const t = store.addTask({
      title: 'quiet edit', kind: 'code', runner: 'shell', repo: dir,
      prompt: 'f=src/lo; printf \'export const lock = 9;\\n\' > "${f}ck.ts" && git add -A && git commit -qm quiet',
    });
    await sched.drain(60_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'failed', after.error ?? '');
    assert.match(after.error ?? '', /^core change refused: .*src\/lock\.ts/);
    assert.equal(reviews, 0, 'refused before any review');
    assert.equal(store.latestRun(t.id)!.status, 'failed');
    assert.equal(after.attempts, 1, 'fatal: not retried');

    // A name git quotes in patch headers ("b/src/security/cap\303\255tulo.ts") is read
    // from no header at all; git's own listing still names it.
    const odd = store.addTask({
      title: 'odd name', kind: 'code', runner: 'shell', repo: dir,
      prompt: 'd=src/secu; mkdir -p "${d}rity" && printf \'x\\n\' > "${d}rity/capítulo.ts"',
    });
    await sched.drain(60_000);
    assert.equal(store.getTask(odd.id)!.status, 'failed', store.getTask(odd.id)!.error ?? '');
    assert.match(store.getTask(odd.id)!.error ?? '', /^core change refused: .*\(src\/security\/capítulo\.ts\)/);
    assert.equal(reviews, 0);
  } finally {
    await sched.stop();
    store.close();
    rm(dir);
  }
});

// --------------------------------------------- H3: a person lands every self-change

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

/** A claude CLI stand-in that approves whatever it is shown, and counts how often it was asked. */
function approvingOwner(): { dir: string; count: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-cli-'));
  const bin = path.join(dir, 'claude');
  const countFile = path.join(dir, 'count');
  fs.writeFileSync(path.join(dir, 'body'), envelope(JSON.stringify({ decision: 'approve', rationale: 'looks right' })));
  fs.writeFileSync(bin, `#!/bin/sh\nprintf 'x' >> "${countFile}"\ncat "${dir}/body"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  return { dir, count: () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8').length : 0) };
}

test('the owner gate never decides a change to Foreman itself: not asked, ticket stays parked (no allowCore needed)', async () => {
  const dir = repo();
  const owner = approvingOwner();
  try {
    await withStore(async (store) => {
      const { task, run, jail } = await parked(store, dir);
      write(jail.dir, { 'src/app.ts': 'export const app = 7;\n' });
      recordDiff(store, task, run, owner.dir);
      await recordTree(store, run, jail);
      assert.match(hardHumanReason(task, run, { selfRoot: dir }) ?? '', /a change to foreman itself is landed by a person/);

      const decision = await ownerGate({ task, run, store, selfRoot: dir });
      assert.equal(decision, 'hold');
      assert.equal(owner.count(), 0, 'the owner model was never asked');
      assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), BASE['src/app.ts']);

      // The same green ticket on somebody else's repo IS the owner's to decide.
      const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-else-')));
      try {
        assert.equal(await ownerGate({ task, run, store, selfRoot: elsewhere }), 'approved');
        assert.equal(owner.count(), 1);
      } finally {
        rm(elsewhere);
      }
    });
  } finally {
    delete process.env['FOREMAN_CLAUDE_BIN'];
    rm(dir, owner.dir);
  }
});

test('the batch gate never decides changes to Foreman itself either', async () => {
  const dir = repo();
  const owner = approvingOwner();
  try {
    await withStore(async (store) => {
      const epic = store.addTask({ title: 'epic', prompt: 'p', runner: 'echo' });
      const a = await parked(store, dir, { parentId: epic.id });
      const b = await parked(store, dir, { parentId: epic.id });
      for (const it of [a, b]) recordDiff(store, it.task, it.run, owner.dir);
      const decisions = await ownerGateBatch({
        items: [{ task: a.task, run: a.run }, { task: b.task, run: b.run }], store, selfRoot: dir,
      });
      assert.deepEqual([...decisions.values()], ['hold', 'hold']);
      assert.equal(owner.count(), 0, 'the owner model was never asked');
      for (const t of [a.task, b.task]) assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    });
  } finally {
    delete process.env['FOREMAN_CLAUDE_BIN'];
    rm(dir, owner.dir);
  }
});

// ------------------------------------------------- H4: self by identity, not spelling

test('a self-task is recognised by repository, however its path is spelled', () => {
  const dir = repo();
  const other = repo();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-spell-')));
  // Each spelling is decided on its own lookup, not on one cached for another.
  const self = (p: string | null): boolean => { clearIdentities(); return isSelfTask({ repo: p }, dir); };
  try {
    assert.equal(self(dir), true);
    assert.equal(self(`${dir}/`), true, 'a trailing slash');
    assert.equal(self(path.join(dir, 'src')), true, 'a sub-directory of the checkout');
    assert.equal(self(path.join(dir, 'src', 'security')), true);

    const link = path.join(scratch, 'link');
    fs.symlinkSync(dir, link);
    assert.equal(self(link), true, 'a symlink to the checkout');
    assert.equal(self(path.join(link, 'src')), true, 'a sub-directory reached through a symlink');

    const linked = path.join(scratch, 'linked-worktree');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', linked);
    assert.equal(self(linked), true, 'a linked worktree of the same repository');

    assert.equal(self(other), false, 'a different repository with the same files');
    assert.equal(self(scratch), false, 'a directory that is not a repository');
    assert.equal(self(path.join(scratch, 'missing')), false);
    assert.equal(self(null), false);
    // A separate repository nested inside the checkout is its own repository.
    const nested = path.join(dir, 'vendor');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    assert.equal(self(nested), false);

    // When git cannot answer, the old comparison of resolved paths still holds.
    clearIdentities();
    assert.equal(isSelfTask({ repo: `${scratch}/` }, scratch), true);
    clearIdentities();
    assert.equal(isSelfTask({ repo: link }, scratch), false);
  } finally {
    rm(dir, other, scratch);
  }
});

test('a self-task is recognised under another letter-case spelling of the checkout', (t) => {
  const dir = repo();
  try {
    const shout = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
    if (shout === dir || !fs.existsSync(shout)) return t.skip('this disk does not fold letter-case');
    assert.equal(isSelfTask({ repo: shout }, dir), true);
    assert.equal(isSelfTask({ repo: path.join(shout, 'SRC') }, dir), true);
  } finally {
    rm(dir);
  }
});

// ----------------------------------------------------- H5: the warning is surfaced

/**
 * A `frisk-scan` stand-in on PATH that reports one core-guard warning.
 * admit() takes frisk's findings as they come, which is how a core-guard
 * finding reaches the scheduler here without a brief that names a path.
 */
function friskWarns(message: string, rule = 'core-guard'): { restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-frisk-'));
  const bin = path.join(dir, 'frisk-scan');
  fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify({ findings: [{ severity: 'warn', rule, message }] }));
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat "${dir}/out.json"\n`);
  fs.chmodSync(bin, 0o755);
  const before = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${before ?? ''}`;
  return { restore: () => { process.env['PATH'] = before; rm(dir); } };
}

const WARNING = 'this ticket names src/merge.ts';

test('a core-guard admission finding is a timeline warning and leads the park note on the gate item', async () => {
  const dir = repo();
  const frisk = friskWarns(WARNING);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  try {
    const t = store.addTask({ title: 'ordinary', prompt: "printf 'more\\n' >> README.md", kind: 'code', runner: 'shell', repo: dir });
    await sched.drain(60_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.ok((after.error ?? '').startsWith(`core-guard: ${WARNING}`), `the note on the gate item leads with it: ${after.error}`);
    const warnings = store.eventsForTask(t.id).filter((e) => e.type === 'warning').map((e) => e.message);
    assert.deepEqual(warnings, [`CORE-GUARD: ${WARNING}`]);
  } finally {
    await sched.stop();
    store.close();
    frisk.restore();
    rm(dir);
  }
});

test('the core-guard note goes in front of another park note and stays inside the note cap', () => {
  assert.equal(leadWithCoreGuard(null, []), null);
  assert.equal(leadWithCoreGuard('council split — needs your call', []), 'council split — needs your call');
  assert.equal(leadWithCoreGuard('council split — needs your call', ['names src/lock.ts']), 'core-guard: names src/lock.ts | council split — needs your call');
  assert.equal(leadWithCoreGuard('n'.repeat(990), ['names src/lock.ts'])!.length, 1000);
});

const CORE_LINE = `CORE GUARD: do not modify any of: ${PROTECTED_PATHS.join(', ')}. A change to them is refused. ` +
  'If this ticket cannot be done without changing one of them, stop and say so.';

test('the worker brief tells a self-task the whole protected list, not only the paths its text names', () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const naming = probeTask({ repo: dir, kind: 'code', prompt: 'Read src/merge.ts and report what src/security/admit.ts returns on a conflict.' });
    assert.ok(briefFor(store, naming, dir).includes(CORE_LINE), briefFor(store, naming, dir));
    assert.ok(coreGuardBrief(naming, dir).endsWith(CORE_LINE));
    for (const p of PROTECTED_PATHS) assert.ok(coreGuardBrief(naming, dir).includes(p), `${p} is listed`);
  } finally {
    store.close();
    rm(dir);
  }
});

test('a self-task whose prompt names no protected path still gets the full core-guard list in its brief', () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const plain = probeTask({ repo: dir, kind: 'code', prompt: 'Tidy src/cli.ts.' });
    assert.ok(briefFor(store, plain, dir).includes(CORE_LINE), briefFor(store, plain, dir));
    assert.ok(coreGuardBrief(plain, dir).endsWith(CORE_LINE));
    // The list is in the brief, not in the ticket admission reads: it raises no warning.
    assert.equal(admit(plain, { selfRoot: dir }).some((f) => f.rule === 'core-guard'), false);
  } finally {
    store.close();
    rm(dir);
  }
});

test('a task against another repo and an allowCore self-task get no core-guard line in the brief', () => {
  const dir = repo();
  const store = new Store(':memory:');
  try {
    const naming = probeTask({ repo: dir, kind: 'code', prompt: 'Change src/merge.ts.' });
    const elsewhere = fs.realpathSync(os.tmpdir());
    assert.equal(coreGuardBrief(naming, elsewhere), '', 'not a self-task: nothing to say');
    assert.doesNotMatch(briefFor(store, naming, elsewhere), /CORE GUARD/);
    assert.equal(coreGuardBrief(probeTask({ kind: 'code', prompt: 'Change src/merge.ts.' }), dir), '', 'no repo: not a self-task');
    assert.equal(coreGuardBrief({ ...naming, allowCore: true }, dir), '');
    assert.doesNotMatch(briefFor(store, { ...naming, allowCore: true }, dir), /CORE GUARD/);
  } finally {
    store.close();
    rm(dir);
  }
});

test('the brief the scheduler hands a claude-code worker on a self-task carries the core-guard line', async () => {
  const dir = repo();
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-brief-'));
  // A `claude` stand-in that keeps the text after -p and edits an unprotected file.
  exe(path.join(stub, 'claude'), [
    `[ "$1" = "--version" ] && { printf '1.2.3\\n'; exit 0; }`,
    `while [ $# -gt 0 ]; do [ "$1" = "-p" ] && printf '%s' "$2" > "${stub}/prompt"; shift; done`,
    `printf 'more\\n' >> README.md`,
    `printf '{"type":"system","subtype":"init","session_id":"sess-1"}\\n'`,
    `printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"done"}\\n'`,
  ].join('\n'));
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub, 'claude');
  resetPreflightCache();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  try {
    const t = store.addTask({ title: 'tidy', prompt: 'Add a line to the readme.', kind: 'code', runner: 'claude-code', repo: dir });
    await sched.drain(120_000);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
    const sent = fs.readFileSync(path.join(stub, 'prompt'), 'utf8');
    assert.ok(sent.includes('Add a line to the readme.'), sent);
    assert.ok(sent.includes(CORE_LINE), `the worker was told the protected list: ${sent}`);
  } finally {
    await sched.stop();
    store.close();
    delete process.env['FOREMAN_CLAUDE_BIN'];
    resetPreflightCache();
    rm(dir, stub);
  }
});

// --------------------------------------------------------------- H7: reopen

test('reopen refuses a ticket whose latest run is not the one that failed review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-reopen-'));
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'repair me', prompt: 'p', runner: 'echo' });
    // Round 1 fails review…
    const first = store.startRun(t.id).id;
    store.setRunMeta(first, { worktreePath: dir, branch: 'foreman/x' });
    store.addVerdict({ runId: first, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique: 'no' });
    store.endRun(first, 'failed', { exitCode: 1, summary: 'review said no' });
    // …and round 2, in the reused jail, is refused by the core guard: no review at all.
    const second = store.startRun(t.id).id;
    store.setRunMeta(second, { worktreePath: dir, branch: 'foreman/x' });
    store.endRun(second, 'failed', { exitCode: 1, summary: 'core change refused: …' });
    store.setStatus(t.id, 'failed', 'core change refused: …');

    assert.throws(() => store.reopen(t.id), /latest run is not the one that failed review; retry it instead/);
    assert.equal(store.getTask(t.id)!.status, 'failed');

    // A ticket whose latest run IS the failed review reopens as before.
    const ok = store.addTask({ title: 'reopen me', prompt: 'p', runner: 'echo' });
    const only = store.startRun(ok.id).id;
    store.setRunMeta(only, { worktreePath: dir });
    store.addVerdict({ runId: only, taskId: ok.id, verdict: 'fail', disagreement: false, council: [], critique: 'no' });
    store.endRun(only, 'failed', { exitCode: 1, summary: 'review said no' });
    store.setStatus(ok.id, 'failed', 'review said no');
    assert.equal(store.reopen(ok.id).status, 'awaiting-approval');
  } finally {
    store.close();
    rm(dir);
  }
});

// ------------------------------------------------------- H8: the list, end to end

test('the protected list names real paths, including the guard, the jail and the tests that pin them', () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const p of PROTECTED_PATHS) assert.ok(fs.existsSync(path.join(root, p)), `${p} does not exist`);
  for (const p of ['src/security/coreGuard.ts', 'src/security/admit.ts', 'src/improve.ts', 'src/merge.ts', 'src/isolate.ts',
    'src/gate.ts', 'src/scheduler.ts', 'src/queue.ts', 'src/server.ts', 'src/db.ts',
    'test/improve.test.ts', 'test/security-guard.test.ts']) {
    assert.equal(isProtectedPath(p), true, p);
  }
});

test('end to end: a self-task whose worker writes a protected file ends failed with the reason, is never parked, and its timeline carries the admission warning', async () => {
  const dir = repo();
  const frisk = friskWarns(WARNING);
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5, selfRoot: dir,
    verify: async (args) => { reviews++; return passing(store)(args); },
  });
  try {
    const t = store.addTask({
      title: 'writes core', kind: 'code', runner: 'shell', repo: dir,
      prompt: 'd=src/secu; mkdir -p "${d}rity" && printf \'export const x = 1;\\n\' > "${d}rity/extra.ts"',
    });
    await sched.drain(60_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'failed', after.error ?? '');
    assert.match(after.error ?? '', /^core change refused: this change touches Foreman's core \(src\/security\/extra\.ts\)/);
    assert.equal(reviews, 0);
    const events = store.eventsForTask(t.id);
    assert.ok(events.some((e) => e.type === 'warning' && e.message === `CORE-GUARD: ${WARNING}`), 'the admission warning line');
    assert.equal(events.some((e) => /awaiting-approval/.test(e.message)), false, 'never parked');
    assert.equal(fs.existsSync(path.join(dir, 'src/security/extra.ts')), false);

    // The same worker against a repo that is not Foreman parks as usual.
    const elsewhere = repo();
    const plain = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
    try {
      const u = store.addTask({ title: 'writes there', kind: 'code', runner: 'shell', repo: elsewhere, prompt: t.prompt });
      await plain.drain(60_000);
      assert.equal(store.getTask(u.id)!.status, 'awaiting-approval', store.getTask(u.id)!.error ?? '');
    } finally {
      await plain.stop();
      rm(elsewhere);
    }
  } finally {
    await sched.stop();
    store.close();
    frisk.restore();
    rm(dir);
  }
});

// ----------------------------------- the landing check, on what the merge really does

const exe = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
};

for (const where of ['a tracked directory', 'an absolute path']) {
  test(`landing: a merge hook under ${where} does not run, so it cannot write Foreman's core after the check`, async () => {
    const dir = repo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-hooks-')));
    await withStore(async (store) => {
      const { task, jail } = await parked(store, dir);
      const hooks = where === 'a tracked directory' ? path.join(jail.dir, 'tools/hooks') : outside;
      const ran = path.join(outside, 'ran');
      for (const hook of ['pre-commit', 'pre-merge-commit', 'post-merge', 'post-commit']) {
        // Staged as well as written: a pre-commit hook puts it in the commit being made.
        exe(path.join(hooks, hook), `printf '${hook}\\n' >> "${ran}"; printf 'EVIL-FROM-HOOK\\n' > src/lock.ts; git add src/lock.ts`);
      }
      write(jail.dir, { 'src/app.ts': 'export const app = 2;\n' });
      // The jail shares the repo's config: this is the worker's own `git config`.
      git(jail.dir, 'config', 'core.hooksPath', where === 'a tracked directory' ? 'tools/hooks' : outside);

      const out = await applyApproval(store, task.id, { selfRoot: dir });
      assert.equal(out.merge.merged, true, out.merge.reason);
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), 'export const app = 2;\n');
      assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts'], 'no hook ran in the checkout');
      assert.equal(git(dir, 'status', '--porcelain'), '');
      assert.equal(fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '', '', 'no hook ran for the pending-work commit or for the merge');
    });
    rm(dir, outside);
  });
}

test('landing: a branch built on two merge bases that puts a protected file back is refused', async () => {
  const dir = repo();
  // The shape every landing leaves: a side branch with a protected fix, merged --no-ff.
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, { 'src/lock.ts': 'export const lock = 2; // SECURITY FIX\n' });
  git(dir, 'commit', '-qam', 'fix'); git(dir, 'checkout', '-q', '-');
  write(dir, { 'other.txt': 'c1\n' });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'c1');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'M', 'side');
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    // The old lock.ts plus an ordinary edit, committed on BOTH of M's parents:
    // no commit of the branch names lock.ts against the base git picks.
    write(jail.dir, { 'src/lock.ts': BASE['src/lock.ts']!, 'src/app.ts': 'export const app = 2;\n' });
    git(jail.dir, 'add', '-A');
    const x = git(jail.dir, 'commit-tree', git(jail.dir, 'write-tree'), '-p', 'HEAD^1', '-p', 'HEAD^2', '-m', 'x');
    git(jail.dir, 'reset', '-q', '--hard', x);
    assert.equal(git(dir, 'merge-base', '--all', 'HEAD', x).split('\n').length, 2, 'precondition: two merge bases');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: .*could not be listed \(it has 2 merge bases/);
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), 'export const lock = 2; // SECURITY FIX\n');
  });
  rm(dir);
});

test('landing: an edit that follows a file HEAD has since renamed into a protected path is refused', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`);
  const dir = repo({ ...BASE, 'src/old.ts': `${lines.join('\n')}\n` });
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/old.ts': `${[...lines.slice(0, -1), '// EVIL-LINE'].join('\n')}\n` });
    git(jail.dir, 'commit', '-qam', 'edit old.ts');
    // On main, after the jail was cut:
    git(dir, 'mv', 'src/old.ts', 'src/security/new.ts'); git(dir, 'commit', '-qm', 'moved into the core');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: .*\(src\/security\/new\.ts\)/, 'named where it would land, not where it was edited');
    assert.doesNotMatch(out.merge.reason, /undone/, 'refused before any merge was made in the checkout');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'src/security/new.ts'), 'utf8'), /EVIL-LINE/);
  });
  rm(dir);
});

test('landing: an ordinary change still lands after HEAD moved on with a protected change of its own', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/app.ts': 'export const app = 2;\n' });
    write(dir, { 'src/lock.ts': 'export const lock = "a person changed this";\n' });
    git(dir, 'commit', '-qam', 'by hand');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), 'export const lock = "a person changed this";\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), 'export const app = 2;\n');
  });
  rm(dir);
});

test('landing: a self-task spelled as a sub-directory, in a repo with diff.relative=true, is still refused', async () => {
  const dir = repo({ ...BASE, 'docs/x.md': 'docs\n' });
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir, { repo: path.join(dir, 'docs') });
    git(jail.dir, 'config', 'diff.relative', 'true');
    write(jail.dir, { 'src/lock.ts': 'EVIL\n', 'docs/x.md': 'more docs\n' });
    git(jail.dir, 'commit', '-qam', 'both');
    assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: path.join(jail.dir, 'docs'), encoding: 'utf8' }).trim(), 'x.md',
      'precondition: from docs/ a plain listing shows only the file in docs/');
    assert.deepEqual(await changedPaths(path.join(jail.dir, 'docs'), 'HEAD~1', 'HEAD'), ['docs/x.md', 'src/lock.ts'], 'the guard\'s listing is of the whole tree');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: .*\(src\/lock\.ts\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
  });
  rm(dir);
});

test('landing: a commit added to the branch between the check and the merge does not land', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, run, jail } = await parked(store, dir);
    write(jail.dir, { 'src/app.ts': 'export const app = 2;\n' });
    const out = await mergeApproved(store.decide(task.id, true), run, {
      selfRoot: dir,
      beforeMerge: () => {
        write(jail.dir, { 'src/lock.ts': 'export const lock = "EVIL";\n' });
        git(jail.dir, 'commit', '-qam', 'late');
      },
    });
    assert.equal(out.merged, true, out.reason);
    assert.match(out.reason, /^merged 1 commit\(s\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), 'export const app = 2;\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts'], 'the late commit is not part of the merge');
    assert.doesNotMatch(git(dir, 'log', '--format=%s', 'HEAD'), /^late$/m);
  });
  rm(dir);
});

// The driver is repo config, which the jail can write. git used to run it in the checkout, during the prediction
// and the merge; the landing's git calls now name git's own line merge in its place (isolate.ts driverlessEnv), so
// whatever the driver would do, it never runs, and the protected file is never touched.
for (const [what, driver] of [
  // Would hand back the branch's side, after writing the protected file.
  ['the merge is undone', "printf 'EVIL-FROM-DRIVER\\n' > src/lock.ts; cat %B > %A"],
  // Would keep HEAD's side, after writing the protected file.
  ['the file is put back', "printf 'EVIL-FROM-DRIVER\\n' > src/lock.ts"],
  // Would report a conflict, after writing the protected file.
  ['the file is put back after a conflict', "printf 'EVIL-FROM-DRIVER\\n' > src/lock.ts; printf 'both\\n' > %A; exit 1"],
] as const) {
  test(`landing: a merge driver that writes a protected file in the checkout is never run (it would have: ${what})`, async () => {
    const dir = repo({ ...BASE, '.gitattributes': 'src/app.ts merge=mine\n', 'src/app.ts': 'one\ntwo\nthree\nfour\nfive\n' });
    await withStore(async (store) => {
      const { task, jail } = await parked(store, dir);
      write(jail.dir, { 'src/app.ts': 'one\ntwo\nthree\nfour\nFIVE\n' });
      const ran = path.join(dir, '.git', 'driver-ran');
      git(jail.dir, 'config', 'merge.mine.driver', `: > "${ran}"; ${driver}`);
      // Both sides touched app.ts, so git hands it to the driver — had it one.
      write(dir, { 'src/app.ts': 'ONE\ntwo\nthree\nfour\nfive\n' });
      git(dir, 'commit', '-qam', 'main side');
      const head = git(dir, 'rev-parse', 'HEAD');

      const out = await applyApproval(store, task.id, { selfRoot: dir });
      assert.equal(fs.existsSync(ran), false, 'the planted driver did not run, in the prediction or the merge');
      assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
      assert.equal(git(dir, 'status', '--porcelain'), '');
      // git's own line merge in its place: the two app.ts edits do not overlap, and only app.ts lands.
      assert.equal(out.merge.merged, true, out.merge.reason);
      assert.equal(git(dir, 'rev-parse', 'HEAD^1'), head, 'the merge is on the HEAD that was checked');
      assert.equal(git(dir, 'show', 'HEAD:src/app.ts'), 'ONE\ntwo\nthree\nfour\nFIVE');
      assert.deepEqual(git(dir, 'diff', '--name-only', head, 'HEAD').split('\n'), ['src/app.ts'], 'no protected path landed');
      assert.equal(store.getTask(task.id)!.status, 'done');
    });
    rm(dir);
  });
}

test('landing: with a merge driver planted, a branch that changes a protected file is refused by the core guard, and the driver never runs', async () => {
  const dir = repo({ ...BASE, '.gitattributes': 'src/* merge=mine\n', 'src/app.ts': 'one\ntwo\nthree\nfour\nfive\n' });
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/app.ts': 'one\ntwo\nthree\nfour\nFIVE\n', 'src/lock.ts': 'export const lock = "EVIL";\n' });
    const ran = path.join(dir, '.git', 'driver-ran');
    // Would answer every merge with HEAD's side, so the prediction lists no protected path.
    git(jail.dir, 'config', 'merge.mine.driver', `: > "${ran}"; exit 0`);
    write(dir, { 'src/app.ts': 'ONE\ntwo\nthree\nfour\nfive\n' });
    git(dir, 'commit', '-qam', 'main side');
    const head = git(dir, 'rev-parse', 'HEAD');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: this change touches Foreman's core \(src\/lock\.ts\)/);
    assert.equal(fs.existsSync(ran), false, 'the planted driver did not run');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'HEAD is where it was');
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });
  rm(dir);
});

test('an inherited GIT_DIR does not make an unrelated repo count as Foreman', () => {
  const dir = repo();
  const other = repo();
  const before = process.env['GIT_DIR'];
  process.env['GIT_DIR'] = path.join(dir, '.git');
  try {
    assert.equal(isSelfTask({ repo: other }, dir), false);
    assert.equal(isSelfTask({ repo: dir }, dir), true);
  } finally {
    if (before === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = before;
    rm(dir, other);
  }
});

// ------------------------------------------------- the jail's base, and the run check

test('a reused jail is measured from the base its caller kept, whatever the worker wrote into the jail\'s git directory', async () => {
  const dir = repo();
  const task = probeTask({ id: 'rb1', repo: dir, kind: 'code' });
  const jail = await createJail(task, 'r_rb1');
  write(jail.dir, { 'src/lock.ts': 'EVIL\n', 'src/app.ts': 'export const app = "hidden";\n' });
  git(jail.dir, 'commit', '-qam', 'work');
  // What a worker can do from inside: point every record it can reach at its own HEAD.
  fs.writeFileSync(path.join(git(jail.dir, 'rev-parse', '--absolute-git-dir'), 'foreman-base'), `${git(jail.dir, 'rev-parse', 'HEAD')}\n`);

  const again = await reuseJail(task, jail.dir, jail.branch, jail.baseCommit);
  assert.ok(again);
  assert.match(await diffJail(again), /^\+export const app = "hidden";$/m);
  const listed = await jailChanges(again);
  assert.deepEqual(listed.paths.sort(), ['src/app.ts', 'src/lock.ts']);
  assert.equal(listed.changed, true);
  rm(dir);
});

test('a recorded base that is not in the jail\'s history is ignored for the point where the jail left HEAD', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'elsewhere');
  write(dir, { 'elsewhere.txt': 'not this run\n' });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'elsewhere');
  const stray = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-');
  const task = probeTask({ id: 'rb2', repo: dir, kind: 'code' });
  const jail = await createJail(task, 'r_rb2');
  write(jail.dir, { 'mine.txt': 'this run\n' });

  const wrong = await reuseJail(task, jail.dir, jail.branch, stray);
  assert.ok(wrong);
  assert.deepEqual((await jailChanges(wrong)).paths, ['mine.txt']);
  assert.doesNotMatch(await diffJail(wrong), /elsewhere\.txt/);
  // No record at all (a jail cut before it was kept) is measured the same way.
  const none = await reuseJail(task, jail.dir, jail.branch);
  assert.ok(none);
  assert.deepEqual((await jailChanges(none)).paths, ['mine.txt']);
  rm(dir);
});

test('a jail that had HEAD merged into it is measured from that merge, not from where it was first cut', async () => {
  const dir = repo();
  const task = probeTask({ id: 'rb3', repo: dir, kind: 'code' });
  const jail = await createJail(task, 'r_rb3');
  write(jail.dir, { 'src/app.ts': 'export const app = 2;\n', 'new file.txt': 'n\n' });
  git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'work');
  // Meanwhile on main: another ticket's file and a person's change to the core.
  write(dir, { 'other.ts': 'o\n', 'src/lock.ts': 'export const lock = "by hand";\n' });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moved');
  git(jail.dir, 'merge', '-q', '--no-edit', git(dir, 'rev-parse', 'HEAD'));

  const again = await reuseJail(task, jail.dir, jail.branch, jail.baseCommit);
  assert.ok(again);
  const listed = await jailChanges(again);
  assert.deepEqual(listed.paths.sort(), ['new file.txt', 'src/app.ts']);
  assert.equal(coreRefusal(listed.paths, listed.changed), null);
  assert.doesNotMatch(await diffJail(again), /other\.ts|src\/lock\.ts/);
  rm(dir);
});

test('the review diff is git\'s own patch under a repo-configured external diff, and for a change to Foreman under a textconv driver', async () => {
  for (const key of ['diff.external', 'diff.hide.textconv']) {
    const dir = repo({ ...BASE, '.gitattributes': '*.ts diff=hide\n' });
    const blank = path.join(dir, '.git', 'blank');
    exe(blank, 'exit 0'); // prints nothing: as an external diff no patch, as a textconv two equal files
    git(dir, 'config', key, blank);
    const jail = await createJail(probeTask({ id: 'rb4', repo: dir, kind: 'code' }), `r_rb4_${key.length}`);
    write(jail.dir, { 'src/app.ts': 'export const app = "seen";\n' });
    assert.doesNotMatch(git(jail.dir, 'diff', 'HEAD'), /seen/, `precondition: ${key} hides the change from a plain git diff`);
    assert.match(await diffJail(jail, { noTextconv: true }), /^\+export const app = "seen";$/m, key);
    rm(dir);
  }
});

test('a repo with a textconv driver set up is reviewed on its raw content and the driver never runs: named in .gitattributes or in .git/info/attributes', async () => {
  const { createHash } = await import('node:crypto');
  for (const where of ['.gitattributes', '.git/info/attributes']) {
    const dir = repo({ ...BASE, ...(where === '.gitattributes' ? { '.gitattributes': '*.bin diff=upper\n' } : {}), 'a.bin': 'abc\n' });
    if (where !== '.gitattributes') write(dir, { [where]: '*.bin diff=upper\n' });
    const upper = path.join(dir, '.git', 'upper');
    const ran = path.join(dir, '.git', 'upper-ran');
    exe(upper, `touch '${ran}'\ntr a-z A-Z < "$1"`);
    git(dir, 'config', 'diff.upper.textconv', upper);
    git(dir, 'config', 'diff.upper.binary', 'true');
    const jail = await createJail(probeTask({ id: 'rb6', repo: dir, kind: 'code' }), `r_rb6_${where.length}`);
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x61, 0x62, 0x63, 0x0a]); // binary by content: it holds NULs
    write(jail.dir, { 'a.bin': 'abd\n' });
    fs.writeFileSync(path.join(jail.dir, 'doc.bin'), bytes);
    assert.match(git(jail.dir, 'diff', 'HEAD'), /^-ABC\n\+ABD$/m, `precondition: a plain git diff goes through the driver (${where})`);
    assert.ok(fs.existsSync(ran), `precondition: a plain git diff runs the driver (${where})`);
    fs.rmSync(ran);

    const diff = await diffJail(jail);
    assert.match(diff, /^-abc\n\+abd$/m, `the file's own lines (${where})`);
    assert.doesNotMatch(diff, /ABC|ABD/, `nothing the driver printed (${where})`);
    assert.ok(
      diff.includes(`\nBinary file doc.bin changed (${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')})\n`),
      `a file that is binary gets the short line about its real bytes (${where}): ${diff.slice(-600)}`,
    );
    assert.ok(!fs.existsSync(ran), `diffJail ran the textconv driver (${where})`);
    await jailTree(jail.dir);
    assert.ok(!fs.existsSync(ran), `jailTree ran the textconv driver (${where})`);
    assert.deepEqual((await changedFiles(jail)).map((f) => f.path).sort(), ['a.bin', 'doc.bin']);
    assert.ok(!fs.existsSync(ran), `changedFiles ran the textconv driver (${where})`);
    assert.equal(await showBaseFile(jail, 'a.bin'), 'abc\n', `the pre-image is the file's own content too (${where})`);
    assert.ok(!fs.existsSync(ran), `showBaseFile ran the textconv driver (${where})`);
    rm(dir);
  }
});

test('the scheduler reviews every repo, ordinary or Foreman itself, on raw content and never runs its textconv driver', async () => {
  for (const self of [false, true]) {
    for (const where of ['.gitattributes', '.git/info/attributes']) {
      const dir = repo({ ...BASE, ...(where === '.gitattributes' ? { '.gitattributes': '*.bin diff=upper\n' } : {}), 'a.bin': 'abc\n' });
      if (where !== '.gitattributes') write(dir, { [where]: '*.bin diff=upper\n' });
      const upper = path.join(dir, '.git', 'upper');
      const ran = path.join(dir, '.git', 'upper-ran');
      exe(upper, `touch '${ran}'\ntr a-z A-Z < "$1"`);
      git(dir, 'config', 'diff.upper.textconv', upper);
      git(dir, 'config', 'diff.upper.binary', 'true');
      assert.match(git(dir, 'log', '-p', '-1', '--', 'a.bin'), /^\+ABC$/m, `precondition: plain git shows this repo through the driver (${where})`);
      assert.ok(fs.existsSync(ran), `precondition: plain git runs the driver (${where})`);
      fs.rmSync(ran);
      const store = new Store(':memory:');
      const shown: string[] = [];
      const sched = new Scheduler(store, {
        maxWorkers: 1, tickMs: 5, selfRoot: self ? dir : fs.realpathSync(os.tmpdir()),
        verify: async (args) => { shown.push(args.evidence.body); return passing(store)(args); },
      });
      try {
        const t = store.addTask({ title: 'binary edit', kind: 'code', runner: 'shell', repo: dir, prompt: "printf 'abd\\n' > a.bin" });
        await sched.drain(60_000);
        assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
        assert.match(shown[0] ?? '', /^-abc\n\+abd$/m, `self=${self} ${where}: ${shown[0]}`);
        assert.doesNotMatch(shown[0] ?? '', /ABC|ABD/, `self=${self} ${where}: ${shown[0]}`);
        assert.ok(!fs.existsSync(ran), `self=${self} ${where}: the textconv driver ran in the daemon`);
      } finally {
        await sched.stop();
        store.close();
        rm(dir);
      }
    }
  }
});

test('the per-file listing and its pre-image are taken from the jail\'s base, so committed work is in them', async () => {
  const dir = repo({ ...BASE, 'ch1.md': 'the original chapter\n' });
  const jail = await createJail(probeTask({ id: 'rb5', repo: dir, kind: 'code' }), 'r_rb5');
  write(jail.dir, { 'ch1.md': 'the rewritten chapter\n' });
  git(jail.dir, 'commit', '-qam', 'committed in the jail');
  assert.deepEqual(await changedFiles(jail), [{ path: 'ch1.md', from: null, status: 'modified' }]);
  assert.equal(await showBaseFile(jail, 'ch1.md'), 'the original chapter\n');
  rm(dir);
});

/** Run one shell-runner self-task to its end; `prompt` is the worker. */
async function runSelf(dir: string, over: Partial<Parameters<Store['addTask']>[0]>): Promise<{ task: Task; reviews: number; run: Run }> {
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5, selfRoot: dir,
    verify: async (args) => { reviews++; return passing(store)(args); },
  });
  try {
    const t = store.addTask({ title: 'a self ticket', kind: 'code', runner: 'shell', repo: dir, prompt: 'true', ...over });
    await sched.drain(60_000);
    return { task: store.getTask(t.id)!, reviews, run: store.latestRun(t.id)! };
  } finally {
    await sched.stop();
    store.close();
  }
}

test('the run check fails closed: a jail that changed with no path listed is refused', async () => {
  const dir = repo();
  const { task, reviews } = await runSelf(dir, { prompt: 'git commit -q --allow-empty -m nothing-listed' });
  assert.equal(task.status, 'failed', task.error ?? '');
  assert.match(task.error ?? '', /^core change refused: .*listed no path/);
  assert.equal(reviews, 0);
  rm(dir);
});

test('the run check fails closed: a jail whose base cannot be found is refused, once, with the reason', async () => {
  const dir = repo();
  // The branch is reset onto a commit with no history: nothing to measure from.
  const { task, reviews } = await runSelf(dir, { prompt: 't=$(git write-tree) && c=$(git commit-tree -m orphan "$t") && git reset -q --hard "$c"' });
  assert.equal(task.status, 'failed', task.error ?? '');
  assert.match(task.error ?? '', /^core change refused: the paths this run changed could not be listed/);
  assert.equal(task.attempts, 1, 'fatal: not retried');
  assert.equal(reviews, 0);
  rm(dir);
});

test('the run check fails closed: a listing that fails while the diff still works is refused', async () => {
  const dir = repo();
  // `git status` now dies on its own config; `git diff` does not read it.
  const { task, reviews } = await runSelf(dir, { prompt: "git config status.showUntrackedFiles bogus && printf 'more\\n' >> README.md" });
  assert.equal(task.status, 'failed', task.error ?? '');
  assert.match(task.error ?? '', /^core change refused: the paths this run changed could not be listed/);
  assert.equal(reviews, 0);
  rm(dir);
});

test('the run check is made again after the test command: a protected file the tests wrote fails the run unreviewed', async () => {
  const dir = repo();
  const { task, reviews } = await runSelf(dir, {
    prompt: "printf 'more\\n' >> README.md",
    testCmd: 'f=src/lo; printf \'export const lock = 9;\\n\' > "${f}ck.ts"',
  });
  assert.equal(task.status, 'failed', task.error ?? '');
  assert.match(task.error ?? '', /^core change refused: .*\(src\/lock\.ts\)/);
  assert.equal(reviews, 0, 'no reviewer was shown a diff without it');
  rm(dir);
});

test('the scheduler passes its self root to admission: a self-ticket that names a core path runs, parks for a person, and carries the warning', async () => {
  const dir = repo();
  // The brief names src/merge.ts and changes only the README: admitted with a warning, not refused.
  const { task, reviews } = await runSelf(dir, { prompt: ": src/merge.ts returns merged:false; printf 'more\\n' >> README.md" });
  assert.equal(task.status, 'awaiting-approval', task.error ?? '');
  assert.match(task.error ?? '', /^core-guard: names src\/merge\.ts: /, 'the admission warning leads the note on the gate item');
  assert.equal(reviews, 1, 'the work was reviewed');
  rm(dir);
});

test('a self-ticket that names a core path and then changes it is refused at the run check, not at admission', async () => {
  const dir = repo();
  const { task, reviews } = await runSelf(dir, { prompt: "printf '// loosened\\n' >> src/merge.ts" });
  assert.equal(task.status, 'failed', task.error ?? '');
  assert.match(task.error ?? '', /^core change refused: .*src\/merge\.ts/);
  assert.equal(reviews, 0, 'no reviewer was asked');
  rm(dir);
});

test('the base commit of a jail is kept on the run row', async () => {
  const dir = repo();
  const { task, run } = await runSelf(dir, { prompt: "printf 'more\\n' >> README.md && git commit -qam committed" });
  assert.equal(task.status, 'awaiting-approval', task.error ?? '');
  assert.equal(run.baseCommit, git(dir, 'rev-parse', 'HEAD'));
  rm(dir);
});

/**
 * A `claude` stand-in for a worker that commits what it writes and then points
 * the base record inside its jail at its own HEAD.
 */
function committingWorker(): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-worker-'));
  exe(path.join(dir, 'claude'), [
    `[ "$1" = "--version" ] && { printf '1.2.3\\n'; exit 0; }`,
    `n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/n"`,
    `printf 'round %s\\n' "$n" >> rounds.txt && git add -A && git commit -qm "round $n"`,
    `git rev-parse HEAD > "$(git rev-parse --absolute-git-dir)/foreman-base"`,
    `printf '{"type":"system","subtype":"init","session_id":"sess-1"}\\n'`,
    `printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"done"}\\n'`,
  ].join('\n'));
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  resetPreflightCache();
  return { dir };
}

test('a repair round in a reused jail is reviewed on both rounds\' committed work, whatever the worker wrote into the jail', async () => {
  const dir = repo();
  const worker = committingWorker();
  const store = new Store(':memory:');
  const shown: string[] = [];
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5,
    verify: async ({ task, runId, evidence }) => {
      shown.push(evidence.body);
      return store.addVerdict({
        runId, taskId: task.id, verdict: shown.length === 1 ? 'fail' : 'pass', disagreement: false, council: [],
        ...(shown.length === 1 ? { critique: 'do one more round' } : {}),
      });
    },
  });
  try {
    const t = store.addTask({ title: 'two rounds', prompt: 'Write the rounds file.', kind: 'code', runner: 'claude-code', repo: dir });
    await sched.drain(120_000);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
    const runs = store.runsForTask(t.id);
    assert.equal(runs.length, 2);
    assert.equal(new Set(runs.map((r) => r.worktreePath)).size, 1, 'precondition: the repair round reused the jail');
    for (const r of runs) assert.equal(r.baseCommit, git(dir, 'rev-parse', 'HEAD'), 'the base is copied forward on the run rows');
    assert.match(shown[1]!, /^\+round 1$/m, "the first round's committed work is in the second review");
    assert.match(shown[1]!, /^\+round 2$/m);
  } finally {
    await sched.stop();
    store.close();
    delete process.env['FOREMAN_CLAUDE_BIN'];
    resetPreflightCache();
    rm(dir, worker.dir);
  }
});

// --------------------------------------------- the warning stays on every park note

test('the core-guard lead survives a re-check, a pruned timeline, a budget stop, a reopen and an approval that did not land', async () => {
  const dir = repo();
  const frisk = friskWarns(WARNING);
  const store = new Store(':memory:');
  const cap = config as { logLinesPerRun: number };
  const lines = cap.logLinesPerRun;
  cap.logLinesPerRun = 3; // the admission warning is the run's first event, far outside this
  let over = false;
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5, selfRoot: dir,
    verify: async (args) => {
      if (over) throw new BudgetExceeded('the day is spent');
      return store.addVerdict({ runId: args.runId, taskId: args.task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
    },
  });
  const note = (id: string): string => store.getTask(id)!.error ?? '';
  const lead = `core-guard: ${WARNING}`;
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  try {
    const worker = "for i in 1 2 3 4 5 6 7 8; do echo line $i; done; printf 'more\\n' >> README.md";
    const t = store.addTask({ title: 'ordinary', prompt: worker, kind: 'code', runner: 'shell', repo: dir });
    await sched.drain(60_000);
    assert.ok(note(t.id).startsWith(`${lead} | `), note(t.id));
    assert.ok(store.eventsForTask(t.id).length <= 4, 'precondition: the timeline was pruned');

    // The full council's re-check rewrites the note.
    const full = store.addVerdict({ runId: store.latestRun(t.id)!.id, taskId: t.id, verdict: 'pass', disagreement: false, council: [] });
    (sched as unknown as { settleRecheck(id: string, v: Verdict): void }).settleRecheck(t.id, full);
    assert.equal(note(t.id), lead, 'the provisional part is gone, the warning is not');

    // An approval that does not land (the checkout is dirty) goes back to the gate.
    write(dir, { 'scratch.txt': 'the operator is mid-edit\n' });
    const out = await applyApproval(store, t.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.ok(note(t.id).startsWith(`${lead} | approved, but not landed: repo has uncommitted changes`), note(t.id));
    rm(path.join(dir, 'scratch.txt'));

    // A run parked by the budget hard-stop.
    over = true;
    const b = store.addTask({ title: 'over budget', prompt: worker, kind: 'code', runner: 'shell', repo: dir });
    await sched.drain(60_000);
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    assert.ok(note(b.id).startsWith(`${lead} | budget hard-stop: `), note(b.id));

    // A failed review the operator reopens.
    const r = store.addTask({ title: 'reopened', prompt: 'p', kind: 'code', runner: 'shell', repo: dir });
    const run = store.startRun(r.id).id;
    store.setRunMeta(run, { worktreePath: dir });
    store.record({ taskId: r.id, runId: run, type: 'warning', message: `CORE-GUARD: ${WARNING}` });
    store.addVerdict({ runId: run, taskId: r.id, verdict: 'fail', disagreement: false, council: [], critique: 'no' });
    store.endRun(run, 'failed', { exitCode: 1, summary: 'review said no' });
    store.setStatus(r.id, 'failed', 'review said no');
    store.reopen(r.id);
    assert.ok(note(r.id).startsWith(`${lead} | reopened by the operator`), note(r.id));
  } finally {
    cap.logLinesPerRun = lines;
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    await sched.stop();
    store.close();
    frisk.restore();
    rm(dir);
  }
});

test('an admission warning that is not the core guard\'s is neither a CORE-GUARD event nor a lead on the park note', async () => {
  const dir = repo();
  const frisk = friskWarns('mentions sudo', 'privilege-mention');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  try {
    const t = store.addTask({ title: 'ordinary', prompt: "printf 'more\\n' >> README.md", kind: 'code', runner: 'shell', repo: dir });
    await sched.drain(60_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.doesNotMatch(after.error ?? '', /core-guard/);
    assert.equal(store.eventsForTask(t.id).some((e) => e.message.startsWith('CORE-GUARD')), false);
    assert.ok(store.eventsForTask(t.id).some((e) => /admission warn: mentions sudo/.test(e.message)), 'precondition: the finding was reported');
  } finally {
    await sched.stop();
    store.close();
    frisk.restore();
    rm(dir);
  }
});

// ----------------------------------------------- the human hold, through the scheduler

test('the scheduler never sends a green change to Foreman itself to the owner model, whatever the ticket\'s gate', async () => {
  const dir = repo();
  const owner = approvingOwner();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  try {
    const t = store.addTask({ title: 'ordinary', prompt: "printf 'more\\n' >> README.md", kind: 'code', runner: 'shell', repo: dir, gate: 'owner' });
    await sched.drain(60_000);
    // Every outcome of the gate, a hold included, leaves its decision on the ticket.
    for (let i = 0; store.gateDecision(t.id) === null && i < 3000; i++) await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(store.gateDecision(t.id), null, 'precondition: the gate ran');
    assert.equal(owner.count(), 0, 'the owner model was never asked');
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.ok(store.eventsForTask(t.id).some((e) => /hard-human: a change to foreman itself is landed by a person/.test(e.message)));
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), BASE['README.md']);
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    delete process.env['FOREMAN_CLAUDE_BIN'];
    await sched.stop();
    store.close();
    rm(dir, owner.dir);
  }
});

test('a ticket that becomes a change to Foreman while the owner is deciding is held, not approved on its reply', async () => {
  const dir = repo();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-late-')));
  // Not Foreman when the owner is asked; the stand-in makes it so before it answers.
  const self = path.join(scratch, 'self');
  const owner = approvingOwner();
  fs.writeFileSync(path.join(owner.dir, 'claude'), `#!/bin/sh\nln -s "${dir}" "${self}"\ncat "${owner.dir}/body"\n`);
  try {
    await withStore(async (store) => {
      const { task, run, jail } = await parked(store, dir);
      write(jail.dir, { 'src/app.ts': 'export const app = 7;\n' });
      recordDiff(store, task, run, owner.dir);
      await recordTree(store, run, jail);
      assert.equal(hardHumanReason(task, run, { selfRoot: self }), null, 'precondition: the owner may be asked');
      assert.equal(await ownerGate({ task, run, store, selfRoot: self }), 'hold');
      assert.ok(fs.existsSync(self), 'precondition: the owner was asked, and answered approve');
      assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
      assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), BASE['src/app.ts']);
    });
  } finally {
    delete process.env['FOREMAN_CLAUDE_BIN'];
    rm(dir, owner.dir, scratch);
  }
});

// ------------------------------------------------ the merge as made, checked again

test('landing: a merge driver that would answer the real merge differently from the prediction is never asked; the guard refuses the protected change at the prediction', async () => {
  const dir = repo({ ...BASE, '.gitattributes': 'src/lock.ts merge=flip\n', 'src/lock.ts': 'one\ntwo\nthree\nfour\nfive\n' });
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir);
    write(jail.dir, { 'src/lock.ts': 'one\ntwo\nthree\nfour\nEVIL\n', 'src/app.ts': 'export const app = 2;\n' });
    // First asked (the prediction): keeps HEAD's side. Asked again (the merge): the branch's. It is asked neither time:
    // `asked` would be created by the first.
    const asked = path.join(dir, '.git', 'asked');
    git(jail.dir, 'config', 'merge.flip.driver', `if [ -f "${asked}" ]; then cat %B > %A; else : > "${asked}"; fi`);
    write(dir, { 'src/lock.ts': 'ONE\ntwo\nthree\nfour\nfive\n' });
    git(dir, 'commit', '-qam', 'main side');
    const head = git(dir, 'rev-parse', 'HEAD');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    // git's own line merge predicts what the merge would make, and that touches src/lock.ts: refused before any merge.
    assert.match(out.merge.reason, /^core change refused: this change touches Foreman's core \(src\/lock\.ts\)/);
    assert.equal(fs.existsSync(asked), false, 'the planted driver was not asked, for the prediction or a merge');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), 'ONE\ntwo\nthree\nfour\nfive\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), BASE['src/app.ts']);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });
  rm(dir);
});

// No driver runs in the landing any more, but a process a run left behind can still write the checkout while it lands
// (the listing of drivers and the merge are two calls): the merge as made is checked again and undone (refuseLanded),
// and a conflicted merge's abort, which keeps the write, is followed by putting the core back (putCoreBack).
for (const [what, mainSide, expected] of [
  ['merged', null, /^core change refused: the merge left Foreman's core changed in the checkout \(src\/lock\.ts\) — the merge was undone$/],
  ['conflicted', 'export const app = 3;\n', /^merge conflict, aborted [^]*changed in the checkout while landing \(src\/lock\.ts\) and has been put back$/],
] as const) {
  test(`landing: a protected file written in the checkout while the merge is made (${what}) is put back`, async () => {
    const dir = repo();
    await withStore(async (store) => {
      const { task, run, jail } = await parked(store, dir);
      write(jail.dir, { 'src/app.ts': 'export const app = 2;\n' });
      if (mainSide) { write(dir, { 'src/app.ts': mainSide }); git(dir, 'commit', '-qam', 'main side'); }
      const head = git(dir, 'rev-parse', 'HEAD');
      const out = await mergeApproved(store.decide(task.id, true), run, {
        selfRoot: dir,
        beforeMerge: () => write(dir, { 'src/lock.ts': 'export const lock = "EVIL";\n' }),
      });
      assert.equal(out.merged, false);
      assert.match(out.reason, expected);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
      assert.equal(git(dir, 'status', '--porcelain'), '');
    });
    rm(dir);
  });
}

test('landing: a merge made on a HEAD that moved after the check is undone, and the commit that moved it stays', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, run, jail } = await parked(store, dir);
    write(jail.dir, { 'src/app.ts': 'export const app = 2;\n' });
    const out = await mergeApproved(store.decide(task.id, true), run, {
      selfRoot: dir,
      beforeMerge: () => {
        write(dir, { 'meanwhile.txt': 'another session\n' });
        git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'meanwhile');
      },
    });
    assert.equal(out.merged, false);
    assert.match(out.reason, /^core change refused: the merge could not be checked \(the merge commit does not join the two commits that were checked\) — the merge was undone/);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'meanwhile', 'the other commit is still HEAD');
    assert.equal(fs.readFileSync(path.join(dir, 'meanwhile.txt'), 'utf8'), 'another session\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), BASE['src/app.ts']);
  });
  rm(dir);
});

test('landing: a branch that removes the sub-directory the ticket names as its repo still merges', async () => {
  const dir = repo({ ...BASE, 'docs/x.md': 'docs\n' });
  await withStore(async (store) => {
    const { task, jail } = await parked(store, dir, { repo: path.join(dir, 'docs') });
    git(jail.dir, 'rm', '-qr', 'docs');
    const out = await applyApproval(store, task.id, { selfRoot: fs.realpathSync(os.tmpdir()) });
    assert.equal(out.merge.merged, true, out.merge.reason);
    assert.equal(fs.existsSync(path.join(dir, 'docs')), false);
  });
  rm(dir);
});

// ------------------------------- a branch Foreman does not merge itself (foreman improve)

test('approval of a self-task that does not merge on approval is refused while its branch or worktree holds a core change', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const refused = async (id: string, named: RegExp): Promise<void> => {
      for (const attempt of ['first', 'second']) {
        const out = await applyApproval(store, id, { selfRoot: dir });
        assert.equal(out.merge.merged, false);
        assert.match(out.merge.reason, /^core change refused: /, attempt);
        assert.match(out.merge.reason, named, attempt);
        assert.equal(store.getTask(id)!.status, 'awaiting-approval', `${attempt} approval: not done`);
        assert.match(store.getTask(id)!.error ?? '', /approved, but not landed: core change refused/);
      }
    };

    // Committed on the branch after the run parked: what a hand merge would bring.
    const committed = await parked(store, dir, { mergeOnApprove: false });
    write(committed.jail.dir, { 'src/lock.ts': 'EVIL\n', 'src/app.ts': 'export const app = 2;\n' });
    git(committed.jail.dir, 'commit', '-qam', 'after the run');
    await refused(committed.task.id, /\(src\/lock\.ts\)/);

    // Left in the worktree, tracked or not: what the operator would commit there.
    const pending = await parked(store, dir, { mergeOnApprove: false });
    write(pending.jail.dir, { 'src/security/late.ts': 'export const late = 1;\n' });
    await refused(pending.task.id, /\(src\/security\/late\.ts\)/);

    // The worktree is gone; the branch is still there to be merged.
    const gone = await parked(store, dir, { mergeOnApprove: false });
    write(gone.jail.dir, { 'src/lock.ts': 'EVIL\n' });
    git(gone.jail.dir, 'commit', '-qam', 'after the run');
    git(dir, 'worktree', 'remove', '--force', gone.jail.dir);
    await refused(gone.task.id, /\(src\/lock\.ts\)/);

    assert.equal(fs.readFileSync(path.join(dir, 'src/lock.ts'), 'utf8'), BASE['src/lock.ts']);
  });
  rm(dir);
});

test('approval of a task that does not merge on approval is unchanged for an ordinary change, with allowCore, and on another repo', async () => {
  const dir = repo();
  const other = repo();
  await withStore(async (store) => {
    const done = async (p: { task: Task }): Promise<void> => {
      const out = await applyApproval(store, p.task.id, { selfRoot: dir });
      assert.deepEqual([out.merge.merged, out.merge.reason], [false, 'merge-on-approve disabled for this task']);
      assert.equal(store.getTask(p.task.id)!.status, 'done');
    };
    const ordinary = await parked(store, dir, { mergeOnApprove: false });
    write(ordinary.jail.dir, { 'src/app.ts': 'export const app = 2;\n', 'new.txt': 'n\n' });
    await done(ordinary);

    const untouched = await parked(store, dir, { mergeOnApprove: false });
    await done(untouched);

    const allowed = await parked(store, dir, { mergeOnApprove: false, allowCore: true });
    write(allowed.jail.dir, { 'src/lock.ts': 'export const lock = 3;\n' });
    await done(allowed);

    const foreign = await parked(store, other, { mergeOnApprove: false });
    write(foreign.jail.dir, { 'src/lock.ts': 'export const lock = 4;\n' });
    await done(foreign);
  });
  rm(dir, other);
});

// ----------------------------------------- the files that hold the rules around the guard

test('the run check refuses a self-task that changes the gate, the scheduler, the queue, the API or the schema', async () => {
  for (const file of ['gate', 'scheduler', 'queue', 'server', 'db']) {
    const dir = repo({ ...BASE, [`src/${file}.ts`]: 'export const rule = 1;\n' });
    // The path is assembled in the shell so the brief does not name it.
    const { task, reviews } = await runSelf(dir, { prompt: `f=${file}; printf '// loosened\\n' >> "src/$f.ts"` });
    assert.equal(task.status, 'failed', `${file}: ${task.error ?? ''}`);
    assert.match(task.error ?? '', new RegExp(`^core change refused: .*\\(src/${file}\\.ts\\)`));
    assert.equal(reviews, 0);
    rm(dir);
  }
});

test('a process a self-task leaves behind cannot land a change to the gate by approving its own ticket over HTTP', async () => {
  const dir = repo({ ...BASE, 'src/gate.ts': 'export const gate = 1;\n' });
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-left-')));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const answer = path.join(scratch, 'answer.json');
  // Waits for the ticket to park, writes the gate in its jail, approves the ticket.
  fs.writeFileSync(path.join(scratch, 'left-behind.mjs'), `
import fs from 'node:fs';
for (let i = 0; i < 3000; i++) {
  const state = await (await fetch('${base}/api/state')).json().catch(() => ({ tasks: [] }));
  const parked = state.tasks.find((t) => t.status === 'awaiting-approval');
  if (parked) {
    fs.appendFileSync('src/gate.ts', '// loosened by a worker\\n');
    const res = await fetch('${base}/api/tasks/' + parked.id + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    fs.writeFileSync('${answer}.tmp', JSON.stringify({ status: res.status, body: await res.json() }));
    fs.renameSync('${answer}.tmp', '${answer}');
    break;
  }
  await new Promise((r) => setTimeout(r, 20));
}
`);
  fs.writeFileSync(path.join(scratch, 'launch.mjs'), `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['${path.join(scratch, 'left-behind.mjs')}'], { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
`);
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const t = store.addTask({
      title: 'tidy a comment', kind: 'code', runner: 'shell', repo: dir,
      prompt: `printf 'more\\n' >> README.md && node "${path.join(scratch, 'launch.mjs')}"`,
    });
    await sched.drain(60_000);
    for (let i = 0; !fs.existsSync(answer) && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(answer), 'precondition: the left-behind process approved the ticket');
    const { status, body } = JSON.parse(fs.readFileSync(answer, 'utf8')) as { status: number; body: { status: string; merge: { merged: boolean; reason: string } } };
    assert.equal(status, 200, 'precondition: the endpoint took the call');
    assert.equal(body.merge.merged, false);
    assert.match(body.merge.reason, /^core change refused: .*\(src\/gate\.ts\)/);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing landed');
    assert.equal(fs.readFileSync(path.join(dir, 'src/gate.ts'), 'utf8'), 'export const gate = 1;\n');
  } finally {
    delete process.env['FOREMAN_POSTMERGE_CHECK'];
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    await sched.stop();
    store.close();
    rm(dir, scratch);
  }
});

// ------------------------------------------------------------- smaller pins

test('the run check lets an allowCore self-task change a protected file: it is reviewed and parks', async () => {
  const dir = repo();
  const { task, reviews } = await runSelf(dir, { allowCore: true, prompt: 'f=src/lo; printf \'export const lock = 9;\\n\' > "${f}ck.ts"' });
  assert.equal(task.status, 'awaiting-approval', task.error ?? '');
  assert.equal(reviews, 1);
  rm(dir);
});

test('the core-guard lead is the latest run\'s: a warning from an earlier run does not lead a later park note', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'two runs', prompt: 'p', runner: 'echo' });
    const first = store.startRun(t.id).id;
    store.record({ taskId: t.id, runId: first, type: 'warning', message: `CORE-GUARD: ${WARNING}` });
    assert.equal(store.withCoreGuard(t.id, 'parked'), `core-guard: ${WARNING} | parked`);
    store.endRun(first, 'failed', { exitCode: 1, summary: 'no' });
    // The brief was edited and no longer names the path: the next run records no warning.
    store.startRun(t.id);
    assert.equal(store.withCoreGuard(t.id, 'parked'), 'parked');
  } finally {
    store.close();
  }
});

test('a budget hard-stop is still named as the hold when the park note leads with the core-guard warning', async () => {
  const dir = repo();
  await withStore(async (store) => {
    const { task, run } = await parked(store, dir);
    const elsewhere = { selfRoot: fs.realpathSync(os.tmpdir()) };
    assert.equal(hardHumanReason({ ...task, error: 'budget hard-stop: over' }, run, elsewhere), 'the run stopped on a budget hard-stop');
    assert.equal(
      hardHumanReason({ ...task, error: `core-guard: ${WARNING} | budget hard-stop: over` }, run, elsewhere),
      'the run stopped on a budget hard-stop',
    );
    assert.equal(hardHumanReason({ ...task, error: `core-guard: ${WARNING} | council split` }, run, elsewhere), null);
  });
  rm(dir);
});

// ------------------------------------------------- the identity lookup is cached

/**
 * A `git` on PATH that notes each repository-identity lookup (`rev-parse
 * --git-common-dir`, which nothing else in Foreman runs) and then runs the real
 * git. `count()` is how many were spawned since the shim went in.
 */
function countingGit(): { count: () => number; restore: () => void } {
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-git-')));
  const log = path.join(dir, 'lookups.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) echo x >> '${log}' ;; esac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const before = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${before ?? ''}`;
  return {
    count: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    restore: () => { process.env['PATH'] = before; rm(dir); },
  };
}

test('one scheduler run against an ordinary repo spawns at most two identity lookups', async () => {
  const dir = repo();
  const other = repo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: dir, verify: passing(store) });
  const shim = countingGit();
  try {
    clearIdentities();
    const t = store.addTask({
      title: 'ordinary', kind: 'code', runner: 'shell', repo: other, gate: 'human',
      prompt: "printf 'x\\n' > note.txt",
    });
    await sched.drain(60_000);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    const n = shim.count();
    assert.ok(n >= 1, 'precondition: the shim saw the lookup');
    assert.ok(n <= 2, `one run spawned ${n} identity lookups; at most 2 (the repo and the self root)`);
  } finally {
    shim.restore();
    await sched.stop();
    store.close();
    rm(dir, other);
  }
});

test('repeated isSelfTask and hardHumanReason calls for one repo spawn no further git once its identity is known', async () => {
  const dir = repo();
  const other = repo();
  await withStore(async (store) => {
    const { task, run } = await parked(store, other);
    const shim = countingGit();
    try {
      clearIdentities();
      assert.equal(isSelfTask(task, dir), false);
      const first = shim.count();
      assert.ok(first >= 1 && first <= 2, `the first answer took ${first} lookups`);
      for (let i = 0; i < 5; i++) assert.equal(isSelfTask(task, dir), false);
      for (let i = 0; i < 3; i++) {
        assert.equal(hardHumanReason(task, run, { selfRoot: dir }), null, 'precondition: the question reaches the self-task check');
      }
      assert.equal(isSelfTask({ repo: path.join(other, 'src') }, dir), false, 'another path: one lookup, the self root is not asked again');
      assert.equal(shim.count(), first + 1, 'eight repeat calls spawned no git; a new path spawned one');
      // A path that is not a repository is remembered too.
      const plain = fs.realpathSync(os.tmpdir());
      isSelfTask({ repo: plain }, dir);
      const afterMiss = shim.count();
      isSelfTask({ repo: plain }, dir);
      assert.equal(shim.count(), afterMiss, 'a failed lookup is not repeated at once');
    } finally {
      shim.restore();
    }
  });
  rm(dir, other);
});

test('the landing check decides on a fresh lookup: a cached "not self" does not let a protected path land', async () => {
  const dir = repo();
  const other = repo();
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-repoint-')));
  const link = path.join(scratch, 'checkout');
  await withStore(async (store) => {
    // The ticket's repo is a path that, while the run was made, was Foreman.
    fs.symlinkSync(dir, link);
    const { task, jail } = await parked(store, link, { mergeOnApprove: true });
    assert.equal(task.repo, link, 'precondition: the ticket keeps the path as given');
    write(jail.dir, { 'src/lock.ts': 'export const lock = 7;\n' });
    git(jail.dir, 'add', '-A'); git(jail.dir, 'commit', '-qm', 'core');

    // The cache learns "not self" while the path points somewhere else...
    fs.unlinkSync(link); fs.symlinkSync(other, link);
    clearIdentities();
    assert.equal(isSelfTask(task, dir), false);
    // ...and the path is Foreman again by the time a person approves.
    fs.unlinkSync(link); fs.symlinkSync(dir, link);
    assert.equal(isSelfTask(task, dir), false, 'precondition: the cached answer is the stale one');

    const out = await applyApproval(store, task.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /^core change refused: .*src\/lock\.ts/);
    assert.equal(git(dir, 'show', 'HEAD:src/lock.ts'), 'export const lock = 1;');
    assert.equal(isSelfTask(task, dir), true, 'the fresh answer replaced the stale one');
  });
  rm(dir, other, scratch);
});

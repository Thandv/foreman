import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, conflictRepairNotes } from '../src/queue.ts';
import { applyApproval } from '../src/gate.ts';
import { Scheduler, resumableSession } from '../src/scheduler.ts';
import { leftoverMarkers } from '../src/isolate.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';
import type { Run, Task } from '../src/types.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo(files: Record<string, string | Buffer>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-conflict-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/**
 * A shell ticket: in a fresh jail it rewrites line 2 of a.txt and adds its own
 * file; in a jail whose a.txt holds conflict markers it copies what it was
 * handed to `seen` and then runs `onMarkers` (by default: resolves the file).
 */
function script(seen: string, name: string, onMarkers = `printf 'l1\\nRESOLVED\\nl3\\n' > a.txt`): string {
  return [
    `if grep -q '<<<<<<<' a.txt; then`,
    `  cp a.txt ${seen}/a.txt; ls > ${seen}/ls; git rev-parse HEAD > ${seen}/head; ${onMarkers};`,
    `else`,
    `  printf 'l1\\n${name}\\nl3\\n' > a.txt; printf '${name}\\n' > ${name}.txt;`,
    `fi`,
  ].join(' ');
}

async function toGate(
  store: Store, sched: Scheduler, dir: string, prompt: string, opts: { maxRepairs?: number; baseRef?: string; testCmd?: string } = {},
) {
  const t = store.addTask({
    title: 'ticket', prompt, kind: 'code', runner: 'shell', repo: dir,
    maxRepairs: opts.maxRepairs ?? 1, testCmd: opts.testCmd ?? 'test -f a.txt', baseRef: opts.baseRef ?? null,
  });
  await sched.drain(30_000);
  const parked = store.getTask(t.id)!;
  assert.equal(parked.status, 'awaiting-approval', parked.error ?? '');
  return parked;
}

const moveMain = (dir: string, body = 'l1\nMAIN\nl3\n'): string => {
  fs.writeFileSync(path.join(dir, 'a.txt'), body); git(dir, 'commit', '-qam', 'main moved');
  return git(dir, 'rev-parse', 'HEAD');
};

const HAND_MERGE = /approved, but not landed: merge conflict, aborted — resolve .* by hand: [\s\S]* — resolve it, then approve again/;

const setup = (files: Record<string, string | Buffer> = { 'a.txt': 'l1\nl2\nl3\n' }, selfRoot?: string) => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo(files);
  const seen = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-seen-'));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1, ...(selfRoot ? { selfRoot: selfRoot === 'repo' ? dir : selfRoot } : {}) });
  return { dir, seen, store, sched };
};
const teardown = (store: Store): void => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  store.close();
};

test('a conflicting approval becomes a repair round cut from main with the 3-way markers in its jail', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    const tip = moveMain(dir);
    const approved = store.latestRun(t.id)!;

    const out = await applyApproval(store, t.id, {});
    assert.equal(out.merge.merged, false);
    const queued = store.getTask(t.id)!;
    assert.equal(queued.status, 'queued', 'requeued, not back at the gate and not done');
    assert.equal(queued.repairs, 1);
    assert.ok(!queued.baseRef);
    assert.equal(store.carryRun(t.id), approved.id);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), tip, 'nothing landed');

    await sched.drain(30_000);
    assert.equal(fs.readFileSync(path.join(seen, 'head'), 'utf8').trim(), tip, 'the jail was cut from main\'s current tip');
    const markers = fs.readFileSync(path.join(seen, 'a.txt'), 'utf8');
    assert.match(markers, /<<<<<<<[\s\S]*MAIN[\s\S]*=======[\s\S]*ticket[\s\S]*>>>>>>>/, 'conflict markers from the 3-way apply');
    assert.match(fs.readFileSync(path.join(seen, 'ls'), 'utf8'), /ticket\.txt/, 'the non-conflicting hunk (a new file) was applied');

    const after = store.getTask(t.id)!;
    // Named where the apply happened, in the jail.
    assert.equal(
      after.repairNotes,
      'Foreman applied your earlier diff onto current main. Resolve the conflict markers in a.txt, ' +
        "keeping both sides' intent, then run test -f a.txt.",
    );
    assert.equal(after.status, 'awaiting-approval', 'never auto-landed');
    assert.match(after.error ?? '', /diff changed since the earlier approval/);
    assert.equal(store.carryRun(t.id), null, 'cleared once the round was reviewed');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'l1\nMAIN\nl3\n');
  } finally {
    teardown(store);
  }
});

test('the repair jail is cut from main even for a task that began on a base ref', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'side.txt'), 's\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'side');
    git(dir, 'checkout', '-q', '-');
    const t = await toGate(store, sched, dir, script(seen, 'ticket'), { baseRef: 'side' });
    assert.equal(store.getTask(t.id)!.baseRef, 'side');
    const tip = moveMain(dir);

    await applyApproval(store, t.id, {});
    assert.ok(!store.getTask(t.id)!.baseRef, 'base_ref cleared');
    await sched.drain(30_000);
    assert.equal(fs.readFileSync(path.join(seen, 'head'), 'utf8').trim(), tip, 'cut from main\'s tip, not from the side branch');
    assert.doesNotMatch(fs.readFileSync(path.join(seen, 'ls'), 'utf8'), /side\.txt/);
  } finally {
    teardown(store);
  }
});

test('approve A, then B that conflicts with A: B is requeued with markers, and stays at the gate once the budget is spent', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const mk = (name: string, maxRepairs = 1) => toGate(store, sched, dir, script(seen, name), { maxRepairs });
    const a = await mk('alpha');
    const b = await mk('beta');
    const spent = await mk('gamma', 0);

    assert.equal((await applyApproval(store, a.id, {})).merge.merged, true);

    const outB = await applyApproval(store, b.id, {});
    assert.equal(outB.merge.merged, false);
    assert.equal(store.getTask(b.id)!.status, 'queued');
    assert.equal(store.getTask(b.id)!.repairs, 1);

    const outC = await applyApproval(store, spent.id, {});
    assert.equal(outC.merge.merged, false);
    const stuck = store.getTask(spent.id)!;
    assert.equal(stuck.status, 'awaiting-approval', 'not requeued');
    assert.equal(stuck.repairs, 0);
    assert.match(stuck.error ?? '', HAND_MERGE);

    await sched.drain(30_000);
    assert.match(fs.readFileSync(path.join(seen, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*alpha[\s\S]*=======[\s\S]*beta[\s\S]*>>>>>>>/);
    assert.match(store.getTask(b.id)!.repairNotes ?? '', /^Foreman applied your earlier diff onto current main\. Resolve the conflict markers in a\.txt, .* then run test -f a\.txt\.$/);
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    // A second conflict on the same task: the one repair round is used, so the hand-merge text is back.
    moveMain(dir, 'l1\nlater\nl3\n');
    const again = await applyApproval(store, b.id, {});
    assert.equal(again.merge.merged, false);
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    assert.equal(store.getTask(b.id)!.repairs, 1, 'no second round');
    assert.match(store.getTask(b.id)!.error ?? '', /not landed: merge conflict/);
  } finally {
    teardown(store);
  }
});

test('an approval whose run left no diff artifact is not requeued', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    moveMain(dir);
    store.db.prepare("DELETE FROM artifacts WHERE task_id = ? AND type = 'diff'").run(t.id);
    await applyApproval(store, t.id, {});
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.equal(now.repairs, 0);
    assert.match(now.error ?? '', HAND_MERGE);
  } finally {
    teardown(store);
  }
});

test('a refused core change is not a conflict and is never requeued', async () => {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo({ 'src/merge.ts': 'one\ntwo\nthree\n', 'a.txt': 'x\n' });
  const store = new Store(':memory:');
  try {
    git(dir, 'checkout', '-q', '-b', 'ticket');
    fs.writeFileSync(path.join(dir, 'src/merge.ts'), 'one\nTICKET\nthree\n'); git(dir, 'commit', '-qam', 'ticket');
    const diffPath = path.join(dir, '..', `refused-${process.pid}.diff`);
    fs.writeFileSync(diffPath, git(dir, 'diff', 'HEAD~1', 'HEAD') + '\n');
    git(dir, 'checkout', '-q', '-');
    fs.writeFileSync(path.join(dir, 'src/merge.ts'), 'one\nMAIN\nthree\n'); git(dir, 'commit', '-qam', 'main moved');
    const t = store.addTask({ title: 'core', prompt: 'p', kind: 'code', runner: 'echo', repo: dir, maxRepairs: 3 });
    const run = store.startRun(t.id);
    store.setRunMeta(run.id, { branch: 'ticket', worktreePath: null });
    store.addArtifact({ runId: run.id, taskId: t.id, type: 'diff', path: diffPath, summary: null });
    store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(t.id, 'awaiting-approval');

    const out = await applyApproval(store, t.id, { selfRoot: dir });
    assert.match(out.merge.reason, /^core change refused: /);
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.equal(now.repairs, 0);
    assert.match(now.error ?? '', /not landed: core change refused/);
    fs.rmSync(diffPath, { force: true });
  } finally {
    teardown(store);
  }
});

test('a merge driver named in the repo config cannot dirty the checkout after a conflicting approval of a self-task', async () => {
  const { dir, seen, store, sched } = setup({ 'a.txt': 'l1\nl2\nl3\n', 'src/merge.ts': 'core\n' }, 'repo');
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    moveMain(dir);
    // A driver the jail could have written: it runs wherever git merges a.txt, and writes a protected file.
    git(dir, 'config', 'merge.evil.driver', 'printf pwned >> src/merge.ts; false');
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'a.txt merge=evil\n');

    const out = await applyApproval(store, t.id, { selfRoot: dir });
    assert.equal(out.merge.merged, false);
    assert.equal(store.getTask(t.id)!.status, 'queued', 'still a repair round');
    assert.equal(git(dir, 'status', '--porcelain'), '', 'no git merge machinery ran in the checkout after the core was put back');
    assert.equal(fs.readFileSync(path.join(dir, 'src/merge.ts'), 'utf8'), 'core\n');
  } finally {
    teardown(store);
  }
});

for (const [kind, files, edit] of [
  ['a delete/modify conflict', { 'a.txt': 'l1\nl2\nl3\n' }, `rm -f a.txt; printf x > other.txt`],
  ['a binary-file conflict', { 'a.txt': 'l1\nl2\nl3\n', 'b.bin': Buffer.from([0, 1, 2, 3]) }, `printf '\\000\\001\\377' > b.bin; printf 'l1\\nt\\nl3\\n' > a.txt`],
] as const) {
  test(`${kind}: the diff cannot be applied with markers, so the round is not run and the approved run goes back to the gate`, async () => {
    const { dir, seen, store, sched } = setup(files);
    try {
      const t = await toGate(store, sched, dir, edit, { testCmd: 'true' });
      const approved = store.latestRun(t.id)!;
      fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nMAIN\nl3\n');
      if (kind.startsWith('a binary')) fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 9, 9, 9]));
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moved');
      const tip = git(dir, 'rev-parse', 'HEAD');

      assert.equal((await applyApproval(store, t.id, {})).merge.merged, false);
      assert.equal(store.getTask(t.id)!.status, 'queued');
      await sched.drain(30_000);

      const now = store.getTask(t.id)!;
      assert.equal(now.status, 'awaiting-approval');
      assert.equal(now.repairs, 1);
      assert.match(now.error ?? '', HAND_MERGE);
      assert.equal(store.latestRun(t.id)!.id, approved.id, 'the gate rules on the approved run, not the dropped round');
      assert.equal(store.carryRun(t.id), null);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);

      // Approving again must not turn into "no commits ahead" and a done task with the work gone.
      const again = await applyApproval(store, t.id, {});
      assert.equal(again.merge.merged, false);
      assert.match(again.merge.reason, /^merge conflict/);
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    } finally {
      teardown(store);
    }
  });
}

test('a round that leaves conflict markers in a file is dropped back to the gate, not parked', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket', 'true'));
    const approved = store.latestRun(t.id)!;
    const tip = moveMain(dir);
    await applyApproval(store, t.id, {});
    await sched.drain(30_000);

    assert.match(fs.readFileSync(path.join(seen, 'a.txt'), 'utf8'), /<<<<<<</, 'the worker was handed markers and left them');
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.match(now.error ?? '', HAND_MERGE);
    assert.match(now.error ?? '', /conflict markers are still in a\.txt/);
    assert.equal(store.latestRun(t.id)!.id, approved.id);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), tip, 'nothing with markers landed');
  } finally {
    teardown(store);
  }
});

test('an empty conflict round (the resolution equals main) is dropped back to the gate, not parked', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket', `printf 'l1\\nMAIN\\nl3\\n' > a.txt; rm -f ticket.txt`));
    const approved = store.latestRun(t.id)!;
    moveMain(dir);
    await applyApproval(store, t.id, {});
    await sched.drain(30_000);

    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.match(now.error ?? '', HAND_MERGE);
    assert.match(now.error ?? '', /no change against main/);
    assert.equal(store.latestRun(t.id)!.id, approved.id);
  } finally {
    teardown(store);
  }
});

test('a diff that applies cleanly onto the moved main says so instead of telling the worker to resolve markers', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    const approved = store.latestRun(t.id)!;
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moved elsewhere');

    assert.ok(store.scheduleConflictRepair(t.id, approved.id, 'test -f a.txt'));
    await sched.drain(30_000);

    const now = store.getTask(t.id)!;
    assert.equal(now.repairNotes, conflictRepairNotes([], 'test -f a.txt'));
    assert.match(now.repairNotes ?? '', /without conflict markers/);
    assert.doesNotMatch(now.repairNotes ?? '', /Resolve the conflict markers/);
    assert.equal(now.status, 'awaiting-approval');
  } finally {
    teardown(store);
  }
});

test('a daemon stop mid-round and a limit requeue both keep the approved work to be carried again', async () => {
  const { dir, seen, store } = setup();
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  const sched2 = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const once = path.join(seen, 'once');
    const t = await toGate(store, sched, dir, script(seen, 'ticket', `if [ ! -f ${once} ]; then touch ${once}; sleep 60; fi; printf 'l1\\nRESOLVED\\nl3\\n' > a.txt`));
    const approved = store.latestRun(t.id)!;
    moveMain(dir);
    await applyApproval(store, t.id, {});

    // Round one: stopped while the worker sleeps on the markers.
    sched.start();
    for (let i = 0; i < 400 && !fs.existsSync(once); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(once), 'the round started');
    await sched.stop();
    assert.equal(store.getTask(t.id)!.status, 'queued');
    assert.equal(store.carryRun(t.id), approved.id, 'the stop did not drop the approved work');
    assert.match(store.getTask(t.id)!.repairNotes ?? '', /markers in a\.txt/);

    // A provider-limit requeue goes through the same row and keeps it too.
    store.requeueAfterLimit(t.id, 'later');
    assert.equal(store.carryRun(t.id), approved.id);

    // Round two starts from main with the markers again and parks a real resolution.
    fs.rmSync(path.join(seen, 'a.txt'), { force: true });
    await sched2.drain(30_000);
    assert.match(fs.readFileSync(path.join(seen, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*MAIN[\s\S]*ticket/);
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.match(now.error ?? '', /diff changed since the earlier approval/);
    assert.equal(store.carryRun(t.id), null);
  } finally {
    teardown(store);
  }
});

test('a conflict round never resumes the earlier claude session; an ordinary repair round does', () => {
  const task = (repairNotes: string): Task => ({ runner: 'claude-code', repairNotes } as Task);
  const previous = { sessionId: 'sess-1' } as Run;
  assert.equal(resumableSession(task('fix the critique'), previous), 'sess-1');
  assert.equal(resumableSession(task(conflictRepairNotes(null, 'npm test')), previous), null);
  assert.equal(resumableSession(task(conflictRepairNotes(['a.txt'], 'npm test')), previous), null);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(sched: Scheduler, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !cond(); i++) { await sched.tick(); await sleep(20); }
  assert.ok(cond(), 'settled');
}
const decisionOf = (store: Store, id: string): unknown =>
  (store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(id) as { decision: unknown }).decision;

/** The task is back at the gate on the approved run, every later run is excluded, and approving again cannot land anything. */
async function assertBackAtGate(store: Store, dir: string, id: string, approved: Run, tip: string): Promise<void> {
  const now = store.getTask(id)!;
  assert.equal(now.status, 'awaiting-approval');
  assert.match(now.error ?? '', HAND_MERGE);
  assert.equal(store.latestRun(id)!.id, approved.id);
  assert.equal(store.latestRunByTask().get(id)!.id, approved.id, 'latestRunByTask skips abandoned runs');
  for (const r of store.runsForTask(id)) if (r.id !== approved.id) assert.equal(decisionOf(store, r.id), 'abandoned');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
  const again = await applyApproval(store, id, {});
  assert.equal(again.merge.merged, false);
  assert.match(again.merge.reason, /^merge conflict/);
  assert.equal(store.getTask(id)!.status, 'awaiting-approval');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), tip, 'main is unchanged');
}

for (const reason of ['markers', 'empty', 'cannot-apply'] as const) {
  test(`stop mid-round, then the next attempt is abandoned (${reason}): the gate rules on the approved run`, async () => {
    const { dir, seen, store } = setup();
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
    const sched2 = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
    try {
      const once = path.join(seen, 'once');
      const second = reason === 'markers' ? 'true' : `printf 'l1\\nMAIN\\nl3\\n' > a.txt; rm -f ticket.txt`;
      const t = await toGate(store, sched, dir, script(seen, 'ticket', `if [ ! -f ${once} ]; then touch ${once}; sleep 60; fi; ${second}`));
      const approved = store.latestRun(t.id)!;
      moveMain(dir);
      await applyApproval(store, t.id, {});
      sched.start();
      for (let i = 0; i < 400 && !fs.existsSync(once); i++) await sleep(25);
      await sched.stop();
      if (reason === 'cannot-apply') { git(dir, 'rm', '-q', 'a.txt'); git(dir, 'commit', '-qm', 'main drops a.txt'); }
      const tip = git(dir, 'rev-parse', 'HEAD');
      await sched2.drain(30_000);
      await assertBackAtGate(store, dir, t.id, approved, tip);
    } finally {
      teardown(store);
    }
  });

  test(`provider-limit requeue mid-round, then the next attempt is abandoned (${reason})`, async () => {
    const { dir, seen, store, sched } = setup();
    const bin = path.join(seen, 'claude');
    const second = reason === 'markers' ? 'true' : `printf 'l1\\nMAIN\\nl3\\n' > a.txt; rm -f ticket.txt`;
    fs.writeFileSync(bin, [
      '#!/bin/sh', `case "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac`,
      `if grep -q '<<<<<<<' a.txt 2>/dev/null; then`,
      `  if [ ! -f ${seen}/limited ]; then touch ${seen}/limited; echo "You've hit your session limit · resets 4:30pm"; exit 1; fi`,
      `  ${second}`, 'else', `  printf 'l1\\nticket\\nl3\\n' > a.txt; printf 'ticket\\n' > ticket.txt`, 'fi',
      `printf '{"type":"result","subtype":"success","is_error":false,"result":"done"}\\n'`,
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    process.env['FOREMAN_CLAUDE_BIN'] = bin;
    process.env['FOREMAN_LIMIT_BACKOFF_MS'] = '20';
    resetPreflightCache();
    try {
      const t = store.addTask({ title: 'ticket', prompt: 'x', kind: 'code', runner: 'claude-code', repo: dir, maxRepairs: 1, testCmd: 'test -f a.txt' });
      await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
      const approved = store.latestRun(t.id)!;
      moveMain(dir);
      await applyApproval(store, t.id, {});
      await settle(sched, () => fs.existsSync(path.join(seen, 'limited')) && store.getTask(t.id)!.status === 'queued' && sched.limitHoldUntil > 0);
      assert.equal(store.runsForTask(t.id).length, 2, 'the limited attempt is its own run');
      if (reason === 'cannot-apply') { git(dir, 'rm', '-q', 'a.txt'); git(dir, 'commit', '-qm', 'main drops a.txt'); }
      const tip = git(dir, 'rev-parse', 'HEAD');
      sched.limitHoldUntil = 0;
      await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
      await assertBackAtGate(store, dir, t.id, approved, tip);
    } finally {
      delete process.env['FOREMAN_CLAUDE_BIN'];
      delete process.env['FOREMAN_LIMIT_BACKOFF_MS'];
      resetPreflightCache();
      await sched.stop();
      teardown(store);
    }
  });
}

test('an approval never lands or completes a conflict round that was interrupted, or whose tree holds markers or unmerged paths', async () => {
  // Interrupted: stopped mid-round, then (abnormally) parked with the interrupted run latest.
  {
    const { dir, seen, store } = setup();
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
    try {
      const once = path.join(seen, 'once');
      const t = await toGate(store, sched, dir, script(seen, 'ticket', `touch ${once}; sleep 60`));
      const approved = store.latestRun(t.id)!;
      moveMain(dir);
      await applyApproval(store, t.id, {});
      sched.start();
      for (let i = 0; i < 400 && !fs.existsSync(once); i++) await sleep(25);
      await sched.stop();
      store.setStatus(t.id, 'awaiting-approval', null);
      const tip = git(dir, 'rev-parse', 'HEAD');
      const r = await applyApproval(store, t.id, {});
      assert.equal(r.merge.merged, false);
      assert.notEqual(store.getTask(t.id)!.status, 'done');
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
      assert.equal(store.latestRun(t.id)!.id, approved.id);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
    } finally {
      teardown(store);
    }
  }
  // A parked round whose tree is spoiled afterwards.
  for (const spoil of ['markers', 'unmerged'] as const) {
    const { dir, seen, store, sched } = setup();
    try {
      const t = await toGate(store, sched, dir, script(seen, 'ticket'));
      const approved = store.latestRun(t.id)!;
      moveMain(dir);
      await applyApproval(store, t.id, {});
      await sched.drain(30_000);
      const round = store.latestRun(t.id)!;
      assert.notEqual(round.id, approved.id);
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
      const wt = round.worktreePath!;
      if (spoil === 'markers') fs.appendFileSync(path.join(wt, 'a.txt'), '<<<<<<< x\n');
      else {
        const sha = git(wt, 'rev-parse', 'HEAD:a.txt');
        git(wt, 'update-index', '--force-remove', 'a.txt');
        execFileSync('git', ['update-index', '--index-info'], { cwd: wt, input: `100644 ${sha} 1\ta.txt\n100644 ${sha} 2\ta.txt\n` });
      }
      const tip = git(dir, 'rev-parse', 'HEAD');
      const r = await applyApproval(store, t.id, {});
      assert.equal(r.merge.merged, false, spoil);
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', spoil);
      assert.equal(store.latestRun(t.id)!.id, approved.id, spoil);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), tip, spoil);
    } finally {
      teardown(store);
    }
  }
});

test('a marker in a file the ticket itself added is reported as such', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir,
      `if grep -q '<<<<<<<' a.txt; then printf 'l1\\nRESOLVED\\nl3\\n' > a.txt; else printf 'l1\\nticket\\nl3\\n' > a.txt; printf 'x\\n=======\\ny\\n' > doc.txt; fi`);
    moveMain(dir);
    await applyApproval(store, t.id, {});
    await sched.drain(30_000);
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'awaiting-approval');
    assert.match(now.error ?? '', /conflict markers are still in doc\.txt \(doc\.txt added by this ticket itself/);
  } finally {
    teardown(store);
  }
});

test('leftoverMarkers fails closed: a git failure other than "found problems" throws', async () => {
  const dir = repo({ 'a.txt': 'x\n' });
  fs.writeFileSync(path.join(dir, 'a.txt'), '<<<<<<< x\n');
  const jail = { dir, repo: dir, branch: 'main' };
  assert.deepEqual((await leftoverMarkers(jail)).paths, ['a.txt']);
  git(dir, 'config', 'diff.algorithm', 'bogus');
  await assert.rejects(leftoverMarkers(jail));
});

test('a later ordinary repair round drops the carried run', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'), { maxRepairs: 3 });
    assert.ok(store.scheduleConflictRepair(t.id, store.latestRun(t.id)!.id, null));
    assert.ok(store.carryRun(t.id));
    assert.ok(store.scheduleRepair(t.id, 'fix it'));
    assert.equal(store.carryRun(t.id), null);
  } finally {
    teardown(store);
  }
});

test('approving a conflict round that was stopped mid-way (task still queued) lands nothing and does not complete it', async () => {
  const { dir, seen, store } = setup();
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    const once = path.join(seen, 'once');
    const t = await toGate(store, sched, dir, script(seen, 'ticket', `touch ${once}; sleep 60`));
    const approved = store.latestRun(t.id)!;
    moveMain(dir);
    await applyApproval(store, t.id, {});
    sched.start();
    for (let i = 0; i < 400 && !fs.existsSync(once); i++) await sleep(25);
    await sched.stop();
    assert.equal(store.getTask(t.id)!.status, 'queued');
    assert.notEqual(store.latestRun(t.id)!.id, approved.id, 'the interrupted attempt is the latest run');
    const tip = git(dir, 'rev-parse', 'HEAD');
    const r = await applyApproval(store, t.id, {});
    assert.equal(r.merge.merged, false);
    assert.notEqual(store.getTask(t.id)!.status, 'done');
    await assertBackAtGate(store, dir, t.id, approved, tip);
  } finally {
    teardown(store);
  }
});

test('approving a queued conflict round before it has started a run keeps the approved run and completes nothing', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    const approved = store.latestRun(t.id)!;
    moveMain(dir);
    await applyApproval(store, t.id, {});
    assert.equal(store.getTask(t.id)!.status, 'queued');
    const tip = git(dir, 'rev-parse', 'HEAD');
    const r = await applyApproval(store, t.id, {});
    assert.equal(r.merge.merged, false);
    assert.notEqual(decisionOf(store, approved.id), 'abandoned');
    await assertBackAtGate(store, dir, t.id, approved, tip);
  } finally {
    teardown(store);
  }
});

test('a resolved conflict round that landed is done for good: a second approval changes nothing', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    moveMain(dir);
    await applyApproval(store, t.id, {});
    await sched.drain(30_000);
    const round = store.latestRun(t.id)!;
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    const first = await applyApproval(store, t.id, {});
    assert.equal(first.merge.merged, true);
    assert.equal(store.getTask(t.id)!.status, 'done');
    assert.match(git(dir, 'show', 'HEAD:a.txt'), /RESOLVED/);
    const tip = git(dir, 'rev-parse', 'HEAD');
    await assert.rejects(applyApproval(store, t.id, {}), /is done/);
    assert.equal(store.getTask(t.id)!.status, 'done');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), tip);
    assert.notEqual(decisionOf(store, round.id), 'abandoned');
    assert.equal(store.latestRun(t.id)!.id, round.id);
  } finally {
    teardown(store);
  }
});

test('a marker check that cannot run at the gate drops the parked round back to the approved run', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    const approved = store.latestRun(t.id)!;
    moveMain(dir);
    await applyApproval(store, t.id, {});
    await sched.drain(30_000);
    assert.notEqual(store.latestRun(t.id)!.id, approved.id);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    const tip = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'config', 'diff.algorithm', 'bogus');
    const r = await applyApproval(store, t.id, {});
    git(dir, 'config', '--unset', 'diff.algorithm');
    assert.equal(r.merge.merged, false);
    assert.match(r.merge.reason, /could not check the round's tree/);
    await assertBackAtGate(store, dir, t.id, approved, tip);
  } finally {
    teardown(store);
  }
});

test('a conflict round lands the tree ITS review recorded, not the approved run\'s, and nothing written after it', async () => {
  const { dir, seen, store, sched } = setup();
  try {
    const t = await toGate(store, sched, dir, script(seen, 'ticket'));
    const approved = store.latestRun(t.id)!;
    assert.match(approved.reviewedTree ?? '', /^[0-9a-f]{40}$/);
    moveMain(dir);
    const first = await applyApproval(store, t.id, {});
    assert.match(first.merge.reason, /^merge conflict/, 'the approved tree was the reviewed one: the conflict is what stopped it');
    await sched.drain(30_000);
    const round = store.latestRun(t.id)!;
    assert.notEqual(round.id, approved.id);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', store.getTask(t.id)!.error ?? '');
    assert.match(round.reviewedTree ?? '', /^[0-9a-f]{40}$/);
    assert.notEqual(round.reviewedTree, approved.reviewedTree, 'the round was reviewed as its own tree');

    // The round's worktree is held to the round's tree like any other run's.
    const head = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(round.worktreePath!, 'late.txt'), 'after the round was reviewed\n');
    const refused = await applyApproval(store, t.id, {});
    assert.equal(refused.merge.merged, false);
    assert.match(refused.merge.reason, /^work changed after review: late\.txt \(added since review\)/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(store.latestRun(t.id)!.id, round.id, 'the round is still the run at the gate');
    fs.rmSync(path.join(round.worktreePath!, 'late.txt'));

    const landed = await applyApproval(store, t.id, {});
    assert.equal(landed.merge.merged, true, landed.merge.reason);
    assert.equal(landed.merge.note, undefined);
    assert.equal(git(dir, 'rev-parse', 'HEAD^2^{tree}'), round.reviewedTree);
    assert.match(git(dir, 'show', 'HEAD:a.txt'), /RESOLVED/);
    assert.equal(store.getTask(t.id)!.status, 'done');
  } finally {
    teardown(store);
  }
});

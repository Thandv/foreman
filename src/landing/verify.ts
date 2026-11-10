import fs from 'node:fs';
import path from 'node:path';
import { pinnedGit } from '../gitExec.ts';
import { checkMain, type MainCheck } from '../postMerge.ts';
// Type-only: gate.ts value-imports this file, so a value edge back would be a cycle.
import type { ApprovalTracker } from '../gate.ts';
import type { MergeResult } from '../merge.ts';
import type { Store } from '../queue.ts';
import type { Run, Task } from '../types.ts';

/** A landing whose merge has settled (gate.ts approveNow), as its post-merge check needs it. */
export interface Landed {
  task: Task;
  run: Run | null;
  merge: MergeResult;
}

const MAIN_WORKTREE_PREFIX = 'foreman-main-';

/**
 * Remove every registered foreman-main-* worktree of `repo` (checkMain's
 * scratch checkouts), then prune registrations whose directory is gone. Used
 * after an interrupted check and at startup, after a crash. A worktree named
 * for another process that is still alive is that process's running check
 * and is left alone. Returns the paths removed. Through `pinnedGit`, so an
 * inherited GIT_DIR cannot point the listing and removals at another repo.
 */
export async function pruneMainWorktrees(repo: string): Promise<string[]> {
  const list = await pinnedGit(repo, ['worktree', 'list', '--porcelain'])
    .then((r) => r.stdout)
    .catch(() => '');
  const removed: string[] = [];
  for (const line of list.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length).trim();
    const name = path.basename(dir);
    if (!name.startsWith(MAIN_WORKTREE_PREFIX)) continue;
    // foreman-main-<pid>-…: another live daemon's (or CLI's) check in progress.
    const owner = Number(/^foreman-main-(\d+)-/.exec(name)?.[1]);
    if (owner && owner !== process.pid && pidAlive(owner)) continue;
    await pinnedGit(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  await pinnedGit(repo, ['worktree', 'prune']).catch(() => {});
  return removed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Runs the repo's tests at `head`, the HEAD a landing's merge made (postMerge.ts checkMain). */
export type MainChecker = (repo: string, testCmd: string | null, signal: AbortSignal, head: string) => Promise<MainCheck>;

export const checkMergedHead: MainChecker = (repo, testCmd, signal, head) => checkMain(repo, testCmd, signal, undefined, head);

/** Resolves when `signal` aborts, never otherwise: a check that ignores its signal must not hold a shutdown. */
function onAbort(signal: AbortSignal): Promise<'interrupted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('interrupted');
    else signal.addEventListener('abort', () => resolve('interrupted'), { once: true });
  });
}

/**
 * The post-merge check of a landing, at the HEAD its merge made. Outside the
 * merge section, after the approval has returned, but still inside the landing
 * hold, so no dependent is released before that HEAD has been shown to pass its
 * own tests. A red or an interrupted check marks the repo red at that HEAD,
 * names this task and says so on its timeline. Returns the merge result with
 * what the check found appended to its reason (for the owner gate's log; the
 * decision row was written without it).
 */
export async function verifyLanding(store: Store, landed: Landed, head: string, mainCheck: MainChecker, tracker: ApprovalTracker): Promise<MergeResult> {
  const { task, run } = landed;
  const taskId = task.id;
  const repo = task.repo!;
  let merge = landed.merge;
  const { signal, release } = tracker.checkSignal();
  const ran = await Promise.race([
    mainCheck(repo, task.testCmd ?? null, signal, head)
      .catch((err: Error): MainCheck => ({ ok: false, head: '', cmd: null, tail: err.message, firstTail: '' })),
    onAbort(signal),
  ]).finally(release);
  // A shutdown aborted the check: it did not run, so the repo is not known
  // green. Held like a red main, due for a re-check at once (the
  // scheduler's red re-check verifies HEAD and releases it), so no
  // dependent is cut from an untested HEAD; and the scratch worktree is
  // taken down rather than left registered in the repo.
  if (ran === 'interrupted') {
    await pruneMainWorktrees(repo);
    store.markRepoRed(repo, {
      head, taskId, testCmd: task.testCmd ?? null,
      reason: 'post-merge check interrupted — untested', nextCheckAt: Date.now(),
    });
    store.record({
      taskId, runId: run?.id ?? null, type: 'warning',
      message: `main check after merging ${taskId} was interrupted by a daemon shutdown and did not run: ` +
        'the merged HEAD is untested; new work for this repo is held until a re-check passes',
    });
    merge = { ...merge, reason: `${merge.reason}; main check interrupted by shutdown — untested, dependents held` };
  }
  const check: MainCheck = ran === 'interrupted'
    ? { ok: true, head: '', cmd: null, tail: '', firstTail: '' } // already held above
    : ran;
  const firstRun = check.firstTail ? `\n--- first run (failed) ---\n${check.firstTail.slice(-2_000)}\n--- second run ---\n` : '\n';
  if (check.ok && check.firstTail) {
    store.record({
      taskId, runId: run?.id ?? null, type: 'status',
      message: `main check after ${taskId} failed once, then passed on an immediate re-run at the same HEAD (flaky; repo not marked red)` +
        `${firstRun}${check.tail.slice(-2_000)}`,
    });
  }
  if (!check.ok) {
    store.markRepoRed(repo, { head: check.head, taskId, testCmd: task.testCmd ?? null, reason: check.tail.slice(-2_000) });
    store.record({
      taskId, runId: run?.id ?? null, type: 'error',
      message: `MAIN IS RED after merging ${taskId}${check.cmd ? ` (${check.cmd})` : ''}: new work for this repo is held ` +
        `until HEAD moves and its tests pass.${firstRun}${check.tail.slice(-2_000)}`,
    });
    merge = { ...merge, reason: `${merge.reason}; MAIN IS RED after the merge — dependents held` };
  }
  return merge;
}

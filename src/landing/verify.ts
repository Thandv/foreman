import fs from 'node:fs';
import path from 'node:path';
import { config, type PostMergeMode } from '../config.ts';
import { swallowed } from '../debug.ts';
import { pinnedGit } from '../gitExec.ts';
import { checkMain, postMergeCheckEnabled, type MainCheck } from '../postMerge.ts';
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
 * The post-merge check of one landing, at the HEAD its merge made (FOREMAN_POSTMERGE_MODE=per-merge). Outside the
 * merge section, after the approval has returned, but still inside the landing hold, so no dependent is released
 * before that HEAD has been shown to pass its own tests. Returns the merge result with what the check found appended
 * to its reason (for the owner gate's log; the decision row was written without it).
 */
async function verifyLanding(store: Store, landed: Landed, head: string, mainCheck: MainChecker, tracker: ApprovalTracker): Promise<MergeResult> {
  return withFinding(landed.merge, await checkCovering(store, [landed], head, mainCheck, tracker));
}

const withFinding = (merge: MergeResult, finding: string): MergeResult =>
  finding ? { ...merge, reason: `${merge.reason}${finding}` } : merge;

/**
 * One check at `head` on behalf of `covered` (oldest first; the last one's merge made `head`, and every one shares
 * its test command). A red or an interrupted check marks the repo red at that HEAD, naming the newest of them, and
 * one event on its timeline names them all. Returns what to append to each one's merge reason: '' when it passed.
 */
async function checkCovering(store: Store, covered: Landed[], head: string, mainCheck: MainChecker, tracker: ApprovalTracker): Promise<string> {
  const { task, run } = covered[covered.length - 1]!;
  const taskId = task.id;
  const names = covered.map((l) => l.task.id).join(', ');
  const repo = task.repo!;
  let finding = '';
  const { signal, release } = tracker.checkSignal();
  // A shutdown that began before this check starts it not at all: its outcome would be 'interrupted' anyway.
  const ran = await (signal.aborted ? Promise.resolve('interrupted' as const) : Promise.race([
    mainCheck(repo, task.testCmd ?? null, signal, head)
      .catch((err: Error): MainCheck => ({ ok: false, head: '', cmd: null, tail: err.message, firstTail: '' })),
    onAbort(signal),
  ])).finally(release);
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
      message: `main check after merging ${names} was interrupted by a daemon shutdown and did not run: ` +
        'the merged HEAD is untested; new work for this repo is held until a re-check passes',
    });
    finding = '; main check interrupted by shutdown — untested, dependents held';
  }
  const check: MainCheck = ran === 'interrupted'
    ? { ok: true, head: '', cmd: null, tail: '', firstTail: '' } // already held above
    : ran;
  const firstRun = check.firstTail ? `\n--- first run (failed) ---\n${check.firstTail.slice(-2_000)}\n--- second run ---\n` : '\n';
  if (check.ok && check.firstTail) {
    store.record({
      taskId, runId: run?.id ?? null, type: 'status',
      message: `main check after ${names} failed once, then passed on an immediate re-run at the same HEAD (flaky; repo not marked red)` +
        `${firstRun}${check.tail.slice(-2_000)}`,
    });
  }
  if (!check.ok) {
    store.markRepoRed(repo, { head: check.head, taskId, testCmd: task.testCmd ?? null, reason: check.tail.slice(-2_000) });
    store.record({
      taskId, runId: run?.id ?? null, type: 'error',
      message: `MAIN IS RED after merging ${names}${check.cmd ? ` (${check.cmd})` : ''}: new work for this repo is held ` +
        `until HEAD moves and its tests pass.${firstRun}${check.tail.slice(-2_000)}`,
    });
    finding = '; MAIN IS RED after the merge — dependents held';
  }
  return finding;
}

/** A landing waiting for a coalesced check to cover it. */
interface Pending {
  landed: Landed;
  /** The HEAD its merge made. */
  head: string;
  mainCheck: MainChecker;
  tracker: ApprovalTracker;
  resolve: (merge: MergeResult) => void;
  reject: (err: unknown) => void;
}

/** Landings not yet covered by a check, per resolved repo path, in landing order; present while a repo's checks run. */
const lanes = new Map<string, Pending[]>();

const commandOf = (p: Pending): string | null => p.landed.task.testCmd ?? null;

/** Whether coalesced landing checks are running in `repo`: their next check is at the newest HEAD merged there. */
export const landingChecksRunning = (repo: string): boolean => lanes.has(path.resolve(repo));

/**
 * The post-merge check of a landing whose merge made `head`, and the end of its landing hold. Resolves, like
 * verifyLanding, with the merge result and what the check that covered it found, once one has.
 * per-merge: one check per landing, at once, at its own merge HEAD.
 * coalesced: one check at a time per repo. The next one is for the test command of the oldest landing not yet
 * covered, at the newest HEAD merged with that command, and covers every landing with that command whose merge HEAD
 * is an ancestor of it; so merges that land while a check runs share one more check, not one each. In memory only,
 * like the landing hold.
 */
export function checkLanding(
  store: Store, landed: Landed, head: string, mainCheck: MainChecker, tracker: ApprovalTracker,
  mode: PostMergeMode = config.postMergeMode,
): Promise<MergeResult> {
  if (mode === 'per-merge') return verifyLanding(store, landed, head, mainCheck, tracker).finally(() => store.endLanding(landed.task.id));
  const repo = path.resolve(landed.task.repo!);
  return new Promise<MergeResult>((resolve, reject) => {
    const entry: Pending = { landed, head, mainCheck, tracker, resolve, reject };
    const lane = lanes.get(repo);
    if (lane) {
      lane.push(entry);
      return;
    }
    lanes.set(repo, [entry]);
    void drainLane(store, repo);
  });
}

/** What a post-merge check runs with outside an approval: the daemon's tracker and checker, or a test's. */
export interface PostMergeRun {
  mainCheck: MainChecker;
  tracker: ApprovalTracker;
  /** Stands in for FOREMAN_POSTMERGE_MODE in tests. */
  mode?: PostMergeMode;
}

/**
 * The post-merge check of a merge request's landing (landing/mr.ts), once the checkout has been synced to the forge's
 * merge commit `mergeHead`: checkLanding at that commit, tracked like an approval's, so its hold ends with the check
 * that covers it. With FOREMAN_POSTMERGE_CHECK off, or the ticket gone, the hold ends at once.
 */
export async function checkMrLanding(
  store: Store, mr: { taskId: string; runId: string; mergeHead: string; reason: string }, post: PostMergeRun,
): Promise<void> {
  const task = store.getTask(mr.taskId);
  if (!task?.repo || !postMergeCheckEnabled()) {
    store.endLanding(mr.taskId);
    return;
  }
  const landedRun = store.getRun(mr.runId);
  const merge: MergeResult = { merged: true, code: 'merged', reason: mr.reason, branch: landedRun?.branch ?? null };
  await post.tracker.track(checkLanding(store, { task, run: landedRun, merge }, mr.mergeHead, post.mainCheck, post.tracker, post.mode));
}

/** Runs `repo`'s checks until every landing queued there is covered, then drops the lane. */
async function drainLane(store: Store, repo: string): Promise<void> {
  const lane = lanes.get(repo)!;
  while (lane.length > 0) {
    const cmd = commandOf(lane[0]!);
    const same = lane.filter((p) => commandOf(p) === cmd);
    const newest = same[same.length - 1]!;
    // The newest is always covered, so every round settles at least one landing.
    const covered: Pending[] = [];
    for (const p of same) if (p === newest || await isAncestor(repo, p.head, newest.head)) covered.push(p);
    for (const p of covered) lane.splice(lane.indexOf(p), 1);
    await checkCovering(store, covered.map((p) => p.landed), newest.head, newest.mainCheck, newest.tracker).then(
      (finding) => settle(store, covered, (p) => p.resolve(withFinding(p.landed.merge, finding))),
      (err: unknown) => settle(store, covered, (p) => p.reject(err)),
    );
  }
  lanes.delete(repo);
}

/** Ends each covered landing's hold, as the per-merge check's .finally does, then answers its approval. */
function settle(store: Store, covered: Pending[], answer: (p: Pending) => void): void {
  for (const p of covered) {
    store.endLanding(p.landed.task.id);
    answer(p);
  }
}

/**
 * Whether `older` is an ancestor of `newer` (git exits 1 when it is not); a git that cannot say is logged and
 * leaves the landing for a later check.
 */
const isAncestor = (repo: string, older: string, newer: string): Promise<boolean> =>
  pinnedGit(repo, ['merge-base', '--is-ancestor', older, newer]).then(() => true, (err: { code?: unknown }) => {
    if (err.code !== 1) swallowed('landing', 'is-ancestor', err);
    return false;
  });

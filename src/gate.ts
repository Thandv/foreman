import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ownerCall } from './assistant/ownerCall.ts';
import { recordDecision } from './assistant/memory.ts';
import { dailyCapUsd, subscriptionCapUsd } from './budget.ts';
import { config } from './config.ts';
import { boundBrief, compactDiff, diffStats } from './context.ts';
import { pathsInDiff } from './improve.ts';
import { landingRefusal, mergeApproved, NOT_REVIEWED, type MergeResult } from './merge.ts';
import { NOTHING_TO_CHANGE_CLOSED, personPark } from './verify/gateOutcome.ts';
import { extractJson } from './models.ts';
import { cloudFallback, localOnly } from './localOnly.ts';
import { getPlaybook } from './playbooks.ts';
import { isSelfTask } from './security/coreGuard.ts';
import { leftoverMarkers, pinnedGit, unmergedPaths } from './isolate.ts';
// Type-only, like ownerCall.ts: the Store is always the caller's, so gate.ts
// keeps no runtime edge to queue.ts and cannot form a cycle with it.
import type { Store } from './queue.ts';
import { registerApprovedTool, type RegisterResult } from './tools/forge.ts';
import { checkMain, postMergeCheckEnabled, repoHead, type MainCheck } from './postMerge.ts';
import type { Decision, GateMode, Run, Task } from './types.ts';
import { chairRuled } from './verify/council.ts';
import { assertionHold } from './verify/assertionCheck.ts';
import { storedRevertTestsNote } from './verify/revertTests.ts';
import { cutMiddle, storedReport } from './verify/report.ts';
import { boundDroppedIssues, droppedSinceLastPark, DROPPED_ISSUE_PREFIX, formatDroppedIssues, heldReason, isCapDrop } from './verify/crewReview.ts';

export type GateDecision = 'approved' | 'rejected' | 'hold';

/** Owner tier, one shot, 2 minutes — a gate call is not an agent loop. */
const GATE_TIMEOUT_MS = 120_000;
const GATE_MAX_TURNS = 2;
/**
 * Tickets per batched gate call. Five is the point where one prompt still fits
 * the owner's attention: past it the later tickets get read the way a tenth
 * item on a list gets read, and a gate that skims is worse than a gate that
 * costs one more call.
 */
export const GATE_BATCH_MAX = 5;
/** A batch is one call for N tickets, so it gets N tickets' worth of clock — capped. */
const GATE_BATCH_TIMEOUT_MS = 300_000;
const MAX_DIFF = 12_000;
const MAX_FIELD = 2_000;
/**
 * The worker's report in a gate prompt: its first lines and its last, whole lines only. The report ENDS with the
 * acceptance map and the known gaps, and the first 2000 characters of the run row's copy — what this prompt carried
 * before — never reached either on a report of any length: the owner model decided without them.
 */
const MAX_REPORT = 6_000;
const MAX_CRITIQUE = 1_200;
/**
 * Marker on the decision note, so a rejection reason names who wrote it. The
 * durable "the owner gate decided this" fact is `tasks.gate_decision` (that is
 * what dataset.ts filters on); this prefix is the human-readable half.
 */
export const OWNER_GATE_NOTE = 'owner-gate:';

/** Read lazily so a test (or an operator's shell) can flip it per case. */
export function envGate(): GateMode {
  return process.env['FOREMAN_GATE'] === 'owner' ? 'owner' : 'human';
}

/** Kill-switch for batched gating; a batch is an optimisation, never a policy. */
export function gateBatchEnabled(): boolean {
  return process.env['FOREMAN_GATE_BATCH'] !== 'off';
}

/**
 * Who decides this task: the per-ticket opt-in wins, then the playbook's own
 * policy, then the environment, then the human.
 *
 * The playbook deliberately outranks FOREMAN_GATE: a domain that says its work
 * is human-gated (every seed playbook does) must not become autonomous because
 * a shell exported one variable. Autonomy on such a playbook is opt-in per
 * ticket — `foreman build --gate owner` — and nothing else.
 */
export function effectiveGate(task: Pick<Task, 'gate' | 'playbook'>, houseDefault?: GateMode | null): GateMode {
  // The local-only policy: owner gating is abolished under local-only. The owner gate is
  // a model deciding that a model's work is good enough to land, and the whole
  // premise of local-only is that the models left cannot make that call. It
  // outranks even an explicit `--gate owner` on the ticket, because a ticket
  // queued before the flag was set must not auto-approve after it.
  if (localOnly()) return 'human';
  // The owner model IS Claude. With the CLI known down an owner gate can only
  // fail, so the decision is the human's until it is back.
  if (cloudFallback()) return 'human';
  if (task.gate === 'owner' || task.gate === 'human') return task.gate;
  const pb = task.playbook ? getPlaybook(task.playbook) : null;
  if (pb) return pb.gate.default;
  // The board's switch sits above FOREMAN_GATE and below the playbook, for the
  // same reason the assignee toggle does: a playbook's gate policy is a
  // standing decision about a kind of work.
  return houseDefault ?? envGate();
}

/**
 * The standing, written-down opt-in to owner gating: this ticket asked for it
 * (`--gate owner`), or its playbook declares the whole domain autonomous.
 *
 * FOREMAN_GATE is deliberately NOT consulted here. An exported variable is the
 * operator's *live* intent, so it qualifies only tickets the daemon watched
 * park while it was set (scheduler.ts, the at-park trigger) — never a backlog
 * that was already sitting at the gate when the shell exported it. The sweep
 * over already-parked tasks asks this function; the at-park trigger asks
 * effectiveGate(). Without the split, `FOREMAN_GATE=owner foreman up` would
 * retroactively hand the Owner model every playbook-less ticket a human had
 * been sitting on, which is the one thing an env var must not be able to do.
 */
export function gateOptIn(task: Pick<Task, 'gate' | 'playbook'>, houseDefault?: GateMode | null): boolean {
  if (localOnly()) return false; // local-only policy, same argument as effectiveGate
  if (cloudFallback()) return false; // the owner model is unreachable; the sweep retries once it is back
  if (task.gate === 'human') return false;
  if (task.gate === 'owner') return true;
  const pb = task.playbook ? getPlaybook(task.playbook) : null;
  if (pb) return pb.gate.default === 'owner';
  // A house default set from the board IS a standing, written-down opt-in —
  // the thing FOREMAN_GATE deliberately is not. It is stored, it survives a
  // restart, and it took a deliberate action to set.
  return houseDefault === 'owner';
}

const execGit = promisify(execFile);

/** Thrown by applyApproval once the daemon has begun shutting down. */
export class ShuttingDownError extends Error {}

/**
 * The approvals in flight in this process, so a shutdown can wait for them.
 *
 * An approval is a merge into the operator's own checkout followed by a test
 * run on the merged HEAD. Exiting mid `git merge` leaves the operator's repo
 * with a MERGE_HEAD; exiting mid check leaves a registered foreman-main-*
 * worktree and a merge nobody was told went untested. So a shutdown stops
 * accepting new approvals, aborts the checks (they are re-runnable; a merge
 * is not), and waits — bounded — for each merge step to settle.
 */
export class ApprovalTracker {
  private closing = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly checks = new Set<AbortController>();

  get shuttingDown(): boolean {
    return this.closing;
  }

  /** Refuse before any state changes, so a refused approval leaves the ticket parked. */
  admit(taskId: string): void {
    if (this.closing) throw new ShuttingDownError(`daemon is shutting down; approval of ${taskId} not accepted — approve again after restart`);
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.catch(() => {}).finally(() => this.inflight.delete(p));
    return p;
  }

  /** A controller for one post-merge check; already aborted once shutdown began. */
  checkSignal(): { signal: AbortSignal; release: () => void } {
    const ac = new AbortController();
    if (this.closing) ac.abort();
    else this.checks.add(ac);
    return { signal: ac.signal, release: () => this.checks.delete(ac) };
  }

  get pending(): number {
    return this.inflight.size;
  }

  /**
   * Stop accepting, abort every post-merge check, and wait up to `capMs` for
   * the in-flight approvals to settle. Resolves with how many did not.
   */
  async shutdown(capMs = APPROVAL_DRAIN_CAP_MS): Promise<number> {
    this.closing = true;
    for (const ac of this.checks) ac.abort();
    if (!this.inflight.size) return 0;
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((r) => { timer = setTimeout(r, capMs); });
    await Promise.race([Promise.allSettled([...this.inflight]), cap]);
    clearTimeout(timer);
    return this.inflight.size;
  }
}

/** Hard cap on how long a shutdown waits for in-flight merges. */
export const APPROVAL_DRAIN_CAP_MS = 60_000;

/** The daemon's tracker. Tests pass their own via applyApproval's opts. */
export const approvals = new ApprovalTracker();

const MAIN_WORKTREE_PREFIX = 'foreman-main-';

/**
 * Remove every registered foreman-main-* worktree of `repo` (checkMain's
 * scratch checkouts), then prune registrations whose directory is gone. Used
 * after an interrupted check and at startup, after a crash. A worktree named
 * for another process that is still alive is that process's running check
 * and is left alone. Returns the paths removed.
 */
export async function pruneMainWorktrees(repo: string): Promise<string[]> {
  const list = await execGit('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
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
    await execGit('git', ['worktree', 'remove', '--force', dir], { cwd: repo }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  await execGit('git', ['worktree', 'prune'], { cwd: repo }).catch(() => {});
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

/**
 * Startup half of the above: a crash (or a shutdown past its cap) can leave a
 * foreman-main-* worktree registered in any repo Foreman has merged into.
 * Called before the scheduler starts, so no check of this process is running.
 */
export async function pruneStaleMainWorktrees(store: Store): Promise<string[]> {
  const rows = store.db.prepare('SELECT DISTINCT repo FROM tasks WHERE repo IS NOT NULL').all() as Record<string, unknown>[];
  const removed: string[] = [];
  for (const row of rows) {
    const repo = String(row['repo']);
    if (!fs.existsSync(repo)) continue;
    removed.push(...(await pruneMainWorktrees(repo)));
  }
  return removed;
}

type MainChecker = (repo: string, testCmd: string | null, signal: AbortSignal) => Promise<MainCheck>;

/** Resolves when `signal` aborts, never otherwise: a check that ignores its signal must not hold a shutdown. */
function onAbort(signal: AbortSignal): Promise<'interrupted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('interrupted');
    else signal.addEventListener('abort', () => resolve('interrupted'), { once: true });
  });
}

export interface ApprovalResult {
  task: Task;
  merge: MergeResult;
  registration: RegisterResult;
  /** The row this approval left in `decisions`; null if the ledger could not take it (the timeline says why). */
  decision?: Decision | null;
}

/** What only the person approving can state, for the decision row. Read only when `source` is 'human'. */
export interface ApprovalStatement {
  /** true: the work needed a fix beyond the reviewed diff (`--corrected`); false: it did not (`--clean`); absent: not stated. */
  corrected?: boolean | null;
  /** Who verified the work, in the approver's words. */
  reviewSource?: string | null;
}

/**
 * The one approve path. A human approving over HTTP and the owner gate
 * approving off-tick run exactly this: decide → remember → land the branch →
 * register a built tool. `source` only marks the decision; it never branches
 * the effects, so autonomy cannot quietly do something approval does not.
 */
export async function applyApproval(
  store: Store,
  taskId: string,
  opts: {
    note?: string | null; source?: 'human' | 'owner-gate'; tracker?: ApprovalTracker; mainCheck?: MainChecker;
    /** Stands in for Foreman's own checkout in tests (merge.ts). */
    selfRoot?: string;
    /**
     * `foreman approve --as-is <sha>`: land this tree although it is not the
     * reviewed one (merge.ts). Read only when `source` is 'human'.
     */
    acceptTree?: string | null;
  } & ApprovalStatement = {},
): Promise<ApprovalResult> {
  const tracker = opts.tracker ?? approvals;
  tracker.admit(taskId);
  return tracker.track(approve(store, taskId, opts, tracker));
}

async function approve(
  store: Store,
  taskId: string,
  opts: { note?: string | null; source?: 'human' | 'owner-gate'; mainCheck?: MainChecker; selfRoot?: string; acceptTree?: string | null } & ApprovalStatement,
  tracker: ApprovalTracker,
): Promise<ApprovalResult> {
  const source = opts.source ?? 'human';
  const before = store.getTask(taskId);
  const run = before ? store.latestRun(taskId) : null;
  // The ledger's own record of this decision (recordApproval below): written once, when the outcome is known.
  const recorded = (result: ApprovalResult): Promise<ApprovalResult> => recordApproval(store, opts, before, run, result);
  // A conflict round that is not a clean, finished result is never approved
  // into main, nor is the task marked done on top of it: it goes back to the
  // gate on the approved run, with the hand-merge message.
  const unlandable = before && run ? await conflictRoundProblem(store, before, run) : null;
  if (unlandable) {
    const reason = store.abandonConflictRound(taskId, run!.id, unlandable);
    return recorded({
      task: store.getTask(taskId)!,
      merge: { merged: false, reason, branch: run!.branch ?? null },
      registration: { registered: false, reason: 'nothing landed', tool: null },
    });
  }
  // Only work this decision vouches for lands: a run parked for approval and
  // not cut short. A ticket marked done on the operator's own desk approved no
  // run — its latest one may be an interrupted run's kept worktree, or work
  // the operator rejected or canceled before retrying it.
  const landable = before?.status === 'awaiting-approval' && run !== null && run.status !== 'canceled';
  // Only a person names a tree to land as it is; the owner gate's approval
  // never carries one, whatever its caller passed.
  const who = { source, acceptTree: source === 'human' ? (opts.acceptTree ?? null) : null };
  // Work that is not the tree its reviewers were shown is not approved at all:
  // asked before decide(), so the task is never marked done, no approval is
  // remembered and no dependent is released. It stays parked, with the reason.
  const unreviewed = landable ? await landingRefusal(before!, run, { ...who, selfRoot: opts.selfRoot }).catch(() => null) : null;
  if (unreviewed) {
    store.setStatus(taskId, 'awaiting-approval', store.withCoreGuard(taskId, `not landed: ${unreviewed}`));
    store.record({ taskId, runId: run!.id, type: 'status', message: `merge: ${unreviewed}` });
    return recorded({
      task: store.getTask(taskId)!,
      merge: { merged: false, reason: unreviewed, branch: run!.branch ?? null },
      registration: { registered: false, reason: 'nothing landed', tool: null },
    });
  }
  // Read before decide(), which labels a gate-decided run.
  const left = !landable && leftOver(store, run);
  const note = opts.note ?? null;
  // The note is NOT passed to decide(): `tasks.error` is the rejection reason
  // column, and writing an approval note there makes every approved ticket look
  // like it carries an error (and changes what dpoFromGate reads as `reason`).
  // The note's homes are the memory preference, the `decisions` row and its
  // timeline event (recordApproval).
  // Held from BEFORE decide() until the merge settles: decide() marks the task
  // done, and the scheduler's next tick (250ms) would otherwise release its
  // dependents and cut their worktrees from a main the merge has not reached
  // yet. Observed on the first Kiln epic: the executor started in the same
  // second its dependency was approved, one second before that merge landed,
  // and failed its typecheck on the missing module.
  if (landable) store.beginLanding(taskId);
  let task: Task;
  let merge: ApprovalResult['merge'];
  try {
    task = store.decide(taskId, true, undefined, source);
    recordDecision(store, task, true, note, source);
    merge = landable
      ? await mergeApproved(task, run, { selfRoot: opts.selfRoot, ...who }).catch((err: Error): MergeResult => ({
        merged: false,
        reason: `merge failed: ${err.message}`,
        branch: run?.branch ?? null,
      }))
    : left
      ? {
        merged: false,
        reason: `not landed: an interrupted run's work is still in ${run!.worktreePath} (branch ${run!.branch}) — ` +
          'commit it there and merge it yourself if you want it',
        branch: run!.branch,
      }
      : { merged: false, reason: 'nothing to land: no run was approved', branch: null };
    // A run that changed nothing (it recorded no diff) and whose branch the landing found empty: the approval
    // closes the ticket, and says so instead of reading like a merge that went missing. Nothing above is skipped —
    // the reviewed-tree check and mergeApproved ran as for any approval, and found nothing to merge.
    if (landable && !merge.merged && merge.reason === 'branch has no commits ahead of HEAD'
      && !store.artifactsForTask(taskId).some((a) => a.type === 'diff' && a.runId === run!.id)) {
      merge = { ...merge, reason: NOTHING_TO_CHANGE_CLOSED };
    }
    // An approval whose work did not land is not done: its dependents would be
    // released onto a main without it (Kiln Desktop: a conflict aborted the
    // settings ticket's merge and it was marked done anyway). It goes back to
    // the gate with the reason; approving again retries the merge. A refused
    // core change is the same, except that approving again is refused again:
    // it is never marked done with the change unlanded, and its note does not
    // promise that another approval will help.
    // A conflict (and only a conflict: a refused core change starts with other
    // words) with repair budget left becomes a repair round Foreman prepares.
    // Nothing lands here; the round parks at the gate like any other.
    const requeued = landable && !merge.merged && merge.reason.startsWith('merge conflict') && run !== null
      ? requeueConflict(store, task, run)
      : null;
    if (requeued) {
      merge = { ...merge, reason: `${merge.reason}; requeued as repair round ${requeued} to resolve the conflict` };
      task = store.getTask(taskId)!;
    } else if (landable && !merge.merged && NOT_REVIEWED.test(merge.reason)) {
      // The worktree changed between the check above and the commit. The
      // reason already says what a person can do.
      store.setStatus(taskId, 'awaiting-approval', store.withCoreGuard(taskId, `approved, but not landed: ${merge.reason}`));
      task = store.getTask(taskId)!;
    } else if (landable && !merge.merged && /^(merge conflict|merge failed|repo has uncommitted|branch .* no longer exists|core change refused)/.test(merge.reason)) {
      const next = merge.reason.startsWith('core change refused')
        ? 'reject it, or take the core change out of its branch by hand before approving'
        : 'resolve it, then approve again';
      store.setStatus(taskId, 'awaiting-approval', store.withCoreGuard(taskId, `approved, but not landed: ${merge.reason} — ${next}`));
      task = store.getTask(taskId)!;
    }
    // Still inside the landing hold, so no dependent is released before the
    // merged main has been shown to pass its own tests.
    if (landable && merge.merged && task.repo && postMergeCheckEnabled()) {
      const { signal, release } = tracker.checkSignal();
      const repo = task.repo;
      const ran = await Promise.race([
        (opts.mainCheck ?? checkMain)(repo, task.testCmd ?? null, signal)
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
          head: await repoHead(repo), taskId, testCmd: task.testCmd ?? null,
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
        store.markRepoRed(task.repo, { head: check.head, taskId, testCmd: task.testCmd ?? null, reason: check.tail.slice(-2_000) });
        store.record({
          taskId, runId: run?.id ?? null, type: 'error',
          message: `MAIN IS RED after merging ${taskId}${check.cmd ? ` (${check.cmd})` : ''}: new work for this repo is held ` +
            `until HEAD moves and its tests pass.${firstRun}${check.tail.slice(-2_000)}`,
        });
        merge = { ...merge, reason: `${merge.reason}; MAIN IS RED after the merge — dependents held` };
      }
    }
  } finally {
    if (landable) store.endLanding(taskId);
  }
  if (merge.branch) {
    store.record({ taskId, runId: run?.id ?? null, type: 'status', message: `merge: ${merge.reason}` });
  }
  if (merge.merged && merge.note) {
    store.record({ taskId, runId: run?.id ?? null, type: 'warning', message: merge.note });
  }
  // A tool task lands by being registered, the way a code task lands by merging.
  const registration: RegisterResult = landable
    ? registerApprovedTool(task, run)
    : task.kind === 'tool'
      ? { registered: false, reason: 'nothing to register: no run was approved', tool: null }
      : { registered: false, reason: 'not a tool task', tool: null };
  if (task.kind === 'tool') {
    store.record({
      taskId,
      runId: run?.id ?? null,
      type: registration.registered ? 'status' : 'error',
      message: `tool: ${registration.reason}`,
    });
  }
  return recorded({ task, merge, registration });
}

/**
 * The tree a merge just landed, read from what the checkout RECEIVED: the
 * second parent of the newest merge commit on HEAD's first-parent line that
 * merge.ts wrote for this task (`foreman: <title> (<task id>)`, always
 * --no-ff). Never from the branch NAME: the row is written after the main
 * check, minutes after the merge, and a process a run left behind can point
 * the branch anywhere by then (merge.ts reads the branch once for the same
 * reason). Null when git cannot say.
 *
 * Through isolate.ts's `pinnedGit`: the repo's config is the one every jail
 * can write, and with `log.showSignature` set there, `git log` ran the
 * `gpg.program` it also names on a signed merge commit. Exported for its test.
 */
export async function landedTreeOf(repo: string | null, taskId: string): Promise<string | null> {
  if (!repo) return null;
  const sha = /^[0-9a-f]{40,64}$/;
  try {
    const { stdout: found } = await pinnedGit(
      repo,
      ['log', '--first-parent', '--merges', '-n', '1', '--fixed-strings', `--grep=(${taskId})`, '--format=%H', 'HEAD', '--'],
    );
    const commit = found.trim();
    if (!sha.test(commit)) return null;
    const { stdout } = await pinnedGit(repo, ['rev-parse', '--verify', '--quiet', `${commit}^2^{tree}`]);
    const tree = stdout.trim();
    return sha.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

/**
 * The approval as the ledger keeps it: one row in `decisions`, written when
 * the outcome is known (so the merge's own reason and the tree that landed are
 * in it), and its `decision` event. Nothing here decides or changes anything;
 * a ledger that cannot take the row leaves the approval exactly as it was.
 *
 * `corrected`, most specific first: an `--as-is` landing of a tree other than
 * the reviewed one is a correction by definition; else what the person stated
 * (`--corrected` / `--clean`); else NULL, "not stated". It is never read out
 * of the note's wording. The owner gate states nothing, so its rows are NULL.
 */
async function recordApproval(
  store: Store,
  opts: { note?: string | null; source?: 'human' | 'owner-gate'; acceptTree?: string | null } & ApprovalStatement,
  before: Task | null,
  run: Run | null,
  result: ApprovalResult,
): Promise<ApprovalResult> {
  if (!before) return result;
  const person = (opts.source ?? 'human') === 'human';
  // The run under review; a ticket finished on the operator's own desk approved none.
  const ruled = before.status === 'awaiting-approval' ? run : null;
  const asIs = person && typeof opts.acceptTree === 'string' && opts.acceptTree !== '';
  const reviewedTree = ruled?.reviewedTree ?? null;
  const landedTree = result.merge.merged
    ? (await landedTreeOf(before.repo, before.id)) ?? (asIs ? opts.acceptTree! : null)
    : null;
  const stated = person && typeof opts.corrected === 'boolean' ? opts.corrected : null;
  const byTrees = asIs && landedTree !== null && reviewedTree !== null && landedTree !== reviewedTree;
  const decision = store.noteDecision({
    taskId: before.id,
    runId: ruled?.id ?? null,
    action: 'approve',
    actor: person ? 'human' : 'owner-model',
    note: opts.note ?? null,
    statusAfter: store.getTask(before.id)?.status ?? null,
    reviewedTree,
    landedTree,
    asIs,
    merged: result.merge.merged,
    mergeReason: result.merge.reason,
    corrected: byTrees ? true : stated,
    correctedSource: byTrees ? 'trees' : stated === null ? null : 'operator',
    reviewSource: person ? opts.reviewSource ?? null : null,
    // Said and overruled by the trees: kept, so the statement is not lost.
    extra: byTrees && stated !== null ? { stated: stated ? 'corrected' : 'clean' } : null,
  });
  return { ...result, decision };
}

/**
 * Why the latest run of a task parked after a conflict round cannot be
 * approved, or null. Either the round never reached review (an interrupted
 * run's jail is the latest run) or its tree still holds unmerged paths or
 * conflict markers, which an approval would commit and merge as text.
 * A failed check counts as a problem: it is not read as a clean tree.
 */
async function conflictRoundProblem(store: Store, task: Task, run: Run): Promise<string | null> {
  if (!store.inConflictRound(task.id)) return null;
  // Whatever the status: a round stopped or limit-requeued mid-way is queued or
  // failed with the interrupted run latest, and nothing of it may be approved.
  // carry_run is set from requeue until the round reaches review, so a landed
  // (done) round, whose notes still carry the prefix, is left alone.
  const carry = store.carryRun(task.id);
  if (task.status !== 'awaiting-approval') return carry ? 'the round has not finished' : null;
  if (carry === run.id) return null;
  if (carry) return 'the round never finished: an interrupted run is the latest';
  if (!run.worktreePath || !task.repo) return null;
  try {
    const unmerged = await unmergedPaths(run.worktreePath);
    if (unmerged.length) return `unmerged paths remain in ${unmerged.join(', ')}`;
    const left = await leftoverMarkers({ dir: run.worktreePath, repo: task.repo, branch: run.branch ?? '', baseCommit: run.baseCommit ?? undefined });
    if (left.paths.length) {
      return `conflict markers are still in ${left.paths.join(', ')}` +
        (left.added.length ? ` (${left.added.join(', ')} added by this ticket itself — the marker may be a legitimate line such as =======)` : '');
    }
  } catch (err) {
    return `could not check the round's tree for conflict markers (${(err as Error).message.slice(0, 200)})`;
  }
  return null;
}

/**
 * Requeue an approval that hit a merge conflict as a repair round that starts
 * from the approved diff laid onto current main. The round number, or null
 * when it cannot be done (budget spent, no diff to carry) and the operator
 * merges by hand as before. No git runs in the repo here, after mergeApproved
 * has put the core back; the files are named when the round carries the diff
 * in its jail.
 */
function requeueConflict(store: Store, task: Task, run: Run): number | null {
  if (task.repairs >= task.maxRepairs || !task.repo || !run.branch) return null;
  if (!store.artifactsForTask(task.id).some((a) => a.type === 'diff' && a.runId === run.id)) return null;
  return store.scheduleConflictRepair(task.id, run.id, task.testCmd ?? null) ? task.repairs + 1 : null;
}

/** The one reject path; the note is the reason, whoever wrote it. */
export function applyRejection(
  store: Store,
  taskId: string,
  note: string,
  source: 'human' | 'owner-gate' = 'human',
): Task {
  // Read before decide(): the run under review, when the ticket is at the approval gate.
  const ruled = store.getTask(taskId)?.status === 'awaiting-approval' ? store.latestRun(taskId) : null;
  const task = store.decide(taskId, false, note, source);
  recordDecision(store, task, false, note, source);
  store.noteDecision({
    taskId, runId: ruled?.id ?? null, action: 'reject', actor: source === 'human' ? 'human' : 'owner-model', note,
    statusAfter: task.status, reviewedTree: ruled?.reviewedTree ?? null,
  });
  return task;
}

/** Deterministic, code-side bound on the diff before it reaches the prompt. */
function boundDiff(body: string): string {
  const compacted = body.includes('diff --git') ? compactDiff(body, config.diffCapBytes) : body;
  return compacted.length > MAX_DIFF
    ? `${compacted.slice(0, MAX_DIFF)}\n… [truncated, ${compacted.length - MAX_DIFF} more chars]`
    : compacted;
}

function summarizeDiff(body: string): string {
  const stats = diffStats(body);
  if (!stats.length) return body.trim() ? `${body.split('\n').length} line(s) of output` : '(no diff recorded)';
  const total = stats.reduce((n, s) => n + s.added + s.removed, 0);
  return `${stats.length} file(s), ${total} changed line(s): ${stats
    .slice(0, 12)
    .map((s) => `${s.path} (+${s.added}/-${s.removed})`)
    .join(', ')}${stats.length > 12 ? ', …' : ''}`;
}

/** The diff artifact this run wrote, if any; the gate never re-reads the repo. */
function runDiff(store: Store, task: Task, run: Run | null): string {
  if (!run) return '';
  const artifact = store
    .artifactsForTask(task.id)
    .filter((a) => a.runId === run.id && a.type === 'diff')
    .pop();
  if (!artifact) return '';
  try {
    return fs.readFileSync(artifact.path, 'utf8');
  } catch {
    return '';
  }
}

/** Every reviewer that spoke on this run, in the order they spoke. */
export function verdictChain(store: Store, task: Task, run: Run | null): string {
  const verdicts = store.verdictsForTask(task.id).filter((v) => !run || v.runId === run.id);
  const dropped = formatDroppedIssues(boundDroppedIssues(store.warningsWithPrefix(task.id, DROPPED_ISSUE_PREFIX), MAX_CRITIQUE));
  if (!verdicts.length) return dropped ? `(no review ran)\n${dropped}` : '(no review ran)';
  const lines: string[] = [];
  for (const v of verdicts) {
    lines.push(`- ${v.source} review → ${v.verdict}${v.disagreement ? ' (advisors disagreed)' : ''}`);
    if (v.critique) lines.push(`  critique: ${v.critique.slice(0, MAX_CRITIQUE)}`);
    if (v.chairSummary) {
      // A status line in the chair field (a lost seat, an unreachable chair) is
      // not a ruling, and the owner model must not read it as one.
      lines.push(chairRuled(v)
        ? `  chair (${v.chairModel ?? 'unknown model'}): ${v.chairSummary.slice(0, MAX_CRITIQUE)}`
        : `  council note (no chair ruled): ${v.chairSummary.slice(0, MAX_CRITIQUE)}`);
    }
    for (const opinion of v.council) {
      const who = opinion.role ? `${opinion.role}/${opinion.style ?? 'review'}` : opinion.model;
      const said = opinion.error ? `unavailable: ${opinion.error}` : opinion.critique.slice(0, MAX_CRITIQUE);
      lines.push(`  ${who} → ${opinion.verdict}${said ? `: ${said}` : ''}`);
    }
  }
  if (dropped) lines.push(dropped);
  return lines.join('\n');
}

const GATE_CONTRACT = [
  'You are the owner of this crew, standing at the approval gate of one finished ticket.',
  'Everything below has already passed its automated checks and its review chain; your job is to decide',
  'whether it ships as-is, goes back, or needs the human operator.',
  '',
  'Reply with JSON only, no prose outside the object:',
  '{"decision":"approve"|"reject"|"hold","rationale":"..."}',
  '- "approve": the work does what the ticket asked and nothing else. It will be merged immediately.',
  '- "reject": the work is wrong or out of scope. The rationale is what the author is told, so be specific.',
  '- "hold": you are not sure, or the call belongs to a person. The ticket waits for the human. Holding is free;',
  '  approving something you have doubts about is not.',
  '- rationale is one or two sentences of your own reasoning, never a restatement of the reviews.',
].join('\n');

const BATCH_CONTRACT = [
  'You are the owner of this crew, standing at the approval gate of several finished tickets from one epic.',
  'Everything below has already passed its automated checks and its review chain; your job is to decide, for',
  'EACH ticket on its own evidence, whether it ships as-is, goes back, or needs the human operator. They share',
  'an epic, not a fate: one bad ticket does not condemn its siblings, and one good one does not vouch for them.',
  '',
  'Reply with JSON only, no prose outside the object:',
  '{"decisions":[{"id":"<ticket id>","decision":"approve"|"reject"|"hold","rationale":"..."}]}',
  '- one entry per ticket below, carrying its id exactly as written in its === TICKET <id> === header.',
  '- "approve": the work does what its ticket asked and nothing else. It will be merged immediately.',
  '- "reject": the work is wrong or out of scope. The rationale is what the author is told, so be specific.',
  '- "hold": you are not sure, or the call belongs to a person. The ticket waits for the human. Holding is free;',
  '  approving something you have doubts about is not. A ticket you leave out of the reply is held.',
  '- rationale is one or two sentences of your own reasoning about THAT ticket, never a restatement of the reviews.',
].join('\n');

/**
 * One ticket's evidence, with no contract attached: the single gate puts
 * GATE_CONTRACT in front of it, the batch puts BATCH_CONTRACT in front of a
 * concatenation of them. Sharing the builder is what keeps a batched ticket
 * from being judged on less than a solo one would be.
 */
function gateEvidence(task: Task, run: Run | null, diff: string, chain: string, report?: string | null, revert?: string | null): string {
  const bounded = boundDiff(diff.trim());
  // The stored report when the caller read it (ownerGate), else the run row's copy; either way head and tail.
  const said = cutMiddle((report ?? run?.summary ?? '').trim(), MAX_REPORT, (dropped) =>
    `[FOREMAN cut ${dropped} characters from the middle of this report here; the acceptance map at its end is kept]`);
  return [
    `TICKET: ${task.title}`,
    `BRIEF:\n${task.prompt.slice(0, MAX_FIELD)}`,
    `ACCEPTANCE CRITERIA:\n${boundBrief(task.acceptance ?? '(none stated — judge against the brief)', config.acceptanceBytes)}`,
    `WHAT THE WORKER REPORTED:\n${said || '(no summary)'}`,
    `CHECKS: ${run?.testsPassed === true ? 'passed' : run?.testsPassed === false ? 'FAILED' : 'none ran'}`,
    // The per-test revert check's table (verify/revertTests.ts), when the run has one: information, not a rule.
    ...(revert ? [revert] : []),
    `REVIEW CHAIN:\n${chain}`,
    `CHANGE: ${summarizeDiff(diff)}`,
    `DIFF:\n${bounded || '(the worker produced no diff)'}`,
  ].join('\n\n');
}

/**
 * Pure prompt assembly: the caller reads the chain (it holds the Store), this
 * shapes it. static-first for prompt-cache hits — GATE_CONTRACT is identical on
 * every gate call, so it leads and this ticket's evidence trails.
 */
export function buildGatePrompt(task: Task, run: Run | null, diff: string, chain: string, report?: string | null, revert?: string | null): string {
  return [GATE_CONTRACT, gateEvidence(task, run, diff, chain, report, revert)].join('\n\n');
}

export interface GateBatchEvidence {
  task: Task;
  run: Run | null;
  diff: string;
  chain: string;
  /** The run's stored report (verify/report.ts); absent, the run row's copy is shown. */
  report?: string | null;
  /** The run's per-test revert check table (verify/revertTests.ts), when it has one. */
  revert?: string | null;
}

/**
 * The same evidence, N tickets at a time, under one static contract. The ids
 * are stated twice — once as a manifest, once as each section's header — so a
 * reply can be matched back to a ticket by exact string rather than by order.
 */
export function buildBatchGatePrompt(items: GateBatchEvidence[]): string {
  return [
    BATCH_CONTRACT,
    `TICKETS IN THIS BATCH (${items.length}): ${items.map((i) => i.task.id).join(', ')}`,
    ...items.map((i) => `=== TICKET ${i.task.id} ===\n${gateEvidence(i.task, i.run, i.diff, i.chain, i.report, i.revert)}`),
  ].join('\n\n');
}

/**
 * Defensive by contract. A reply that is not an object with a `decisions` array
 * is no reply at all (null — the caller holds every ticket in the batch); an id
 * nobody asked about is dropped; a second entry for an id already answered is
 * dropped; and a decision word the contract does not name becomes a hold rather
 * than a guess. Ids the reply never mentions are simply absent from the map,
 * which the caller reads as a hold.
 */
export function parseGateBatchReply(
  text: string,
  ids: string[],
): Map<string, { decision: GateDecision; rationale: string }> | null {
  const parsed = extractJson<{ decisions?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.decisions)) return null;
  const known = new Set(ids);
  const out = new Map<string, { decision: GateDecision; rationale: string }>();
  for (const entry of parsed.decisions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const taskId = String(row['id'] ?? '').trim();
    if (!known.has(taskId) || out.has(taskId)) continue;
    const raw = String(row['decision'] ?? '').toLowerCase().trim();
    const decision: GateDecision | null =
      raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw === 'hold' ? 'hold' : null;
    const rationale = typeof row['rationale'] === 'string' ? row['rationale'].trim().slice(0, MAX_FIELD) : '';
    out.set(taskId, decision
      ? { decision, rationale }
      : { decision: 'hold', rationale: `the owner model did not answer the contract for this ticket: '${raw.slice(0, 60)}'` });
  }
  return out;
}

function parseGateReply(text: string): { decision: GateDecision; rationale: string } | null {
  const parsed = extractJson<{ decision?: unknown; rationale?: unknown }>(text);
  if (!parsed) return null;
  const raw = String(parsed.decision ?? '').toLowerCase().trim();
  const decision: GateDecision | null =
    raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw === 'hold' ? 'hold' : null;
  if (!decision) return null;
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim().slice(0, MAX_FIELD) : '';
  return { decision, rationale };
}

/**
 * Classes a playbook's `gate.hardHuman` list can name for this ticket: its
 * sensitivity, its kind, and its crew role — the role is how an investment
 * playbook keeps `ic-chair` decision tickets human-gated. `S2`, `allowCore`
 * and `budget` are listed by every seed playbook and are honoured here too,
 * but they never get this far: they are unconditional, playbook or not.
 */
function taskClasses(task: Task): Set<string> {
  const classes = new Set<string>([task.sensitivity.toLowerCase(), task.kind.toLowerCase()]);
  if (task.role) classes.add(task.role.toLowerCase());
  if (task.allowCore) classes.add('allowcore');
  return classes;
}

/**
 * Paths whose change a person approves, whatever else is in the diff: what a
 * repo installs and runs (manifests, shell, build and CI scripts), how git
 * itself treats the tree, and anything named for a security boundary. Matched
 * on the path alone, case-blind, at any depth — a nested package.json or a
 * scripts/ directory inside a package runs just as readily as the root one.
 */
export const HUMAN_ONLY_PATHS: readonly RegExp[] = [
  /(^|\/)(package\.json|package-lock\.json|Makefile|\.gitattributes|\.gitmodules)$/i,
  /\.sh$/i,
  // The directory, or an entry of that very name (a symlink standing in for it).
  /(^|\/)(scripts|\.github)(\/|$)/i,
  // Any segment, directory or file, that starts with one of these words.
  /(^|\/)(security|auth|trust|sandbox|crypto)/i,
];

/**
 * The name a case-insensitive macOS volume would open for this path. APFS and
 * HFS+ fold more than ASCII case: `pac\u212Aage.json` (KELVIN SIGN) is
 * package.json on disk, `\u017Fcripts/` (LONG S) is scripts/, `Make\uFB01le` is
 * Makefile — and git, which compares bytes, lists each as a different file.
 * NFKC maps all of those onto the ASCII letters; HFS+ also ignores the
 * zero-width and directional marks removed here.
 */
function foldedPath(file: string): string {
  return file.normalize('NFKC').replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

/** The first path a person must approve, or null. `extra` are the repo's own prefixes (settings `gate.humanPaths`). */
export function humanOnlyPath(paths: readonly string[], extra: readonly string[] = []): string | null {
  for (const raw of paths) {
    const file = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    // A name outside plain printable ASCII goes to a person outright: which
    // on-disk name a volume opens for it is the volume's rule, not NFKC's, and
    // no list of look-alikes is complete.
    if (/[^\x20-\x7E]/.test(file)) return raw;
    const forms = [...new Set([file, foldedPath(file)])];
    if (forms.some((f) => HUMAN_ONLY_PATHS.some((re) => re.test(f)) || extra.some((prefix) => f.startsWith(prefix)))) return raw;
  }
  return null;
}

/**
 * A repo's extra human-only prefixes, from the settings table. The value is
 * the operator's free text, so every shape that is not the documented one adds
 * nothing — and nothing here can take a built-in away.
 */
function repoHumanPaths(store: Store, repo: string | null): string[] {
  if (!repo) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getSetting('gate.humanPaths') ?? 'null');
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list) || (key !== repo && path.resolve(key) !== path.resolve(repo))) continue;
    for (const entry of list) {
      const prefix = typeof entry === 'string' ? entry.trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '') : '';
      if (prefix) out.push(prefix);
    }
  }
  return out;
}

/**
 * Reasons the owner gate must not decide at all. Checked before any model call
 * — a call that cannot change the outcome is money spent on nothing, and every
 * one of these parks for a person.
 *
 * The rule underneath all of them: the owner gate exists to skip rubber-stamping
 * work that already went green, never to overrule work that went red.
 */
export function hardHumanReason(
  task: Task,
  run: Run | null,
  opts: {
    provisional?: boolean; unruled?: boolean; unfiled?: boolean;
    /** The work merges into a repo on approval (reviewHolds). The landing rules below apply only then. */
    landing?: boolean;
    /** Paths in the run's diff; null (or absent) when no diff was recorded. */
    changed?: string[] | null;
    /** A code ticket in a repo whose latest run recorded no diff (reviewHolds): the scheduler's "nothing to change" park. */
    noChange?: boolean;
    /** The repo's own human-only prefixes, on top of HUMAN_ONLY_PATHS. */
    humanPaths?: string[];
    /** The run's crew review could not verify an acceptance item (reviewHolds, from the recorded status list). */
    unverified?: string | null;
    /** The run's diff removes or changes pre-existing assertions (reviewHolds, from the run's `assertions` artifact). */
    assertions?: string | null;
    /** Stands in for Foreman's own checkout in tests. */
    selfRoot?: string;
  } = {},
): string | null {
  if (task.sensitivity === 'S2') return 'S2 work is never shown to the hosted owner model';
  // Reviewed by stepped-down models because the full council did not fit: the
  // scheduler re-checks it once it does, and nothing signs it off before then.
  if (opts.provisional) return 'the review ran on stepped-down models and is provisional until the full council re-checks it';
  if (task.allowCore) return 'the ticket carries allowCore — a change to foreman itself is landed by a person';

  // The budget park (scheduler.ts, BudgetExceeded) is a decision for the
  // operator by construction. It is recognisable two ways and both are checked:
  // its note, and the fact that its run never ended in a clean pass.
  // The note may lead with the admission core-guard warning (Store.withCoreGuard).
  if (/^(core-guard: .*? \| )?budget hard-stop/i.test(task.error ?? '')) return 'the run stopped on a budget hard-stop';
  // The scheduler's other parks for a person, by their note (verify/gateOutcome.ts): a run that changed nothing,
  // a gate that timed out twice, a red gate on tests main has since changed. No reviewer read any of them, and a
  // verdict written later (a re-review) does not make one the owner model's to sign off.
  const parked = personPark(task.error);
  if (parked) return parked;
  if (!run) return 'there is no run to judge';
  if (run.status !== 'succeeded') return `the run ended '${run.status}', not in a clean pass`;
  if (run.testsPassed === false) return 'the checks failed';
  if (run.verdict === 'fail' || run.verdict === 'split') return `the review verdict was '${run.verdict}'`;
  if (run.verdict == null) return 'no review verdict was recorded — there is no green result to sign off';
  // Two reviewers disagreed and no chair ruled (it timed out, or answered
  // off-contract): the verdict that stood is one side's, not a decision.
  if (opts.unruled) return 'the reviewers disagreed and no chair ruled';
  if (opts.unfiled) return 'review issues could not be filed (epic depth/cap) — a person decides';
  // Whatever its allowCore, and whoever the house gate is: the owner model
  // never signs off a change to the program that runs it. Asked after the
  // checks above only because this one runs git.
  if (isSelfTask(task, opts.selfRoot)) return 'a change to foreman itself is landed by a person';

  const pb = task.playbook ? getPlaybook(task.playbook) : null;
  if (pb) {
    const classes = taskClasses(task);
    const hit = pb.gate.hardHuman.find((c) => classes.has(String(c).toLowerCase()));
    if (hit) return `playbook '${pb.id}' marks '${hit}' as hard-human`;
    // An explicit per-ticket opt-in beats the playbook default; FOREMAN_GATE
    // alone does not (see effectiveGate).
    if (pb.gate.default === 'human' && task.gate !== 'owner') {
      return `playbook '${pb.id}' gates on the human and this ticket did not opt in`;
    }
  }
  // Work that merges into a repo. The house default (and FOREMAN_GATE) is one
  // switch for every ticket in every repo; it is not a decision about this
  // one, and a model merged a playbook-less ticket on it seconds after it
  // parked. So a landing needs an opt-in somebody wrote for this ticket or its
  // domain, a test run that passed, and a diff that stays off the paths a
  // person approves. A ticket marked for the human has not opted in, whatever
  // its playbook says. Asked last, so every older reason above still names
  // itself: these rules only add holds, they never rename one.
  if (opts.landing) {
    const optedIn = task.gate === 'owner'
      || (task.gate !== 'human' && pb?.gate.default === 'owner');
    if (!optedIn) return 'work that lands in a repo is approved by a person unless the ticket or its playbook opted in';
    if (run.testsPassed !== true) return 'no test run passed for this work';
    if (!opts.changed || opts.changed.length === 0) return 'the run produced no diff to sign off';
    const touched = humanOnlyPath(opts.changed, opts.humanPaths);
    if (touched) return `the diff touches ${touched}, which a person approves`;
  }
  // The scheduler's "nothing to change" park by what is recorded, for when its note has been written over (a
  // full-council re-check clears it, a refused approval replaces it): a code run in a repo that recorded no diff
  // has nothing a reviewer could have read, whether or not the ticket lands. (A gate that timed out twice, or
  // failed on a stale jail, is held the same way by the run's `testsPassed`, above.) Asked last: it only adds a
  // hold where none of the older rules had one, and renames none of theirs.
  if (opts.noChange) return 'the run produced no change — a person decides whether that closes the ticket';
  // What the run's crew reviewer recorded, item by item, whatever a later verdict on the same run says: a chair or
  // a council re-review saw no more of the source than the reviewer that could not check the item.
  if (opts.unverified) return opts.unverified;
  // A test that was there before the run now checks less, or is gone. A ticket may mean that; only a person says so.
  if (opts.assertions) return opts.assertions;
  return null;
}

export interface OwnerGateOptions {
  task: Task;
  run: Run | null;
  store: Store;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The broker's ceiling; defaults to the same env the broker reads. */
  dailyCapUsd?: number;
  /** Re-asked when the owner answers: is this ticket still the owner gate's to decide? */
  stillEligible?: () => boolean;
  /** Stands in for Foreman's own checkout in tests (hardHumanReason). */
  selfRoot?: string;
}

/**
 * Owner-tier calls bypass the broker, so nothing else stops the gate lane from
 * spending past the daily cap. Returns the refusal text, or null to proceed.
 */
export function overDailyCap(store: Store, capUsd: number = dailyCapUsd()): string | null {
  // Two ceilings doing two jobs. The metered one protects real money. The
  // subscription one is far larger and exists only to stop a runaway loop —
  // a gate re-deciding the same ticket every tick costs a rate limit just as
  // fast as it would cost a card. Either being reached holds the ticket.
  if (capUsd > 0) {
    const spent = store.spentToday();
    if (spent >= capUsd) {
      return `budget: today's metered spend $${spent.toFixed(4)} has reached the $${capUsd.toFixed(2)} daily cap`;
    }
  }
  const subCap = subscriptionCapUsd();
  if (subCap > 0) {
    const sub = store.spentTodaySubscription();
    if (sub >= subCap) {
      return `budget: today's subscription usage $${sub.toFixed(2)} (list price) has reached the $${subCap.toFixed(2)} ceiling`;
    }
  }
  return null;
}

type GateLog = (decision: GateDecision, why: string, decided?: boolean) => GateDecision;

/**
 * The latest run left work behind that a desk close should point at: nobody
 * ruled on it (a run the operator or the owner gate rejected is not left over,
 * it is turned down), and its worktree is still on disk — an errored or
 * canceled-before-review attempt, or a prune, has already removed it.
 */
function leftOver(store: Store, run: Run | null): boolean {
  if (!run?.branch || !run.worktreePath || !fs.existsSync(run.worktreePath)) return false;
  const row = store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(run.id) as Record<string, unknown> | undefined;
  return row?.['decision'] == null;
}

/** git's C-style quoting undone: `scripts/\\303\\251.sh` -> `scripts/é.sh`. */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted[i]!;
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const octal = /^[0-7]{1,3}/.exec(quoted.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
    const next = quoted[++i] ?? '';
    bytes.push(...(next in named ? [named[next]!] : Buffer.from(next, 'utf8')));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The paths git had to quote in a patch header. git quotes any path holding a
 * non-ASCII byte (core.quotePath, on by default), a double quote, a backslash
 * or a control character, and pathsInDiff (improve.ts) reads bare headers
 * only — so a worker that names a file `.github/workflows/dé.yml` would
 * otherwise keep it out of the list the human-only rule reads.
 */
export function quotedPathsInDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    const head = /^(diff --git|---|\+\+\+|rename from|rename to|copy from|copy to) /.exec(line);
    if (!head || !line.includes('"')) continue;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const file = unquoteGitPath(m[1]!);
      const clean = /^(rename|copy)/.test(head[1]!) ? file : file.replace(/^[ab]\//, '');
      if (clean) paths.add(clean);
    }
  }
  return [...paths];
}

/** The longest patch header read. PATH_MAX is 1024 bytes here; quoted, twice over, a real header stays well under this. */
const MAX_HEADER_CHARS = 20_000;
const PATCH_HEADER = /^(diff --git|---|\+\+\+|rename from|rename to|copy from|copy to) /;
/**
 * Characters a header line cannot hold and still be read: the header patterns
 * (here and in improve.ts) match a path with `.`, which stops at CR, U+2028 and
 * U+2029. git prints the last two bare under `core.quotePath=false` — a config
 * the jail can write — and a header holding one matches no pattern at all, so
 * `.github/workflows/ci\u2028x.yml` was in the diff and in no list of paths.
 */
const HEADER_UNREADABLE = /[\r\u2028\u2029]/;

/**
 * Whether the text is git's plain patch, the only shape the header readers
 * understand. The jail can write the repo's git config, and `color.ui=always`
 * wraps every header in terminal escapes: with the default colours no header
 * is read at all, and with `color.diff.new=normal` an added line
 * `++ b/docs/ok.md` prints at column 0 as the only header there is — a diff
 * that adds a CI workflow then reads as one harmless path. In a plain patch no line starts with an escape (file
 * content is behind +, - or a space) and no header holds one (git quotes a
 * path that does, as \033). An over-long header line is refused rather than
 * read: the header patterns are quadratic on one.
 */
function plainPatch(diff: string): boolean {
  for (const line of diff.split('\n')) {
    if (line.startsWith('\x1b')) return false;
    if (PATCH_HEADER.test(line) && (line.length > MAX_HEADER_CHARS || line.includes('\x1b') || HEADER_UNREADABLE.test(line))) return false;
  }
  return true;
}

/** Paths in the diff artifact the task's latest run wrote; null when it wrote none, or it cannot be read. */
function changedPaths(store: Store, taskId: string): string[] | null {
  const run = store.latestRun(taskId);
  if (!run) return null;
  const artifact = store
    .artifactsForTask(taskId)
    .filter((a) => a.runId === run.id && a.type === 'diff')
    .pop();
  if (!artifact) return null;
  try {
    const diff = fs.readFileSync(artifact.path, 'utf8');
    if (!plainPatch(diff)) return null;
    return [...new Set([...pathsInDiff(diff), ...quotedPathsInDiff(diff)])];
  } catch {
    return null;
  }
}

/**
 * What the newest review says about who may sign the work off, and what the
 * work would land (hardHumanReason's inputs that need the Store).
 */
export function reviewHolds(store: Store, taskId: string): {
  provisional?: boolean; unruled?: boolean; unfiled?: boolean;
  changed: string[] | null; landing: boolean; humanPaths: string[]; noChange: boolean; unverified: string | null;
  assertions: string | null;
} {
  const verdicts = store.verdictsForTask(taskId);
  const v = verdicts[0];
  const task = store.getTask(taskId);
  const run = task ? store.latestRun(taskId) : null;
  return {
    assertions: assertionHold(store, run),
    // The newest crew review of the latest run, by its recorded status list — not the newest verdict of any kind.
    unverified: heldReason(run ? verdicts.find((x) => x.source === 'crew' && x.runId === run.id) : null),
    changed: changedPaths(store, taskId),
    // By the artifact, not by `changed`: a diff that was recorded and cannot be read is not "no change".
    noChange: task?.kind === 'code' && Boolean(task.repo) && run !== null
      && !store.artifactsForTask(taskId).some((a) => a.type === 'diff' && a.runId === run.id),
    landing: Boolean(task?.repo) && Boolean(task?.mergeOnApprove),
    humanPaths: repoHumanPaths(store, task?.repo ?? null),
    provisional: v?.provisional,
    unruled: Boolean(v?.disagreement) && !chairRuled(v ?? null),
    // Issues the reviewer raised that could not be filed: an approval writes
    // over the park note that names them, so no model signs that off.
    unfiled: droppedSinceLastPark(store, taskId).some(isCapDrop),
  };
}

/**
 * One ticket's timeline line plus the durable marker. Shared by the single and
 * the batched gate so a batched ticket leaves exactly the trail a solo one does.
 *
 * `decided: false` marks a deferral rather than a judgement: the ticket gets
 * its timeline line, but no durable marker, so the gate will look at it again
 * once the condition that deferred it (today's cap) has lifted.
 */
function gateLogger(store: Store, task: Task, run: Run | null, seen?: string | null): GateLog {
  return (decision, why, decided = true) => {
    store.record({
      taskId: task.id,
      runId: run?.id ?? null,
      type: decision === 'hold' ? 'status' : 'verdict',
      message: `owner-gate: ${decision} — ${why}`.slice(0, 1000),
    });
    // A hold records nothing durable once the work has moved on: the marker
    // would keep a newer parked run (or a decided ticket's retry) from its own
    // owner review. An approval or rejection has already checked that it is
    // about the run it read.
    const stillParked = store.getTask(task.id)?.status === 'awaiting-approval' && store.latestRun(task.id)?.id === run?.id
      && (seen === undefined || (store.verdictsForTask(task.id)[0]?.id ?? null) === seen);
    if (decided && (decision !== 'hold' || stillParked)) store.markGateDecision(task.id, decision);
    return decision;
  };
}

/**
 * Everything a decision DOES once the model has spoken. Both gates run this
 * exact function, so autonomy cannot quietly mean something different inside a
 * batch than it does on its own.
 */
async function applyGateReply(
  store: Store,
  task: Task,
  run: Run | null,
  seen: string | null,
  reply: { decision: GateDecision; rationale: string },
  log: GateLog,
  stillEligible?: () => boolean,
  selfRoot?: string,
): Promise<GateDecision> {
  const rationale = reply.rationale || '(no rationale given)';
  if (reply.decision === 'hold') return log('hold', rationale);

  // The ticket may have been decided by a person, cancelled or re-queued while
  // the model was thinking; decide() would throw, and it would be right to.
  // Neither hold is a decision about the work now parked, so neither leaves the
  // durable marker: a newer run must still get its own owner review.
  const current = store.getTask(task.id);
  if (current?.status !== 'awaiting-approval') {
    return log('hold', `task moved to ${current?.status ?? 'gone'} while the owner was deciding`, false);
  }
  // …or rejected, retried and parked AGAIN: the same status, different work.
  // The ruling is about the run the owner read, never a newer one.
  if (store.latestRun(task.id)?.id !== run?.id) {
    return log('hold', 'the work changed while the owner was deciding — the ruling was about an earlier run', false);
  }
  // …or re-reviewed, or handed to the human, on the same run: not the review
  // the owner was shown, or no longer the owner's call.
  // (The scheduler's eligibility covers the board's house-default switch and a
  // ticket reset to the default — not just a ticket set to 'human'.)
  const now = store.getTask(task.id)!;
  if ((store.verdictsForTask(task.id)[0]?.id ?? null) !== seen || now.gate === 'human'
      || (stillEligible && !stillEligible())
      || hardHumanReason(now, store.latestRun(task.id), { ...reviewHolds(store, task.id), selfRoot })) {
    return log('hold', 'the review or the gate changed while the owner was deciding', false);
  }

  const note = `${OWNER_GATE_NOTE} ${rationale}`.slice(0, 1000);
  if (reply.decision === 'approved') {
    if (approvals.shuttingDown) return log('hold', 'the daemon is shutting down; the ticket stays parked for the next start', false);
    const result = await applyApproval(store, task.id, { note, source: 'owner-gate', selfRoot });
    // Not the tree that was reviewed, or no tree on record: nothing landed and
    // the ticket is a person's now.
    if (!result.merge.merged && NOT_REVIEWED.test(result.merge.reason)) return log('hold', result.merge.reason);
    return log('approved', `${rationale}${result.merge.branch ? ` [merge: ${result.merge.reason}]` : ''}`);
  }
  applyRejection(store, task.id, note, 'owner-gate');
  return log('rejected', rationale);
}

/**
 * Opt-in autonomy: let the Owner model sign off one ticket that is already
 * parked at `awaiting-approval`.
 *
 * Safety shape: every uncertainty is a hold. A hard-human class, an unparseable
 * reply, an unreachable CLI, a decision on a task that has since moved — all of
 * them leave the ticket exactly where a human will find it, and say why in the
 * task's timeline.
 */
export async function ownerGate(opts: OwnerGateOptions): Promise<GateDecision> {
  const { task, run, store } = opts;
  // The review the owner is about to be shown; a different one by the time it
  // answers means its ruling is about something else.
  const seen = store.verdictsForTask(task.id)[0]?.id ?? null;
  const log = gateLogger(store, task, run, seen);

  if (task.status !== 'awaiting-approval') return log('hold', `task is ${task.status}, not awaiting-approval`);

  const blocked = hardHumanReason(task, run, { ...reviewHolds(store, task.id), selfRoot: opts.selfRoot });
  if (blocked) return log('hold', `hard-human: ${blocked}`);

  // The worktree is no longer the tree that was reviewed, or no tree was
  // recorded: the owner would be ruling on a diff that is not what would land.
  // Held before the call is paid for; applyApproval asks again when it answers.
  const unreviewed = await landingRefusal(task, run, { source: 'owner-gate', selfRoot: opts.selfRoot }).catch(() => null);
  if (unreviewed) return log('hold', unreviewed);

  // Defense in depth: the scheduler pre-checks the cap before it even queues a
  // gate, but ownerGate is callable directly and the spend is real money the
  // broker never sees.
  const broke = overDailyCap(store, opts.dailyCapUsd);
  if (broke) return log('hold', broke, false);

  const diff = runDiff(store, task, run);
  const prompt = buildGatePrompt(task, run, diff, verdictChain(store, task, run), run ? storedReport(store, run).text : null, storedRevertTestsNote(store, run));

  let text: string;
  try {
    const res = await ownerCall(prompt, {
      tier: 'owner',
      store,
      kind: 'gate',
      taskId: task.id,
      maxTurns: GATE_MAX_TURNS,
      timeoutMs: opts.timeoutMs ?? GATE_TIMEOUT_MS,
      signal: opts.signal,
    });
    text = res.text;
  } catch (err) {
    // A daemon stop mid-call is not the owner deciding to hold: no durable
    // marker, so the ticket is asked again after the restart.
    return log('hold', `the owner model could not be reached (${(err as Error).message.slice(0, 300)})`, !opts.signal?.aborted);
  }

  const reply = parseGateReply(text);
  if (!reply) return log('hold', `the owner model did not answer the contract: ${text.slice(0, 200)}`);
  return applyGateReply(store, task, run, seen, reply, log, opts.stillEligible, opts.selfRoot);
}

export interface GateBatchItem {
  task: Task;
  run: Run | null;
}

export interface OwnerGateBatchOptions {
  items: GateBatchItem[];
  store: Store;
  /** Where the single receipt is billed: the epic, or the first ticket. */
  billTo?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  dailyCapUsd?: number;
  /** Re-asked per ticket when the owner answers: is it still the owner gate's to decide? */
  stillEligible?: (taskId: string) => boolean;
  /** Stands in for Foreman's own checkout in tests (hardHumanReason). */
  selfRoot?: string;
}

/**
 * One owner call, up to GATE_BATCH_MAX tickets, one decision each.
 *
 * The saving is the call, never the scrutiny: every short-circuit is re-checked
 * per ticket before the prompt is built (a hard-human ticket is dropped from the
 * batch and parked exactly as it would have been alone), every decision is
 * applied through applyGateReply, and every ticket gets its own timeline line
 * and durable marker. Uncertainty still resolves to a hold, and it resolves
 * per ticket: an unknown id is ignored, a ticket the reply forgot is held, and
 * a reply that does not answer the contract at all holds the whole batch.
 */
export async function ownerGateBatch(opts: OwnerGateBatchOptions): Promise<Map<string, GateDecision>> {
  const { store } = opts;
  const out = new Map<string, GateDecision>();
  const eligible: Array<GateBatchItem & { log: GateLog; seen: string | null }> = [];

  // Per ticket, exactly as ownerGate checks it: batching changes who is asked
  // in one call, not who may be asked at all.
  for (const [i, item] of opts.items.entries()) {
    const seen = store.verdictsForTask(item.task.id)[0]?.id ?? null;
    const log = gateLogger(store, item.task, item.run, seen);
    // A caller handing us more than the cap gets explicit holds for the
    // overflow, never a silent drop — those tickets re-enter the next sweep.
    if (i >= GATE_BATCH_MAX) {
      out.set(item.task.id, log('hold', `batch full (max ${GATE_BATCH_MAX}); deferred to the next sweep`, false));
      continue;
    }
    if (item.task.status !== 'awaiting-approval') {
      out.set(item.task.id, log('hold', `task is ${item.task.status}, not awaiting-approval`));
      continue;
    }
    const blocked = hardHumanReason(item.task, item.run, { ...reviewHolds(store, item.task.id), selfRoot: opts.selfRoot });
    if (blocked) {
      out.set(item.task.id, log('hold', `hard-human: ${blocked}`));
      continue;
    }
    // As ownerGate: work that is not the reviewed tree is not put to the owner.
    const unreviewed = await landingRefusal(item.task, item.run, { source: 'owner-gate', selfRoot: opts.selfRoot }).catch(() => null);
    if (unreviewed) {
      out.set(item.task.id, log('hold', unreviewed));
      continue;
    }
    eligible.push({ ...item, log, seen });
  }
  if (!eligible.length) return out;

  // A batch of one is the single path: same prompt, same contract, same
  // receipt kind. Nothing about one ticket should depend on how it was found.
  const solo = eligible.length === 1 ? eligible[0]! : null;
  if (solo) {
    out.set(solo.task.id, await ownerGate({
      task: solo.task, run: solo.run, store,
      signal: opts.signal, timeoutMs: opts.timeoutMs, dailyCapUsd: opts.dailyCapUsd,
      stillEligible: opts.stillEligible ? () => opts.stillEligible!(solo.task.id) : undefined,
      selfRoot: opts.selfRoot,
    }));
    return out;
  }

  // Defense in depth, once for the call the batch is about to make.
  const broke = overDailyCap(store, opts.dailyCapUsd);
  if (broke) {
    for (const item of eligible) out.set(item.task.id, item.log('hold', broke, false));
    return out;
  }

  const prompt = buildBatchGatePrompt(eligible.map(({ task, run }) => ({
    task, run, diff: runDiff(store, task, run), chain: verdictChain(store, task, run), report: run ? storedReport(store, run).text : null,
    revert: storedRevertTestsNote(store, run),
  })));

  let text: string;
  try {
    const res = await ownerCall(prompt, {
      tier: 'owner',
      store,
      // Its own kind, so the ledger can tell one call that decided five tickets
      // from five calls that decided one each.
      kind: 'gate:batch',
      // Attributed once — to the epic these tickets share, or to the first of
      // them. Splitting a single call's cost N ways would invent numbers.
      taskId: opts.billTo ?? eligible[0]!.task.parentId ?? eligible[0]!.task.id,
      maxTurns: GATE_MAX_TURNS,
      timeoutMs: opts.timeoutMs ?? Math.min(GATE_TIMEOUT_MS * eligible.length, GATE_BATCH_TIMEOUT_MS),
      signal: opts.signal,
    });
    text = res.text;
  } catch (err) {
    const why = `the owner model could not be reached (${(err as Error).message.slice(0, 300)})`;
    // A daemon stop mid-call is no decision: asked again after the restart.
    for (const item of eligible) out.set(item.task.id, item.log('hold', why, !opts.signal?.aborted));
    return out;
  }

  const replies = parseGateBatchReply(text, eligible.map((item) => item.task.id));
  if (!replies) {
    const why = `the owner model did not answer the batch contract: ${text.slice(0, 200)}`;
    for (const item of eligible) out.set(item.task.id, item.log('hold', why));
    return out;
  }

  for (const item of eligible) {
    const reply = replies.get(item.task.id);
    out.set(item.task.id, reply
      ? await applyGateReply(store, item.task, item.run, item.seen, reply, item.log,
        opts.stillEligible ? () => opts.stillEligible!(item.task.id) : undefined, opts.selfRoot)
      : item.log('hold', 'the owner model gave no decision for this ticket in its batch reply'));
  }
  return out;
}

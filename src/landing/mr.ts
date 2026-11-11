import path from 'node:path';
import { config } from '../config.ts';
import { pinnedGit } from '../gitExec.ts';
import { prepareLandingCommit, type Approver, type MergeResult } from '../merge.ts';
import type { Store } from '../queue.ts';
import { isSelfTaskFresh } from '../security/coreGuard.ts';
import type { Run, Task } from '../types.ts';
import { projectRefusal, type Landing, type LandingMapping } from './config.ts';
import { ForgeError, type Forge, type MergeOutcome, type Mr } from './forge.ts';
import { forgeBranch, MirrorError } from './push.ts';
import { withRepoMergeSection } from './queue.ts';
import { checkMrLanding, type PostMergeRun } from './verify.ts';

/**
 * Landing by merge request: an approved ticket whose repo is mapped in landing.json (./config.ts) is not merged into
 * the operator's checkout. Its reviewed commit is pushed to foreman/<task id> through the Foreman-owned mirror
 * (./push.ts) and a merge request is opened on the forge (./forge.ts); the MR merges later, once its pipeline
 * passes (pollMergeRequests), and the checkout is then fast-forwarded to the merge and handed to the post-merge check
 * (./verify.ts). A change to Foreman itself always lands locally: the core guard is not delegated to a forge.
 *
 * The ticket stays `done` with its landing hold on and its durable landing marker open while its MR is pending; this
 * module's pending-MR table owns both from then on, until the checkout is synced (the post-merge check then ends the
 * hold) or the repo is held for the operator (Store.holdLanding). In memory only: a daemon that stops with an MR open
 * leaves the marker, and the next start holds the repo for the operator (Store.adoptInterruptedLandings).
 */

/** An MR opened for an approval, polled until its merge is synced into the checkout or the repo is held for the operator. */
export interface PendingMr {
  taskId: string;
  runId: string;
  /** The checkout's top level, as the mapping names it. */
  repo: string;
  /** The task's repo, as the ticket names it: the key of its merge section and its landing marker. */
  checkout: string;
  iid: number;
  /** The reviewed commit the MR's head is. */
  tip: string;
  /** Its tree, the reviewed tree. */
  tree: string;
  /** The durable landing marker (Store.openLanding) the MR holds open. */
  marker: number;
  openedAt: number;
}

/** The poller's own state for an entry. */
interface Entry extends PendingMr {
  polledAt: number;
  polling: boolean;
  /** Why the last poll waited; an event is recorded only when it changes. */
  waiting: string | null;
  /** The forge reported the MR merged: only the confirmation is waited for, and the timeout no longer applies. */
  forgeMerged: boolean;
  /** Foreman called merge and no read since showed the MR still open: it may have merged, so it is not dropped. */
  mergeCalled: boolean;
  /** Four-eyes for the approver as the ledger stands now (FourEyesRecheck), asked right before the merge call. */
  fourEyes: FourEyesRecheck;
  /** GitLab refused a merge while it reported mergeable (two merges into one target can collide): tried once more. */
  mergeRetried: boolean;
  /** Ends this MR's turn in its target's merge queue: set when its merge call is made, called once pollOne is done. */
  endTurn?: () => void;
}

/**
 * Four-eyes (security/fourEyes.ts recheck) for the approve decision's actor landing `task` as it reads now: null, or
 * why not. The approval path supplies it, since what the change touches is its to say.
 */
export type FourEyesRecheck = (task: Task) => Promise<string | null>;

let active: { landing: Landing; home: string } | null = null;
const pending = new Map<string, Entry>();

/** Set at daemon start from loadLanding (null: merge-request landing is off, and no MR is followed). */
export function useLanding(landing: Landing | null, home: string): void {
  active = landing ? { landing, home } : null;
  if (!landing) pending.clear();
}

export function pendingMrs(): PendingMr[] {
  return [...pending.values()];
}

/** The MR pending for `taskId`, if any. */
export function pendingMr(taskId: string): PendingMr | undefined {
  return pending.get(taskId);
}

/**
 * Who approved an MR landing, as Foreman's approve decision names them. GitLab shows the user of Foreman's token as
 * whoever merges; this is the person of record.
 */
export interface ApproverOfRecord {
  /** The decision's actor: '<name> (<principal id>)', or a reserved actor id such as 'operator'. */
  approver: string;
  /** Who created the ticket: a principal's name, else the id it records, else 'unknown'. */
  author: string;
  decisionId: string;
}

/**
 * Posts the approver of record on the task's pending MR as one note: the reviewed tree (saying it replaces any earlier
 * Foreman approval, since a reused MR keeps its older notes) and the Foreman-Approved-By,
 * Foreman-Author and Foreman-Decision trailers. A forge failure is a ForgeError.
 */
export async function noteApproval(taskId: string, record: ApproverOfRecord): Promise<void> {
  const mr = pending.get(taskId);
  const map = mr && active?.landing.mappings.find((m) => m.repo === mr.repo);
  if (!active || !mr || !map) throw new Error(`no merge request is pending for ${taskId}`);
  await active.landing.forge(map).addNote(map.project, mr.iid, [
    `Approved in Foreman at reviewed tree ${mr.tree}. This replaces any earlier Foreman approval on this request.`,
    '',
    `Foreman-Approved-By: ${record.approver}`,
    `Foreman-Author: ${record.author}`,
    `Foreman-Decision: ${record.decisionId}`,
  ].join('\n'));
}

/**
 * The mapping an approval of `task` lands through, or null when it lands locally: merge-request landing is off, the
 * checkout's top level is not mapped, or the task changes Foreman itself.
 */
export async function mrLandingFor(task: Task, selfRoot?: string): Promise<LandingMapping | null> {
  if (!active || !task.repo) return null;
  const top = (await pinnedGit(task.repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const map = active.landing.mappings.find((m) => m.repo === path.resolve(top));
  if (!map || (await isSelfTaskFresh(task, selfRoot))) return null;
  return map;
}

/**
 * Why a person may not record `task` as landed by hand (POST /landed, D6), or null when they may. A ticket whose repo
 * lands by merge request, and every ticket once auth is on, lands through its MR: the only hand landing recorded is of
 * the MR its latest MR-opening approval names (that decision's mrIid), merged on the forge with `commit` as its head
 * and that commit's tree the tree the approval reviewed. With auth off and the repo not mapped, nothing changes.
 */
export async function handLandingRefusal(store: Store, task: Task, commit: string, opts: { authOn: boolean; selfRoot: string | undefined }): Promise<string | null> {
  const refuse = (why: string): string => `cannot mark ${task.id} landed: this repo lands through its merge request (${why}); nothing was recorded`;
  let map: LandingMapping | null;
  try {
    map = await mrLandingFor(task, opts.selfRoot);
  } catch (err) {
    return refuse(`whether it lands by merge request could not be read: ${(err as Error).message}`);
  }
  if (!map || !active) return opts.authOn ? refuse('auth is on, and no forge is configured for it') : null;
  const approval = store.decisionsForTask(task.id).filter((d) => d.action === 'approve' && typeof d.extra?.['mrIid'] === 'number').at(-1);
  if (!approval) return refuse('no merge request was opened for it');
  const iid = approval.extra!['mrIid'] as number;
  // A name git cannot resolve is the refusal's answer, as markLanded gives it.
  const sha = (await pinnedGit(map.repo, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]).catch(() => null))?.stdout.trim();
  if (!sha) return refuse(`${commit} is not a commit in ${map.repo}`);
  let mr: Mr;
  try {
    mr = await active.landing.forge(map).getMr(map.project, iid);
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    return refuse(`the forge could not say whether !${iid} merged: ${err.message}`);
  }
  if (mr.state !== 'merged') return refuse(`!${iid} is ${mr.state}`);
  if (mr.headSha !== sha) return refuse(`the head of !${iid} is ${mr.headSha}, not ${sha}`);
  const tree = (await pinnedGit(map.repo, ['rev-parse', '--verify', `${sha}^{tree}`])).stdout.trim();
  if (tree !== approval.reviewedTree) return refuse(`the tree of ${sha} is ${tree}, not the reviewed tree ${approval.reviewedTree ?? '(none recorded)'}`);
  return null;
}

/** How long an approval that reuses an open MR waits for its head to read the pushed commit before refusing. */
const REUSED_HEAD_WAIT_MS = 30_000;

/**
 * The merge step of an approval in a mapped repo, inside the repo's merge section: check the project's merge settings
 * (projectRefusal), fetch the target branch, run every
 * landing check against it (prepareLandingCommit; a refusal comes back exactly as the local merge gives it), push the
 * checked commit, then find or open the MR and confirm its head is that commit (a reused MR's head is read again for up
 * to REUSED_HEAD_WAIT_MS, as GitLab refreshes it after a push in the background). 'mr-opened' puts the MR in the pending
 * table with `marker`; a forge or mirror failure is 'mr-refused', with the reason. Nothing merges here.
 */
export async function openForApproval(
  task: Task,
  run: Run | null,
  map: LandingMapping,
  opts: { marker: number; selfRoot?: string; fourEyes: FourEyesRecheck } & Approver,
): Promise<MergeResult> {
  if (!active) throw new Error('merge-request landing is not configured');
  const branch = run?.branch ?? null;
  const mirror = active.landing.mirror(map, active.home);
  const forge = active.landing.forge(map);
  try {
    // Asked on every approval: a project setting can change between two.
    const unsupported = projectRefusal(await forge.project(map.project));
    if (unsupported) return { merged: false, code: 'mr-refused', reason: `merge request not opened: ${map.project}: ${unsupported}`, branch };
    const target = await mirror.fetchTarget();
    const landing = await prepareLandingCommit(task, run, { ...opts, against: target });
    if ('code' in landing) return landing;
    const { tip, tipTree, note } = landing;
    await mirror.pushReviewed(tip, task.id);
    const sourceBranch = forgeBranch(task.id).slice('refs/heads/'.length);
    const reused = await forge.findOpenMr(map.project, sourceBranch, map.targetBranch);
    const opened = reused ?? await forge.openMr(map.project, {
      sourceBranch,
      targetBranch: map.targetBranch,
      title: mrTitle(task),
      // A reused MR keeps its description: the tree is named in each approval's note instead.
      description: `Foreman task ${task.id}\n\nThe reviewed tree is in the latest Foreman approval note.`,
    });
    let mr = await forge.getMr(map.project, opened.iid);
    // GitLab takes a push into an MR that was already open in a background job, so its head can lag for a while.
    for (const until = Date.now() + REUSED_HEAD_WAIT_MS; reused && mr.headSha !== tip && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 500));
      mr = await forge.getMr(map.project, opened.iid);
    }
    if (mr.headSha !== tip) {
      return { merged: false, code: 'mr-refused', reason: `the head of !${mr.iid} is ${mr.headSha}, not the reviewed commit ${tip}`, branch };
    }
    const wrong = notAsOpened(mr, map);
    if (wrong) return { merged: false, code: 'mr-refused', reason: wrong, branch };
    pending.set(task.id, {
      taskId: task.id, runId: run!.id, repo: map.repo, checkout: task.repo!, iid: mr.iid, tip, tree: tipTree, marker: opts.marker, openedAt: Date.now(),
      polledAt: 0, polling: false, waiting: null, forgeMerged: false, mergeCalled: false, mergeRetried: false,
      fourEyes: opts.fourEyes,
    });
    return { merged: false, code: 'mr-opened', reason: `opened !${mr.iid} ${mr.webUrl}`, branch, ...(note ? { note } : {}) };
  } catch (err) {
    if (!(err instanceof ForgeError) && !(err instanceof MirrorError)) throw err;
    return { merged: false, code: 'mr-refused', reason: `merge request not opened: ${err.message}`, branch };
  }
}

/**
 * The MR title: one line of at most 255 characters (GitLab refuses a longer one), led by the task id, so a ticket title
 * such as "Draft: ..." does not make GitLab open the MR as a draft, which never merges.
 */
function mrTitle(task: Task): string {
  return [...`Foreman ${task.id}: ${task.title.replace(/\s+/g, ' ').trim()}`].slice(0, 255).join('');
}

/**
 * Why `mr` is not an MR as Foreman opens it for `map` (into the mapped target, from the project's own branch, never
 * squashed), or null. Someone else may have opened the MR Foreman reuses, or edited it since.
 */
function notAsOpened(mr: Mr, map: LandingMapping): string | null {
  if (mr.targetBranch !== map.targetBranch) return `!${mr.iid} targets ${mr.targetBranch}, not ${map.targetBranch}`;
  if (mr.sourceProjectId !== mr.targetProjectId) return `!${mr.iid} is from another project (a fork)`;
  if (mr.squash) return `!${mr.iid} is set to squash`;
  return null;
}

/** GitLab detailed_merge_status words that change by themselves: a merge refused while one reads is retried. */
const TRANSIENT_MERGE_STATUS: ReadonlySet<string> = new Set(['checking', 'unchecked', 'ci_still_running', 'preparing', 'approvals_syncing']);

/** detailed_merge_status words only a new head can clear; the new head is not the reviewed commit, so waiting is no use. */
const NEEDS_NEW_HEAD: ReadonlySet<string> = new Set(['conflict', 'need_rebase']);

/** What one poll of an open MR decided. */
type Step = { wait: string } | { gate: string } | { confirm: string | null };

/**
 * The tick stage: each open MR not polled in the last FOREMAN_MR_POLL_MS is polled, one call at a time per MR, and
 * the tick does not wait for it. A ticket that left `done` (a person reopened, rejected or archived it) is dropped
 * here, before any call: its hold ends and its marker closes. Once the forge has merged, the merge is confirmed and
 * settled whatever the ticket's status, so the marker is never closed on a merge left unrecorded. A poll that throws
 * something other than a forge or mirror failure goes to `onError` and the MR is polled again next time. A confirmed
 * merge's post-merge check runs with `check`. Resolves when the polls started here end, their checks included.
 */
export function pollMergeRequests(store: Store, now: number, onError: (err: unknown) => void, check: PostMergeRun): Promise<void> {
  const started: Promise<void>[] = [];
  for (const mr of pending.values()) {
    if (mr.polling || now - mr.polledAt < config.mrPollMs) continue;
    if (left(store, mr)) continue;
    mr.polledAt = now;
    mr.polling = true;
    started.push(pollOne(store, mr, now, check).catch(onError).finally(() => { mr.polling = false; }));
  }
  // The forge calls of MRs let go (release) start by the time every poll ends.
  return Promise.all(started).then(() => Promise.all(releasing)).then(() => undefined);
}

/** Statuses a ticket does not come back from to land this MR: its MR is closed when it is let go. */
const GONE_FOR_GOOD: ReadonlySet<string> = new Set(['rejected', 'canceled', 'failed', 'gone']);

/** The forge calls (release) of MRs let go that have not ended yet. */
const releasing = new Set<Promise<void>>();

/**
 * An MR Foreman no longer follows gets one note saying so, so the earlier 'Approved in Foreman' note is not read as
 * standing, and is closed when its ticket is gone for good. A note or close the forge refuses is a warning. Not awaited
 * by the caller; pollMergeRequests waits for it.
 */
function release(store: Store, mr: Entry, note: string, close: boolean): void {
  const map = active?.landing.mappings.find((m) => m.repo === mr.repo);
  if (!active || !map) return;
  const forge = active.landing.forge(map);
  const done = (async () => {
    try {
      await forge.addNote(map.project, mr.iid, note);
      if (close) await forge.closeMr(map.project, mr.iid);
    } catch (err) {
      if (!(err instanceof ForgeError)) throw err;
      store.record({ taskId: mr.taskId, runId: mr.runId, type: 'warning', message: `merge request !${mr.iid} not marked as no longer approved${close ? ' and closed' : ''}: ${err.message}` });
    }
  })().catch(() => undefined).finally(() => releasing.delete(done));
  releasing.add(done);
}

/**
 * Drops `mr` when its ticket is no longer `done`, or a later approval replaced it; true when it did. An MR the forge
 * has merged, or may have merged (a merge call not answered), is kept whatever the ticket's status, so its merge is
 * confirmed and settled before its marker closes.
 */
function left(store: Store, mr: Entry): boolean {
  if (pending.get(mr.taskId) !== mr) return true;
  if (mr.forgeMerged || mr.mergeCalled) return false;
  const status = store.getTask(mr.taskId)?.status ?? 'gone';
  if (status === 'done') return false;
  pending.delete(mr.taskId);
  store.endLanding(mr.taskId);
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} no longer followed: the ticket is ${status}; no merge made by Foreman` });
  const close = GONE_FOR_GOOD.has(status);
  release(store, mr, `No longer approved in Foreman: the ticket is ${status}. Foreman will not merge this request${close ? ', and closes it' : ''}.`, close);
  return true;
}

async function pollOne(store: Store, mr: Entry, now: number, check: PostMergeRun): Promise<void> {
  try {
    await pollOnce(store, mr, now, check);
  } finally {
    endTurn(mr);
  }
}

/** Ends `mr`'s turn in its target's merge queue, if it has one, so the next merge into that target may start. */
function endTurn(mr: Entry): void {
  mr.endTurn?.();
  mr.endTurn = undefined;
}

async function pollOnce(store: Store, mr: Entry, now: number, check: PostMergeRun): Promise<void> {
  const map = active?.landing.mappings.find((m) => m.repo === mr.repo);
  if (!active || !map) throw new Error(`merge request !${mr.iid} of ${mr.taskId}: ${mr.repo} is no longer mapped for landing`);
  const forge = active.landing.forge(map);
  let step: Step;
  try {
    step = await decide(store, mr, forge, map);
    if ('confirm' in step) mr.forgeMerged = true;
    if ('confirm' in step && step.confirm !== null) {
      const ok = await active.landing.mirror(map, active.home).confirmMerge(step.confirm, mr.tip);
      if (!ok) step = { confirm: null };
    }
  } catch (err) {
    if (!(err instanceof ForgeError) && !(err instanceof MirrorError)) throw err;
    step = { wait: err.message };
  }
  if ('confirm' in step) return settle(store, mr, step.confirm, map, check);
  if (left(store, mr)) return;
  if ('gate' in step) return backToGate(store, mr, step.gate, forge, map.project);
  if (!mr.forgeMerged && !mr.mergeCalled && now - mr.openedAt >= config.mrTimeoutMin * 60_000) {
    return backToGate(store, mr, `merge request !${mr.iid} not merged within FOREMAN_MR_TIMEOUT_MIN (${config.mrTimeoutMin} min); last: ${step.wait}`, forge, map.project);
  }
  if (step.wait === mr.waiting) return;
  mr.waiting = step.wait;
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} waiting: ${step.wait}` });
}

/**
 * Reads the MR and merges it when it may be: its head is still the reviewed commit, it is still as Foreman opened it
 * (notAsOpened), its pipeline for that commit
 * passed (or none is required), GitLab calls it mergeable and four-eyes still lets the approver land it (the approver
 * may have been disabled while the pipeline ran). A merged MR is to be confirmed at its merge commit.
 */
async function decide(store: Store, mr: Entry, forge: Forge, map: LandingMapping): Promise<Step> {
  const { project, requirePipeline } = map;
  const seen = await forge.getMr(project, mr.iid);
  if (seen.state === 'merged') return { confirm: seen.mergeCommitSha };
  if (seen.state !== 'opened' && seen.state !== 'closed') return { wait: `the merge request is ${seen.state}` };
  // An open or closed MR shows that no merge call of Foreman's merged it.
  mr.mergeCalled = false;
  if (seen.state === 'closed') return { gate: `merge request !${mr.iid} was closed on the forge` };
  if (seen.headSha !== mr.tip) return { gate: `MR head moved after review: !${mr.iid} is at ${seen.headSha}, not ${mr.tip}` };
  const wrong = notAsOpened(seen, map);
  if (wrong) return { gate: wrong };
  const pipeline = seen.pipeline?.sha === mr.tip ? seen.pipeline : null;
  if (pipeline && (pipeline.status === 'failed' || pipeline.status === 'canceled')) {
    return { gate: `the pipeline of !${mr.iid} ${pipeline.status}: ${pipeline.webUrl}` };
  }
  if (requirePipeline && pipeline?.status !== 'success') return { wait: pipelineWait(seen) };
  if (NEEDS_NEW_HEAD.has(seen.mergeStatus)) {
    return { gate: `GitLab reports ${seen.mergeStatus}: the merge request conflicts with ${map.targetBranch} or needs a rebase; rework it, then approve again` };
  }
  if (seen.mergeStatus !== 'mergeable') return { wait: `GitLab reports ${seen.mergeStatus}` };
  // Merges into one target branch go one at a time: GitLab can refuse two that overlap. The ticket, the repo hold and
  // four-eyes are read in the merge's turn, so waiting behind another merge does not stretch the recheck's age. A turn
  // that makes a merge call lasts until pollOne has confirmed and synced that merge, or held the repo for it.
  const out = await oneMergeAtATime(`${project}\0${map.targetBranch}`, async (extend): Promise<Step | MergeOutcome> => {
    // A person may have reopened the ticket while the MR was read or the merge waited its turn.
    if (left(store, mr)) return { wait: 'the ticket left done' };
    // left() saw the ticket `done`, so it exists.
    const refused = await mr.fourEyes(store.getTask(mr.taskId)!);
    if (refused !== null) return { gate: `four-eyes: ${refused}` };
    // Or while four-eyes was asked (it awaits a git diff): nothing awaits between these checks and the merge call.
    if (left(store, mr)) return { wait: 'the ticket left done' };
    // The merge it waited behind may have held the repo (not confirmed, or not synced).
    if (store.landInterrupted(mr.checkout)) return { wait: 'the repo is held until foreman land-clear' };
    extend(new Promise<void>((resolve) => { mr.endTurn = resolve; }));
    mr.mergeCalled = true;
    return forge.merge(project, mr.iid, mr.tip).catch((err: unknown) => {
      // A 4xx is GitLab's answer that nothing merged, so the timeout applies again; no answer, or a server error, may
      // hide a merge, and keeps the MR until a read shows it open.
      if (err instanceof ForgeError && err.status !== null && err.status >= 400 && err.status < 500) mr.mergeCalled = false;
      throw err;
    });
  });
  if (!('merged' in out)) return out;
  mr.mergeCalled = false;
  if (out.merged) return { confirm: out.mergeCommitSha };
  if (out.reason === 'head-moved') return { gate: `MR head moved after review: ${out.detail}` };
  if (out.reason === 'not-mergeable') {
    const now = (await forge.getMr(project, mr.iid)).mergeStatus;
    if (TRANSIENT_MERGE_STATUS.has(now)) return { wait: `GitLab reports ${now}` };
    if (now === 'mergeable' && !mr.mergeRetried) {
      mr.mergeRetried = true;
      return { wait: 'GitLab refused the merge while reporting mergeable; trying once more' };
    }
  }
  return { gate: `GitLab did not merge !${mr.iid}: ${out.detail}` };
}

/** The tail of the merge calls queued for each "project\0target branch". */
const mergeQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `call` after every turn queued before it for `key` has ended. A turn ends when `call` settles, or later, when
 * the promise `call` hands to `extend` settles.
 */
function oneMergeAtATime<T>(key: string, call: (extend: (until: Promise<void>) => void) => Promise<T>): Promise<T> {
  let until: Promise<void> = Promise.resolve();
  const turn = (mergeQueues.get(key) ?? Promise.resolve()).then(() => call((p) => { until = p; }));
  const tail = turn.then(() => until, () => until).catch(() => undefined);
  mergeQueues.set(key, tail);
  void tail.then(() => { if (mergeQueues.get(key) === tail) mergeQueues.delete(key); });
  return turn;
}

function pipelineWait(mr: Mr): string {
  if (!mr.pipeline) return 'no pipeline yet';
  return mr.pipeline.sha === mr.headSha ? `pipeline ${mr.pipeline.status}` : 'the pipeline is for another commit';
}

/**
 * A merged MR: confirmed (`merged` is the merge commit, on the target with the reviewed commit as its second parent),
 * the checkout is synced to it inside the repo's merge section, its marker closes and the merge goes to its post-merge
 * check, which ends the landing hold. Not confirmed (null), or not synced, the repo is held for the operator with the
 * hold and the marker (Store.holdLanding). A ticket that left `done` meanwhile is warned of.
 */
async function settle(store: Store, mr: Entry, merged: string | null, map: LandingMapping, check: PostMergeRun): Promise<void> {
  const status = store.getTask(mr.taskId)?.status ?? 'gone';
  if (status !== 'done') {
    store.record({ taskId: mr.taskId, runId: mr.runId, type: 'warning', message: `merge request !${mr.iid} merged on the forge while the ticket is ${status}` });
  }
  if (merged === null) return hold(store, mr, `merge request !${mr.iid} merged, but the merged commit is not the reviewed commit ${mr.tip}`);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merged !${mr.iid} at ${merged}` });
  const unsynced = await withRepoMergeSection(mr.checkout, () => syncCheckout(store, mr, map, merged))
    .catch((err: Error) => `checkout not synced to ${merged}: ${err.message.slice(0, 300)}`);
  if (unsynced !== null) return hold(store, mr, `merge request !${mr.iid} merged at ${merged}, but ${unsynced}`);
  pending.delete(mr.taskId);
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `checkout synced to ${merged}` });
  // Confirmed and synced: the next merge into the target need not wait for the post-merge check.
  endTurn(mr);
  await checkMrLanding(store, { taskId: mr.taskId, runId: mr.runId, mergeHead: merged, reason: `merged !${mr.iid} at ${merged}` }, check);
}

/**
 * Fast-forwards the checkout to `merged`: imported from the mirror (no URL is resolved in the task repo), then merged
 * by sha, only when the repo is not held, the checkout is on the target branch and clean. Null, or why not.
 */
async function syncCheckout(store: Store, mr: Entry, map: LandingMapping, merged: string): Promise<string | null> {
  if (!active) throw new Error('merge-request landing is not configured');
  if (store.landInterrupted(mr.checkout)) return 'the repo is held for an earlier landing';
  await active.landing.mirror(map, active.home).importCommit(merged);
  const head = await pinnedGit(mr.checkout, ['symbolic-ref', '--quiet', 'HEAD']).then((r) => r.stdout.trim(), (err: { code?: unknown }) => {
    // Exit 1: HEAD is detached.
    if (err.code === 1) return null;
    throw err;
  });
  if (head !== `refs/heads/${map.targetBranch}`) return `checkout not on ${map.targetBranch}`;
  if ((await pinnedGit(mr.checkout, ['status', '--porcelain'])).stdout.trim()) return 'checkout dirty';
  await pinnedGit(mr.checkout, ['merge', '--ff-only', '--quiet', merged]);
  return null;
}

/** The repo is held for the operator with the task's hold and marker (Store.holdLanding), and the entry is let go. */
function hold(store: Store, mr: Entry, reason: string): void {
  pending.delete(mr.taskId);
  store.holdLanding(mr.checkout, mr.taskId, reason, mr.marker);
}

/**
 * The MR will not merge as reviewed: the ticket goes back to awaiting-approval with the reason, and is let go. The MR
 * gets one note saying why (a note the forge refuses is a warning) and stays open, so approving again reuses it.
 */
async function backToGate(store: Store, mr: Entry, reason: string, forge: Forge, project: string): Promise<void> {
  pending.delete(mr.taskId);
  store.setStatus(mr.taskId, 'awaiting-approval', store.withCoreGuard(mr.taskId, `approved, but not landed: ${reason} — resolve it, then approve again`));
  store.endLanding(mr.taskId);
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} back to the gate: ${reason}` });
  try {
    await forge.addNote(project, mr.iid, `Not merged by Foreman: ${reason}. The ticket is back at the gate in Foreman, so this request is no longer approved there.`);
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    store.record({ taskId: mr.taskId, runId: mr.runId, type: 'warning', message: `merge request note giving why !${mr.iid} was not merged not posted: ${err.message}` });
  }
}

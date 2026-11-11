import path from 'node:path';
import { config } from '../config.ts';
import { pinnedGit } from '../gitExec.ts';
import { prepareLandingCommit, type Approver, type MergeResult } from '../merge.ts';
import type { Store } from '../queue.ts';
import { isSelfTaskFresh } from '../security/coreGuard.ts';
import type { Run, Task } from '../types.ts';
import type { Landing, LandingMapping } from './config.ts';
import { ForgeError, type Forge, type Mr } from './forge.ts';
import { forgeBranch, MirrorError } from './push.ts';

/**
 * Landing by merge request: an approved ticket whose repo is mapped in landing.json (./config.ts) is not merged into
 * the operator's checkout. Its reviewed commit is pushed to foreman/<task id> through the Foreman-owned mirror
 * (./push.ts) and a merge request is opened on the forge (./forge.ts); the MR merges later (LD-MR7a), once its
 * pipeline passes (pollMergeRequests). A change to Foreman itself always lands locally: the core guard is not
 * delegated to a forge.
 *
 * The ticket stays `done` with its landing hold on and its durable landing marker open while its MR is pending; this
 * module's pending-MR table owns both from then on. In memory only: a daemon that stops with an MR open leaves the
 * marker, and the next start holds the repo for the operator (Store.adoptInterruptedLandings).
 */

/** An MR opened for an approval and not merged yet. */
export interface PendingMr {
  taskId: string;
  runId: string;
  /** The checkout's top level, as the mapping names it. */
  repo: string;
  iid: number;
  /** The reviewed commit the MR's head is. */
  tip: string;
  /** Its tree, the reviewed tree. */
  tree: string;
  /** The durable landing marker (Store.openLanding) the MR holds open. */
  marker: number;
  openedAt: number;
  /**
   * 'open' while it is polled; 'merged' once the forge merged it and the mirror confirmed the merge commit `merged`
   * (the checkout is not synced to it yet, so the landing hold stays on); 'held' when the forge's merge commit is not
   * the reviewed commit, which keeps the hold and the marker for the operator.
   */
  phase: 'open' | 'merged' | 'held';
  merged: string | null;
}

/** The poller's own state for an entry. */
interface Entry extends PendingMr {
  polledAt: number;
  polling: boolean;
  /** Why the last poll waited; an event is recorded only when it changes. */
  waiting: string | null;
  /** The forge reported the MR merged: only the confirmation is waited for, and the timeout no longer applies. */
  forgeMerged: boolean;
}

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
 * Who approved an MR landing, as Foreman's approve decision names them. GitLab shows the cell's service account as
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
 * Posts the approver of record on the task's pending MR as one note: the reviewed tree and the Foreman-Approved-By,
 * Foreman-Author and Foreman-Decision trailers. A forge failure is a ForgeError.
 */
export async function noteApproval(taskId: string, record: ApproverOfRecord): Promise<void> {
  const mr = pending.get(taskId);
  const map = mr && active?.landing.mappings.find((m) => m.repo === mr.repo);
  if (!active || !mr || !map) throw new Error(`no merge request is pending for ${taskId}`);
  await active.landing.forge(map).addNote(map.project, mr.iid, [
    `Approved in Foreman at reviewed tree ${mr.tree}.`,
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
 * The merge step of an approval in a mapped repo, inside the repo's merge section: fetch the target branch, run every
 * landing check against it (prepareLandingCommit; a refusal comes back exactly as the local merge gives it), push the
 * checked commit, then find or open the MR and confirm its head is that commit. 'mr-opened' puts the MR in the pending
 * table with `marker`; a forge or mirror failure is 'mr-refused', with the reason. Nothing merges here.
 */
export async function openForApproval(
  task: Task,
  run: Run | null,
  map: LandingMapping,
  opts: { marker: number; selfRoot?: string } & Approver,
): Promise<MergeResult> {
  if (!active) throw new Error('merge-request landing is not configured');
  const branch = run?.branch ?? null;
  const mirror = active.landing.mirror(map, active.home);
  const forge = active.landing.forge(map);
  try {
    const target = await mirror.fetchTarget();
    const landing = await prepareLandingCommit(task, run, { ...opts, against: target });
    if ('code' in landing) return landing;
    const { tip, tipTree, note } = landing;
    await mirror.pushReviewed(tip, task.id);
    const sourceBranch = forgeBranch(task.id).slice('refs/heads/'.length);
    const opened = await forge.findOpenMr(map.project, sourceBranch) ?? await forge.openMr(map.project, {
      sourceBranch,
      targetBranch: map.targetBranch,
      title: task.title,
      description: `Foreman task ${task.id}\n\nReviewed tree ${tipTree}`,
    });
    const mr = await forge.getMr(map.project, opened.iid);
    if (mr.headSha !== tip) {
      return { merged: false, code: 'mr-refused', reason: `the head of !${mr.iid} is ${mr.headSha}, not the reviewed commit ${tip}`, branch };
    }
    pending.set(task.id, {
      taskId: task.id, runId: run!.id, repo: map.repo, iid: mr.iid, tip, tree: tipTree, marker: opts.marker, openedAt: Date.now(),
      phase: 'open', merged: null, polledAt: 0, polling: false, waiting: null, forgeMerged: false,
    });
    return { merged: false, code: 'mr-opened', reason: `opened !${mr.iid} ${mr.webUrl}`, branch, ...(note ? { note } : {}) };
  } catch (err) {
    if (!(err instanceof ForgeError) && !(err instanceof MirrorError)) throw err;
    return { merged: false, code: 'mr-refused', reason: `merge request not opened: ${err.message}`, branch };
  }
}

/** GitLab detailed_merge_status words that change by themselves: a merge refused while one reads is retried. */
const TRANSIENT_MERGE_STATUS: ReadonlySet<string> = new Set(['checking', 'unchecked', 'ci_still_running', 'preparing', 'approvals_syncing']);

/** What one poll of an open MR decided. */
type Step = { wait: string } | { gate: string } | { confirm: string | null };

/**
 * The tick stage: each open MR not polled in the last FOREMAN_MR_POLL_MS is polled, one call at a time per MR, and
 * the tick does not wait for it. A ticket that left `done` (a person reopened, rejected or archived it) is dropped
 * here, before any call: its hold ends and its marker closes. Once the forge has merged, the merge is confirmed and
 * settled whatever the ticket's status, so the marker is never closed on a merge left unrecorded. A poll that throws something other than a forge or
 * mirror failure goes to `onError` and the MR is polled again next time. Resolves when the polls started here end.
 */
export function pollMergeRequests(store: Store, now: number, onError: (err: unknown) => void): Promise<void> {
  const started: Promise<void>[] = [];
  for (const mr of pending.values()) {
    if (mr.phase !== 'open' || mr.polling || now - mr.polledAt < config.mrPollMs) continue;
    if (left(store, mr)) continue;
    mr.polledAt = now;
    mr.polling = true;
    started.push(pollOne(store, mr, now).catch(onError).finally(() => { mr.polling = false; }));
  }
  return Promise.all(started).then(() => undefined);
}

/**
 * Drops `mr` when its ticket is no longer `done`, or a later approval replaced it; true when it did. An MR the forge
 * has merged is kept whatever the ticket's status, so its merge is confirmed and settled before its marker closes.
 */
function left(store: Store, mr: Entry): boolean {
  if (pending.get(mr.taskId) !== mr) return true;
  if (mr.forgeMerged) return false;
  const status = store.getTask(mr.taskId)?.status ?? 'gone';
  if (status === 'done') return false;
  pending.delete(mr.taskId);
  store.endLanding(mr.taskId);
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} no longer followed: the ticket is ${status}; no merge made by Foreman` });
  return true;
}

async function pollOne(store: Store, mr: Entry, now: number): Promise<void> {
  const map = active?.landing.mappings.find((m) => m.repo === mr.repo);
  if (!active || !map) throw new Error(`merge request !${mr.iid} of ${mr.taskId}: ${mr.repo} is no longer mapped for landing`);
  const forge = active.landing.forge(map);
  let step: Step;
  try {
    step = await decide(store, mr, forge, map.project, map.requirePipeline);
    if ('confirm' in step) mr.forgeMerged = true;
    if ('confirm' in step && step.confirm !== null) {
      const ok = await active.landing.mirror(map, active.home).confirmMerge(step.confirm, mr.tip);
      if (!ok) step = { confirm: null };
    }
  } catch (err) {
    if (!(err instanceof ForgeError) && !(err instanceof MirrorError)) throw err;
    step = { wait: err.message };
  }
  if ('confirm' in step) return settle(store, mr, step.confirm);
  if (left(store, mr)) return;
  if ('gate' in step) return backToGate(store, mr, step.gate);
  if (!mr.forgeMerged && now - mr.openedAt >= config.mrTimeoutMin * 60_000) {
    return backToGate(store, mr, `merge request !${mr.iid} not merged within FOREMAN_MR_TIMEOUT_MIN (${config.mrTimeoutMin} min); last: ${step.wait}`);
  }
  if (step.wait === mr.waiting) return;
  mr.waiting = step.wait;
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} waiting: ${step.wait}` });
}

/**
 * Reads the MR and merges it when it may be: its head is still the reviewed commit, its pipeline for that commit
 * passed (or none is required) and GitLab calls it mergeable. A merged MR is to be confirmed at its merge commit.
 */
async function decide(store: Store, mr: Entry, forge: Forge, project: string, requirePipeline: boolean): Promise<Step> {
  const seen = await forge.getMr(project, mr.iid);
  if (seen.state === 'merged') return { confirm: seen.mergeCommitSha };
  if (seen.state === 'closed') return { gate: `merge request !${mr.iid} was closed on the forge` };
  if (seen.state !== 'opened') return { wait: `the merge request is ${seen.state}` };
  if (seen.headSha !== mr.tip) return { gate: `MR head moved after review: !${mr.iid} is at ${seen.headSha}, not ${mr.tip}` };
  const pipeline = seen.pipeline?.sha === mr.tip ? seen.pipeline : null;
  if (pipeline && (pipeline.status === 'failed' || pipeline.status === 'canceled')) {
    return { gate: `the pipeline of !${mr.iid} ${pipeline.status}: ${pipeline.webUrl}` };
  }
  if (requirePipeline && pipeline?.status !== 'success') return { wait: pipelineWait(seen) };
  if (seen.mergeStatus !== 'mergeable') return { wait: `GitLab reports ${seen.mergeStatus}` };
  // A person may have reopened the ticket while the MR was read.
  if (left(store, mr)) return { wait: 'the ticket left done' };
  const out = await forge.merge(project, mr.iid, mr.tip);
  if (out.merged) return { confirm: out.mergeCommitSha };
  if (out.reason === 'head-moved') return { gate: `MR head moved after review: ${out.detail}` };
  if (out.reason === 'not-mergeable') {
    const now = (await forge.getMr(project, mr.iid)).mergeStatus;
    if (TRANSIENT_MERGE_STATUS.has(now)) return { wait: `GitLab reports ${now}` };
  }
  return { gate: `GitLab did not merge !${mr.iid}: ${out.detail}` };
}

function pipelineWait(mr: Mr): string {
  if (!mr.pipeline) return 'no pipeline yet';
  return mr.pipeline.sha === mr.headSha ? `pipeline ${mr.pipeline.status}` : 'the pipeline is for another commit';
}

/**
 * A merged MR: confirmed (`merged` is the merge commit, on the target with the reviewed commit as its second parent),
 * its marker closes and it waits for the checkout sync with the landing hold on; not confirmed (null), the hold and
 * the marker stay, so the next start holds the repo for the operator. A ticket that left `done` meanwhile is warned of.
 */
function settle(store: Store, mr: Entry, merged: string | null): void {
  const status = store.getTask(mr.taskId)?.status ?? 'gone';
  if (status !== 'done') {
    store.record({ taskId: mr.taskId, runId: mr.runId, type: 'warning', message: `merge request !${mr.iid} merged on the forge while the ticket is ${status}` });
  }
  if (merged === null) {
    mr.phase = 'held';
    store.record({
      taskId: mr.taskId, runId: mr.runId, type: 'warning',
      message: `merge request !${mr.iid} merged, but the merged commit is not the reviewed commit ${mr.tip}; its dependents stay held`,
    });
    return;
  }
  mr.phase = 'merged';
  mr.merged = merged;
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merged !${mr.iid} at ${merged}; checkout sync pending` });
}

/** The MR will not merge as reviewed: the ticket goes back to awaiting-approval with the reason, and is let go. */
function backToGate(store: Store, mr: Entry, reason: string): void {
  pending.delete(mr.taskId);
  store.setStatus(mr.taskId, 'awaiting-approval', store.withCoreGuard(mr.taskId, `approved, but not landed: ${reason} — resolve it, then approve again`));
  store.endLanding(mr.taskId);
  store.closeLanding(mr.marker);
  store.record({ taskId: mr.taskId, runId: mr.runId, type: 'status', message: `merge request !${mr.iid} back to the gate: ${reason}` });
}

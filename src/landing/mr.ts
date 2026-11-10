import path from 'node:path';
import { pinnedGit } from '../gitExec.ts';
import { prepareLandingCommit, type Approver, type MergeResult } from '../merge.ts';
import { isSelfTaskFresh } from '../security/coreGuard.ts';
import type { Run, Task } from '../types.ts';
import type { Landing, LandingMapping } from './config.ts';
import { ForgeError } from './forge.ts';
import { forgeBranch, MirrorError } from './push.ts';

/**
 * Landing by merge request: an approved ticket whose repo is mapped in landing.json (./config.ts) is not merged into
 * the operator's checkout. Its reviewed commit is pushed to foreman/<task id> through the Foreman-owned mirror
 * (./push.ts) and a merge request is opened on the forge (./forge.ts); the MR merges later (LD-MR7a), once its
 * pipeline passes. A change to Foreman itself always lands locally: the core guard is not delegated to a forge.
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
  /** The durable landing marker (Store.openLanding) the MR holds open. */
  marker: number;
  openedAt: number;
}

let active: { landing: Landing; home: string } | null = null;
const pending = new Map<string, PendingMr>();

/** Set at daemon start from loadLanding (null: merge-request landing is off). */
export function useLanding(landing: Landing | null, home: string): void {
  active = landing ? { landing, home } : null;
}

export function pendingMrs(): PendingMr[] {
  return [...pending.values()];
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
    pending.set(task.id, { taskId: task.id, runId: run!.id, repo: map.repo, iid: mr.iid, tip, marker: opts.marker, openedAt: Date.now() });
    return { merged: false, code: 'mr-opened', reason: `opened !${mr.iid} ${mr.webUrl}`, branch, ...(note ? { note } : {}) };
  } catch (err) {
    if (!(err instanceof ForgeError) && !(err instanceof MirrorError)) throw err;
    return { merged: false, code: 'mr-refused', reason: `merge request not opened: ${err.message}`, branch };
  }
}

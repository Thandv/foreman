/**
 * The forge port: what merge-request landing needs from a code host, and
 * nothing about when to land. src/landing/gitlab.ts implements it over GitLab's
 * REST v4; another host goes behind the same port. Whether to wait on a
 * transient state or give a ticket back is the caller's decision.
 *
 * A projectRef is the host's path for the project ("group/app").
 */

export type MrState = 'opened' | 'merged' | 'closed' | 'locked';

export interface ForgeProject {
  defaultBranch: string;
  /** The host's merge method, as it names it ('merge', 'rebase_merge', 'ff'). */
  mergeMethod: string;
}

export interface MrPipeline {
  sha: string;
  /** The host's pipeline status, as it names it ('running', 'success', 'failed', ...). */
  status: string;
  webUrl: string;
}

export interface Mr {
  iid: number;
  state: MrState;
  /** The source branch head the host sees now. */
  headSha: string;
  /** The host's own mergeability word (GitLab's detailed_merge_status: 'mergeable', 'checking', 'ci_still_running', ...). */
  mergeStatus: string;
  pipeline: MrPipeline | null;
  mergeCommitSha: string | null;
  webUrl: string;
}

export interface NewMr {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

/**
 * head-moved: the source branch is no longer the sha asked for, so nothing was
 * merged. not-mergeable: the host will not merge it now (pipeline, conflicts,
 * a transient check). refused: the host does not allow this caller to merge.
 */
export type MergeOutcome =
  | { merged: true; mergeCommitSha: string }
  | { merged: false; reason: 'head-moved' | 'not-mergeable' | 'refused'; detail: string };

export interface Forge {
  project(projectRef: string): Promise<ForgeProject>;
  /** The one open MR from `sourceBranch`, or null. */
  findOpenMr(projectRef: string, sourceBranch: string): Promise<Mr | null>;
  /** Opens an MR that removes its source branch on merge and never squashes. */
  openMr(projectRef: string, mr: NewMr): Promise<Mr>;
  getMr(projectRef: string, iid: number): Promise<Mr>;
  /** Merges only if the source branch head is still `sha`. */
  merge(projectRef: string, iid: number, sha: string): Promise<MergeOutcome>;
}

/** A forge call that failed or answered something unexpected. `status` is the HTTP status when there was one. */
export class ForgeError extends Error {
  override readonly name = 'ForgeError';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

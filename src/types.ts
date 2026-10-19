export type TaskKind = 'code' | 'writing' | 'research' | 'general' | 'tool';
export type RunnerId = 'echo' | 'shell' | 'claude-code' | 'codex-cli' | 'api';
export type Sensitivity = 'S0' | 'S1' | 'S2';
/** Who signs off at the gate: the operator, or the Owner model (Phase 6). */
export type GateMode = 'human' | 'owner';

/**
 * Who does the WORK — distinct from `GateMode`, which is only who signs it off.
 * `ai` dispatches the task to a runner as usual. `human` never dispatches it at
 * all: the task parks at `awaiting-human` and waits for the operator to do the
 * work themselves and close it. Default is `ai`; see assign.ts for resolution.
 */
export type Assignee = 'ai' | 'human';

/**
 * Terminal statuses are `done`, `failed`, `rejected`, `canceled`.
 * `blocked` means an unmet DAG dependency; the scheduler promotes it to
 * `queued` once every dependency reaches `done`.
 * `awaiting-human` means the task is assigned to the operator: no runner will
 * ever claim it, and it leaves that state only when a human closes it.
 */
export type TaskStatus =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'verifying'
  | 'awaiting-approval'
  | 'awaiting-human'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'canceled';

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'rejected', 'canceled'];

/** Ordered stage rail; the board renders these left-to-right. */
export const STAGES = ['admit', 'isolate', 'plan', 'work', 'test', 'verify', 'gate'] as const;
export type Stage = (typeof STAGES)[number];

export interface Task {
  id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  repo: string | null;
  agent: string | null;
  runner: RunnerId;
  sensitivity: Sensitivity;
  budgetUsd: number | null;
  priority: number;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  /** Command that must pass in the jail before a code task can be gated. */
  testCmd: string | null;
  mergeOnApprove: boolean;
  /** Critic feedback carried into a repair round. */
  repairNotes: string | null;
  /**
   * What a human demanded when they rejected an attempt at the gate. Unlike
   * repairNotes, which each repair round overwrites with the latest critique,
   * these persist for the life of the ticket: they are acceptance criteria the
   * operator added, and only the operator can waive them.
   */
  operatorDemands?: string | null;
  repairs: number;
  maxRepairs: number;
  scheduleId: string | null;
  /** The task whose run asked for this one (a tool build, a decomposed step). */
  parentId: string | null;
  /** Explicit human consent for a self-improvement task to edit core files. */
  allowCore: boolean;
  /**
   * The git ref this task's jail is cut from. Null means HEAD, which is right
   * for every task that starts from the current book. A ticket a reviewer
   * filed about unmerged work carries that work's branch instead.
   */
  baseRef: string | null;
  /** Playbook-defined role string (e.g. 'dev', 'senior'); drives model tier and, in later phases, review chain. */
  role: string | null;
  /** Id of the playbook this task was decomposed under, if any. */
  playbook: string | null;
  /** Relative sizing for an epic's tickets; informational only in Phase 0. */
  points: number | null;
  /** What a reviewer checks to consider this task's work done. */
  acceptance: string | null;
  /** Paths this task may not touch, declared in the plan; null when absent. */
  forbiddenPaths?: string[] | null;
  /**
   * Skills named for this ticket (skills.ts), at most two; null or absent
   * means the role's default. Set by Foreman or the operator, never the worker.
   */
  skills?: string[] | null;
  /** Repair rounds the pre-review checks queued; separate from `repairs`. */
  preReviewRepairs?: number;
  /**
   * Epic container: a crew epic's parent row. It never runs — it holds the
   * ask, groups its tickets by `parentId`, and closes when they all close.
   */
  isEpic: boolean;
  /**
   * Who decides this task at the gate. null resolves from the playbook then
   * FOREMAN_GATE (gate.ts:effectiveGate); 'owner' is the per-ticket opt-in.
   */
  gate: GateMode | null;
  /**
   * `'<decision>@<epochMs>'` if the owner gate already ran on this attempt —
   * the durable form of "already decided" (queue.ts:markGateDecision). Null
   * until it runs, and null again after a retry or repair round.
   */
  gateDecision: string | null;
  /**
   * Who does the work. Null resolves from the playbook then FOREMAN_ASSIGNEE
   * (assign.ts:effectiveAssignee), which defaults to 'ai'.
   */
  assignee: Assignee | null;
  /**
   * Epoch ms at which a closed task was folded into the archive, or null while
   * it is still in the Closed lane. Archiving never deletes: the compact record
   * in `archive` outlives the row (see archive.ts).
   */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deps: string[];
}

export interface Run {
  id: string;
  taskId: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  stage: Stage;
  progress: number;
  worktreePath: string | null;
  branch: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** pid (== pgid; children are spawned detached) of the live worker child, null once it exits. */
  pid: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  summary: string | null;
  verdict: CouncilVerdict | null;
  testsPassed: boolean | null;
  /** Total ms this run's test commands queued for a verify slot (FOREMAN_MAX_VERIFIES). */
  verifyWaitMs?: number;
  /**
   * The hosted CLI's conversation id for this run, when the runner reported one.
   * A repair round resumes it instead of re-sending the whole brief cold.
   */
  sessionId: string | null;
  /** The commit this run's jail was cut from; a round that reuses the jail copies it forward. */
  baseCommit?: string | null;
  /**
   * The git tree of the work as it was reviewed (isolate.ts jailTree); the
   * landing refuses any other. Null on a run parked before it was recorded.
   */
  reviewedTree?: string | null;
  /**
   * What the run itself recorded when it ended (runFacts.ts); every one is null on a run from before they existed.
   * `turns` is the model responses seen in the worker's stream (distinct message ids), `turnsReported` the CLI's own
   * `num_turns` from its result event (it counts differently), `turnLimit` the `--max-turns` in force.
   */
  turns?: number | null;
  turnsReported?: number | null;
  turnLimit?: number | null;
  endedReason?: RunEndedReason | null;
  /** The brief as sent, in UTF-8 bytes; and each section boundBrief cut from it (context.ts BriefCut). */
  briefBytes?: number | null;
  briefCuts?: Array<{ section: string; limit: number; before: number; cut: number }> | null;
  /** The worker's final report in UTF-8 bytes, before anything bounded it. */
  reportBytes?: number | null;
}

/** How a run ended, from what the runner and the scheduler already know. A daemon stop is none of these: null. */
export type RunEndedReason = 'ok' | 'turn-ceiling' | 'deadline' | 'provider-limit' | 'tripwire' | 'canceled' | 'error';
export const RUN_ENDED_REASONS: readonly RunEndedReason[] = ['ok', 'turn-ceiling', 'deadline', 'provider-limit', 'tripwire', 'canceled', 'error'];

export type DecisionAction = 'approve' | 'reject' | 'cancel' | 'retry' | 'reopen';
export type DecisionActor = 'human' | 'owner-model' | 'system';
export const DECISION_ACTIONS: readonly DecisionAction[] = ['approve', 'reject', 'cancel', 'retry', 'reopen'];
export const DECISION_ACTORS: readonly DecisionActor[] = ['human', 'owner-model', 'system'];

/**
 * One decision on a task, as the `decisions` table holds it (db.ts). Written once, when the decision's outcome is
 * known, and never changed. The landing fields (landedTree, asIs, merged, mergeReason, corrected, reviewSource)
 * are an approval's and null on every other action; a rejection also carries the reviewed tree it turned down.
 */
export interface Decision {
  id: string;
  taskId: string;
  /** The run the decision was about, when there was one. */
  runId: string | null;
  at: number;
  action: DecisionAction;
  actor: DecisionActor;
  /** The whole text given, bounded at 16 KB with a marker; null when none was given. */
  note: string | null;
  /** Bytes of the note that were not stored (0 when it was stored whole). */
  noteCutBytes: number;
  /** The task's status once the decision had taken effect: an approval that did not land leaves it at the gate. */
  statusAfter: string | null;
  reviewedTree: string | null;
  /** The tree that was merged; null when nothing merged. */
  landedTree: string | null;
  asIs: boolean | null;
  merged: boolean | null;
  mergeReason: string | null;
  /** true: the work needed a correction beyond the reviewed diff; false: stated that it did not; null: not stated. */
  corrected: boolean | null;
  /** What `corrected` rests on: 'trees' (an --as-is landing of a tree other than the reviewed one) or 'operator' (--corrected / --clean). */
  correctedSource: 'trees' | 'operator' | null;
  /** Who verified the work, in the approver's words (at most 200 characters). */
  reviewSource: string | null;
  /** Anything else the path recorded, e.g. `{ skills }` on a retry. */
  extra: Record<string, unknown> | null;
}

export type CouncilVerdict = 'pass' | 'fail' | 'split';

/**
 * A crew reviewer's status for one numbered acceptance item. `not-verifiable`
 * is the reviewer saying it was not shown what it needed; `unreported` is
 * Foreman's own, for an item the reply gave no usable status.
 */
export interface AcceptanceEntry {
  item: number;
  status: 'met' | 'partial' | 'missing' | 'not-verifiable' | 'unreported';
  note: string;
}

export interface AdvisorOpinion {
  model: string;
  provider: string;
  local: boolean;
  verdict: 'pass' | 'fail';
  confidence: number;
  critique: string;
  costUsd: number;
  latencyMs: number;
  error?: string;
  /** Set only on a playbook crew review entry: the reviewer's playbook role. */
  role?: string;
  /** Set only on a playbook crew review entry: the reviewer's style (code-review, editorial-letter, ...). */
  style?: string;
  /** Set only on a crew review of a ticket with numbered acceptance: the reviewer's status per item (crewReview.ts). */
  acceptance?: AcceptanceEntry[];
}

export interface Verdict {
  id: string;
  runId: string;
  taskId: string;
  verdict: CouncilVerdict;
  disagreement: boolean;
  council: AdvisorOpinion[];
  chairSummary: string | null;
  /** The chair's model, when an escalation was actually paid for. */
  chairModel: string | null;
  /** Which review wrote this row: the local council, or a playbook's crew chain. */
  source: 'council' | 'crew';
  /**
   * The council ran on smaller models than it asked for, because the intended
   * ones did not fit in memory. A provisional verdict is never auto-approved,
   * and the scheduler re-reviews the work once the full council fits.
   */
  provisional: boolean;
  critique: string | null;
  costUsd: number;
  createdAt: number;
}

export interface MemoryFact {
  id: string;
  /** Usually a repo path or 'global'. */
  scope: string;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  supersedes: string | null;
  retiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunEvent {
  id: number;
  taskId: string | null;
  runId: string | null;
  ts: number;
  type: 'status' | 'stage' | 'log' | 'progress' | 'artifact' | 'error' | 'metrics' | 'verdict' | 'assign' | 'archive' | 'shadow' | 'warning' | 'skills' | 'decision';
  stage: Stage | null;
  message: string;
}

export interface Artifact {
  id: string;
  runId: string;
  taskId: string;
  /**
   * `assertions`: the pre-existing assertions the run's diff removed or changed (verify/assertionCheck.ts).
   * `revert-tests`: each changed test run with the src change put back (verify/revertTests.ts); a reviewer aid, never a hold.
   */
  type: 'diff' | 'file' | 'report' | 'log' | 'assertions' | 'revert-tests';
  path: string;
  summary: string | null;
  /** null = undecided, 1 = approved, 0 = rejected. */
  approved: number | null;
  createdAt: number;
}

/**
 * A fully-populated Task for code paths that need to *scan* or *probe* rather
 * than schedule — admission checks on agent and tool sources, runner preflight
 * probes. Having one factory keeps those call sites from drifting as Task grows.
 */
export function probeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'probe', title: 'probe', prompt: '', kind: 'general', repo: null, agent: null,
    runner: 'api', sensitivity: 'S1', budgetUsd: null, priority: 0, status: 'queued',
    attempts: 0, maxAttempts: 1, error: null, testCmd: null, mergeOnApprove: false,
    repairNotes: null, repairs: 0, maxRepairs: 0, scheduleId: null, parentId: null, allowCore: false, baseRef: null,
    role: null, playbook: null, points: null, acceptance: null, forbiddenPaths: null, isEpic: false, gate: null, gateDecision: null,
    assignee: null, archivedAt: null,
    createdAt: 0, updatedAt: 0, deps: [], ...over,
  };
}

/**
 * Whether a verdict's chairSummary is a chair's actual ruling, or a status line
 * the council wrote in the same field: a lone reachable advisor, a seat that
 * answered nothing usable, a chair that was unreachable, answered off-contract
 * or had argued a side. A council chair rules only on a disagreement, and only
 * a pass/fail is a ruling; a crew row's chairSummary is only ever written by a
 * chair (verify/crewReview.ts). board/lib/store.js mirrors this for the board —
 * the two are held equal by test/board.test.ts. Lives here, beside Verdict, so
 * the store can label rows without importing the council.
 */
export function chairRuled(v: Pick<Verdict, 'chairSummary' | 'source' | 'disagreement' | 'verdict'> | null): boolean {
  if (!v?.chairSummary) return false;
  if (v.source === 'crew') return true;
  return Boolean(v.disagreement) && (v.verdict === 'pass' || v.verdict === 'fail');
}

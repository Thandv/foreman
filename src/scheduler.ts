import { checkMain, repoHead } from './postMerge.ts';
import { boundSummary, testSlotCommand, workerShellAllowlist, workerShellDenylist } from './runners/cliRunners.ts';
import { cloudFallback } from './localOnly.ts';
import { abortCause, abortFor } from './abort.ts';
import { deadlineNote, RunClock } from './runClock.ts';
import { backfillRunDecisions } from './db.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Broker, BudgetExceeded } from './budget.ts';
import { config } from './config.ts';
import { DEFAULT_ARCHIVE_AFTER_DAYS } from './archive.ts';
import { startAdoptedPersonas } from './align/personaHealth.ts';
import { shadowEnabled } from './agreement.ts';
import { localModelLockHolder } from './align/localLock.ts';
import { provisionDeps } from './deps.ts';
import {
  effectiveGate, GATE_BATCH_MAX, gateBatchEnabled, gateOptIn, hardHumanReason, overDailyCap, ownerGate, reviewHolds,
  ownerGateBatch, quotedPathsInDiff, type GateBatchItem,
} from './gate.ts';
import { changedFiles, createJail, diffJail, DirtyRepoError, jailBase, jailChanges, jailTree, leftoverMarkers, pinnedGit, removeJail, reuseJail, showBaseFile, type Jail, carryDiff } from './isolate.ts';
import { auditDirAsync } from './prose/auditWorker.ts';
import type { ProseAuditResult } from './prose/audit.ts';
import { factDrift } from './prose/linecheck.ts';
import { assertSelfDiffAllowed, CoreChangeRefused, gatherEvidence, pathsInDiff, proposeImprovement, queueImprovement } from './improve.ts';
import { checkAcceptanceMap, formatMapGaps } from './acceptanceMap.ts';
import { checkScope, effectiveScopeRules } from './scope.ts';
import { admit, AdmissionBlocked } from './security/admit.ts';
import { coreRefusal, isSelfTask, PROTECTED_PATHS } from './security/coreGuard.ts';
import { boundBrief, collectBriefCuts, compactDiff, tailLog } from './context.ts';
import { endedReason, newRunFacts, noteBrief, noteResult, noteResumed } from './runFacts.ts';
import { getRunner, type RunnerContext } from './runners/index.ts';
import { ProviderLimited, isProviderLimit, limitBackoffMs } from './providerLimit.ts';
import { CONFLICT_REPAIR_PREFIX, CORE_GUARD_PREFIX, conflictRepairNotes, redBackoffMs, type Store } from './queue.ts';
import { recordEpisode, relevantFacts, scopeOf } from './assistant/memory.ts';
import { planAsk, queuePlan } from './assistant/plan.ts';
import { deterministicFindings } from './verify/determinism.ts';
import { getPlaybook } from './playbooks.ts';
import { resumedSkillsBrief, roleAgent, skillsRunEvent } from './roles.ts';
import { checkBuiltTool, toolEvidence, toolTestCommand } from './tools/forge.ts';
import { migrateLegacyToolbox } from './tools/catalog.ts';
import { buildPrompt, councilAliases, councilNumCtx, MAX_RUNG, rungFor, runCouncil, wasReviewed, type Evidence } from './verify/council.ts';
import { crewLeadsVerify, crewReview, DROPPED_ISSUE_PREFIX, droppedSinceLastPark, heldReason, isPartialPassNote, type CrewVerdict } from './verify/crewReview.ts';
import { storeReport, storedReport } from './verify/report.ts';
import { recordAssertionChanges, storedAssertionNote } from './verify/assertionCheck.ts';
import { recordRevertTests, revertTestsApplies, revertTestsCheck, revertTestsNote, revertTestsSummary, storedRevertTestsNote } from './verify/revertTests.ts';
import { detectTestCmd, runTestsSlotted } from './verify/tests.ts';
import {
  BEHIND_ADVICE, behindLine, behindMain, behindParkNote, failuresAllChangedOnMain, gateTimeout, nothingToChangeNote, timedOutTwiceNote,
  type BehindMain,
} from './verify/gateOutcome.ts';
import { maxVerifies, verifySlotStats } from './verify/slots.ts';
import { BACKGROUND_RESUME_PROMPT, backgroundTestPending } from './verify/backgroundRun.ts';
import { SensitivityViolation, specs } from './models.ts';
import { TERMINAL_STATUSES } from './types.ts';
import type { CouncilVerdict, Run, Stage, Task, Verdict } from './types.ts';

export interface SchedulerOptions {
  maxWorkers?: number;
  /** Cap on tasks parked in the verify lane. Defaults to 2x maxWorkers. */
  maxVerifying?: number;
  tickMs?: number;
  taskTimeoutMs?: number;
  broker?: Broker;
  /** Injectable so tests can verify the pipeline without a model server. */
  verify?: (args: VerifyArgs) => Promise<Verdict>;
  verifyEnabled?: boolean;
  /** Injectable clock for the red-main and dirty-checkout backoffs and the tick-error rate limit. */
  now?: () => number;
  /** Injectable so tests can drive a run's deadline with a clock of their own (src/runClock.ts). */
  runClock?: (budgetMs: number, onExpire: () => void) => RunClock;
  /** Injectable so tests can drive the red-main re-check without a real test run. */
  checkMain?: typeof checkMain;
  repoHead?: typeof repoHead;
  /** Stands in for Foreman's own checkout, so a test can run a self-task against a throwaway repo. */
  selfRoot?: string;
  /** The per-test revert check (verify/revertTests.ts); defaults to FOREMAN_REVERT_TESTS (config.revertTests). */
  revertTests?: boolean;
}

export { redBackoffMs };

/** The cap on a park note: tasks.error is shown whole on the board and in `foreman ls`. */
const PARK_NOTE_MAX = 1000;

/**
 * The park note for review issues that could not be filed (the epic's depth
 * limit, its cap, or a duplicate), across every round since the last park: on
 * the gate item itself — what `foreman ls` and the approve view show — not
 * only in the timeline. Every title first; bodies only while there is room;
 * whatever does not fit is counted, with where to read it. `room` is what the
 * caller has left after its own note.
 */
export function droppedNote(events: Array<{ message: string }>, taskId: string, room = PARK_NOTE_MAX): string | null {
  if (!events.length) return null;
  const byTitle = new Map<string, { head: string; body: string }>();
  for (const e of events) {
    const nl = e.message.indexOf('\n');
    const head = (nl < 0 ? e.message : e.message.slice(0, nl)).slice(DROPPED_ISSUE_PREFIX.length + 1);
    const body = nl < 0 ? '' : e.message.slice(nl + 1).replace(/\s+/g, ' ').trim().slice(0, 200);
    byTitle.set(head.replace(/^\[[^\]]*\] /, '').replace(/ \([^()]*\)$/, '').toLowerCase(), { head, body });
  }
  const items = [...byTitle.values()];
  const deep = events.some((e) => / parents deep, max /.test(e.message.split('\n')[0]!));
  const lead = `REVIEW ISSUES NOT FILED (${items.length})${deep ? ' (epic depth limit)' : ''} — decide at approval: `;
  const more = (k: number): string => `… +${k} more — foreman show ${taskId}`;
  const fits = (parts: string[], k: number): boolean => (lead + parts.join('; ') + (k ? `; ${more(k)}` : '')).length <= room;
  // Titles first, as many as fit with the "+K more" tail.
  const shown: string[] = [];
  for (const [i, it] of items.entries()) {
    if (!fits([...shown, it.head], items.length - i - 1)) break;
    shown.push(it.head);
  }
  const cut = items.length - shown.length;
  // Then bodies, in order, while they still fit.
  for (let i = 0; i < shown.length; i++) {
    const it = items[i]!;
    if (!it.body) continue;
    const next = [...shown];
    next[i] = `${it.head}: ${it.body}`;
    if (fits(next, cut)) shown.splice(0, shown.length, ...next);
  }
  return (lead + shown.join('; ') + (cut ? `${shown.length ? '; ' : ''}${more(cut)}` : '')).slice(0, room);
}

/** A park note with the unfiled-issue note appended, never replaced by it. */
function withDropped(note: string | null, store: Store, taskId: string): string | null {
  const base = note ?? '';
  const sep = base ? ' | ' : '';
  // Too little room left for even the heading and a count: the timeline has them.
  if (PARK_NOTE_MAX - base.length - sep.length < 120) return note;
  const dropped = droppedNote(droppedSinceLastPark(store, taskId), taskId, PARK_NOTE_MAX - base.length - sep.length);
  return dropped ? `${base}${sep}${dropped}` : note;
}

/**
 * The brief line for every ticket against Foreman itself that does not carry
 * allowCore: the whole protected list (security/coreGuard.ts), whether or not
 * the ticket's text names any of it. Changing one is refused, and a worker
 * that is not told finds out when its run is. The line is in the brief only:
 * admission reads the stored ticket, so the list here raises no warning.
 */
export function coreGuardBrief(task: Task, selfRoot?: string, isSelf?: boolean): string {
  if (!(isSelf ?? isSelfTask(task, selfRoot)) || task.allowCore) return '';
  return (
    `\n---\nCORE GUARD: do not modify any of: ${PROTECTED_PATHS.join(', ')}. A change to them is refused. ` +
    'If this ticket cannot be done without changing one of them, stop and say so.'
  );
}

/** Probe backoff for a dirty operator checkout: 30s doubling, capped at 10 minutes. */
export function dirtyBackoffMs(probes: number): number {
  return Math.min(30_000 * 2 ** probes, 10 * 60_000);
}

/** How long a repeated tick failure stays quiet in the timeline after it is recorded once. */
const TICK_ERROR_QUIET_MS = 5 * 60_000;

export interface VerifyArgs {
  task: Task;
  runId: string;
  evidence: Evidence;
  signal: AbortSignal;
  onNote: (line: string) => void;
  /** Non-binding: compute a verdict but write no verdict row and leave the run's verdict alone. */
  shadow?: boolean;
  /** See CouncilOptions.stillCurrent. */
  stillCurrent?: () => boolean;
}

/**
 * Which lane a live task occupies. A worker slot should cover the work a
 * worker actually does; the council stage is pure model wait, and holding a
 * slot through it left workers idle in `verifying` while ready tasks queued.
 */
type Lane = 'work' | 'verify';

interface Active {
  lane: Lane;
  taskId: string;
  runId: string;
  controller: AbortController;
  done: Promise<void>;
  /** The run's deadline (src/runClock.ts), set once the run starts. */
  clock?: RunClock;
  /** Slot waits its worker has open through the slot wrapper (slotQueued), and when the first of them began. */
  slotWaits?: number;
  slotWaitAt?: number;
}

/** A conflict round that cannot park a landable result; the task goes back to the gate on the approved run (queue.ts abandonConflictRound). */
class ConflictRoundAbandoned extends Error {}

/** A repair round Foreman prepared after an approval's merge conflicted (queue.ts scheduleConflictRepair). */
function isConflictRepair(task: Pick<Task, 'repairNotes'>): boolean {
  return Boolean(task.repairNotes?.startsWith(CONFLICT_REPAIR_PREFIX));
}

/** The run before the one a brief is being written for, with whether a reviewer failed it. */
export interface PreviousRound {
  run: Pick<Run, 'id' | 'status' | 'stage' | 'verdict' | 'testsPassed' | 'endedReason' | 'turnLimit'>;
  /** A council or crew review of THAT run came back `fail` (a verdict row with reviewers on it). */
  reviewerFailed: boolean;
}

/** The newest run of the task other than `currentRunId`, as the ledger recorded it; null when there is none. */
export function previousRound(store: Store, taskId: string, currentRunId: string | null): PreviousRound | null {
  const run = store.runsForTask(taskId).find((r) => r.id !== currentRunId);
  if (!run) return null;
  const reviewerFailed = store.verdictsForTask(taskId)
    .some((v) => v.runId === run.id && v.verdict === 'fail' && (v.source === 'crew' || v.council.length > 0));
  return { run, reviewerFailed };
}

/** The opening line of a repair round on main: kept to the byte wherever the previous round WAS a rejection. */
const REJECTED_RESUMED = 'Your previous attempt in this session was REJECTED by the verification council. Fix exactly this and nothing else:';
const REJECTED_COLD = 'A previous attempt was REJECTED by the verification council. Fix exactly this and nothing else:';

/**
 * The first line of a repair round's notes: what actually happened to the run before, from what that run recorded
 * (its `ended_reason`, its verdict, its status, its test result) — never from the notes' own wording. A round
 * requeued after its run ran out of time was told its work had been "REJECTED by the verification council" although
 * nothing had been reviewed. Where the run before was failed by a reviewer, or nothing is known of it, the line is
 * main's, unchanged. A round the scheduler itself failed on a red test stage says that: no reviewer saw it either.
 */
export function repairOpening(previous: PreviousRound | null | undefined, resumed: boolean, testCmd?: string | null): string {
  const rejected = resumed ? REJECTED_RESUMED : REJECTED_COLD;
  if (!previous || previous.reviewerFailed) return rejected;
  const { run } = previous;
  const your = resumed ? 'Your previous run' : 'The previous run';
  const during = ` during its ${run.stage} stage`;
  // A resumed round is in the jail its session edited; a cold one may be in a new tree, so nothing is promised.
  const carryOn = resumed ? ' Your work is in place: continue from it.' : '';
  const standing = ' The notes below still stand; do exactly this and nothing else:';
  const unreviewed = (what: string): string => `${your} ${what}${during}; nothing was rejected.${carryOn}${standing}`;
  switch (run.endedReason) {
    case 'deadline': return unreviewed('reached its time limit');
    case 'turn-ceiling': return unreviewed(`stopped at its turn limit${run.turnLimit ? ` (${run.turnLimit} turns)` : ''}`);
    case 'provider-limit': return unreviewed('was stopped by the provider\'s usage limit');
    case 'tripwire': return unreviewed('was stopped by Foreman for writing outside its working directory');
    case 'canceled': return unreviewed('was canceled');
    case 'error': return unreviewed('ended on an error');
    default: break;
  }
  // Ended in the ordinary way from here on.
  if (run.verdict === 'fail' && run.testsPassed === false) {
    // The scheduler's own fail: the test stage was red, so no reviewer was asked. The command is the ticket's own
    // (a detected one is not on record, and is then left out).
    const cmd = (testCmd ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return `The project's tests failed at the gate${cmd ? ` (${cmd})` : ''}; nothing was reviewed yet.${carryOn} Fix exactly this and nothing else:`;
  }
  if (run.verdict === 'fail') return rejected;
  if (run.status === 'failed' && run.verdict == null && run.endedReason === 'ok') {
    return `${your} was sent back by Foreman's own pre-review checks; no reviewer was called and nothing was rejected.${carryOn} Do exactly this and nothing else:`;
  }
  if (run.status === 'succeeded') {
    return run.testsPassed === false
      ? `${your} was parked for a person because its checks did not finish or pass (a gate that timed out twice, or tests main has since changed), and the operator sent it back; no reviewer rejected it.${carryOn} Do exactly this and nothing else:`
      : `${your} reached the gate and the operator sent it back; the verification council did not reject it.${carryOn} Do exactly this and nothing else:`;
  }
  return rejected;
}

/**
 * Facts the store has learned about this repo, folded into the worker brief.
 * static-first for prompt-cache hits: role prompt and hard constraints lead,
 * per-ticket text (brief, repair notes, remembered facts) trails.
 */
export function briefFor(store: Store, task: Task, selfRoot?: string, isSelf?: boolean, previous?: PreviousRound | null): string {
  const parts: string[] = [];
  // Crew ticket (playbook + role, no explicit agent): lead with the role's
  // system prompt + hard constraints, same "persona text first, ticket text
  // last" shape runners/api.ts uses for an explicit task.agent — the
  // claude-code runner has no separate system-prompt channel, so this is the
  // seam that gets the role's voice into the CLI's single -p prompt.
  if (task.playbook && task.role && !task.agent) {
    const pb = getPlaybook(task.playbook);
    if (pb?.roles[task.role]) {
      // The tool brief is told for the runner this ticket runs on (only the api runner has use_tool), which can
      // differ from the crew's default: a crew queued with an explicit runner, or one queued before the plane changed.
      const runner = task.runner === 'api' ? 'api' : 'claude-code';
      parts.push(`${roleAgent(pb, task.role, { skills: task.skills, runner }).systemPrompt}\n\n---\n`);
    }
  }
  parts.push(task.prompt);
  const acceptance = acceptanceBrief(task);
  if (acceptance) parts.push(acceptance);
  const shell = shellBrief(task);
  if (shell) parts.push(shell);
  const core = coreGuardBrief(task, selfRoot, isSelf);
  if (core) parts.push(core);
  const operator = operatorBrief(task);
  if (operator) parts.push(operator);
  if (task.repairNotes) {
    parts.push(
      `\n---\n${isConflictRepair(task)
        ? 'Your earlier work was approved but did not merge. Do exactly this and nothing else:'
        : repairOpening(previous, false, task.testCmd)}\n` +
        boundBrief(task.repairNotes, config.repairBriefBytes, 'repair-notes') +
        REPORT_LINE,
    );
  }
  const facts = relevantFacts(store, scopeOf(task), `${task.title} ${task.prompt}`, 8);
  if (facts.length) {
    parts.push(
      `\n---\nWhat Foreman has learned about this workspace (may be stale — verify before relying on it):\n` +
        boundBrief(facts.map((f) => `- ${f.key}: ${f.value}`).join('\n'), undefined, 'memory'),
    );
  }
  return parts.join('\n');
}

/**
 * How a worker uses the slot wrapper, said in the brief. A worker ran the full suite four times in one hour — two
 * started a second apart, each holding one of the two test slots, all four piped through tail/head/grep and so re-run
 * to read more — and ran out its deadline waiting for a slot.
 */
export const SUITE_ONCE_BRIEF =
  'Run the full suite through the wrapper ONCE, alone, at the end — never start two suite runs at once; while ' +
  'iterating use `node --test <one file>`. The wrapper saves the full output to a file and prints its path on its ' +
  'last line: to see more of a run, read that file (or run the wrapper with `--saved`), do not run the suite again. ';

/**
 * What the headless worker may run, said up front. A worker that is not told
 * spends its turns discovering the allowlist one refusal at a time: on the
 * first Kiln epic the diagnostics worker tried tsc, node, python3 and bash in
 * turn, was refused each time, and delivered nothing.
 */
export function shellBrief(task: Pick<Task, 'runner' | 'testCmd'>): string {
  if (task.runner !== 'claude-code') return '';
  const allowed = workerShellAllowlist(task).slice(1);
  if (!allowed.length) return '';
  const asCmd = (t: string): string => t.replace(/^Bash\((.*?)(:\*)?\)$/, '$1');
  const cmds = allowed.map(asCmd).join(', ');
  const denied = workerShellDenylist(task).slice(1).map(asCmd);
  const wrapper = testSlotCommand();
  // The full suite goes through the slot wrapper, in the foreground: 48 runs ended their turn with
  // `npm run verify` "still running in the background", and 26 of those failed review unconfirmed.
  const suite = allowed.some((t) => asCmd(t) === wrapper)
    ? `Run the FULL test suite only as \`${wrapper}\` (it waits for a shared test slot, runs this ticket's ` +
      'test command and exits with its result; append `-- npm run <script>` for another suite script). Run it in the ' +
      'FOREGROUND with the longest Bash timeout: never with run_in_background, and never end your turn while a test ' +
      'run is still going. A single targeted test file may be run directly with `node --test <file>`. ' +
      (denied.length ? `These are refused when run directly — use the wrapper: ${denied.join(', ')}. ` : '') +
      SUITE_ONCE_BRIEF +
      'Run the suite yourself before you finish and report its result. '
    : 'Run the test command yourself, in the foreground, before you finish. ';
  return (
    '\n---\nSHELL: this session is headless and nobody can approve a command. These run without ' +
    `approval: ${cmds} (plus read-only inspection). Anything else — a bare interpreter, compiler or ` +
    'script — is refused. To run another tool, add a script to package.json and run it with ' +
    '`npm run <script>`; that script is part of your diff and is reviewed. ' + suite +
    'Acceptance items only a person can check (live in a browser or app, visual, ' +
    'marked "(operator)") are run by the operator at the gate: build for them, but do not try to run or report them.'
  );
}

/**
 * The brief for a repair round that is CONTINUING the previous run's CLI
 * session. The session already holds the role prompt, the ticket, the hard
 * constraints and everything the worker read last round, so re-sending them is
 * the whole bill this saves: all that is new is the critique.
 */
export function repairBrief(task: Task, previous?: PreviousRound | null): string {
  return (
    `${repairOpening(previous, true, task.testCmd)}\n` +
    boundBrief(task.repairNotes ?? '', config.repairBriefBytes, 'repair-notes') +
    REPORT_LINE +
    operatorBrief(task) +
    acceptanceBrief(task)
  );
}

/**
 * The ticket's acceptance criteria, which the reviewer judges the work
 * against. They were never in the worker's brief: on Kiln phase 4b a worker
 * reported that "the acceptance list never reached" it, and the review failed
 * it on the exact ids and groupings that list named. Across the Kiln epics this
 * is the likely root of many repair rounds — workers built to the prompt and
 * were judged against a list they had not seen.
 */
export function acceptanceBrief(task: Pick<Task, 'acceptance'>): string {
  const text = task.acceptance?.trim();
  if (!text) return '';
  return (
    '\n---\nACCEPTANCE CRITERIA — the reviewer checks your work against each of these. Meet every one ' +
    '(items marked "(operator)" are checked by a person at the gate; build for them, do not report them):\n' +
    boundBrief(text, config.acceptanceBytes, 'acceptance') +
    '\n\nEnd your final report with a section headed `ACCEPTANCE MAP`, one line per numbered acceptance item, ' +
    'in one of these forms:\n' +
    '- `N. <test file> :: <test name>` — the test file and the exact title of the test in it that proves the item: a test you added or changed, ' +
    'or, only for an item that says something stays as it was, a test that was already there\n' +
    '- `N. (diff) <path>` — a file that is in your diff, for an item the diff itself proves (a file\'s content, or code that had to stay the same); ' +
    'never for an item that asks for a test, and when you changed code at least one item must be mapped to a test you added or changed\n' +
    '- `N. (operator)` or `N. (review)` — only for items the acceptance itself marks "(operator)" or "(review)"; ' +
    'you cannot opt an item out yourself'
  );
}

/**
 * The worker's final message reaches the reviewer (as claims, not evidence),
 * so a demand that cannot be met as written can be disputed there — before,
 * the reviewer saw only the diff and "argued away in the work" was impossible.
 */
export const REPORT_LINE =
  '\nYour final message is shown to the reviewer. If a demand cannot be met as written (for example it names ' +
  'code that does not exist), meet its intent and say exactly why in your final message.';

/**
 * The operator's standing demands, when this round's repair notes no longer
 * carry them. The first attempt after a rejection has them in its notes; every
 * later repair round's notes are the latest review's critique, and a reviewer
 * that restates three of six findings silently drops the other three.
 */
export function operatorBrief(task: Pick<Task, 'operatorDemands' | 'repairNotes'>): string {
  const demands = task.operatorDemands?.trim();
  if (!demands || task.repairNotes?.includes(demands)) return '';
  return (
    '\n---\nA HUMAN rejected an earlier attempt at the gate with the findings below. They still bind ' +
    'this ticket alongside its acceptance criteria; make sure each one is met before you finish:\n' +
    boundBrief(demands, config.repairBriefBytes, 'operator-demands')
  );
}

/**
 * What a repair round carries over from the run it continues: the CLI session
 * AND the worktree that session was recorded in. The two are inseparable —
 * `claude` scopes a conversation to the project directory it ran in — so they
 * travel together or not at all (see execute's isolate stage).
 */
export interface ResumePlan {
  sessionId: string;
  worktreePath: string | null;
  branch: string | null;
  /** The commit that worktree was cut from, copied forward from the run that cut it. */
  baseCommit?: string | null;
}

/**
 * The session a repair round may continue, or null to run cold.
 *
 * Only a repair round qualifies (a first attempt has nothing to continue), only
 * the claude-code runner (nothing else speaks `--resume`), and only while the
 * kill-switch is off. The caller CONSUMES what this returns — a session is
 * offered once, so a `--resume` the CLI rejects cannot wedge the ticket in a
 * loop against a stale id: the next attempt finds nothing and goes cold.
 */
export function resumableSession(task: Task, previous: Run | null): string | null {
  if (!couldResume(task)) return null;
  return previous?.sessionId?.trim() || null;
}

/** The half of resumableSession that needs no run row, so the query can be skipped. */
function couldResume(task: Task): boolean {
  if (process.env['FOREMAN_CLAUDE_RESUME'] === 'off') return false;
  if (task.runner !== 'claude-code') return false;
  // Its tree is a new one cut from main, not the session's.
  if (isConflictRepair(task)) return false;
  return Boolean(task.repairNotes?.trim());
}

/**
 * How long the local council may have of what is left.
 *
 * It is advisory. The crew chain — the reviewer that reads the work and writes
 * the letter — comes after it and inherits the remainder, so a council left
 * unbounded can spend the entire task deadline on models that time out and
 * leave the real reviewer nothing. Observed exactly that: three chapters parked
 * at the human gate with no reviewer having read them.
 */
export function councilShareOf(deadlineAt: number, share = Number(process.env['FOREMAN_COUNCIL_DEADLINE_SHARE'] ?? 0.4)): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return 1_000;
  return Math.max(30_000, Math.floor(remaining * Math.min(0.9, Math.max(0.1, share))));
}

/** Resolve to null rather than hang past `ms`; the caller treats null as "no verdict". */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const bell = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The distinct reasons every reviewer gave for not answering, for the gate note. */
/**
 * The gate note for work no council advisor could read. A crew chain that lost
 * a reviewer while the rest passed gives no verdict (crewReview.ts), but its
 * survivor DID read the work — so the note must not say nobody did.
 */
export function unreviewedNote(verdict: { council: Array<{ model: string; error?: string }> }, crewPassedPartly: boolean): string {
  const reasons = unreachableReasons(verdict);
  return (crewPassedPartly
    ? `UNREVIEWED — no council advisor could be reached (${reasons}); a crew reviewer passed it, but its chain lost a reviewer, so nothing has given a verdict`
    : `UNREVIEWED — no reviewer could be reached (${reasons}); nothing has read this work`).slice(0, 1000);
}

/**
 * What the run has when the council runs out of its share of the deadline: the
 * newest round it finished and wrote (a climb writes one row per rung), if
 * any advisor in it answered — otherwise nothing, and the caller records that
 * nobody could. The newest row only, so the in-memory verdict is the row the
 * gate and the board read. A full round seats two advisors; the fast tier's
 * one seat is triage, whose non-pass means "ask the full council"
 * (verify/triage.ts) and is never adopted as the council's word.
 */
export function finishedRound(store: Store, taskId: string, runId: string): Verdict | null {
  const newest = store.verdictsForTask(taskId).find((v) => v.runId === runId && v.source !== 'crew');
  return newest && newest.council.length >= 2 && wasReviewed(newest) ? newest : null;
}

function unreachableReasons(verdict: { council: Array<{ model: string; error?: string }> }): string {
  const seen = new Set<string>();
  for (const opinion of verdict.council) {
    if (!opinion.error) continue;
    seen.add(`${opinion.model}: ${opinion.error.slice(0, 80)}`);
  }
  return [...seen].slice(0, 3).join('; ') || 'no reviewer ran at all';
}

/**
 * Single-process worker pool. One tick promotes ready tasks, claims up to the
 * free-slot count, and launches them; each task owns exactly one run.
 */
/** How often the archive sweep is even considered. See runDueArchiveSweep. */
const ARCHIVE_SWEEP_INTERVAL_MS = 3_600_000;

/** The worker's report as the crew chain is handed it: the whole text, where it is stored, and Foreman's own note. */
interface CrewReport {
  text: string | null;
  path: string | null;
  note?: string | null;
}

export interface PreReviewGaps {
  /** One line per gap item or violating file. */
  items: string[];
  /** The repair brief: the items, and nothing else. */
  notes: string;
  /**
   * The subset of `items` that are scope violations. Unlike a map gap these
   * are not heuristics — a forbidden path was written — so they fail the
   * ticket once the repair rounds are spent instead of going to a reviewer.
   */
  scope: string[];
  /**
   * The subset of `items` that are soft deterministic findings (verify/determinism.ts: an added skip, a deleted test
   * file, missing required content). The worker may answer one by explaining it in the report, which the check cannot
   * read, so these alone get one repair round, not the whole cap, before the reviewer judges them.
   */
  advisory?: string[];
}

/** Two sets of pre-review gaps as one: a background-run gap must not hide a scope violation. */
function mergeGaps(a: PreReviewGaps | null, b: PreReviewGaps | null): PreReviewGaps | null {
  if (!a || !b) return a ?? b;
  return {
    items: [...a.items, ...b.items], notes: `${a.notes}\n\n${b.notes}`, scope: [...a.scope, ...b.scope],
    advisory: [...(a.advisory ?? []), ...(b.advisory ?? [])],
  };
}

/**
 * Whether a pre-review gap set earns another repair round before any reviewer: a scope violation or a hard finding
 * always does (and fails the ticket once the cap is spent); soft findings alone get one round; anything else, the cap.
 */
export function preReviewRepairDue(gaps: PreReviewGaps, rounds: number): boolean {
  if (gaps.scope.length > 0) return true;
  if (rounds >= config.preReviewRepairs) return false;
  const advisoryOnly = (gaps.advisory?.length ?? 0) === gaps.items.length;
  return !(advisoryOnly && rounds >= 1);
}

/**
 * The pure checks that run before any crew reviewer: the acceptance map for
 * code tickets, the scope guard for every kind. Null when the ticket is not a
 * crew ticket or both checks are clean.
 */
export function preReviewGaps(task: Task, diff: string, report: string | null, treeDir: string | null = null): PreReviewGaps | null {
  if (!task.playbook || !getPlaybook(task.playbook)?.reviewers.length) return null;
  const items: string[] = [];
  const sections: string[] = [];
  if (task.kind === 'code') {
    const gaps = checkAcceptanceMap({ acceptance: task.acceptance, report, diff, treeDir });
    if (gaps.length) {
      const lines = formatMapGaps(gaps).split('\n');
      items.push(...lines);
      sections.push(`Your ACCEPTANCE MAP leaves these acceptance items uncovered; fix each and end the report with a complete map:\n${lines.join('\n')}`);
    }
  }
  const violations = checkScope(effectiveScopeRules(task), pathsInDiff(diff));
  const scope = violations.map((v) => `${v.file} (${v.rule})`);
  if (scope.length) {
    items.push(...scope);
    sections.push(`The diff breaks the ticket's scope; revert these files:\n${scope.join('\n')}`);
  }
  // The role's deterministic checks (verify/determinism.ts). A hard finding — a committed secret, a focused test —
  // is held like a scope violation: still there after the repair rounds, the ticket fails. A soft one goes to the
  // reviewer as a note once the rounds are spent, like a map gap.
  const pb = getPlaybook(task.playbook);
  const det = pb ? deterministicFindings(pb, task.role ?? null, diff, treeDir) : { hard: [], soft: [] };
  if (det.hard.length) {
    items.push(...det.hard);
    scope.push(...det.hard);
    sections.push(`These must be fixed before the work is reviewed:\n${det.hard.join('\n')}`);
  }
  if (det.soft.length) {
    items.push(...det.soft);
    sections.push(`Fix these, or say in the report why each one is right:\n${det.soft.join('\n')}`);
  }
  return items.length ? { items, notes: sections.join('\n\n'), scope, advisory: det.soft } : null;
}

export class Scheduler {
  private readonly store: Store;
  private readonly maxWorkers: number;
  private readonly tickMs: number;
  /** An explicit ceiling from the constructor; otherwise the mode-dependent config value, read per run. */
  private readonly fixedTaskTimeoutMs: number | undefined;
  /** Held claude-code tickets at the last tick, so the hold is logged on change, not every 250ms. */
  private lastHeld = 0;
  /** Until when claude-code work is held after a provider usage limit (src/providerLimit.ts). */
  limitHoldUntil = 0;
  private readonly now: () => number;
  private readonly runClockFn: (budgetMs: number, onExpire: () => void) => RunClock;
  private readonly checkMainFn: typeof checkMain;
  private readonly repoHeadFn: typeof repoHead;
  /** Undefined outside tests: the guards then use Foreman's own checkout. Read by the HTTP API's approve route. */
  readonly selfRoot: string | undefined;
  /**
   * Repos whose operator checkout was dirty when a jail was cut. No ticket for
   * them is claimed until a probe finds the checkout clean — in-memory on
   * purpose: a restarted daemon simply rediscovers a still-dirty checkout.
   */
  private readonly dirtyHolds = new Map<string, { files: string; probes: number; nextProbeAt: number; probing: boolean }>();
  /** Rate limit for recording tick failures: the last recorded message, when, and how many were suppressed since. */
  private tickError: { message: string; at: number; suppressed: number } | null = null;
  private get taskTimeoutMs(): number {
    return this.fixedTaskTimeoutMs ?? config.taskTimeoutMs;
  }
  private readonly active = new Map<string, Active>();
  private readonly maxVerifying: number;
  private readonly verifyWaiters: Array<() => void> = [];
  private readonly verifyFn: (args: VerifyArgs) => Promise<Verdict>;
  private readonly verifyEnabled: boolean;
  private readonly revertTests: boolean;
  /** Owner-gate calls in flight, keyed by task: single-flight across ticks. */
  private readonly gating = new Map<string, Promise<void>>();
  /**
   * Tickets this process watched park at the gate. FOREMAN_GATE=owner is the
   * operator's live intent, so it qualifies these — and only these — for the
   * gate; the sweep over a pre-existing backlog needs a written-down opt-in
   * (gate.ts:gateOptIn). Process-local on purpose: a restart forgets it.
   */
  private readonly parkedHere = new Set<string>();
  /** Tasks already told (once, in the timeline) that the gate is over budget. */
  private readonly budgetHeld = new Set<string>();
  /** Aborted by stop(); a gate call outlives its run, so it cannot use the run's controller. */
  private lifetime = new AbortController();
  readonly broker: Broker;
  private timer: NodeJS.Timeout | undefined;
  /** Epoch ms of the last archive sweep; 0 means "sweep on the first tick". */
  private lastArchiveSweep = 0;
  private lastRecheck = 0;
  private recheckInFlight: Promise<void> | null = null;
  /** Tasks with a re-review running — the automatic re-check or a manual one. */
  private readonly reverifying = new Set<string>();
  /** Automatic re-check attempts per task, for the backoff and the give-up. */
  private readonly recheckAttempts = new Map<string, number>();
  /** Per task: not before this instant — a re-check that came back provisional again waits. */
  private readonly recheckNotBefore = new Map<string, number>();
  /** Edge-tracking, so "paused" and "resumed" are logged once, not per tick. */
  private deferredForLock = false;
  private ticking = false;
  private stopped = true;

  constructor(store: Store, opts: SchedulerOptions = {}) {
    this.store = store;
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? config.maxWorkers);
    // The verify lane exists to stop head-of-line blocking, not to run
    // unbounded reviews: the broker's provider caps still gate real calls.
    this.maxVerifying = Math.max(1, opts.maxVerifying ?? config.maxVerifying);
    this.tickMs = opts.tickMs ?? config.schedulerTickMs;
    this.now = opts.now ?? Date.now;
    this.runClockFn = opts.runClock ?? ((budgetMs, onExpire) => new RunClock(budgetMs, onExpire));
    this.checkMainFn = opts.checkMain ?? checkMain;
    this.repoHeadFn = opts.repoHead ?? repoHead;
    this.selfRoot = opts.selfRoot;
    this.fixedTaskTimeoutMs = opts.taskTimeoutMs;
    this.broker = opts.broker ?? new Broker(store);
    this.verifyEnabled = opts.verifyEnabled ?? process.env['FOREMAN_VERIFY'] !== 'off';
    this.revertTests = opts.revertTests ?? config.revertTests;
    this.verifyFn =
      opts.verify ??
      ((args) =>
        runCouncil({
          store,
          broker: this.broker,
          task: args.task,
          runId: args.runId,
          evidence: args.evidence,
          signal: args.signal,
          onNote: args.onNote,
          shadow: args.shadow,
          stillCurrent: args.stillCurrent,
        }));
    this.store.on('cancel', (taskId: string) => abortFor(this.active.get(taskId)?.controller, 'cancel'));
  }

  /** Tasks occupying a worker slot: admit → test. */
  get activeCount(): number {
    return this.laneCount('work');
  }

  /** Tasks parked in the verify lane, waiting on or running the council. */
  get verifyingCount(): number {
    return this.laneCount('verify');
  }

  get verifyLaneSize(): number {
    return this.maxVerifying;
  }

  private laneCount(lane: Lane): number {
    let n = 0;
    for (const a of this.active.values()) if (a.lane === lane) n++;
    return n;
  }

  /**
   * A worker's own suite run (the slot wrapper, through POST /api/verify-slot) started or stopped waiting for a test
   * slot: that wait is not the run's own time, so its deadline stops meanwhile (RunClock caps the total). A run id
   * that is not running here is ignored.
   */
  slotQueued(runId: string, queued: boolean): void {
    for (const entry of this.active.values()) {
      if (entry.runId !== runId || !entry.clock) continue;
      const open = entry.slotWaits ?? 0;
      if (queued) {
        entry.slotWaits = open + 1;
        entry.clock.pause(`worker-slot:${open + 1}`);
        // In the run's timeline, so an hour that went on a queue reads as one.
        if (open === 0) {
          entry.slotWaitAt = Date.now();
          this.store.record({ taskId: entry.taskId, runId, type: 'log', message: "the worker's suite run is waiting for a test slot; the run deadline is stopped meanwhile" });
        }
      } else if (open > 0) {
        entry.clock.resume(`worker-slot:${open}`);
        entry.slotWaits = open - 1;
        if (open === 1) {
          const secs = Math.round((Date.now() - (entry.slotWaitAt ?? Date.now())) / 1000);
          this.store.record({ taskId: entry.taskId, runId, type: 'log', message: `the worker's suite run stopped waiting for a test slot after ${secs} s` });
        }
      }
      return;
    }
  }

  /**
   * Hand back the worker slot and take a place in the verify lane. The lane is
   * capped so a burst of reviews cannot park unbounded runs, and the wait is
   * abort-aware so a cancelled task never sits here.
   */
  private async enterVerifyLane(taskId: string, signal: AbortSignal): Promise<void> {
    const entry = this.active.get(taskId);
    if (!entry || entry.lane === 'verify') return;
    for (;;) {
      if (signal.aborted) throw new Error('aborted while waiting for a verify slot');
      if (this.laneCount('verify') < this.maxVerifying) {
        entry.lane = 'verify';
        // A freed worker slot should be filled now, not at the next tick.
        void this.pulse();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const at = this.verifyWaiters.indexOf(wake);
          if (at >= 0) this.verifyWaiters.splice(at, 1);
          reject(new Error('aborted while waiting for a verify slot'));
        };
        this.verifyWaiters.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private releaseVerifySlot(): void {
    const next = this.verifyWaiters.shift();
    next?.();
  }

  get workers(): number {
    return this.maxWorkers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dispatchPaused = false;
    // A restarted scheduler needs a live lifetime; the old one is spent.
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    fs.mkdirSync(config.workRoot, { recursive: true });
    fs.mkdirSync(config.artifactRoot, { recursive: true });
    const migrated = migrateLegacyToolbox();
    if (migrated.length) {
      this.store.record({ type: 'status', message: `migrated ${migrated.length} tool(s) into the toolbox: ${migrated.join(', ')}` });
    }
    this.store.recoverOrphans();
    // Fills only blanks: decisions an older daemon made after this ledger was
    // migrated (the open-time pass ran before them) get their label here.
    backfillRunDecisions(this.store.db);
    // An adopted persona is already routed live work by modelForTask, so the
    // daemon owning its server is not a convenience — it is what keeps routing
    // and reality in step. Fire-and-forget: a
    // model server that will not start is a reason to refuse the tickets that
    // want it, never a reason to refuse to boot the queue.
    void startAdoptedPersonas()
      .then((reports) => {
        for (const r of reports) {
          if (r.reason === 'already serving') continue;
          this.store.record({ type: 'status', message: `persona ${r.id}: ${r.ok ? 'serving' : `not serving — ${r.reason}`}` });
        }
      })
      .catch(() => {});
    this.timer = setInterval(() => void this.pulse(), this.tickMs);
    this.timer.unref?.();
    void this.pulse();
  }

  private dispatchPaused = false;

  /**
   * Claim nothing from here on (a shutdown, before its approvals drain). Work
   * already running is left to stop(); start() resumes dispatch.
   */
  pauseDispatch(): void {
    this.dispatchPaused = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.lifetime.abort();
    for (const a of this.active.values()) abortFor(a.controller, 'stop');
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    // Gate calls are off-tick and own no run row, so they are settled here too:
    // a shutdown must not leave a claude CLI deciding a ticket in the dark.
    await Promise.allSettled([...this.gating.values()]);
    // A provisional re-check is a review in flight; it was aborted above and
    // must settle before the store it writes to is closed.
    if (this.recheckInFlight) await this.recheckInFlight.catch(() => {});
    await Promise.allSettled([...this.probes]);
    // Aborting SIGTERMs each child's group (and proc.ts escalates to SIGKILL);
    // anything still recorded belongs to a run that never settled its row.
    // Kill it now rather than leave an orphan behind a clean shutdown.
    this.store.killLiveRunGroups();
  }

  /** Runs the queue to completion. Test helper; the daemon uses start(). */
  async drain(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.tick();
      const s = this.store.stats();
      // Epic containers sit `blocked` by design until their tickets close (and
      // tickets park at the gate, which is not terminal), so they are not
      // pending work — counting them here would make drain() spin to timeout.
      const blockedWork = Number(
        (this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'blocked' AND is_epic = 0").get() as
          | Record<string, unknown>
          | undefined)?.['n'] ?? s.blocked,
      );
      if (this.active.size === 0 && s.queued === 0 && this.store.reconcileBlocked() === 0 && blockedWork === 0) return;
      if (Date.now() > deadline) throw new Error('drain timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * A tick whose failure is recorded rather than swallowed. Every timer and
   * fire-and-forget tick goes through here: a SQLITE_BUSY inside claimable()
   * used to stop dispatch with no trace at all. Recorded once per distinct
   * message per quiet window (with a count of what was suppressed), so a
   * persistent failure does not flood the timeline; the next tick still runs.
   */
  async pulse(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.noteTickError(err);
    }
  }

  private noteTickError(err: unknown): void {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const now = this.now();
    const last = this.tickError;
    if (last && last.message === message && now - last.at < TICK_ERROR_QUIET_MS) {
      last.suppressed++;
      return;
    }
    const tail = last?.suppressed ? ` (${last.suppressed} earlier failure(s) not recorded)` : '';
    this.tickError = { message, at: now, suppressed: 0 };
    try {
      this.store.record({ type: 'error', message: `scheduler tick failed: ${message}${tail}` });
    } catch {
      // The store itself may be what is failing; the trace line still lands.
    }
    process.stderr.write(`scheduler tick failed: ${message}${tail}\n`);
  }

  async tick(): Promise<void> {
    // A stopping daemon claims nothing: a run the stop just requeued must not be
    // relaunched behind stop()'s back (a tick can arrive from an in-flight
    // request or a gate settling). The lifetime, not `stopped`, so a scheduler
    // driven tick-by-tick (drain(), tests) still runs.
    if (this.lifetime.signal.aborted || this.dispatchPaused) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.store.runDueSchedules();
      this.runDueArchiveSweep();
      this.runDueAsks();
      this.runDueImprovements();
      this.runDueGates();
      this.store.reconcileBlocked();
      // A trainer or an adoption gate holds the machine-wide local-model lock
      // for hours, and starting new work under it is how a 17 GB machine ends
      // up 33 GB into swap — the exact collision the lock was created for after
      // it happened once for real. Work already running is left alone; only
      // dispatch pauses, so the queue drains the moment the lock frees.
      if (this.deferForLocalModelLock()) return;
      // Only the work lane consumes worker slots.
      const free = this.maxWorkers - this.laneCount('work');
      if (free <= 0) return;
      // While auto mode has fallen back, claude-code tickets are HELD — left
      // queued, attempts untouched — rather than claimed and failed: a lapsed
      // sign-in is not a defect in the ticket, and a retry budget burnt in
      // seconds would turn a five-minute lapse into a failed epic. Ask for
      // seconds would turn a five-minute lapse into a failed epic.
      const limited = this.limitHoldUntil > Date.now();
      const holding = cloudFallback() || limited;
      const held = holding ? this.store.queuedOnRunner('claude-code') : 0;
      // Held tickets are skipped while the queue is paged, not after the
      // window is cut: enough of them at the front would starve every repo.
      const usable = (t: { id: string; repo: string | null }): boolean =>
        // A repair round re-queues a task that is still finishing its run;
        // never let the same task hold two workers.
        !this.active.has(t.id)
        // Never cut a jail from a main that just failed its own tests.
        && !this.store.repoRed(t.repo)
        // Nor from an operator checkout with uncommitted changes: held, not claimed.
        && !(t.repo && this.dirtyHolds.has(path.resolve(t.repo)));
      for (const task of this.store.claimable(free, holding ? { excludeRunner: 'claude-code', usable } : { usable })) {
        if (this.laneCount('work') >= this.maxWorkers) break;
        if (!usable(task)) continue; // changed since the page was read
        if (!this.store.claim(task.id)) continue; // lost the race
        this.launch({ ...task, attempts: task.attempts + 1 });
      }
      // After dispatch, so work claimed this tick already counts as busy:
      // queued work gets the machine first, a re-check only the idle time.
      // (It is also never reached while the training lock defers dispatch, or
      // while every worker slot is taken — both return above.)
      this.runDueRechecks();
      this.recheckRedRepos();
      this.probeDirtyRepos();
      if (held !== this.lastHeld) {
        this.lastHeld = held;
        if (held) {
          const why = limited ? `the provider usage limit passes (${new Date(this.limitHoldUntil).toISOString()})` : 'the Claude CLI is back';
          process.stdout.write(`holding ${held} claude-code ticket(s) until ${why}\n`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Standing asks are planned then queued. Planning is a model call, so it
   * happens off the tick — a slow planner must not stall the pool.
   */
  private runDueAsks(): void {
    for (const due of this.store.claimDueAsks()) {
      void planAsk({ ask: due.ask, store: this.store, broker: this.broker, repo: due.repo })
        .then((plan) => {
          const { tasks } = queuePlan(this.store, plan);
          this.store.record({
            type: 'status',
            message: `standing ask '${due.title}' queued ${tasks.length} task(s)${plan.degraded ? ' (degraded plan)' : ''}`,
          });
        })
        .catch((err: Error) => {
          this.store.record({ type: 'error', message: `standing ask '${due.title}' failed to plan: ${err.message}` });
        });
    }
  }

  /** Weekly self-improvement: proposed off the tick, queued like any task. */
  private runDueImprovements(): void {
    for (const due of this.store.claimDueImprovements()) {
      void proposeImprovement(this.broker, gatherEvidence(this.store), { area: due.area })
        .then((proposal) => {
          const task = queueImprovement(this.store, proposal);
          this.store.record({
            taskId: task.id,
            type: 'status',
            message: `scheduled improvement '${due.title}' queued: ${proposal.title}${proposal.degraded ? ' (degraded)' : ''}`,
          });
        })
        .catch((err: Error) => {
          this.store.record({ type: 'error', message: `scheduled improvement '${due.title}' failed: ${err.message}` });
        });
    }
  }

  private launch(task: Task): void {
    // Read before startRun, or the "previous" run is the one we just opened.
    // Consumed on the spot: a session is offered to exactly one attempt.
    const previous = couldResume(task) ? this.store.latestRun(task.id) : null;
    const sessionId = resumableSession(task, previous);
    // The worktree rides along with the session: `keepJail` left the previous
    // round's tree on disk precisely so the round that continues its session
    // can edit the files that session remembers.
    const resume: ResumePlan | null =
      sessionId && previous
        ? { sessionId, worktreePath: previous.worktreePath, branch: previous.branch, baseCommit: previous.baseCommit ?? null }
        : null;
    if (resume && previous) this.store.setRunMeta(previous.id, { sessionId: null });

    const run = this.store.startRun(task.id);
    const controller = new AbortController();
    const entry: Active = { lane: 'work', taskId: task.id, runId: run.id, controller, done: Promise.resolve() };
    this.active.set(task.id, entry);
    entry.done = this.execute(task, run.id, controller, resume).finally(() => {
      const wasVerifying = this.active.get(task.id)?.lane === 'verify';
      this.active.delete(task.id);
      if (wasVerifying) this.releaseVerifySlot();
    });
  }

  private async execute(
    task: Task,
    runId: string,
    controller: AbortController,
    resume: ResumePlan | null = null,
  ): Promise<void> {
    const logPath = path.join(config.artifactRoot, `${runId}.log`);
    let logFd: number | undefined;
    let jail: Jail | undefined;
    let keepJail = false;
    /** Only the run that MADE a jail may destroy it (see the finally). */
    let createdJail = false;
    // Dropped to null if the worktree this session belongs to is gone: a
    // session resumed anywhere else cannot be found, and would edit the wrong
    // tree if it were.
    let resumeSession = resume?.sessionId ?? null;
    // The one deadline this run has (src/runClock.ts).
    const runTimeoutMs = this.taskTimeoutMs;
    // Time queued behind other runs (for a test slot or the verify lane, or the slot its own worker asked the wrapper
    // for: slotQueued) is not this run's own time: the clock stops while queued and the deadline moves on by the
    // wait. Finished Kiln tickets were cancelled ('aborted while waiting for a verify slot') when their 30 minutes
    // ran out in these queues on a busy machine.
    /** The stage the deadline came in, for the message the run ends with. */
    let expiredIn: string | null = null;
    // What this run records about itself on its own row (runFacts.ts): filled in as it goes, written in the finally.
    const facts = newRunFacts();
    const clock = this.runClockFn(runTimeoutMs, () => {
      expiredIn = this.store.getRun(runId)?.stage ?? null;
      abortFor(controller, 'deadline');
    });
    const active = this.active.get(task.id);
    if (active?.runId === runId) active.clock = clock;
    // The deadline as a wall-clock instant too, so late stages can ask how much of it is actually left.
    let deadlineAt = clock.deadlineAt;
    const pauseDeadline = (): void => clock.pause('verify-lane');
    const resumeDeadline = (): void => {
      clock.resume('verify-lane');
      deadlineAt = clock.deadlineAt;
    };
    const onSlotQueue = (queued: boolean): void => {
      if (queued) return clock.pause('test-slot');
      clock.resume('test-slot');
      deadlineAt = clock.deadlineAt;
    };
    /** How a run its own deadline ended is recorded: a timeout, with the stage and the queueing that was not charged. */
    const deadlineReached = (): string => deadlineNote(runTimeoutMs, expiredIn, clock.pausedMs);

    const writeLog = (line: string): void => {
      if (logFd === undefined) return;
      try {
        fs.writeSync(logFd, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* log best-effort; never fail a run on a log write */
      }
    };
    const emit = (line: string): void => {
      writeLog(line);
      this.store.record({ taskId: task.id, runId, type: 'log', message: line.slice(0, 4000) });
    };

    // Time spent queued for a verify slot (src/verify/slots.ts), summed onto the run.
    const onVerifyWait = (ms: number): void => {
      this.store.addVerifyWait(runId, ms);
      emit(`waited ${ms}ms for a verify slot`);
    };

    try {
      fs.mkdirSync(config.artifactRoot, { recursive: true });
      logFd = fs.openSync(logPath, 'a');

      // --- admit ---------------------------------------------------------
      this.store.setRunStage(runId, task.id, 'admit', `runner ${task.runner}`);
      // Asked once for the whole run (admission, brief, run check, diff
      // options): each ask is a git process the event loop waits on.
      const selfTask = isSelfTask(task, this.selfRoot);
      const findings = admit(task, { selfRoot: this.selfRoot, isSelf: selfTask });
      for (const f of findings) emit(`admission ${f.severity}: ${f.message}`);
      // The run log is read by nobody at the gate: a core-guard finding also
      // goes in the timeline, and on the park note below.
      for (const f of findings) {
        if (f.rule !== 'core-guard') continue;
        this.store.record({ taskId: task.id, runId, type: 'warning', message: `${CORE_GUARD_PREFIX}${f.message}`.slice(0, 4000) });
      }

      const runner = getRunner(task.runner);
      const blocked = await runner.preflight(task);
      if (blocked) throw new Error(blocked);

      // --- isolate -------------------------------------------------------
      this.store.setRunStage(runId, task.id, 'isolate');
      // A resumed round must land in the worktree its session was opened in.
      // `claude` scopes conversations per project directory, so a fresh jail
      // both loses the session ("No conversation found") and would apply a
      // transcript full of the previous jail's absolute paths to the wrong
      // tree — leaving this run's diff empty. Reuse it, and record it on THIS
      // run's row so diff, artifacts and merge all act on the same place.
      if (resumeSession && resume?.worktreePath) {
        jail = (await reuseJail(task, resume.worktreePath, resume.branch, resume.baseCommit)) ?? undefined;
      }
      if (jail) {
        // In the timeline, not just the log: "which tree did this round edit"
        // is the first question a rejected repair round raises.
        emit(`reusing the previous round's worktree ${jail.dir}`);
      } else {
        // Missing, pruned, never recorded, or no longer this repo's: cold is
        // safe, but cold WITH the session is not — that session lives in a
        // directory this run will not be in. Drop it rather than spend the
        // round on a `--resume` that cannot succeed.
        if (resumeSession) {
          emit(
            `the previous round's worktree is unusable (${resume?.worktreePath ?? 'none recorded'}); ` +
              'running cold instead of resuming',
          );
          resumeSession = null;
        }
        jail = await createJail(task, runId);
        createdJail = true;
        const carryFrom = this.store.carryRun(task.id);
        if (carryFrom && jail.repo) {
          const art = this.store.artifactsForTask(task.id).filter((a) => a.type === 'diff' && a.runId === carryFrom).at(-1);
          const conflictRound = isConflictRepair(task);
          const carried = art
            ? await carryDiff(jail, art.path, { keepConflicts: conflictRound })
            : { ok: false as const, reason: 'its diff artifact is gone' };
          if (conflictRound) {
            // The round is only worth running on a tree that holds the approved
            // work, with or without markers. Anything else would hand the
            // worker a bare main and park an empty round.
            const conflicted = carried.ok ? [] : 'conflicted' in carried ? carried.conflicted ?? null : null;
            if (!conflicted) throw new ConflictRoundAbandoned(`the approved diff would not apply onto current main: ${carried.ok ? '' : carried.reason}`);
            // Named here, in the jail where the apply happened; carry_run stays
            // set until this round is reviewed, so a requeue carries it again.
            task = { ...task, repairNotes: conflictRepairNotes(conflicted, task.testCmd ?? null) };
            this.store.setRepairNotes(task.id, task.repairNotes!);
            emit(
              conflicted.length
                ? `applied the work of ${carryFrom} onto current main; conflict markers left in ${conflicted.join(', ')}`
                : `applied the work of ${carryFrom} onto current main without conflict markers`,
            );
          } else {
            emit(
              carried.ok
                ? `carried the work of ${carryFrom} into this jail; fix the critique on top of it`
                : `could not carry the work of ${carryFrom} (${carried.reason}); starting from the base`,
            );
            this.store.clearCarryRun(task.id);
          }
        }
      }
      // The base commit goes on the run row, out of the worker's reach; a
      // round that reuses this jail reads it from there (isolate.ts jailBase).
      this.store.setRunMeta(runId, { worktreePath: jail.dir, branch: jail.branch, baseCommit: jail.baseCommit ?? null });
      writeLog(`jail: ${jail.dir}${jail.branch ? ` (branch ${jail.branch})` : ''}`);
      if (task.baseRef) {
        // Worth saying out loud: if the ref was pruned the ticket silently
        // opens on HEAD, and the agent should not have to deduce that from an
        // absent file.
        emit(
          jail.base === task.baseRef
            ? `cut from ${task.baseRef}, the branch carrying the work this ticket is about`
            : jail.baseMerged
              ? `base ref ${task.baseRef} has merged; cut from HEAD, which carries that work and everything merged since`
              : `base ref ${task.baseRef} is gone; cut from HEAD instead — the work this ticket reviews is not in this tree`,
        );
      }

      // A worktree never carries a gitignored node_modules, so the test gate
      // would run against an uninstalled tree and fail a good change.
      if (jail.repo) {
        const deps = await provisionDeps(jail.dir, jail.repo, {
          allowInstall: true,
          signal: controller.signal,
          onLine: emit,
        });
        emit(`deps: ${deps.reason}${deps.provisioned ? ` (${deps.ms}ms)` : ''}`);
      }

      // --- execute -------------------------------------------------------
      // A resumed round sends the critique alone; the session already holds the
      // brief it would otherwise re-buy in full.
      // What the run before this one recorded, for the repair notes' first line (repairOpening).
      const before = task.repairNotes ? previousRound(this.store, task.id, runId) : null;
      const built = collectBriefCuts(() => !runner.takesBrief
        ? task.prompt
        : resumeSession
          ? repairBrief(task, before) + resumedSkillsBrief(this.store, task)
          : briefFor(this.store, task, this.selfRoot, selfTask, before));
      const brief = built.value;
      noteBrief(facts, brief, built.cuts);
      if (resumeSession) emit(`resuming claude session ${resumeSession} with the critique only`);
      // Which skills this run's brief carries, on the run, so outcomes can be joined to them later.
      const carried = runner.takesBrief ? skillsRunEvent(task, Boolean(resumeSession)) : null;
      if (carried) {
        writeLog(`skills ${carried}`);
        this.store.record({ taskId: task.id, runId, type: 'skills', message: carried });
      }
      const ctx: RunnerContext = {
        task: { ...task, prompt: brief },
        runId,
        dir: jail.dir,
        signal: controller.signal,
        broker: this.broker,
        resumeSession,
        stage: (stage: Stage, message?: string) => this.store.setRunStage(runId, task.id, stage, message),
        child: (pid: number | null) => this.store.setRunPid(runId, pid),
        session: (id: string) => this.store.setRunMeta(runId, { sessionId: id }),
        log: emit,
        progress: (fraction: number) => this.store.setRunProgress(runId, task.id, fraction),
        usage: (u) => this.store.addUsage(runId, task.id, u),
        enqueue: (spec) => {
          const child = this.store.addTask({ ...spec, parentId: task.id });
          emit(`queued follow-up task ${child.id}: ${child.title}`);
          return child;
        },
      };
      let result = await runner.run(ctx);
      noteResult(facts, result);
      // A provider quota refusal is not a verdict on the work: hold, don't fail.
      if (!result.ok && task.runner === 'claude-code' && isProviderLimit(result.summary)) {
        throw new ProviderLimited(result.summary ?? 'provider usage limit');
      }
      // A worker that ended its turn with its own test run still in the background has confirmed nothing, and a
      // review of it is spent on "unconfirmed". Resume the same session once to get the result; with no session to
      // resume (or after the one resume), requeue it as a pre-review repair, which calls no reviewer.
      let backgroundGap: PreReviewGaps | null = null;
      if (result.ok && backgroundTestPending(result.report ?? result.summary)) {
        const session = task.runner === 'claude-code' && process.env['FOREMAN_CLAUDE_RESUME'] !== 'off'
          ? this.store.getRun(runId)?.sessionId ?? null
          : null;
        let resumeFailed = false;
        let latest = result;
        if (session) {
          emit(`the worker ended its turn with a test run still in the background; resuming session ${session} once for its result`);
          const first = result;
          const resumed = await runner.run({ ...ctx, resumeSession: session, task: { ...ctx.task, prompt: BACKGROUND_RESUME_PROMPT } });
          if (!resumed.ok && isProviderLimit(resumed.summary)) throw new ProviderLimited(resumed.summary ?? 'provider usage limit');
          if (!resumed.ok) {
            // The work was done; only the wait for its tests failed. Not a
            // worker failure: keep the first result and requeue it below.
            emit(`the resume failed (${(resumed.summary ?? '').slice(0, 200)}); keeping the first result`);
            resumeFailed = true;
          } else {
            latest = resumed;
            // The resumed turn often carries only the test result: the map and
            // the account of the work are in the first. Both go on, in order.
            const join = (a: string | undefined, b: string | undefined): string => `${a ?? ''}\n--- after resume ---\n${b ?? ''}`;
            result = {
              ...resumed,
              report: join(first.report ?? first.summary, resumed.report ?? resumed.summary),
              summary: boundSummary(join(first.summary, resumed.summary)),
            };
          }
          noteResumed(facts, resumed, resumeFailed ? undefined : result.report);
        }
        if (resumeFailed || (result.ok && backgroundTestPending(latest.report ?? latest.summary))) {
          emit('the worker still left its test run in the background; requeuing without a review');
          backgroundGap = {
            items: ['test run left in the background'],
            notes: BACKGROUND_RESUME_PROMPT,
            scope: [],
          };
        }
      }

      // A tool task must deliver the whole layout, or there is nothing to test.
      if (task.kind === 'tool' && result.ok) {
        const check = checkBuiltTool(jail.dir);
        if (!check.ok) {
          emit(`tool build incomplete: ${check.reason}`);
          result = { ...result, ok: false, summary: `tool build incomplete: ${check.reason}` };
        }
      }

      // --- collect evidence ----------------------------------------------
      // Status moves on, but the stage rail stays on `work` until the tests
      // actually start: attributing artifact collection to `verify` made
      // `test` the final stage event of a failing run, so it never recorded a
      // duration and the latency report showed N=0 for the stage that hurts.
      // Not once the run was stopped: a cancel (or a Retry after it) already set
      // the status this would overwrite; the verify lane throws on the abort.
      if (!controller.signal.aborted) this.store.setStatus(task.id, 'verifying');
      emit('collecting artifacts');
      this.store.addArtifact({ runId, taskId: task.id, type: 'log', path: logPath, summary: 'run log' });
      // The worker's whole final message, stored once: the run row holds only a bounded copy of it. Only a worker
      // that was given a brief writes one — the shell and demo runners' summary is Foreman's own sentence.
      const reportPath = runner.takesBrief && runner.verifiable ? storeReport(this.store, runId, task.id, result.report ?? result.summary) : null;

      let diff = '';
      // Pre-existing assertions the diff removed or changed: told to the reviewers, and a hold for a person.
      let assertionNote: string | null = null;
      // A change to Foreman itself, by a run not allowed to touch its core.
      const guarded = !!jail.repo && selfTask && !task.allowCore;
      if (jail.repo) {
        // A jail whose base cannot be found (its branch was reset onto
        // unrelated history) has no diff to review; for a guarded run that is
        // the guard's refusal and final, not an error worth another attempt.
        // The tree this diff describes, taken on both sides of it: the landing
        // merges exactly this tree or nothing (merge.ts), so the two must be
        // about the same content. A jail still being written while its diff is
        // read has no one tree to record, and the run fails rather than park
        // work nobody can say was reviewed. (A jail git cannot read at all is
        // diffJail's failure to report, as before.)
        const treeBefore = await jailTree(jail.dir).catch(() => null);
        diff = await diffJail(jail).catch((err: Error) => {
          if (!guarded) throw err;
          throw new CoreChangeRefused(`core change refused: the paths this run changed could not be listed (${err.message.slice(0, 200)})`);
        });
        const reviewedTree = await jailTree(jail.dir);
        if (reviewedTree !== treeBefore) {
          throw new Error('the worktree changed while its diff was being collected: something is still writing to it, so there is no one tree to review');
        }
        this.store.setRunMeta(runId, { reviewedTree });
        if (diff.trim()) {
          const diffPath = path.join(config.artifactRoot, `${runId}.diff`);
          fs.writeFileSync(diffPath, diff);
          const changed = diff.split('\n').filter((l) => l.startsWith('+++ ')).length;
          this.store.addArtifact({
            runId, taskId: task.id, type: 'diff', path: diffPath,
            summary: `${changed} file(s) changed on ${jail.branch}`,
          });
          assertionNote = recordAssertionChanges(this.store, runId, task.id, diff, jail.dir);
          if (assertionNote) emit('pre-review check: the diff changes pre-existing assertions or the values they use — the reviewer is told; where an assertion itself is affected the owner model does not sign it off');
        } else {
          emit('no changes produced in the worktree');
        }
        // Checked on what was actually written, not on what was asked for —
        // after the artifact exists, so a refused attempt is still reviewable.
        // The diff text is read here; git's own listing decides (assertCoreUntouched).
        if (guarded) {
          assertSelfDiffAllowed(task, diff, this.selfRoot, selfTask);
          await this.assertCoreUntouched(jail, diff.trim() !== '');
        }
        // A conflict round parks only a tree that is a real, resolved change on
        // main: markers still in it would land as text, and an empty one would
        // be approved as done with the work gone. Either goes back to the gate
        // on the approved run. (After the guard's refusals, which stay fatal.)
        if (isConflictRepair(task)) {
          // A check that could not run is not a clean tree: the round is dropped.
          const left = await leftoverMarkers(jail).catch((err: Error) => {
            throw new ConflictRoundAbandoned(`could not check the tree for conflict markers (${err.message})`);
          });
          if (left.paths.length) {
            throw new ConflictRoundAbandoned(
              `conflict markers are still in ${left.paths.join(', ')}` +
              (left.added.length ? ` (${left.added.join(', ')} added by this ticket itself — the marker may be a legitimate line such as =======)` : ''),
            );
          }
          if (!diff.trim()) throw new ConflictRoundAbandoned('the round produced no change against main');
        }
      }

      // A code run that ended well and changed nothing has nothing to test and nothing to show a reviewer: 60 crew
      // verdicts were bought on a worker's summary alone, and a ticket whose work was already on main got a full
      // verify of a tree identical to main. It parks for a person, who closes it or says what is missing. (A
      // conflict round with an empty diff was abandoned just above, as before.)
      const nothingToChange = task.kind === 'code' && !!jail.repo && result.ok && !diff.trim() && !isConflictRepair(task);
      // Set when the run parks for a person with no reviewer called and no repair round spent: the gate note.
      let personHold: string | null = nothingToChange ? nothingToChangeNote(result.summary) : null;
      if (nothingToChange) emit('no change produced: skipping the tests and the reviewers; a person closes it or says what is missing');
      // How far main has moved past this jail's base, when its test files changed on the way (verify/gateOutcome.ts).
      let behind: BehindMain | null = null;

      // --- test ------------------------------------------------------------
      let tests = { ran: false, passed: false, cmd: null as string | null, output: '' };
      // Set only when a playbook check (not testCmd) is what failed the
      // stage, so the verdict critique below can tell the two apart instead
      // of always saying "the project's own tests failed".
      let failedCheck: string | null = null;
      // Set only by the proseAudit block below; when present it REPLACES the
      // generic labels above with the exact 'prose audit: …' / 'fact drift: …'
      // string the manuscript playbooks want in the critique.
      let proseCritique: string | null = null;
      const pb = task.playbook ? getPlaybook(task.playbook) : null;
      if (result.ok && !nothingToChange && (jail.repo || task.kind === 'tool')) {
        const cmd = task.testCmd ?? (task.kind === 'tool' ? toolTestCommand(jail.dir) : detectTestCmd(jail.dir));
        if (cmd) {
          this.store.setRunStage(runId, task.id, 'test', cmd);
          // Said before the tests run, so a red gate on a stale jail is read with this above it. Read-only, in the
          // real repo; a failure to tell is logged and changes nothing.
          if (jail.repo) {
            behind = await behindMain(jail, cmd).catch((err: Error) => {
              emit(`could not tell whether the jail is behind main (${err.message.slice(0, 200)})`);
              return null;
            });
            if (behind) emit(behindLine(behind));
          }
          const runGate = (): ReturnType<typeof runTestsSlotted> => runTestsSlotted(
            jail!.dir, cmd, controller.signal,
            (line) => emit(`test: ${line}`),
            (pid) => this.store.setRunPid(runId, pid),
            onVerifyWait,
            onSlotQueue,
          );
          const first = await runGate();
          tests = first;
          // A gate that ran out of time with no failing test named is not the worker's failure: it is run once
          // more (one re-run per run, through the same slot), and a second timeout parks for a person.
          const timedOut = controller.signal.aborted ? null : gateTimeout(first);
          if (timedOut) {
            emit(`gate run timed out (${timedOut.seconds ?? '?'} s) with no failing test named; running it once more (${cmd})`);
            // The re-run is Foreman's decision, not the run's own work: its time is not the run's (the clock stops,
            // as for a queue). It is bounded all the same — runTests kills it at FOREMAN_TEST_TIMEOUT_MIN — and a
            // cancel or a daemon stop still ends it. Charged, a healthy ticket whose first gate run timed out met
            // its run deadline in the second and lost an attempt for it.
            clock.pause('gate-rerun');
            let second: Awaited<ReturnType<typeof runTestsSlotted>>;
            try {
              second = await runGate();
            } finally {
              clock.resume('gate-rerun');
              deadlineAt = clock.deadlineAt;
            }
            tests = second;
            const again = controller.signal.aborted ? null : gateTimeout(second);
            if (again) {
              personHold = timedOutTwiceNote(timedOut, again, second.output, PARK_NOTE_MAX);
              this.store.record({ taskId: task.id, runId, type: 'warning', message: personHold.slice(0, 4000) });
            } else if (second.passed) {
              emit('first gate run timed out, second passed');
              this.store.record({ taskId: task.id, runId, type: 'warning', message: 'first gate run timed out, second passed' });
            } else {
              emit('first gate run timed out; the second failed');
            }
          }
          // A gate that timed out twice did not pass, and the run says so in the one field the owner gate reads
          // whatever becomes of the park note (hardHumanReason: "the checks failed"). Left unset it read as "this
          // repo has no test command", and a later verdict on the run made it the owner model's to sign off.
          this.store.setTestsPassed(runId, tests.passed);
          emit(personHold ? `GATE TIMED OUT TWICE (${cmd}); not charged to the worker` : tests.passed ? `tests passed (${cmd})` : `TESTS FAILED (${cmd})`);
          // Red on a jail behind main, and every failing test file named is one main has changed since: parked
          // for a person rather than repaired against tests the ticket never saw.
          if (!personHold && !tests.passed && !controller.signal.aborted && failuresAllChangedOnMain(tests.output, jail.dir, behind, [...pathsInDiff(diff), ...quotedPathsInDiff(diff)])) {
            personHold = behindParkNote(behind!, tests.output, PARK_NOTE_MAX);
            this.store.record({ taskId: task.id, runId, type: 'warning', message: personHold.slice(0, 4000) });
          }
        } else {
          emit('no test command detected; council reviews the diff unaided');
        }

        // Playbook checks run after testCmd, same jail, same command helper.
        // Skipped once testCmd has already failed the stage — nothing left
        // to prove. Every check must exit 0; the first failure stops the run
        // (mirrors testCmd's own single-command fail semantics).
        if (pb?.checks.length && (!tests.ran || tests.passed) && !controller.signal.aborted) {
          const outputs = tests.output ? [tests.output] : [];
          // Only the checks actually run go into the joined label below — the
          // old code joined ALL of pb.checks even when the loop broke early,
          // so a run that failed on check #1 of 3 mislabeled itself with
          // checks #2 and #3 that never executed.
          const ranChecks: string[] = [];
          let checksPassed = true;
          for (const check of pb.checks) {
            if (controller.signal.aborted) { checksPassed = false; break; }
            this.store.setRunStage(runId, task.id, 'test', check);
            const r = await runTestsSlotted(
              jail.dir, check, controller.signal,
              (line) => emit(`check: ${line}`),
              (pid) => this.store.setRunPid(runId, pid),
              onVerifyWait,
              onSlotQueue,
            );
            emit(r.passed ? `check passed (${check})` : `CHECK FAILED (${check})`);
            outputs.push(r.output);
            ranChecks.push(check);
            checksPassed = r.passed;
            if (!r.passed) { failedCheck = check; break; }
          }
          tests = {
            ran: true,
            passed: checksPassed,
            cmd: [tests.cmd, ...ranChecks].filter(Boolean).join(' && '),
            output: outputs.join('\n'),
          };
          this.store.setTestsPassed(runId, tests.passed);
        }
      }

      // Manuscript playbooks (proseAudit: true) get an in-process check on top
      // of (or instead of) shell `checks` — no shell, no runTests: the audit
      // runs straight against the jail's filesystem. Only 'ban'-level findings
      // (hard tic bans, bible always-violations) fail the stage; metric-level
      // findings (echoes, outliers, crutch density) are WARN log lines only,
      // because a manuscript in progress shouldn't fail its stage on style
      // metrics. Skipped once testCmd/checks already failed — same "nothing
      // left to prove" rule the checks loop above uses.
      //
      // OUTSIDE the `jail.repo || kind === 'tool'` gate above: a manuscript
      // does not have to live in a git repo, and gating the audit on one meant
      // a book in a scratch jail was never checked at all. Only the factDrift
      // half needs git, and it says so when it cannot run.
      if (result.ok && !nothingToChange && pb?.proseAudit && (!tests.ran || tests.passed) && !controller.signal.aborted) {
        this.store.setRunStage(runId, task.id, 'test', 'prose audit');
        // In a worker: the audit is whole-book and superlinear in places (the original app
        // measured 505s on 16MB), and this is the daemon's only thread — every
        // second here is a second nothing else is claimed, launched or gated.
        let audit: ProseAuditResult | null = null;
        try {
          audit = await auditDirAsync(jail.dir, { signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          // A timed-out or crashed audit is not a pass: the manuscript was
          // never checked, so the stage fails and the critique says why.
          proseCritique = `prose audit: ${(err as Error).message}`;
          emit(`PROSE AUDIT FAILED: ${(err as Error).message}`);
        }

        if (audit && !audit.files.length) {
          // Nothing to audit is not a clean book. A scan that finds no scenes
          // passes vacuously — the exact way a misplaced manuscript (or a
          // wrong-directory ticket) used to sail through the gate.
          proseCritique = 'prose audit: no manuscript files found';
          emit('PROSE AUDIT FAILED: no .md/.txt manuscript files found in the jail');
        } else if (audit) {
          const bans = audit.findings.filter((f) => f.level === 'ban');
          const warns = audit.findings.filter((f) => f.level === 'warn');
          for (const w of warns) emit(`prose WARN: ${w.file ? `${w.file}: ` : ''}${w.message}`);
          if (bans.length) {
            proseCritique = `prose audit: ${bans.map((b) => `${b.file ? `${b.file}: ` : ''}${b.message}`).join('; ').slice(0, 900)}`;
            emit(`PROSE AUDIT FAILED: ${bans.length} ban-level finding(s)`);
          } else {
            emit(`prose audit passed (${audit.files.length} file(s), ${warns.length} warn(s))`);
          }
        }

        // factDrift guard: every .md/.txt file the runner touched, checked
        // against its pre-image at the jail's base commit. Reuses the same
        // git plumbing diffJail uses (intent-to-add + diff against the jail's base).
        if (!proseCritique) {
          if (!jail.repo) {
            emit('fact drift check skipped: this jail is a scratch directory, so there is no pre-image to compare against');
          } else {
            const touched = (await changedFiles(jail)).filter(
              (f) => /\.(md|txt)$/i.test(f.path) || (f.from !== null && /\.(md|txt)$/i.test(f.from)),
            );
            const drift: string[] = [];
            const sanctionSource = [task.prompt, task.acceptance ?? '', task.repairNotes ?? '', task.operatorDemands ?? ''].join('\n');
            for (const f of touched) {
              // A deletion drops every fact in the file at once — the biggest
              // drift there is, and invisible to a check that only looked at
              // the files that survived.
              if (f.status === 'deleted') {
                drift.push(`${f.path}: deleted`);
                continue;
              }
              // A rename drifts from its OLD name: that is where the pre-image is.
              const before = await showBaseFile(jail, f.from ?? f.path);
              if (before === null) continue; // new file — nothing to drift from
              const afterPath = path.join(jail.dir, f.path);
              if (!fs.existsSync(afterPath)) continue;
              const after = fs.readFileSync(afterPath, 'utf8');
              // A removal the ticket asked for in so many words is not drift.
              // The brief, the acceptance criteria and any repair note are what
              // the operator actually sanctioned; nothing else excuses a drop.
              const dropped = factDrift(before, after, sanctionSource);
              const label = f.from ? `${f.from} -> ${f.path}` : f.path;
              if (dropped.length) drift.push(`${label}: dropped ${dropped.join(', ')}`);
            }
            if (drift.length) {
              proseCritique = `fact drift: ${drift.join('; ').slice(0, 900)}`;
              emit(`FACT DRIFT: ${drift.join('; ')}`);
            }
          }
        }

        if (proseCritique) {
          tests = { ran: true, passed: false, cmd: tests.cmd, output: tests.output };
          this.store.setTestsPassed(runId, false);
        }
      }
      // --- the revert check, per test (verify/revertTests.ts) ----------------
      // FOREMAN_REVERT_TESTS=on only. A reviewer aid: each test the diff adds
      // or changes is run with the diff's non-test files put back, and the
      // table goes to the reviewer, onto the run, and to the owner gate. It
      // repairs, holds and fails nothing. Its commands go through
      // runTestsSlotted like the test stage (a verify slot outside, the
      // sandbox inside, the deadline stopped while it queues), in a scratch
      // tree outside the jail built from the reviewed tree. Its time is not
      // the run's (the clock stops, as for the gate re-run): it is Foreman's
      // aid, and a ticket must not meet its deadline in it. It is bounded on
      // its own (revertTests.ts: per test, per file, 600 s of run time), and a
      // cancel or a stop still ends it.
      let revertNote: string | null = null;
      const reviewedTree = jail?.repo ? this.store.getRun(runId)?.reviewedTree ?? null : null;
      if (revertTestsApplies({
        enabled: this.revertTests, kind: task.kind, repo: jail?.repo, workerOk: result.ok && !nothingToChange && !personHold,
        testsRan: tests.ran, testsPassed: tests.passed, diff, tree: reviewedTree, aborted: controller.signal.aborted,
      })) {
        this.store.setRunStage(runId, task.id, 'test', 'revert check, per test');
        clock.pause('revert-check');
        const checked = await revertTestsCheck({
          repo: jail!.repo!,
          base: await jailBase(jail!).catch(() => null),
          tree: reviewedTree!,
          workRoot: config.workRoot,
          runId,
          signal: controller.signal,
          run: async (dir, cmd, timeoutMs) => {
            // Every line: the TAP report is read off the whole output, not the tail runTests keeps.
            const lines: string[] = [];
            let waitedMs = 0;
            const r = await runTestsSlotted(
              dir, cmd, controller.signal,
              (line) => { if (lines.length < 100_000) lines.push(line); },
              (pid) => this.store.setRunPid(runId, pid),
              (ms) => { waitedMs += ms; onVerifyWait(ms); },
              onSlotQueue,
              { timeoutMs },
            );
            return { passed: r.passed, timedOut: r.killedAfterSec !== undefined, refused: r.refused === true, output: r.refused ? r.output : lines.join('\n'), waitedMs };
          },
          log: emit,
        }).finally(() => {
          clock.resume('revert-check');
          deadlineAt = clock.deadlineAt;
        });
        // Null: the run was stopped on the way, and the verify lane below ends it. n/a: nothing to say, nothing stored.
        if (checked?.status === 'n/a') emit(`revert check: n/a — ${checked.reason}`);
        else if (checked) {
          recordRevertTests(this.store, runId, task.id, checked);
          revertNote = revertTestsNote(checked);
          emit(`${revertTestsSummary(checked)} (${(checked.runMs / 1000).toFixed(1)}s run time) — for the reviewer; nothing is held on it`);
        }
      }
      // The test command and the checks ran in the jail as shell, after the
      // check above: asked again, so a protected file they wrote fails the run
      // here instead of reaching the reviewers on a diff that does not show it.
      if (guarded && jail.repo) await this.assertCoreUntouched(jail, diff.trim() !== '');
      // Give the worker slot back before the council runs: everything from
      // here is model wait, and another task's work can use the slot now.
      // A run already stopped has no place to take: it ends here, said as what stopped it.
      if (controller.signal.aborted) {
        const why = abortCause(controller.signal);
        throw new Error(
          why === 'deadline' ? deadlineReached()
            : why === 'stop' ? 'daemon stopping'
              : why === 'cancel' ? 'canceled' : 'aborted while waiting for a verify slot',
        );
      }
      pauseDeadline();
      try {
        await this.enterVerifyLane(task.id, controller.signal);
      } finally {
        resumeDeadline();
      }
      this.store.setRunStage(runId, task.id, 'verify', 'assembling the review');

      // --- verify ----------------------------------------------------------
      const logTail = fs.existsSync(logPath) ? tailLog(fs.readFileSync(logPath, 'utf8')) : '';
      let verdict: Verdict | null = null;
      // The binding reviewer wrote its verdict. Anything after that (the
      // non-binding shadow) can be cut short without interrupting the review.
      let reviewSettled = false;
      const halted = (): boolean => {
        const cause = abortCause(controller.signal);
        return cause === 'cancel' || cause === 'stop';
      };

      let preReview: PreReviewGaps | null = null;
      let preReviewNote: string | null = null;
      if (!result.ok) {
        verdict = this.store.addVerdict({
          runId, taskId: task.id, verdict: 'fail', disagreement: false, council: [],
          critique: `the worker itself failed: ${result.summary}`,
        });
      } else if (personHold) {
        // Nothing changed, the gate timed out twice, or it failed on tests main has since changed: no verdict is
        // written and no reviewer is asked. The note goes on the gate item below.
        emit('parking for a person: no reviewer called, no repair round spent');
      } else if (tests.ran && !tests.passed) {
        // Label only — same fail/repair semantics either way. A playbook
        // check failing is a different signal than the project's own test
        // suite failing, and the critique should say which one it was.
        const label = proseCritique ?? (failedCheck ? `playbook check failed (${failedCheck})` : `the project's own tests failed (${tests.cmd})`);
        // The repo's own tests, on a jail behind a main that has changed test files: said first, to the worker and the gate.
        const stale = behind && behind.testCommits > 0 && !proseCritique && !failedCheck ? `${behindLine(behind)}; ${BEHIND_ADVICE}\n` : '';
        verdict = this.store.addVerdict({
          runId, taskId: task.id, verdict: 'fail', disagreement: false, council: [],
          critique: `${stale}${label}:\n${tests.output.split('\n').slice(-40).join('\n')}`,
        });
      } else if (
        this.verifyEnabled && runner.verifiable
        && (preReview = mergeGaps(backgroundGap, preReviewGaps(task, diff, result.report ?? result.summary ?? null, jail?.repo ? jail.dir : null)))
        && preReviewRepairDue(preReview, task.preReviewRepairs ?? 0)
      ) {
        // A gap the pure checks can name needs no reviewer: the repair round
        // below carries the exact items or files, and no model is called.
        // A scope violation still standing after the last round fails the
        // ticket there (schedulePreReviewRepair refuses past the cap): a
        // forbidden path was written, which no reviewer may wave through.
        emit(`pre-review check: ${preReview.items.length} gap(s) — no reviewer called`);
      } else if (this.verifyEnabled && runner.verifiable) {
        // Map gaps still standing after the last pre-review repair go to the
        // reviewer instead of failing the ticket: the checks are heuristics
        // (a docs item naming "README's" once failed for not saying README.md),
        // and work whose tests passed is not thrown away on their word alone.
        if (preReview) {
          const rounds = task.preReviewRepairs ?? 0;
          emit(`pre-review gaps remain after ${rounds} repair round(s); the reviewer decides, with the gaps attached`);
          preReviewNote = `FOREMAN CHECK: the deterministic pre-review check still reports these gaps after ${rounds} repair round(s). They may be false positives; judge each against the diff and the acceptance:\n${preReview.items.join('\n')}`;
          preReview = null;
        }
        // Both crew-chain calls below get the note, apart from the report: the
        // report is bounded on its own (verify/report.ts), the note never cut.
        const foremanNote = [preReviewNote, assertionNote, revertNote].filter(Boolean).join('\n\n') || null;
        const crewReport: CrewReport = { text: result.report ?? result.summary ?? null, path: reportPath, note: foremanNote };
        const toolBody = task.kind === 'tool' ? toolEvidence(jail.dir) : '';
        const evidence: Evidence = {
          body: toolBody || diff.trim() || (result.report ?? result.summary),
          bodyLabel: toolBody ? 'tool' : diff.trim() ? 'diff' : 'output',
          testsPassed: tests.ran ? tests.passed : null,
          testOutput: tests.output,
          logTail: foremanNote ? `${foremanNote}\n\n${logTail}` : logTail,
        };
        // Under FOREMAN_CREW_REVIEW=always the crew chain runs regardless of
        // what the council says and its verdict is the one that lands, so the
        // council is latency nobody spends on the outcome. Run the chain first
        // and skip the council outright — unless the chain comes back null
        // (unavailable, nothing to review), which is exactly the case the
        // council still has to cover.
        let crew: CrewVerdict | null = null;
        if (crewLeadsVerify(task)) {
          this.store.setRunStage(runId, task.id, 'verify', 'crew review');
          // council: null is honest here — none ran. It costs the chain its
          // disagreement escalation (there is no second opinion to disagree
          // with); the consecutive-failure escalation still applies.
          crew = await this.runCrewChain(
            task, runId, evidence.body, null, controller.signal, emit, deadlineAt, jail?.branch ?? null, tests, jail?.repo ? jail.dir : null, crewReport,
          );
          if (crew) {
            verdict = crew.record;
            reviewSettled = true;
          }
          else if (!halted()) emit('crew review produced no verdict; falling back to the local council');

          // Shadow the cloud reviewer with a local one, for the record only.
          // This is the ONE path where the cloud verdict lands and the local
          // council would otherwise never run at all — which is exactly the
          // configuration long-form book work runs in, and so exactly where the evidence
          // for retiring the cloud gate has to be collected. See agreement.ts.
          if (crew && shadowEnabled()) {
            await this.recordShadowVerdict(task, runId, evidence, crew.record.verdict, controller.signal, emit, deadlineAt);
          }
        }

        // A canceled or stopping run asks no further reviewer: the gate below
        // ends it, and nobody would act on what a fallback said.
        if (!crew && !halted()) {
          this.store.setRunStage(runId, task.id, 'verify', 'council reviewing');
          try {
            // The local council is advisory and slow; the crew chain is the
            // reviewer that actually reads the work. Bounding the council keeps
            // it from spending the whole task deadline on models that time out
            // and leaving the real reviewer nothing — which is how three
            // chapters reached the gate unread.
            // A council that outlives its share keeps running, and used to
            // write its verdict anyway — minutes later, over whatever the crew
            // chain decided. With provisional verdicts that late row could
            // also block the gate and trigger a re-check overriding the
            // authoritative reviewer. So once given up on, it writes nothing.
            let gaveUp = false;
            verdict = await withDeadline(
              this.verifyFn({ task, runId, evidence, signal: controller.signal, onNote: emit, stillCurrent: () => !gaveUp }),
              councilShareOf(deadlineAt),
            );
            if (!verdict) gaveUp = true;
            if (!verdict) {
              // A climbing council has already written each round it finished.
              // The newest is still this run's best word: an empty split here
              // would read as "nothing has read this work" over a reviewer who had.
              const finished = finishedRound(this.store, task.id, runId);
              if (finished) {
                emit(`council ran out of its share of the deadline; keeping the last round it finished (${finished.verdict})`);
                verdict = finished;
              } else {
                emit('council ran out of its share of the deadline; going on to the crew chain with no local verdict');
                verdict = this.store.addVerdict({
                  runId, taskId: task.id, verdict: 'split', disagreement: false, council: [],
                  critique: 'the local council did not answer inside its share of the task deadline',
                });
              }
            }
          } catch (err) {
            if (err instanceof BudgetExceeded) throw err;
            emit(`council error: ${(err as Error).message}`);
            // A council aborted by a cancel or a stop is no review, and the run
            // it belongs to is ending: it gains no verdict row.
            if (!halted()) {
              verdict = this.store.addVerdict({
                runId, taskId: task.id, verdict: 'split', disagreement: false, council: [],
                critique: `council could not run: ${(err as Error).message.slice(0, 500)}`,
              });
            }
          }

          // The playbook's own review chain, after the cheap local council and
          // the checks. Only crew tickets reach it, and it returns null whenever
          // it cannot or should not run — a non-crew task's path through here is
          // byte-identical to what it was before. Skipped when the chain already
          // ran above and came back empty: re-running it would buy the same
          // silence twice.
          if (task.playbook && !crewLeadsVerify(task) && !halted()) {
            const localVerdict = verdict?.verdict ?? null;
            this.store.setRunStage(runId, task.id, 'verify', 'crew review');
            const after = await this.runCrewChain(
              task, runId, evidence.body, verdict, controller.signal, emit, deadlineAt, jail?.branch ?? null, tests, jail?.repo ? jail.dir : null, crewReport,
            );
            if (after) {
              // Both reviewers have now answered the same question, and this
              // costs nothing extra: the local council already ran above and
              // the cloud chain just overrode it. Not recording the pair here
              // would throw away the cheapest evidence in the system.
              // A stepped-down local verdict is not the local model's answer,
              // and the agreement ledger scores per role, not per model — it
              // would be a wrong number recorded under the right name.
              if (localVerdict && shadowEnabled() && !verdict?.provisional) {
                this.store.addShadowVerdict({
                  taskId: task.id, runId,
                  playbook: task.playbook, role: task.role,
                  authoritative: after.record.verdict,
                  shadow: localVerdict,
                  shadowModel: verdict?.council?.map((c) => c.model).join('+') ?? null,
                  shadowCritique: verdict?.critique ?? null,
                });
                emit(
                  `shadow: local ${localVerdict} vs cloud ${after.record.verdict}` +
                  (localVerdict === after.record.verdict ? ' — agreed' : ' — DISAGREED'),
                );
              }
              verdict = after.record;
              reviewSettled = true;
            }
          }
        }
      }

      // --- gate ------------------------------------------------------------
      // Something may have stopped this run while it was being reviewed, and
      // then the verdict in hand is only what settled before that: a crew
      // chain cut off mid-review comes back null, which reads like "no chain".
      //  - A cancel: the operator's word stands, even if a retry has already
      //    requeued the task — no repair round (its raw UPDATE would requeue
      //    it again) and no park on top of the retry.
      //  - A daemon stop before the binding verdict: handed to the catch,
      //    which requeues the task for when the daemon is back (a stop during
      //    the non-binding shadow interrupts nothing).
      //  - The run's own deadline: it goes on with what it has — the deadline
      //    shares' degrade path, not an interruption.
      const cause = abortCause(controller.signal);
      const statusNow = this.store.getTask(task.id)?.status;
      if (cause === 'cancel' || (statusNow && TERMINAL_STATUSES.includes(statusNow))) {
        keepJail = true; // reviewed work, canceled: left for inspection, as the board's Cancel promises
        this.store.endRun(runId, 'canceled', { exitCode: result.exitCode ?? 1, summary: result.summary });
        emit(`not acting on the review: the task was ${cause === 'cancel' ? 'canceled' : `already ${statusNow}`}`);
        return;
      }
      if (cause === 'stop' && !reviewSettled) throw new Error('the daemon stopped while the work was being reviewed');

      keepJail = true; // the operator may want to inspect it either way
      // The conflict round reached its review: what it carried has done its job.
      if (isConflictRepair(task)) this.store.clearCarryRun(task.id);
      if (preReview) {
        this.store.endRun(runId, 'failed', { exitCode: result.exitCode ?? 1, summary: result.summary });
        if (this.store.schedulePreReviewRepair(task.id, preReview.notes, config.preReviewRepairs)) {
          emit('pre-review check found gaps; queuing an automatic repair round');
        } else {
          this.store.setStatus(task.id, 'failed', `pre-review repairs used up (${config.preReviewRepairs}): ${preReview.items.join('; ')}`.slice(0, 1000));
        }
        return;
      }
      // A fail from stepped-down models is not acted on: repairing or failing
      // the work on the word of the reviewers that did NOT get to look would
      // throw the full council's check away. It parks like a split, marked,
      // and the re-check sweep asks the full council once it fits.
      if (verdict?.verdict === 'fail' && !verdict.provisional) {
        this.store.endRun(runId, 'failed', { exitCode: result.exitCode ?? 1, summary: result.summary });
        const critique = verdict.critique ?? 'rejected by the council';
        recordEpisode(this.store, task, this.store.getRun(runId), verdict);
        if (this.store.scheduleRepair(task.id, critique)) {
          emit('council rejected the work; queuing one repair round');
        } else {
          this.store.setStatus(task.id, 'failed', critique.slice(0, 1000));
        }
        return;
      }

      this.store.setRunStage(runId, task.id, 'gate', 'awaiting your approval');
      this.store.endRun(runId, 'succeeded', { exitCode: result.exitCode ?? 0, summary: result.summary });
      // "split" and "nobody could read it" are not the same fact, and the gate
      // note has to say which. A ticket whose every advisor timed out used to
      // park as "council split — needs your call", which reads as reviewers
      // looked and disagreed; three chapters reached the gate that way with no
      // reviewer having read a word of them.
      const reviewed = wasReviewed(verdict);
      // Only the survivors-passed note: a partial FAIL writes the same receipt,
      // and a chain cut off after it (a stop mid-chair) also comes back null.
      const crewPassedPartly = !reviewed && this.store.eventsForTask(task.id)
        .some((e) => e.runId === runId && e.type === 'error' && isPartialPassNote(e.message));
      if (verdict && !reviewed) {
        emit(crewPassedPartly
          ? 'NOT REVIEWED by the council: no advisor could be reached; a crew reviewer passed it, but its chain was incomplete'
          : 'NOT REVIEWED: no reviewer could be reached; this work reaches you unread');
      }

      // A cancel that landed while the council was still answering must not be
      // undone by this park. The catch branch below already checks — this one
      // did not, so a cancel arriving during verify was overwritten with
      // `awaiting-approval`, and `runOwnerGate` a few lines down could then
      // approve and MERGE work the operator had explicitly stopped.
      //
      // Re-read rather than trusting the `task` captured before the await: it
      // is the whole point that something changed underneath.
      const nowStatus = this.store.getTask(task.id)?.status;
      if (nowStatus && TERMINAL_STATUSES.includes(nowStatus)) {
        emit(`not parking for approval: the task is already ${nowStatus}`);
        return;
      }
      // A round after an approval (the merge conflicted and Foreman requeued
      // it): the diff at the gate is not the one that was approved.
      const reapproval = this.store.hasEarlierApproval(task.id, runId)
        ? 'the diff changed since the earlier approval — it needs approving again'
        : null;
      const parkNote = personHold ? personHold
        : verdict && !reviewed
        ? unreviewedNote(verdict, crewPassedPartly)
        : verdict?.provisional
          ? `provisional ${verdict.verdict} from stepped-down models — re-checked by the full council once it fits`
          : verdict?.verdict === 'split'
            // A crew review that could not verify an acceptance item is a split of its own kind: nobody disagreed.
            ? (heldReason(verdict) ?? `council split — ${verdict.chairSummary ?? 'needs your call'}`).slice(0, 1000)
            : null;
      this.store.setStatus(
        task.id,
        'awaiting-approval',
        withDropped(
          this.store.withCoreGuard(
            task.id,
            reapproval ? (parkNote ? `${reapproval}; ${parkNote}` : reapproval) : parkNote,
            PARK_NOTE_MAX,
          ),
          this.store, task.id,
        ),
      );
      this.rememberOutcome(task, tests.cmd);
      recordEpisode(this.store, task, this.store.getRun(runId), verdict);
      // The at-park trigger: this ticket parked while we were watching, so
      // FOREMAN_GATE=owner counts for it (see gateEligible).
      this.parkedHere.add(task.id);
      this.runOwnerGate(task.id);
    } catch (err) {
      const aborted = controller.signal.aborted;
      facts.threw = true;
      facts.providerLimited = err instanceof ProviderLimited;
      const message = err instanceof Error ? err.message : String(err);
      writeLog(`ERROR: ${message}`);
      this.store.record({ taskId: task.id, runId, type: 'error', message: message.slice(0, 4000) });
      const cause = abortCause(controller.signal);
      // The run's own deadline is a timeout, never a cancel: nobody canceled it.
      const timedOut = cause === 'deadline' ? deadlineReached() : null;
      this.store.endRun(runId, aborted && !timedOut ? 'canceled' : 'failed', { summary: (timedOut ?? message).slice(0, 4000) });

      const current = this.store.getTask(task.id);
      const fatal = err instanceof AdmissionBlocked
        || err instanceof SensitivityViolation || err instanceof CoreChangeRefused;
      if (cause === 'cancel') {
        // The cancel set the status before it aborted the run, and this run
        // moves it no further; a Retry since then stands.
      } else if (cause === 'stop' && current && !TERMINAL_STATUSES.includes(current.status)) {
        // A daemon stop is not a verdict on the work. The task goes back in
        // the queue for when the daemon returns, as after a crash — the
        // worktree kept (follow-up tickets may branch from it), the attempt
        // given back, and a ticket that keeps being stopped sent to the
        // operator (Store.requeueAfterStop).
        keepJail = true;
        this.store.requeueAfterStop(task.id);
      } else if (timedOut && current && !TERMINAL_STATUSES.includes(current.status)) {
        // Out of time, wherever it was (the worker's turn, its tests, a queue): the work so far stays on disk, and
        // the task takes the same road as any failed attempt — requeued while attempts remain, failed after. A
        // refusal that is final on its own (admission, sensitivity, the core guard) stays final, and says so.
        keepJail = true;
        if (fatal) this.store.setStatus(task.id, 'failed', message.slice(0, 1000));
        // A budget hard-stop that comes with the deadline is still the operator's decision, never another attempt.
        else if (err instanceof BudgetExceeded) this.store.setStatus(task.id, 'awaiting-approval', this.store.withCoreGuard(task.id, `budget hard-stop: ${message.slice(0, 500)}`, PARK_NOTE_MAX));
        else if (task.attempts >= task.maxAttempts) this.store.setStatus(task.id, 'failed', timedOut.slice(0, 1000));
        else this.store.setStatus(task.id, 'queued', `attempt ${task.attempts} failed: ${timedOut.slice(0, 500)}`);
      } else if (aborted || current?.status === 'canceled') {
        if (current?.status !== 'canceled') this.store.setStatus(task.id, 'canceled', 'aborted');
      } else if (err instanceof ProviderLimited) {
        // The account hit its limit (src/providerLimit.ts). Give the attempt
        // back, requeue, and stop claiming claude-code work until the backoff
        // passes — the rest of the queue would only hit the same wall.
        keepJail = true;
        this.limitHoldUntil = Date.now() + limitBackoffMs();
        this.store.requeueAfterLimit(task.id, new Date(this.limitHoldUntil).toISOString());
      } else if (err instanceof DirtyRepoError && task.repo) {
        // The operator's checkout has uncommitted changes. Not a defect in the
        // ticket (10 runs failed this way in 14s once): give the attempt back,
        // requeue, and hold every claim for the repo until a probe finds it
        // clean — see probeDirtyRepos.
        const files = message.split('\n').slice(1).join(', ') || 'uncommitted changes';
        this.holdDirtyRepo(task.repo, files);
        this.store.record({ taskId: task.id, runId, type: 'warning', message: `held: ${task.repo} has uncommitted changes (${files}); requeued until the checkout is clean` });
        this.store.requeueAfterDirty(task.id, `held: the repo checkout has uncommitted changes (${files.slice(0, 300)}); resumes once it is clean`);
      } else if (err instanceof ConflictRoundAbandoned) {
        this.store.abandonConflictRound(task.id, runId, err.message);
      } else if (err instanceof BudgetExceeded) {
        // A breach is a decision for the operator, not a failure to retry.
        this.store.setStatus(task.id, 'awaiting-approval', this.store.withCoreGuard(task.id, `budget hard-stop: ${message.slice(0, 500)}`, PARK_NOTE_MAX));
      } else if (fatal || task.attempts >= task.maxAttempts) {
        this.store.setStatus(task.id, 'failed', message.slice(0, 1000));
      } else {
        this.store.setStatus(task.id, 'queued', `attempt ${task.attempts} failed: ${message.slice(0, 500)}`);
      }
    } finally {
      clock.stop();
      if (logFd !== undefined) fs.closeSync(logFd);
      // A reused worktree belongs to the run that created it — and that run's
      // row still points at it. This one only cleans up what it made.
      if (jail && createdJail && !keepJail) await removeJail(jail).catch(() => {});
      // A record only: a ledger that cannot take it must not change how the run ended.
      try {
        this.store.setRunFacts(runId, { ...facts, endedReason: endedReason(facts, abortCause(controller.signal), this.store.getRun(runId)?.status) });
      } catch (err) {
        writeLog(`run facts not recorded: ${(err as Error).message}`);
      }
      this.pruneEvents(task.id);
    }
  }

  /**
   * The run's core guard: git's own listing of every path the jail differs in
   * from its base — committed in the jail, uncommitted and untracked alike
   * (isolate.ts jailChanges, the same listing the landing check uses). A
   * listing that fails, or comes back empty for a jail that holds a change, is
   * a refusal. The landing check (merge.ts) asks again for anything later.
   */
  private async assertCoreUntouched(jail: Jail, diffNonEmpty: boolean): Promise<void> {
    const listed = await jailChanges(jail).catch((err: Error) => {
      throw new CoreChangeRefused(`core change refused: the paths this run changed could not be listed (${err.message.slice(0, 200)})`);
    });
    const refusal = coreRefusal(listed.paths, listed.changed || diffNonEmpty);
    if (refusal) throw new CoreChangeRefused(refusal);
  }

  /**
   * The playbook's review chain, with the one degradation rule it has always
   * had: a chain that throws leaves the caller holding whatever verdict it
   * already has, rather than wedging a ticket nobody can move. Null means "no
   * crew verdict" — the caller decides what to keep instead.
   */

  /**
   * Ask a local reviewer the same question the cloud reviewer was just asked,
   * and write down both answers.
   *
   * Non-binding by construction: the result is never assigned to `verdict` and
   * never reaches the gate. It exists so that "the local models are good enough
   * now" can one day be a measured claim instead of a hopeful one.
   *
   * Failures are swallowed deliberately. A shadow verdict is bookkeeping, and
   * bookkeeping must never be able to fail a ticket whose real review passed —
   * that would make collecting the evidence more expensive than not collecting
   * it, and the mechanism would be turned off.
   */
  private async recordShadowVerdict(
    task: Task,
    runId: string,
    evidence: Evidence,
    authoritative: CouncilVerdict,
    signal: AbortSignal,
    emit: (line: string) => void,
    deadlineAt: number,
  ): Promise<void> {
    try {
      this.store.setRunStage(runId, task.id, 'verify', 'shadow (local, non-binding)');
      const shadow = await withDeadline(
        this.verifyFn({ task, runId, evidence, signal, onNote: () => {}, shadow: true }),
        councilShareOf(deadlineAt),
      );
      if (!shadow) {
        emit('shadow: the local council did not answer in time — recorded as a split');
      }
      // A local reviewer that timed out did not agree with anything. Recording
      // the timeout as `split` is right, but when the cloud verdict is ALSO
      // split the pair reads as agreement — two failures to decide counted as
      // two reviewers deciding the same way, which inflates the number the
      // whole cutover decision rests on.
      if (!shadow && authoritative === 'split') {
        emit('shadow: neither reviewer reached a verdict — not recorded, two silences are not agreement');
        return;
      }
      if (shadow?.provisional) {
        emit('shadow: the local council ran on stepped-down models — not recorded as agreement evidence');
        return;
      }
      this.store.addShadowVerdict({
        taskId: task.id,
        runId,
        playbook: task.playbook,
        role: task.role,
        authoritative,
        shadow: shadow?.verdict ?? 'split',
        shadowModel: shadow?.council?.map((c) => c.model).join('+') ?? null,
        shadowCritique: shadow?.critique ?? null,
        costUsd: shadow?.costUsd ?? 0,
      });
      emit(
        `shadow: local ${shadow?.verdict ?? 'split'} vs cloud ${authoritative}` +
        ((shadow?.verdict ?? 'split') === authoritative ? ' — agreed' : ' — DISAGREED'),
      );
    } catch (err) {
      emit(`shadow verdict not recorded: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  private redCheckAt = 0;
  private readonly redChecking = new Set<string>();

  /**
   * A red repo is re-checked once its HEAD moves (someone fixed main), at most
   * every 15s; a pass releases what was held. See postMerge.ts.
   *
   * At the same HEAD it is re-checked too, on a backoff (redBackoffMs) and only
   * while a verify slot is free: a red main on a loaded machine was usually a
   * flake, and waiting for the operator's next commit held work for hours.
   */
  private recheckRedRepos(): void {
    const now = this.now();
    if (now - this.redCheckAt < (Number(process.env['FOREMAN_REDCHECK_MS']) || 15_000)) return;
    this.redCheckAt = now;
    for (const [repo, red] of this.store.redRepoList()) {
      if (this.redChecking.has(repo)) continue;
      this.redChecking.add(repo);
      void (async () => {
        let head = red.head;
        try {
          head = await this.repoHeadFn(repo);
          const moved = head !== red.head;
          const attempts = red.attempts ?? 0;
          if (!moved) {
            const due = red.nextCheckAt ?? (red.since ?? 0) + redBackoffMs(0);
            if (this.now() < due) return;
            // Speculative work: never queue behind real gate checks for it.
            const slots = verifySlotStats();
            if (slots.active >= maxVerifies() || slots.waiting > 0) return;
          }
          const check = await this.checkMainFn(repo, red.testCmd);
          // The check took minutes, and a merge may have landed and been
          // marked red at a newer HEAD meanwhile: that record is not the one
          // this check answered, and is neither cleared nor overwritten by it.
          // (Identity, not HEAD: a fix moving HEAD past the red one is exactly
          // what a passing check of the new HEAD is meant to release.)
          if (this.store.repoRed(repo) !== red) return;
          if (check.ok) {
            this.store.clearRepoRed(repo);
            this.store.record({ taskId: red.taskId, type: 'status', message: `main is green again at ${check.head.slice(0, 7)}; held work released` });
            process.stdout.write(`${repo}: main is green again; releasing held work\n`);
            this.store.reconcileBlocked();
          } else {
            // Still red: the same HEAD steps further along the backoff; a new
            // HEAD starts it over.
            const n = check.head === red.head ? attempts + 1 : 0;
            this.store.markRepoRed(repo, {
              ...red,
              head: check.head,
              reason: check.tail.slice(-2_000),
              attempts: n,
              nextCheckAt: this.now() + redBackoffMs(n),
            });
          }
        } catch (err) {
          // A check that could not even run (worktree add, a dependency
          // install, a moved repo) backs off like a failing one: retried every
          // window it ran an install each time. Recorded once per record.
          try {
            if (this.store.repoRed(repo) !== red) return;
            // A new HEAD starts the backoff over, as a failing check of it would.
            const n = head && head !== red.head ? 1 : (red.attempts ?? 0) + 1;
            // The HEAD seen this window, so the next one finds it unmoved and
            // waits out the backoff — a moved HEAD otherwise re-ran every window.
            this.store.markRepoRed(repo, { ...red, head: head || red.head, attempts: n, nextCheckAt: this.now() + redBackoffMs(n) });
            if (n === 1) {
              this.store.record({
                taskId: red.taskId, type: 'warning',
                message: `re-check of red main in ${repo} could not run: ${(err as Error).message.slice(0, 500)}; retrying on the backoff`,
              });
            }
          } catch {
            /* the store may be closing; next window */
          }
        } finally {
          this.redChecking.delete(repo);
        }
      })();
    }
  }

  private holdDirtyRepo(repo: string, files: string): void {
    const key = path.resolve(repo);
    const prior = this.dirtyHolds.get(key);
    // Several runs on one repo fail dirty together (one per worker): that is
    // one hold, not a probe each — only a probe finding it still dirty backs
    // off further.
    if (prior) {
      prior.files = files;
      return;
    }
    this.dirtyHolds.set(key, { files, probes: 0, nextProbeAt: this.now() + dirtyBackoffMs(0), probing: false });
  }

  /** Dirty-checkout probes in flight; stop() settles them before the store closes. */
  private readonly probes = new Set<Promise<void>>();

  /**
   * Release a dirty-checkout hold once `git status` comes back clean. The probe
   * is cheap and runs off the tick on a backoff, so a checkout left dirty for
   * a day neither spins nor burns a claim, run row or attempt per check.
   */
  private probeDirtyRepos(): void {
    const now = this.now();
    for (const [repo, hold] of this.dirtyHolds) {
      if (hold.probing || now < hold.nextProbeAt) continue;
      hold.probing = true;
      const probe = (async () => {
        try {
          let dirty: string;
          try {
            // Pinned, drivers off (isolate.ts pinnedGit): the repo's config is the one every jail can write, and
            // `status` hashes changed files through any clean filter it names.
            dirty = (await pinnedGit(repo, ['status', '--porcelain'])).stdout.trim();
          } catch (err) {
            // A probe that could not run proved nothing: still held, on the
            // same backoff, and the reason shown in place of the files.
            dirty = `git status failed: ${(err as Error).message.split('\n')[0]!.slice(0, 200)}`;
          }
          // A stopping daemon's store may already be closed.
          if (this.lifetime.signal.aborted) return;
          if (dirty) {
            hold.probes++;
            hold.files = dirty.split('\n').slice(0, 5).join(', ');
            hold.nextProbeAt = this.now() + dirtyBackoffMs(hold.probes);
            return;
          }
          // Only the hold this probe was for.
          if (this.dirtyHolds.get(repo) !== hold) return;
          this.dirtyHolds.delete(repo);
          this.store.record({ type: 'status', message: `${repo}: the checkout is clean again; held tickets released` });
        } catch (err) {
          // Fire-and-forget: a throw here would be an unhandled rejection.
          process.stderr.write(`dirty-checkout probe for ${repo} failed: ${(err as Error).message}\n`);
        } finally {
          hold.probing = false;
        }
      })();
      this.probes.add(probe);
      void probe.finally(() => this.probes.delete(probe));
    }
  }

  private async runCrewChain(
    task: Task,
    runId: string,
    diff: string,
    council: Verdict | null,
    signal: AbortSignal,
    emit: (line: string) => void,
    deadlineAt: number,
    branch: string | null = null,
    tests: { ran: boolean; passed: boolean; cmd: string | null } | null = null,
    treeDir: string | null = null,
    report: CrewReport | null = null,
  ): Promise<CrewVerdict | null> {
    try {
      return await crewReview({
        task,
        runId,
        store: this.store,
        diff,
        council,
        branch,
        tests,
        treeDir,
        workerReport: report?.text ?? null,
        reportPath: report?.path ?? null,
        foremanNote: report?.note ?? null,
        signal,
        onNote: emit,
        // What is left of the task deadline, not a fresh budget: the chain runs
        // inside the run it reviews.
        timeoutMs: Math.max(1_000, deadlineAt - Date.now()),
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      emit(`crew review error: ${(err as Error).message.slice(0, 500)} — keeping the council verdict`);
      return null;
    }
  }

  /**
   * Opt-in autonomy. A ticket that has just parked at the
   * gate and resolves to `owner` is decided by the Owner model — off the tick,
   * like runDueAsks, because it is a 2-minute CLI call and the pool must keep
   * turning. Single-flight per task so a slow call is not re-fired next tick,
   * abort-aware so `stop()` ends it, and one at a time process-wide.
   *
   * Called two ways, with different eligibility rules (see gateEligible): the
   * at-park trigger in execute(), where FOREMAN_GATE=owner counts, and the
   * per-tick sweep, where only a written-down opt-in does.
   *
   * Failure is not a decision: ownerGate itself degrades every uncertainty to a
   * hold, and anything that escapes it is logged and leaves the ticket parked.
   */
  private runOwnerGate(taskId: string): void {
    // Gated on the lifetime, not on `stopped`: a scheduler driven tick-by-tick
    // (drain(), tests) never "starts", but a stopped one must stay quiet.
    if (this.lifetime.signal.aborted || this.gating.has(taskId)) return;
    // Concurrency 1. Gates are rare, and each one is an uncapped-by-the-broker
    // Owner call: fanning the whole awaiting-approval backlog out at once was
    // twenty parallel CLI spawns and twenty times the bill. Whatever does not
    // start now is picked up by the next tick's sweep.
    if (this.gating.size >= 1) return;
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'awaiting-approval') return;
    if (!this.gateEligible(task)) return;
    if (this.gateAlreadyRan(taskId)) return;

    // Checked per gate, not per sweep: the previous gate in this sweep may be
    // what took us over. Not a decision, so it leaves no durable marker — the
    // ticket is gated normally once the day's spend rolls over.
    const broke = overDailyCap(this.store, this.broker.dailyCap);
    if (broke) {
      if (!this.budgetHeld.has(taskId)) {
        this.budgetHeld.add(taskId);
        this.store.record({ taskId, type: 'status', message: `owner-gate: hold — ${broke}` });
      }
      return;
    }
    this.budgetHeld.delete(taskId);

    const gatedRun = this.store.latestRun(taskId);
    const promise = ownerGate({
      task,
      run: gatedRun,
      store: this.store,
      signal: this.lifetime.signal,
      dailyCapUsd: this.broker.dailyCap,
      stillEligible: () => this.stillEligible(taskId),
      selfRoot: this.selfRoot,
    })
      .then((decision) => {
        // An approval unblocks whatever depended on this ticket; don't wait a tick.
        if (decision !== 'hold') void this.pulse();
      })
      .catch((err: Error) => {
        // Marked decided, like a real hold: a gate that blew up must not be
        // retried in a loop that spends money once per tick. Not when the daemon
        // is stopping — that is no decision, and it is asked again after — nor
        // once a newer run has parked: the marker would keep it from its own review.
        if (!this.lifetime.signal.aborted && this.stillParkedOn(taskId, gatedRun?.id)) this.store.markGateDecision(taskId, 'hold');
        this.store.record({
          taskId,
          type: 'error',
          message: `owner-gate: hold — the gate itself failed, leaving the ticket for the human: ${err.message.slice(0, 500)}`,
        });
      })
      .finally(() => {
        this.gating.delete(taskId);
        // A newer run parked while this one was being gated (a rejection, a
        // retry, a fresh park): it keeps its at-park eligibility and gets its
        // own owner review now.
        if (this.store.latestRun(taskId)?.id !== gatedRun?.id) this.runOwnerGate(taskId);
        else this.parkedHere.delete(taskId);
      });
    this.gating.set(taskId, promise);
  }

  /** Still eligible for the owner gate when its answer comes back (gate.ts applyGateReply). */
  private stillEligible(taskId: string): boolean {
    const task = this.store.getTask(taskId);
    return Boolean(task) && this.gateEligible(task!);
  }

  /** The ticket is still parked at the gate on the run that was being judged. */
  private stillParkedOn(taskId: string, runId: string | undefined): boolean {
    return this.store.getTask(taskId)?.status === 'awaiting-approval' && this.store.latestRun(taskId)?.id === runId;
  }

  /**
   * Who the sweep may hand to the Owner. An explicit opt-in (ticket or
   * playbook) always qualifies; FOREMAN_GATE=owner qualifies only a ticket this
   * process watched park, because an env var is live intent and must not
   * retroactively auto-decide a backlog a human was already sitting on. See
   * gate.ts:gateOptIn.
   */
  private gateEligible(task: Task): boolean {
    const house = this.store.defaultGate();
    if (gateOptIn(task, house)) return true;
    return this.parkedHere.has(task.id) && effectiveGate(task, house) === 'owner';
  }

  /**
   * One owner-gate call per park, forever. Every outcome — approve, reject,
   * hold, hard-human, crash — stamps `tasks.gate_decision`, which is the
   * durable "already decided" marker: it survives both a restart and
   * pruneEvents(), so the sweep below never re-asks the Owner about a held
   * ticket. (A budget deferral is not a decision and leaves no stamp.)
   */
  private gateAlreadyRan(taskId: string): boolean {
    return this.store.gateDecision(taskId) !== null;
  }

  /**
   * The net under the direct call in execute(): tickets that parked before a
   * restart (or while the gate was stopped) still get their decision. Cheap —
   * the gate lane is only ever the handful of tasks sitting at
   * `awaiting-approval` — and serial, one gate at a time.
   */
  private runDueGates(): void {
    // The batch takes the first look: whatever it claims occupies the single
    // gating slot, and whatever it leaves is gated one at a time below.
    this.runDueGateBatch();
    for (const task of this.store.awaitingApproval()) {
      if (this.gating.size >= 1) break; // one gate at a time; the rest wait a tick
      if (this.gating.has(task.id)) continue;
      if (!this.gateEligible(task)) continue;
      this.runOwnerGate(task.id);
    }
    // A ticket that left the gate needs neither the at-park exemption nor its
    // budget note again; both sets are bounded by what is parked right now.
    for (const id of [...this.parkedHere, ...this.budgetHeld]) {
      if (this.store.getTask(id)?.status !== 'awaiting-approval') {
        this.parkedHere.delete(id);
        this.budgetHeld.delete(id);
      }
    }
  }

  /**
   * The tickets one call can decide together: same epic, all eligible, all
   * green. An epic finishing (or a restart finding its tickets already parked)
   * is the case that used to cost one owner call per ticket.
   *
   * Only tickets that share a real parent are grouped — the epic is what makes
   * one prompt's shared context honest. A parentless ticket has nothing to
   * share and stays on the single path, which is also why a lone parked ticket
   * behaves exactly as it did before batching existed.
   */
  private collectGateBatch(): GateBatchItem[] {
    const groups = new Map<string, GateBatchItem[]>();
    for (const task of this.store.awaitingApproval()) {
      if (!task.parentId) continue;
      if (this.gating.has(task.id)) continue;
      if (!this.gateEligible(task)) continue;
      if (this.gateAlreadyRan(task.id)) continue;
      const group = groups.get(task.parentId) ?? [];
      if (group.length >= GATE_BATCH_MAX) continue;
      // Every hard-human short-circuit, per ticket, before the ticket can join
      // a batch — the same check ownerGate makes, made early so a hard-human
      // ticket never reaches the batch prompt at all.
      const run = this.store.latestRun(task.id);
      if (hardHumanReason(task, run, { ...reviewHolds(this.store, task.id), selfRoot: this.selfRoot })) continue;
      group.push({ task, run });
      groups.set(task.parentId, group);
    }
    for (const group of groups.values()) if (group.length > 1) return group;
    return [];
  }

  /** The batched half of the sweep; one call, one gating slot, N tickets. */
  private runDueGateBatch(): void {
    if (this.lifetime.signal.aborted || this.gating.size >= 1) return;
    if (!gateBatchEnabled()) return;
    // Over the cap there is nothing to batch: the single path below logs the
    // deferral per ticket, once, exactly as it did before.
    if (overDailyCap(this.store, this.broker.dailyCap)) return;

    const items = this.collectGateBatch();
    if (items.length < 2) return;
    const ids = items.map((i) => i.task.id);
    const gatedRuns = new Map(items.map((i) => [i.task.id, i.run?.id]));
    const promise = ownerGateBatch({
      items,
      store: this.store,
      signal: this.lifetime.signal,
      dailyCapUsd: this.broker.dailyCap,
      stillEligible: (taskId) => this.stillEligible(taskId),
      selfRoot: this.selfRoot,
    })
      .then((decisions) => {
        // An approval unblocks whatever depended on the ticket; don't wait a tick.
        if ([...decisions.values()].some((d) => d !== 'hold')) void this.pulse();
      })
      .catch((err: Error) => {
        // Marked decided per ticket, like a real hold: a batch that blew up must
        // not be retried in a loop that spends money once per tick.
        for (const taskId of ids) {
          if (!this.lifetime.signal.aborted && this.stillParkedOn(taskId, gatedRuns.get(taskId))) {
            this.store.markGateDecision(taskId, 'hold');
          }
          this.store.record({
            taskId,
            type: 'error',
            message: `owner-gate: hold — the batched gate itself failed, leaving the ticket for the human: ${err.message.slice(0, 500)}`,
          });
        }
      })
      .finally(() => {
        const moved: string[] = [];
        for (const taskId of ids) {
          this.gating.delete(taskId);
          // As on the single path: a newer run parked during the call keeps its
          // at-park eligibility and is gated in turn.
          if (this.store.latestRun(taskId)?.id !== gatedRuns.get(taskId)) moved.push(taskId);
          else this.parkedHere.delete(taskId);
        }
        for (const taskId of moved) this.runOwnerGate(taskId);
      });
    // Every batched ticket holds the slot, so the single path cannot re-fire one
    // of them while the call is in flight.
    for (const taskId of ids) this.gating.set(taskId, promise);
  }

  /** Cheap, deterministic facts worth carrying to the next run on this repo. */
  private rememberOutcome(task: Task, testCmd: string | null): void {
    if (!task.repo) return;
    if (testCmd) {
      this.store.rememberFact({
        scope: task.repo, key: 'test command', value: testCmd, confidence: 0.8, source: task.id,
      });
    }
  }

  /** Keep the events table bounded; the full log always lives on disk. */

  /**
   * Re-run the review on work that is already done, without redoing the work.
   *
   * The missing primitive. When a review comes back `split` the task parks for
   * a person, correctly — the council could not decide, and `split` never
   * passes. But the two things an operator could do about it were `approve`,
   * which signs off something nobody reviewed, and `retry`, which throws the
   * work away and drafts the chapter again from a cold jail. Neither is what
   * the situation calls for: the work is fine and untouched, it is the VERDICT
   * that is missing.
   *
   * This re-reads the diff the run already produced and asks the council again.
   * It is the right response to a review that failed for a reason that has
   * since been fixed — a context window that was silently dropping the
   * instructions, say, which is what put twenty-two chapter drafts here.
   */
  async reverify(taskId: string): Promise<Verdict | null> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'awaiting-approval') {
      throw new Error(`task ${taskId} is ${task.status}; only work parked at the gate can be re-reviewed`);
    }
    // One review of one task at a time: the automatic re-check and a manual
    // Re-review landing together would write two verdicts for one question.
    if (this.reverifying.has(taskId)) throw new Error(`task ${taskId} is already being re-reviewed`);
    const stored = this.storedEvidence(task);
    if (!stored) throw new Error(`task ${taskId} has no stored diff or summary to re-review`);
    const { run, evidence } = stored;

    this.reverifying.add(taskId);
    try {
      this.store.record({ taskId, type: 'status', message: 're-reviewing the stored result' });
      // Still parked on the same run when the verdict is written — not
      // approved, rejected or re-run in the minutes the review took.
      const stillCurrent = (): boolean =>
        this.store.getTask(taskId)?.status === 'awaiting-approval' && this.store.latestRun(taskId)?.id === run.id;
      // A crew ticket is reviewed by its crew chain, not the local council —
      // a re-review must ask the same reviewer the run did. Before, every
      // re-review went to the council: on Kiln phase 4a two tickets parked
      // UNREVIEWED by a usage limit could only ever come back `split`, because
      // the local council times out on this machine and the chain never ran.
      if (crewLeadsVerify(task)) {
        const emit = (line: string): void => void this.store.record({ taskId, runId: run.id, type: 'log', message: line });
        const tree = run.worktreePath && fs.existsSync(run.worktreePath) ? run.worktreePath : null;
        const crew = await this.runCrewChain(
          task, run.id, evidence.body, null, this.lifetime.signal, emit, Date.now() + this.taskTimeoutMs,
          run.branch ?? null,
          run.testsPassed === null ? null : { ran: true, passed: run.testsPassed, cmd: task.testCmd },
          tree, { ...storedReport(this.store, run), note: [storedAssertionNote(this.store, run), storedRevertTestsNote(this.store, run)].filter(Boolean).join('\n\n') || null },
        );
        if (crew && stillCurrent()) {
          this.store.clearGateDecision(taskId);
          this.store.record({ taskId, type: 'verdict', message: `re-review (crew): ${crew.record.verdict}` });
        }
        if (crew) return crew.record;
        emit('crew re-review produced no verdict; falling back to the local council');
      }
      const verdict = await this.verifyFn({
        task,
        runId: run.id,
        evidence,
        signal: this.lifetime.signal,
        onNote: (line) => this.store.record({ taskId, runId: run.id, type: 'log', message: line }),
        stillCurrent,
      });
      if (verdict && stillCurrent()) {
        // The council persists the verdict itself (addVerdict writes the run's
        // column), so there is nothing to write here — only to invalidate. A
        // fresh verdict is a fresh decision to make: whatever the owner gate or
        // a person concluded about the old one no longer applies.
        this.store.clearGateDecision(taskId);
        this.store.record({ taskId, type: 'verdict', message: `re-review: ${verdict.verdict}` });
      }
      return verdict;
    } finally {
      this.reverifying.delete(taskId);
    }
  }

  /** A re-review of this task is running now (the automatic re-check or a manual one). */
  isReverifying(taskId: string): boolean {
    return this.reverifying.has(taskId);
  }

  /**
   * The evidence a re-review reads: the diff the run wrote, read back off
   * disk, or its summary. From the stored artifact rather than the jail on
   * purpose — a jail can be pruned, and what is reviewed should be what was
   * produced, not what a worktree happens to hold now.
   */
  private storedEvidence(task: Task): { run: Run; evidence: Evidence } | null {
    const run = this.store.latestRun(task.id);
    if (!run) return null;
    // THIS run's diff — artifacts list oldest first, and the first diff of a
    // repaired or retried task is the previous attempt's. Reviewing that and
    // stamping the verdict on the latest run handed new work an old verdict,
    // and the opinion cache made the replay exact.
    const diffArtifact = this.store.artifactsForTask(task.id).filter((a) => a.type === 'diff' && a.runId === run.id).at(-1);
    let body = '';
    if (diffArtifact && fs.existsSync(diffArtifact.path)) body = fs.readFileSync(diffArtifact.path, 'utf8');
    if (!body.trim()) body = storedReport(this.store, run).text ?? '';
    if (!body.trim()) return null;
    return {
      run,
      evidence: { body, bodyLabel: diffArtifact ? 'diff' : 'output', testsPassed: run.testsPassed, testOutput: '', logTail: '' },
    };
  }

  /**
   * Fold week-old closed tasks into the archive, at most once an hour.
   *
   * On the tick rather than on a schedule row because it must happen whether or
   * not the operator ever configured anything — an unbounded Closed lane is a
   * default-path problem. It is a handful of indexed SQL statements over rows
   * that are, by construction, no longer moving, so the hourly gate is about
   * not paying it 14,400 times an hour, not about it being expensive.
   *
   * `FOREMAN_ARCHIVE_AFTER_DAYS=0` archives as soon as a task closes;
   * a negative value turns the sweep off entirely, for an operator who wants
   * to manage the lane by hand with `foreman archive`.
   */

  /**
   * True when new work must not start because something else owns the
   * machine's inference.
   *
   * Deliberately blunt: it pauses ALL dispatch, not just tasks that would touch
   * a local model. A cloud-runner ticket looks harmless until its verify stage
   * asks the local council for two opinions, and by then a worktree has been
   * cut and a model is loading. Distinguishing the two cases correctly means
   * predicting what a task will do before it does it, which is not knowable;
   * pausing for a few hours while an adapter trains is cheap and is correct.
   *
   * `FOREMAN_IGNORE_TRAINING_LOCK=1` opts out for an operator with the memory
   * headroom to run both — this machine does not, but another might.
   */
  private deferForLocalModelLock(): boolean {
    if (process.env['FOREMAN_IGNORE_TRAINING_LOCK'] === '1') return false;
    const holder = localModelLockHolder();
    if (!holder) {
      // Say so once, on the edge, so the log explains why the queue moved
      // again rather than leaving the operator to infer it.
      if (this.deferredForLock) {
        this.deferredForLock = false;
        this.store.record({ type: 'status', message: 'local-model lock released; dispatch resumed' });
      }
      return false;
    }
    if (!this.deferredForLock) {
      this.deferredForLock = true;
      this.store.record({
        type: 'status',
        message: `dispatch paused: ${holder.label} (pid ${holder.pid}) holds the local-model lock. Running work continues.`,
      });
    }
    return true;
  }

  /**
   * Re-review provisional work once the full council fits.
   *
   * A verdict is provisional when its council ran on stepped-down models
   * because the intended ones did not fit in memory (budget.ts). The work
   * itself is fine to keep; what it lacks is a review by the models the ladder
   * asked for. So once a minute — and only when no work and no review is
   * running, because the point is to use a machine that has freed up, not to
   * fight live work for it — the oldest provisional task whose full council
   * now fits is re-reviewed with `reverify`. One at a time; a re-check that
   * comes back provisional again (memory filled up mid-way) backs off.
   *
   * FOREMAN_RECHECK_MS sets the interval; a negative value turns it off.
   */
  private runDueRechecks(now = Date.now()): void {
    const interval = Number(process.env['FOREMAN_RECHECK_MS'] ?? 60_000);
    if (!Number.isFinite(interval) || interval < 0) return;
    if (this.recheckInFlight || now - this.lastRecheck < interval) return;
    this.lastRecheck = now;
    if (this.laneCount('work') > 0 || this.laneCount('verify') > 0) return;
    // Backoff is applied BEFORE the limit, so tasks waiting out a backoff
    // cannot hide the ones behind them. Keyed by RUN, not task: a retried or
    // repaired task is new work and starts with a clean slate.
    const keyOf = (t: Task): string => `${t.id}@${this.store.latestRun(t.id)?.id ?? ''}`;
    // Never a run that parked for a person with no reviewer called (notForRecheck): a `fail` here queues a repair
    // round, the round that park was meant to save.
    const waiting = this.store.provisionalAwaiting(200).filter((t) => !this.notForRecheck(t));
    const live = new Set(waiting.map(keyOf));
    for (const key of [...this.recheckNotBefore.keys()]) if (!live.has(key)) this.recheckNotBefore.delete(key);
    for (const key of [...this.recheckAttempts.keys()]) if (!live.has(key)) this.recheckAttempts.delete(key);
    const candidates = waiting
      .filter((t) => (this.recheckNotBefore.get(keyOf(t)) ?? 0) <= now && !this.reverifying.has(t.id))
      .slice(0, 10);
    if (!candidates.length) return;
    this.recheckInFlight = (async () => {
      for (const task of candidates) {
        if (!(await this.fullCouncilFits(task))) continue;
        const key = keyOf(task);
        this.store.record({ taskId: task.id, type: 'status', message: 'the full council fits now — re-checking the provisional review' });
        let verdict: Verdict | null = null;
        try {
          verdict = await this.reverify(task.id);
        } catch (err) {
          this.store.record({ taskId: task.id, type: 'log', message: `re-check did not complete: ${(err as Error).message.slice(0, 300)}` });
        }
        if (verdict && !verdict.provisional) {
          this.recheckNotBefore.delete(key);
          this.recheckAttempts.delete(key);
          this.settleRecheck(task.id, verdict);
          return;
        }
        // Came back provisional again (memory filled mid-way) or did not
        // finish: back off, doubling, and after four tries stop and say so —
        // a machine that never frees up is the operator's to know about.
        const attempts = (this.recheckAttempts.get(key) ?? 0) + 1;
        this.recheckAttempts.set(key, attempts);
        if (attempts >= 4) {
          this.recheckNotBefore.set(key, Number.POSITIVE_INFINITY);
          this.store.record({
            taskId: task.id, type: 'status',
            message: 'gave up re-checking automatically after 4 tries — the full council never fit; re-review by hand when the machine is free',
          });
        } else {
          this.recheckNotBefore.set(key, Date.now() + 15 * 60_000 * 2 ** (attempts - 1));
        }
        return;
      }
    })().finally(() => {
      this.recheckInFlight = null;
    });
  }

  /**
   * Whether the task's latest run is one the idle re-check leaves alone, by what the run recorded — never by the
   * park note, which a re-review, a refused approval or an idle tick can write over:
   *  - its checks did not pass (`testsPassed` false): the gate that timed out twice, and the red gate on a jail
   *    behind main, both end 'succeeded' with exactly this. A reviewer shown that run can only fail it;
   *  - a code run in a repo that recorded no diff: the "nothing to change" park (gate.ts reviewHolds.noChange).
   * A person can still ask for a re-review of either (`foreman reverify`); Foreman does not start one itself.
   */
  private notForRecheck(task: Task): boolean {
    const run = this.store.latestRun(task.id);
    if (!run) return false;
    if (run.testsPassed === false) return true;
    return task.kind === 'code' && Boolean(task.repo)
      && !this.store.artifactsForTask(task.id).some((a) => a.type === 'diff' && a.runId === run.id);
  }

  /**
   * Act on a full-council re-check the way the main path acts on a first
   * review. The park note said "provisional"; it no longer is, so it is
   * rewritten. A fail the full council CONFIRMED is now a real fail, and gets
   * the repair round the provisional one was held back from.
   */
  private settleRecheck(taskId: string, verdict: Verdict): void {
    const current = this.store.getTask(taskId);
    if (current?.status !== 'awaiting-approval') return;
    if (verdict.verdict === 'fail') {
      const critique = verdict.critique ?? 'rejected by the full council on re-check';
      if (this.store.scheduleRepair(taskId, critique)) {
        this.store.record({ taskId, type: 'status', message: 'the full council confirmed the fail; queuing one repair round' });
      } else {
        this.store.setStatus(taskId, 'failed', critique.slice(0, 1000));
      }
      return;
    }
    this.store.setStatus(
      taskId,
      'awaiting-approval',
      withDropped(
        this.store.withCoreGuard(
          taskId, verdict.verdict === 'split' ? `council split — ${verdict.chairSummary ?? 'needs your call'}`.slice(0, 1000) : null, PARK_NOTE_MAX,
        ),
        this.store, taskId,
      ),
    );
  }

  /**
   * Every local model the task's council could seat — its rung and every rung
   * it could escalate to — fits now, at the window the review will actually
   * ask for (sized from the same stored evidence `reverify` will send).
   */
  private async fullCouncilFits(task: Task): Promise<boolean> {
    const stored = this.storedEvidence(task);
    if (!stored) return false;
    const prompt = buildPrompt(task, stored.evidence);
    const advisorCtx = councilNumCtx(prompt);
    // The chair reads the prompt again plus two advisors' arguments.
    const chairCtx = councilNumCtx(`${prompt}\n${'x'.repeat(config.councilMaxOutputTokens * 4 * 2)}`);
    const need = new Map<string, number>();
    for (let rung = rungFor(task); rung <= MAX_RUNG; rung++) {
      const { advisors, chair } = councilAliases(task.sensitivity, rung, task.kind);
      for (const a of advisors) need.set(a, Math.max(need.get(a) ?? 0, advisorCtx));
      need.set(chair, Math.max(need.get(chair) ?? 0, chairCtx));
    }
    for (const [alias, numCtx] of need) {
      const spec = specs().get(alias);
      if (!spec || spec.provider !== 'ollama') continue;
      if (!(await this.broker.fits(spec.model, numCtx))) return false;
    }
    return true;
  }

  private runDueArchiveSweep(now = Date.now()): void {
    if (now - this.lastArchiveSweep < ARCHIVE_SWEEP_INTERVAL_MS) return;
    this.lastArchiveSweep = now;
    const raw = process.env['FOREMAN_ARCHIVE_AFTER_DAYS'];
    const days = raw === undefined || raw.trim() === '' ? DEFAULT_ARCHIVE_AFTER_DAYS : Number(raw);
    if (!Number.isFinite(days) || days < 0) return;
    try {
      this.store.archiveClosed(days, now);
    } catch {
      // A sweep is housekeeping. It must never be able to stop a tick, and so
      // never the queue, on a locked table or a mid-write snapshot.
    }
  }

  private pruneEvents(taskId: string): void {
    // The admission core-guard warning is written first in a run and read back
    // for every later park note (Store.withCoreGuard), so it is never pruned.
    // Nor is a `decision` (what was decided at the gate, by whom, with what
    // note) or a run's `skills` line (which skills its brief carried): one of
    // each per decision or run, and a long ticket's log pushed both out.
    this.store.db
      .prepare(
        `DELETE FROM events WHERE task_id = ? AND id NOT IN
           (SELECT id FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?)
           AND type NOT IN ('decision', 'skills')
           AND NOT (type = 'warning' AND substr(message, 1, ?) = ?)`,
      )
      .run(taskId, taskId, config.logLinesPerRun, CORE_GUARD_PREFIX.length, CORE_GUARD_PREFIX);
  }
}

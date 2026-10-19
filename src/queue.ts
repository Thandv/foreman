import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { signalGroups, snapshotPs, treeGroups, type PsRow } from './runners/proctree.ts';
import { FILED_PREFIX } from './verify/followUpChain.ts';
import { openDb, rowToArtifact, rowToDecision, rowToEvent, rowToRun, rowToTask } from './db.ts';
import { rowToArchive, rowToMemory, rowToVerdict } from './db.ts';
// Runtime edge queue → retro: retro.ts only type-imports Store back (erased),
// so there is no runtime cycle. The epic close is where a retrospective is owed.
import { dropRetrospective, writeRetrospective } from './assistant/retro.ts';
import { effectiveAssignee, readyStatus } from './assign.ts';
import type { ShadowPair } from './agreement.ts';
import {
  archiveTerms, DEFAULT_ARCHIVE_AFTER_DAYS, estimateFrom,
  type ArchiveRecord, type Estimate,
} from './archive.ts';
import { nextRunAt, parseSpec } from './schedule.ts';
import { assertTicketSkills } from './skills.ts';
import type {
  AdvisorOpinion, Artifact, Assignee, CouncilVerdict, Decision, GateMode, MemoryFact, Run, RunEvent, Stage, Task, TaskStatus, Verdict,
} from './types.ts';
import { chairRuled, DECISION_ACTIONS, DECISION_ACTORS, RUN_ENDED_REASONS, TERMINAL_STATUSES } from './types.ts';

/** The most of a decision's note the ledger keeps, in UTF-8 bytes, marker included. */
export const DECISION_NOTE_MAX_BYTES = 16 * 1024;
/** The most of `review_source` (who verified the work) the ledger keeps, in characters. */
export const REVIEW_SOURCE_MAX = 200;
/** How much of the note the timeline's `decision` event carries; the whole note is in the row. */
export const DECISION_EVENT_NOTE = 300;

/** What a path hands Store.addDecision: the row less its id and time, every approve-only field optional. */
export type NewDecision = Pick<Decision, 'taskId' | 'action'> & Partial<Omit<Decision, 'id' | 'at' | 'taskId' | 'action' | 'noteCutBytes'>>;

/** A note cut to the ledger's bound, with a marker saying how much went; `cut` is the bytes not stored. */
export function boundDecisionNote(note: string | null | undefined): { note: string | null; cut: number } {
  const text = note?.trim();
  if (!text) return { note: null, cut: 0 };
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= DECISION_NOTE_MAX_BYTES) return { note: text, cut: 0 };
  // The marker is paid for out of the bound (as in context.ts boundBrief); its own number is at most 12 digits.
  const budget = DECISION_NOTE_MAX_BYTES - 96;
  // Whole characters only: a cut inside a surrogate pair would store half a character.
  let kept = '';
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    kept += ch;
    used += n;
  }
  return { note: `${kept}\n… [FOREMAN cut this note here: ${size - used} more bytes were NOT stored]`, cut: size - used };
}

/** The timeline's short form of a decision: action, who, whether corrected (approvals only), the note's head. */
export function decisionEventMessage(d: Pick<Decision, 'action' | 'actor' | 'corrected' | 'note'>): string {
  const corrected = d.action === 'approve' ? `; corrected: ${d.corrected === null ? 'not stated' : d.corrected ? 'yes' : 'no'}` : '';
  const note = d.note ? ` — ${d.note.length > DECISION_EVENT_NOTE ? `${d.note.slice(0, DECISION_EVENT_NOTE)}…` : d.note}` : '';
  return `${d.action} by ${d.actor}${corrected}${note}`;
}

export interface NewTask {
  title: string;
  prompt: string;
  kind?: Task['kind'];
  repo?: string | null;
  agent?: string | null;
  runner?: Task['runner'];
  sensitivity?: Task['sensitivity'];
  budgetUsd?: number | null;
  priority?: number;
  maxAttempts?: number;
  deps?: string[];
  testCmd?: string | null;
  mergeOnApprove?: boolean;
  maxRepairs?: number;
  scheduleId?: string | null;
  parentId?: string | null;
  allowCore?: boolean;
  /** Branch or commit the jail is cut from; null/undefined means HEAD. */
  baseRef?: string | null;
  role?: string | null;
  playbook?: string | null;
  points?: number | null;
  acceptance?: string | null;
  /** Paths the ticket may not touch; null/undefined means none declared. */
  forbiddenPaths?: string[] | null;
  /** Skills for this ticket's role; null/undefined means the role's default. Refused, not trimmed, if any name fails (skills.ts). */
  skills?: string[] | null;
  isEpic?: boolean;
  /** Who decides at the gate; null resolves from playbook + FOREMAN_GATE. */
  gate?: Task['gate'];
  /** Who does the work; null resolves from playbook + FOREMAN_ASSIGNEE (default 'ai'). */
  assignee?: Task['assignee'];
}

/** Which slice of the spend ledger a receipt read covers. */
export type ReceiptWindow = 'today' | 'all';

export interface ReceiptTotals {
  calls: number;
  localCalls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/** One (playbook, role) line of `foreman crew report`. Zero-token, all local. */
export interface CrewReportRow {
  playbook: string;
  role: string;
  /** Tickets this role carried to `done`. */
  tickets: number;
  /** Tickets whose first crew review is on record — the pass-rate's sample size. */
  firstReviewed: number;
  /** Share of those whose FIRST crew verdict was a pass; null when nothing was reviewed. */
  firstPassRate: number | null;
  /** Tickets left out of the rate because their first review round lost a reviewer. */
  firstIncomplete: number;
  /** Repair rounds per completed ticket (runs beyond the first, averaged). */
  avgRepairs: number;
  /** Pre-review repair rounds (acceptance map, scope guard) summed over the role's tickets. */
  mapRepairs: number;
  costUsd: number;
  avgCostUsd: number;
}

export interface ReceiptGroup {
  name: string;
  calls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

// The window is applied through the indexed `day` column rather than a
// created_at range so 'today' costs the same index probe spentToday() does,
// and the bound parameter keeps the day string out of the SQL text.
/**
 * Same-HEAD re-check backoff for a red main, by failed re-checks so far:
 * 10, 30, 60 minutes, then hourly. Most reds on this machine were load
 * flakes, and before this a red main only cleared once the operator happened
 * to commit something.
 */
export function redBackoffMs(attempts: number): number {
  const steps = [10, 30, 60];
  return (steps[attempts] ?? 60) * 60_000;
}

const receiptWhere = (day: ReceiptWindow): string => (day === 'all' ? '' : 'WHERE day = ?');
const receiptArgs = (day: ReceiptWindow): string[] =>
  day === 'all' ? [] : [new Date().toISOString().slice(0, 10)];

const KINDS = new Set(['code', 'writing', 'research', 'general', 'tool']);
const RUNNERS = new Set(['echo', 'shell', 'claude-code', 'codex-cli', 'api']);
const SENSITIVITIES = new Set(['S0', 'S1', 'S2']);
const GATES = new Set(['human', 'owner']);
const ASSIGNEES = new Set(['ai', 'human']);

function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

/**
 * SIGKILL an entire recorded process group, and every group under it in the
 * `rows` snapshot (a worker's own-group `npm run verify` survives a signal to
 * the worker's group alone). True if a signal was delivered to any of them.
 */
function killGroup(pid: number, rows: PsRow[]): boolean {
  const below = signalGroups(treeGroups(rows, pid, process.pid).filter((g) => g !== pid), 'SIGKILL');
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return below.length > 0; // the recorded group is already gone
  }
}

/**
 * The single owner of foreman's persisted state. Every mutation writes an event
 * row and emits it, so the HTTP layer can stream without polling the tables.
 */
const STOP_REQUEUE_NOTE = 'requeued: the daemon stopped mid-run';
/** Daemon stops a ticket may be requeued through before the next one sends it to the operator instead. */
const MAX_STOP_REQUEUES = 3;

export interface RedRepo {
  /** The HEAD that failed; a re-check runs once HEAD moves. */
  head: string;
  taskId: string;
  testCmd: string | null;
  reason: string;
  /** Epoch ms the repo first went red; kept across re-marks. */
  since?: number;
  /** Epoch ms of the next same-HEAD re-check; null means "the scheduler's first backoff from `since`". */
  nextCheckAt?: number | null;
  /** Same-HEAD re-checks that have failed so far, for the backoff. */
  attempts?: number;
}

/** How an admission core-guard finding is written in a task's timeline (scheduler.ts). */
export const CORE_GUARD_PREFIX = 'CORE-GUARD: ';

/** Opens the repair notes of a round that resolves a merge conflict Foreman prepared (see scheduleConflictRepair). */
export const CONFLICT_REPAIR_PREFIX = 'Foreman applied your earlier diff onto current main.';

/** A conflict round dropped by abandonConflictRound is not a run the gate rules on: latestRun skips it. */
const NOT_ABANDONED = "(decision IS NULL OR decision != 'abandoned')";

/**
 * The repair notes of a conflict round. `files` is what the 3-way apply left
 * markers in; null before the round has carried the diff (they are named
 * then), empty when the apply went through without a conflict.
 */
export function conflictRepairNotes(files: string[] | null, testCmd: string | null): string {
  const test = testCmd?.trim() || "the project's test command";
  if (files && !files.length) {
    return `${CONFLICT_REPAIR_PREFIX} It applied without conflict markers (main moved but nothing overlapped), so there is nothing to resolve: ` +
      `check the combined result still does what the ticket asked, then run ${test}.`;
  }
  return `${CONFLICT_REPAIR_PREFIX} Resolve the conflict markers in ${files ? files.join(', ') : 'the files it conflicted on'}, ` +
    `keeping both sides' intent, then run ${test}.`;
}

/** `note` with the core-guard messages in front of it, cut to `max`. */
export function leadWithCoreGuard(note: string | null, messages: string[], max = 1000): string | null {
  if (!messages.length) return note;
  const lead = `core-guard: ${messages.join('; ')}`;
  return (note ? `${lead} | ${note}` : lead).slice(0, max);
}

export class Store extends EventEmitter {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    super();
    this.setMaxListeners(0);
    this.db = openDb(dbPath);
    this.loadRedRepos();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- events

  record(
    e: { taskId?: string | null; runId?: string | null; type: RunEvent['type']; stage?: Stage | null; message: string },
  ): RunEvent {
    const ts = Date.now();
    const info = this.db
      .prepare('INSERT INTO events (task_id, run_id, ts, type, stage, message) VALUES (?,?,?,?,?,?)')
      .run(e.taskId ?? null, e.runId ?? null, ts, e.type, e.stage ?? null, e.message);
    const ev: RunEvent = {
      id: Number(info.lastInsertRowid),
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      ts,
      type: e.type,
      stage: e.stage ?? null,
      message: e.message,
    };
    this.emit('event', ev);
    return ev;
  }

  eventsSince(sinceId: number, limit = 500): RunEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?')
      .all(sinceId, limit)
      .map(rowToEvent);
  }

  eventsForTask(taskId: string, limit = 500): RunEvent[] {
    return this.db
      .prepare('SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(taskId, limit)
      .map(rowToEvent);
  }

  /**
   * Every warning on the task whose message starts with `prefix`, oldest first,
   * with no tail limit: a retry's log events push a one-off warning out of
   * `eventsForTask`'s window, and these are the ones the operator must still see.
   */
  warningsWithPrefix(taskId: string, prefix: string): RunEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE task_id = ? AND type = 'warning' AND substr(message, 1, ?) = ? ORDER BY id")
      .all(taskId, prefix.length, prefix)
      .map(rowToEvent);
  }

  /**
   * A park note with the admission core-guard warnings of the task's latest
   * run in front of it: the ticket names a protected path, and whoever decides
   * at the gate should know that before reading the rest. Read back from the
   * timeline, so every site that writes a note for a parked ticket (the park,
   * a re-check, a budget stop, a reopen, an approval that did not land) leads
   * with the same thing.
   */
  withCoreGuard(taskId: string, note: string | null, max = 1000): string | null {
    const latest = this.latestRun(taskId);
    const messages = latest
      ? this.warningsWithPrefix(taskId, CORE_GUARD_PREFIX).filter((e) => e.runId === latest.id).map((e) => e.message.slice(CORE_GUARD_PREFIX.length))
      : [];
    return leadWithCoreGuard(note, [...new Set(messages)], max);
  }

  // ------------------------------------------------------------- decisions

  /**
   * Record one decision on a task: a row in `decisions` (the whole note and,
   * for an approval, the trees and what the operator stated) and a `decision`
   * event on the task's timeline with its short form. Append-only: no method
   * here updates or deletes a row, and the table refuses both (db.ts). This
   * only records; it is called once the decision has already taken effect.
   */
  addDecision(d: NewDecision): Decision {
    if (!DECISION_ACTIONS.includes(d.action)) throw new Error(`unknown decision action: ${String(d.action)}`);
    const actor = d.actor ?? 'human';
    if (!DECISION_ACTORS.includes(actor)) throw new Error(`unknown decision actor: ${String(actor)}`);
    const { note, cut } = boundDecisionNote(d.note);
    const flag = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);
    const decisionId = id('d');
    this.db
      .prepare(
        `INSERT INTO decisions (id, task_id, run_id, at, action, actor, note, note_cut_bytes, status_after, reviewed_tree,
           landed_tree, as_is, merged, merge_reason, corrected, corrected_source, review_source, extra)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        decisionId, d.taskId, d.runId ?? null, Date.now(), d.action, actor, note, cut, d.statusAfter ?? null,
        d.reviewedTree ?? null, d.landedTree ?? null, flag(d.asIs), flag(d.merged), d.mergeReason ?? null,
        flag(d.corrected), d.corrected == null ? null : (d.correctedSource ?? 'operator'),
        d.reviewSource?.trim() ? d.reviewSource.trim().slice(0, REVIEW_SOURCE_MAX) : null,
        d.extra && Object.keys(d.extra).length ? JSON.stringify(d.extra) : null,
      );
    const row = rowToDecision(this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Record<string, unknown>);
    this.record({ taskId: row.taskId, runId: row.runId, type: 'decision', message: decisionEventMessage(row) });
    return row;
  }

  /**
   * addDecision for a path whose decision has already taken effect: a ledger
   * that cannot take the row must not undo or interrupt the decision (a cancel
   * still has to reach its worker), so a failure is said on the timeline and
   * null is returned.
   */
  noteDecision(d: NewDecision): Decision | null {
    try {
      return this.addDecision(d);
    } catch (err) {
      try {
        this.record({ taskId: d.taskId, runId: d.runId ?? null, type: 'error', message: `decision not recorded (${d.action}): ${(err as Error).message.slice(0, 300)}` });
      } catch {
        /* the store itself is failing; the decision stands */
      }
      return null;
    }
  }

  /** Every decision recorded on a task, oldest first. */
  decisionsForTask(taskId: string): Decision[] {
    return this.db
      .prepare('SELECT * FROM decisions WHERE task_id = ? ORDER BY at, rowid')
      .all(taskId)
      .map((r) => rowToDecision(r as Record<string, unknown>));
  }

  // ----------------------------------------------------------------- tasks

  addTask(input: NewTask): Task {
    const title = input.title?.trim();
    if (!title) throw new Error('title is required');
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error('prompt is required');
    const kind = input.kind ?? 'general';
    if (!KINDS.has(kind)) throw new Error(`unknown kind: ${kind}`);
    const runner = input.runner ?? (kind === 'code' ? 'claude-code' : 'echo');
    if (!RUNNERS.has(runner)) throw new Error(`unknown runner: ${runner}`);
    const sensitivity = input.sensitivity ?? 'S1';
    if (!SENSITIVITIES.has(sensitivity)) throw new Error(`unknown sensitivity: ${sensitivity}`);
    const gate = input.gate ?? null;
    if (gate !== null && !GATES.has(gate)) throw new Error(`unknown gate: ${gate}`);
    const assignee = input.assignee ?? null;
    if (assignee !== null && !ASSIGNEES.has(assignee)) throw new Error(`unknown assignee: ${assignee}`);
    const maxAttempts = input.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
    // The HTTP route and the CLI pass Number(...) of whatever they were sent, so
    // a typo arrives here as NaN: a NaN priority or repair cap surfaced as a
    // raw "NOT NULL constraint failed", and a negative cap or budget was stored
    // and meant nothing sensible.
    if (input.priority !== undefined && !Number.isFinite(input.priority)) throw new Error('priority must be a finite number');
    if (input.maxRepairs !== undefined && (!Number.isInteger(input.maxRepairs) || input.maxRepairs < 0)) {
      throw new Error('maxRepairs must be a non-negative integer');
    }
    if (input.budgetUsd != null && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0)) {
      throw new Error('budgetUsd must be a non-negative number');
    }
    if (input.points != null && (!Number.isFinite(input.points) || input.points < 0)) throw new Error('points must be a non-negative number');
    if (input.repo != null && typeof input.repo !== 'string') throw new Error('repo must be a path');
    // Every way a ticket is born passes here, so the column only ever holds a
    // list a brief would serve as it stands today. Throws on any refused name.
    const skills = assertTicketSkills(input, input.skills);

    // Dependencies may only point at tasks that already exist. Because every
    // edge therefore points strictly backwards in insertion order, the graph
    // cannot contain a cycle and no cycle check is needed at schedule time.
    const deps = [...new Set(input.deps ?? [])];
    for (const dep of deps) {
      if (!this.getTaskRow(dep)) throw new Error(`dependency not found: ${dep}`);
    }

    const now = Date.now();
    const taskId = id('t');
    // An epic container is born blocked and stays blocked until its tickets
    // close: `blocked` is the one non-terminal status no worker can claim and
    // no human is asked to decide, so the container costs nothing and adds no
    // gate noise. reconcileBlocked()/closeEpicIfComplete() close it.
    // A human-assigned task is never born `queued`: `queued` is precisely the
    // state a worker claims from, so parking it there and filtering later would
    // leave a race in which a tick between INSERT and filter dispatches it.
    // It goes straight to `awaiting-human` instead — and if it has unmet deps
    // it waits in `blocked` like anything else, and reconcileBlocked promotes
    // it to `awaiting-human` rather than to `queued`.
    // Resolved once, at creation, and STORED — not left null to be re-derived
    // on every read. Re-deriving looks equivalent and is not: flipping the
    // house default would then silently relabel every task already in flight,
    // so a ticket an AI had already drafted would start reporting that a human
    // did it. What actually happened is a fact about the past, and the row is
    // where facts about the past live.
    const resolvedAssignee = effectiveAssignee(
      { assignee, role: input.role ?? null, playbook: input.playbook ?? null },
      undefined,
      this.defaultAssignee(),
    );
    const status: TaskStatus = input.isEpic || deps.length ? 'blocked' : readyStatus(resolvedAssignee);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id,title,prompt,kind,repo,agent,runner,sensitivity,budget_usd,priority,status,attempts,max_attempts,created_at,updated_at,test_cmd,merge_on_approve,max_repairs,schedule_id,parent_id,allow_core,role,playbook,points,acceptance,is_epic,gate,base_ref,assignee,forbidden_paths,skills)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          taskId, title, prompt, kind,
          input.repo ?? null, input.agent ?? null, runner, sensitivity,
          input.budgetUsd ?? null, input.priority ?? 0, status, maxAttempts, now, now,
          input.testCmd ?? null,
          (input.mergeOnApprove ?? kind === 'code') ? 1 : 0,
          input.maxRepairs ?? 1,
          input.scheduleId ?? null,
          input.parentId ?? null,
          input.allowCore ? 1 : 0,
          input.role ?? null,
          input.playbook ?? null,
          input.points ?? null,
          input.acceptance ?? null,
          input.isEpic ? 1 : 0,
          gate,
          input.baseRef ?? null,
          resolvedAssignee,
          input.forbiddenPaths?.length ? JSON.stringify(input.forbiddenPaths) : null,
          skills ? JSON.stringify(skills) : null,
        );
      const insDep = this.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?,?)');
      for (const dep of deps) {
        if (dep === taskId) throw new Error('a task cannot depend on itself');
        insDep.run(taskId, dep);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this.record({ taskId, type: 'status', message: `${status}: ${title}` });
    return this.getTask(taskId)!;
  }

  private getTaskRow(taskId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  }

  getTask(taskId: string): Task | null {
    const row = this.getTaskRow(taskId);
    return row ? rowToTask(row, this.depsOf(taskId)) : null;
  }

  depsOf(taskId: string): string[] {
    return this.db
      .prepare('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on')
      .all(taskId)
      .map((r) => String((r as Record<string, unknown>)['depends_on']));
  }

  listTasks(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    const edges = this.db.prepare('SELECT task_id, depends_on FROM task_deps').all() as Record<string, unknown>[];
    const byTask = new Map<string, string[]>();
    for (const e of edges) {
      const k = String(e['task_id']);
      const list = byTask.get(k) ?? [];
      list.push(String(e['depends_on']));
      byTask.set(k, list);
    }
    return rows.map((r) => rowToTask(r, byTask.get(String(r['id'])) ?? []));
  }

  setStatus(taskId: string, status: TaskStatus, error?: string | null): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error ?? null, Date.now(), taskId);
    this.record({ taskId, type: 'status', message: error ? `${status}: ${error}` : status });
    // The single funnel every status transition passes through (the gate, the
    // scheduler, cancel). One extra lookup only when a task with a parent
    // moves, so an epic settles the moment its last ticket does rather than a
    // tick later — and reopens the moment one of them starts over.
    const parent = this.parentIdOf(taskId);
    if (!parent) return;
    if (TERMINAL_STATUSES.includes(status)) this.closeEpicIfComplete(parent);
    else this.reopenEpicIfClosed(parent);
  }

  private parentIdOf(taskId: string): string | null {
    const row = this.db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row?.['parent_id'] ? String(row['parent_id']) : null;
  }

  /**
   * A ticket that leaves a terminal state (a repair round, a retry, a manual
   * requeue) invalidates its epic's verdict: the container is reopened to
   * `blocked` and its retrospective retired, so precedent never quotes a close
   * that has been undone. The next close writes a fresh one.
   *
   * Called from `setStatus` and from the two paths that move a task by raw SQL
   * (`scheduleRepair`, `recoverOrphans`).
   */
  reopenEpicIfClosed(epicId: string): void {
    const row = this.getTaskRow(epicId);
    if (!row || Number(row['is_epic']) !== 1) return;
    if (!TERMINAL_STATUSES.includes(String(row['status']) as TaskStatus)) return;
    try {
      dropRetrospective(this, epicId);
    } catch (err) {
      this.record({ taskId: epicId, type: 'error', message: `retrospective drop failed: ${(err as Error).message}` });
    }
    // Recurses through setStatus for a nested epic: reopening a child epic
    // must reopen the parent that closed on it.
    this.setStatus(epicId, 'blocked', 'a ticket reopened after this epic closed');
  }

  /** Every task queued under `taskId` (an epic's tickets, a run's follow-ups). */
  childrenOf(taskId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => rowToTask(r, this.depsOf(String(r['id']))));
  }

  /**
   * Close an epic container once every ticket under it is terminal: `done` if
   * they all landed, `failed` naming the first that did not. An epic runs no
   * work of its own, so this — not a runner — is what ends it. Retrospective
   * write-back is best-effort: a bad memory write must never wedge the close.
   */
  closeEpicIfComplete(epicId: string): void {
    const row = this.getTaskRow(epicId);
    if (!row || Number(row['is_epic']) !== 1) return;
    if (TERMINAL_STATUSES.includes(String(row['status']) as TaskStatus)) return;
    const children = this.db
      .prepare('SELECT id, status FROM tasks WHERE parent_id = ?')
      .all(epicId) as Record<string, unknown>[];
    if (!children.length) {
      // `queueCrewPlan` refuses a zero-ticket plan and inserts the tickets in
      // the same synchronous call as the container, so a childless epic means
      // its tickets were deleted. Nothing will ever close it: treat the epic as
      // canceled rather than leave it blocked forever.
      this.setStatus(epicId, 'canceled', 'every ticket under this epic was deleted');
      return;
    }
    if (children.some((c) => !TERMINAL_STATUSES.includes(String(c['status']) as TaskStatus))) return;
    const bad = children.find((c) => String(c['status']) !== 'done');
    this.setStatus(
      epicId,
      bad ? 'failed' : 'done',
      bad ? `ticket ${String(bad['id'])} ended as ${String(bad['status'])}` : null,
    );
    try {
      writeRetrospective(this, epicId);
    } catch (err) {
      this.record({ taskId: epicId, type: 'error', message: `retrospective failed: ${(err as Error).message}` });
    }
  }

  deleteTask(taskId: string): void {
    const dependents = this.db
      .prepare('SELECT task_id FROM task_deps WHERE depends_on = ?')
      .all(taskId) as Record<string, unknown>[];
    if (dependents.length) {
      throw new Error(`cannot delete ${taskId}: ${dependents.length} task(s) depend on it`);
    }
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status === 'running' || task.status === 'verifying') {
      throw new Error(`cannot delete ${taskId} while it is ${task.status}; cancel it first`);
    }
    // Same guard as the task_deps one above, for the parent edge: deleting an
    // epic out from under live tickets would leave work running with nothing
    // tracking it and no container to close.
    const children = this.db
      .prepare('SELECT id, status FROM tasks WHERE parent_id = ?')
      .all(taskId) as Record<string, unknown>[];
    const live = children.filter((c) => !TERMINAL_STATUSES.includes(String(c['status']) as TaskStatus));
    if (live.length) {
      throw new Error(
        `cannot delete ${taskId}: ${live.length} child task(s) are still open (${live.map((c) => String(c['id'])).slice(0, 3).join(', ')}); cancel it first`,
      );
    }
    // Detach rather than cascade-delete: a closed ticket owns runs, artifacts
    // and receipts that are the record of work that actually happened, and the
    // operator asked to delete one row, not an audit trail.
    if (children.length) {
      this.db.prepare('UPDATE tasks SET parent_id = NULL, updated_at = ? WHERE parent_id = ?').run(Date.now(), taskId);
    }
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  // ------------------------------------------------------------- scheduling

  /**
   * Promote blocked tasks whose dependencies all finished, and fail the ones
   * whose dependencies can never finish. Returns the number of tasks changed.
   */
  /**
   * Repos whose main failed its own tests after a merge; see postMerge.ts.
   * A write-through cache of the red_repos table: repoRed() is asked per
   * claimable task per tick, and a restart must still find the repo red.
   */
  private readonly redRepos = new Map<string, RedRepo>();

  private loadRedRepos(): void {
    for (const r of this.db.prepare('SELECT * FROM red_repos').all() as Record<string, unknown>[]) {
      this.redRepos.set(String(r['repo']), {
        head: String(r['head']),
        taskId: String(r['task_id']),
        testCmd: r['test_cmd'] == null ? null : String(r['test_cmd']),
        reason: String(r['reason']),
        since: Number(r['since']),
        nextCheckAt: r['next_check_at'] == null ? null : Number(r['next_check_at']),
        attempts: Number(r['attempts'] ?? 0),
      });
    }
  }

  markRepoRed(repo: string, info: RedRepo): void {
    const key = path.resolve(repo);
    const red: RedRepo = {
      ...info,
      since: info.since ?? this.redRepos.get(key)?.since ?? Date.now(),
      // Never "due at once": re-marking a repo that is already red keeps its
      // old `since`, and a null here made the scheduler's since-based default
      // due immediately — a second full test run straight after the first.
      // An explicit `since` is the caller's clock (a scheduler may inject one).
      nextCheckAt: info.nextCheckAt ?? (info.since ?? Date.now()) + redBackoffMs(0),
      attempts: info.attempts ?? 0,
    };
    this.db
      .prepare(
        'INSERT INTO red_repos (repo, head, task_id, test_cmd, reason, since, next_check_at, attempts) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(repo) DO UPDATE SET head = excluded.head, task_id = excluded.task_id, test_cmd = excluded.test_cmd, ' +
        'reason = excluded.reason, since = excluded.since, next_check_at = excluded.next_check_at, attempts = excluded.attempts',
      )
      .run(key, red.head, red.taskId, red.testCmd, red.reason, red.since!, red.nextCheckAt ?? null, red.attempts!);
    this.redRepos.set(key, red);
  }

  clearRepoRed(repo: string): void {
    const key = path.resolve(repo);
    this.db.prepare('DELETE FROM red_repos WHERE repo = ?').run(key);
    this.redRepos.delete(key);
  }

  /**
   * The operator's checkout had uncommitted changes, so no worktree could be
   * cut (isolate.ts DirtyRepoError). Like a provider limit, not a defect in
   * the ticket: the attempt is given back and it waits in the queue.
   */
  requeueAfterDirty(taskId: string, note: string): void {
    this.db.prepare('UPDATE tasks SET attempts = MAX(attempts - 1, 0) WHERE id = ?').run(taskId);
    this.setStatus(taskId, 'queued', note);
  }

  repoRed(repo: string | null | undefined): RedRepo | null {
    return repo ? this.redRepos.get(path.resolve(repo)) ?? null : null;
  }

  redRepoList(): Array<[string, RedRepo]> {
    return [...this.redRepos];
  }

  /** Tasks approved whose merge has not settled yet; see beginLanding. */
  private readonly landing = new Set<string>();

  /**
   * An approved task whose work is still being merged. It is already `done`,
   * but its dependents must not start until the merge lands — they are cut
   * from the repo's HEAD. In-process only: a daemon that dies mid-merge holds
   * nothing, exactly as it holds no merge.
   */
  beginLanding(taskId: string): void {
    this.landing.add(taskId);
  }

  endLanding(taskId: string): void {
    this.landing.delete(taskId);
  }

  /** Whether an approved task's merge is still in flight (see beginLanding). */
  isLanding(taskId: string): boolean {
    return this.landing.has(taskId);
  }

  reconcileBlocked(): number {
    let changed = 0;
    const blocked = this.db
      .prepare("SELECT id, is_epic, parent_id, substr(prompt, 1, ?) AS prompt_head FROM tasks WHERE status = 'blocked'")
      .all(FILED_PREFIX.length) as Record<string, unknown>[];
    for (const row of blocked) {
      const taskId = String(row['id']);
      const isEpic = Number(row['is_epic']) === 1;
      // A reviewer-filed follow-up (a parent, and the prefix crewReview writes on its prompt) has two kinds of
      // edge. The one to the ticket it was filed on is a real dependency, as it always was. Every other one was
      // written by the filing rule (verify/followUpChain.ts) to keep follow-ups from running side by side: an
      // ORDER, which a ticket that ended canceled, failed or rejected has simply left. No Store method adds an
      // edge after a ticket is created, so on such a ticket nothing but that rule can have put one there; an
      // operator's own --after is on a ticket that is not a reviewer's follow-up, and stays a real dependency.
      const parentId = row['parent_id'] == null ? null : String(row['parent_id']);
      const prefixed = !isEpic && parentId !== null && String(row['prompt_head'] ?? '') === FILED_PREFIX;
      const ended = (s: string): boolean => s === 'failed' || s === 'rejected' || s === 'canceled';
      // An epic container waits on its children, not on dep edges. Checking it
      // here as well as in setStatus() is the convergence net: an epic whose
      // tickets all closed before it was even queried still settles on a tick.
      if (isEpic) {
        this.closeEpicIfComplete(taskId);
        if (this.getTaskRow(taskId)?.['status'] !== 'blocked') {
          changed++;
          continue;
        }
        // Fall through, do not `continue`: an epic may carry dep edges of its
        // own, and a dead dependency has to fail it like any other task.
      }
      const depStatuses = this.db
        .prepare('SELECT t.status AS status, t.id AS id FROM task_deps d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ?')
        .all(taskId) as Record<string, unknown>[];
      // The prefix is ticket text, and a planned ticket's prompt is the planner's own (or a plan sent to the API): one
      // that opened "Filed by " had its plan's `after` dependencies read as orders, and started although one of them
      // had failed. So what the ledger recorded has to agree with the prefix: a reviewer's follow-up is filed on a
      // work ticket and always carries an edge to it (crewReview fileIssues), while a planned ticket's parent is its
      // epic container, to which it has no edge. Anything else is an ordinary ticket: all its edges are dependencies.
      const filedFollowUp = prefixed
        && depStatuses.some((d) => String(d['id']) === parentId)
        && Number(this.getTaskRow(parentId!)?.['is_epic']) !== 1;
      const orderOnly = (depId: string): boolean => filedFollowUp && depId !== parentId;
      const dead = depStatuses.find((d) => ended(String(d['status'])) && !orderOnly(String(d['id'])));
      if (dead) {
        this.setStatus(taskId, 'failed', `dependency ${String(dead['id'])} ended as ${String(dead['status'])}`);
        changed++;
        continue;
      }
      // Deps being done promotes a task to `queued`; an epic is promoted by
      // nothing — it is closed by its tickets, and must stay unclaimable.
      if (!isEpic && depStatuses.every((d) =>
        (String(d['status']) === 'done' && !this.landing.has(String(d['id'])))
        || (orderOnly(String(d['id'])) && ended(String(d['status']))))) {
        const task = this.getTask(taskId);
        // A red main is no base to cut new work from: held until it is green.
        if (task && this.repoRed(task.repo)) continue;
        this.setStatus(taskId, task ? readyStatus(effectiveAssignee(task, undefined, this.defaultAssignee())) : 'queued');
        changed++;
      }
    }
    return changed;
  }

  /**
   * Highest-priority ready tasks, oldest first within a priority band.
   * `usable` drops held tickets (a red or dirty repo, a task still finishing
   * its run) while the queue is paged, so up to `limit` usable ones come back:
   * filtered after a LIMIT, held tickets at the front fill the window and
   * starve every other repo behind them.
   */
  claimable(limit: number, opts: { excludeRunner?: string; usable?: (t: { id: string; repo: string | null }) => boolean } = {}): Task[] {
    if (limit <= 0) return [];
    // Excluded in SQL, not after the LIMIT, for the same reason.
    const where = opts.excludeRunner ? "status = 'queued' AND runner != ?" : "status = 'queued'";
    const args = opts.excludeRunner ? [opts.excludeRunner] : [];
    // Keyset paging on the sort key itself (rowid breaks created_at ties), so
    // each page is an index seek: OFFSET re-scanned every held row per page,
    // quadratic in a queue with thousands of them.
    const order = 'ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT ?';
    const first = this.db.prepare(`SELECT rowid AS _rowid, * FROM tasks WHERE ${where} ${order}`);
    const next = this.db.prepare(
      `SELECT rowid AS _rowid, * FROM tasks WHERE ${where} AND (priority < ? OR (priority = ? AND (created_at > ? OR (created_at = ? AND rowid > ?)))) ${order}`,
    );
    const page = Math.max(limit, 50);
    const out: Task[] = [];
    let last: Record<string, unknown> | null = null;
    while (out.length < limit) {
      const rows = (last
        ? next.all(...args, last['priority'] as number, last['priority'] as number, last['created_at'] as number, last['created_at'] as number, last['_rowid'] as number, page)
        : first.all(...args, page)) as Record<string, unknown>[];
      for (const r of rows) {
        if (opts.usable && !opts.usable({ id: String(r['id']), repo: r['repo'] == null ? null : String(r['repo']) })) continue;
        out.push(rowToTask(r, this.depsOf(String(r['id']))));
        if (out.length >= limit) break;
      }
      if (rows.length < page) break;
      last = rows[rows.length - 1]!;
    }
    return out;
  }

  /** Queued tickets on one runner — what a hold is holding. */
  queuedOnRunner(runner: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND runner = ?")
      .get(runner) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /** Everything parked at the gate, oldest first — the owner gate's work list. */
  awaitingApproval(limit = 100): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'awaiting-approval' ORDER BY updated_at ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => rowToTask(r, this.depsOf(String(r['id']))));
  }

  /**
   * Atomically move a queued task to running. Returns false if another claimer
   * (or a status change) got there first.
   */
  claim(taskId: string): boolean {
    const info = this.db
      .prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), taskId);
    if (info.changes === 0) return false;
    this.record({ taskId, type: 'status', message: 'running' });
    return true;
  }

  /**
   * Crash recovery: any run still marked running belongs to a dead process.
   * Requeue its task if it has attempts left, otherwise fail it.
   */
  recoverOrphans(): number {
    const now = Date.now();
    // A killed daemon reaps nothing, but every run row carries its child's
    // pgid. Kill any group that survived before requeueing, so a retry never
    // races its own predecessor over the same jail.
    for (const pid of this.killLiveRunGroups()) {
      this.record({ type: 'status', message: `killed orphaned process group ${pid} left by a previous daemon` });
    }
    const orphans = this.db
      .prepare("SELECT id, task_id FROM runs WHERE status = 'running'")
      .all() as Record<string, unknown>[];
    for (const row of orphans) {
      this.db
        .prepare("UPDATE runs SET status = 'canceled', ended_at = ?, summary = 'interrupted by daemon restart' WHERE id = ?")
        .run(now, String(row['id']));
    }
    const stuck = this.db
      .prepare("SELECT id, attempts, max_attempts FROM tasks WHERE status IN ('running','verifying')")
      .all() as Record<string, unknown>[];
    for (const row of stuck) {
      const taskId = String(row['id']);
      if (Number(row['attempts']) >= Number(row['max_attempts'])) {
        this.setStatus(taskId, 'failed', 'interrupted by daemon restart; no attempts left');
      } else {
        this.db.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?").run(now, taskId);
        this.record({ taskId, type: 'status', message: 'requeued after daemon restart' });
        // Raw SQL again: reopen the epic this ticket may have closed.
        const parent = this.parentIdOf(taskId);
        if (parent) this.reopenEpicIfClosed(parent);
      }
    }
    return stuck.length;
  }

  /**
   * SIGKILL the recorded process group of every run still marked running,
   * plus every group in the process tree under it.
   * Returns the pids that were actually signalled. A pid can be reused after
   * a long outage, so this only ever fires for groups that still exist —
   * that residual race is accepted for a local tool.
   */
  killLiveRunGroups(): number[] {
    const rows = this.db
      .prepare("SELECT DISTINCT pid FROM runs WHERE status = 'running' AND pid IS NOT NULL")
      .all() as Record<string, unknown>[];
    const killed: number[] = [];
    // One snapshot, taken before anything is signalled: a killed parent
    // reparents its children and drops them out of the tree walk.
    const ps = rows.length ? snapshotPs() : [];
    for (const row of rows) {
      const pid = Number(row['pid']);
      if (Number.isInteger(pid) && pid > 0 && killGroup(pid, ps)) killed.push(pid);
    }
    return killed;
  }

  // ------------------------------------------------------------------ runs

  startRun(taskId: string): Run {
    const runId = id('r');
    this.db
      .prepare("INSERT INTO runs (id, task_id, status, stage, progress, started_at) VALUES (?,?,'running','admit',0,?)")
      .run(runId, taskId, Date.now());
    this.record({ taskId, runId, type: 'stage', stage: 'admit', message: 'run started' });
    return this.getRun(runId)!;
  }

  getRun(runId: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  latestRun(taskId: string): Run | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? AND ${NOT_ABANDONED} ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  runsForTask(taskId: string): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC')
      .all(taskId)
      .map(rowToRun);
  }

  setRunStage(runId: string, taskId: string, stage: Stage, message?: string): void {
    this.db.prepare('UPDATE runs SET stage = ? WHERE id = ?').run(stage, runId);
    this.record({ taskId, runId, type: 'stage', stage, message: message ?? stage });
  }

  /**
   * Raw material for `foreman doctor --latency`: the stage-event timeline of
   * the most recent runs, plus each owning task's current status/updated_at
   * (the only place a gate-wait's end is recorded). Shaped to feed straight
   * into `computeLatencyReport`; no aggregation happens here.
   */
  recentRunsForLatency(limit: number): {
    runId: string; taskId: string; taskStatus: string; taskUpdatedAt: number;
    events: { stage: string; ts: number }[];
  }[] {
    const runs = this.db
      .prepare('SELECT id, task_id FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(Math.max(0, limit)) as Record<string, unknown>[];
    return runs.map((r) => {
      const runId = String(r['id']);
      const taskId = String(r['task_id']);
      const task = this.db.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get(taskId) as
        | Record<string, unknown>
        | undefined;
      const events = this.db
        .prepare("SELECT stage, ts FROM events WHERE run_id = ? AND type = 'stage' AND stage IS NOT NULL ORDER BY ts")
        .all(runId) as Record<string, unknown>[];
      return {
        runId,
        taskId,
        taskStatus: task ? String(task['status']) : '',
        taskUpdatedAt: task ? Number(task['updated_at']) : 0,
        events: events.map((e) => ({ stage: String(e['stage']), ts: Number(e['ts']) })),
      };
    });
  }

  setRunProgress(runId: string, taskId: string, progress: number): void {
    const clamped = Math.min(1, Math.max(0, progress));
    this.db.prepare('UPDATE runs SET progress = ? WHERE id = ?').run(clamped, runId);
    this.record({ taskId, runId, type: 'progress', message: clamped.toFixed(3) });
  }

  setRunMeta(
    runId: string,
    meta: {
      worktreePath?: string | null; branch?: string | null; sessionId?: string | null; baseCommit?: string | null;
      reviewedTree?: string | null;
    },
  ): void {
    if (meta.reviewedTree !== undefined) {
      this.db.prepare('UPDATE runs SET reviewed_tree = ? WHERE id = ?').run(meta.reviewedTree, runId);
    }
    if (meta.baseCommit !== undefined) {
      this.db.prepare('UPDATE runs SET base_commit = ? WHERE id = ?').run(meta.baseCommit, runId);
    }
    if (meta.worktreePath !== undefined) {
      this.db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(meta.worktreePath, runId);
    }
    if (meta.branch !== undefined) {
      this.db.prepare('UPDATE runs SET branch = ? WHERE id = ?').run(meta.branch, runId);
    }
    if (meta.sessionId !== undefined) {
      this.db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(meta.sessionId, runId);
    }
  }

  /** Record (or clear) the pid of a run's worker child, so recovery can reap it. */
  setRunPid(runId: string, pid: number | null): void {
    this.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, runId);
  }

  addUsage(runId: string, taskId: string, usage: { tokensIn?: number; tokensOut?: number; costUsd?: number }): void {
    this.db
      .prepare('UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?')
      .run(usage.tokensIn ?? 0, usage.tokensOut ?? 0, usage.costUsd ?? 0, runId);
    const run = this.getRun(runId);
    if (run) {
      this.record({
        taskId,
        runId,
        type: 'metrics',
        message: JSON.stringify({ tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd }),
      });
    }
  }

  /**
   * What a run recorded about itself (runFacts.ts), written once when it ends.
   * A field left out (or null) leaves its column NULL: "not known" stays
   * distinguishable from a measured 0.
   */
  setRunFacts(
    runId: string,
    f: Pick<Run, 'turns' | 'turnsReported' | 'turnLimit' | 'endedReason' | 'briefBytes' | 'briefCuts' | 'reportBytes'>,
  ): void {
    if (f.endedReason != null && !RUN_ENDED_REASONS.includes(f.endedReason)) throw new Error(`unknown ended reason: ${String(f.endedReason)}`);
    const n = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v));
    this.db
      .prepare(
        'UPDATE runs SET turns = ?, turns_reported = ?, turn_limit = ?, ended_reason = ?, brief_bytes = ?, brief_cuts = ?, report_bytes = ? WHERE id = ?',
      )
      .run(
        n(f.turns), n(f.turnsReported), n(f.turnLimit), f.endedReason ?? null, n(f.briefBytes),
        f.briefCuts == null ? null : JSON.stringify(f.briefCuts), n(f.reportBytes), runId,
      );
  }

  endRun(runId: string, status: Run['status'], opts: { exitCode?: number | null; summary?: string | null } = {}): void {
    this.db
      .prepare('UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, summary = ? WHERE id = ?')
      .run(status, Date.now(), opts.exitCode ?? null, opts.summary ?? null, runId);
  }

  // ------------------------------------------------------------- artifacts

  addArtifact(a: Omit<Artifact, 'id' | 'createdAt' | 'approved'>): Artifact {
    const artifactId = id('a');
    this.db
      .prepare('INSERT INTO artifacts (id, run_id, task_id, type, path, summary, approved, created_at) VALUES (?,?,?,?,?,?,NULL,?)')
      .run(artifactId, a.runId, a.taskId, a.type, a.path, a.summary ?? null, Date.now());
    this.record({ taskId: a.taskId, runId: a.runId, type: 'artifact', message: `${a.type}: ${a.path}` });
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').all(artifactId).map(rowToArtifact)[0]!;
  }

  artifactsForTask(taskId: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at')
      .all(taskId)
      .map(rowToArtifact);
  }

  /**
   * Record that the owner gate ran on this task, whatever it decided — hold
   * included. This is the "already gated" marker, and it lives in the row
   * rather than in `events` because events are pruned per run: losing it would
   * let the sweep re-ask (and re-pay for) the Owner about a held ticket every
   * tick. The event is still written, for the timeline.
   */
  markGateDecision(taskId: string, decision: string, at: number = Date.now()): void {
    this.db.prepare('UPDATE tasks SET gate_decision = ? WHERE id = ?').run(`${decision}@${at}`, taskId);
  }

  /** `'<decision>@<epochMs>'`, or null if the gate has not run on this attempt. */
  gateDecision(taskId: string): string | null {
    const row = this.db.prepare('SELECT gate_decision FROM tasks WHERE id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row?.['gate_decision'] == null ? null : String(row['gate_decision']);
  }

  /**
   * A retry or a repair round is a genuinely new run, so the ticket it produces
   * deserves a deliberate gate decision of its own rather than inheriting the
   * one made about work that has since been rewritten.
   */
  clearGateDecision(taskId: string): void {
    this.db.prepare('UPDATE tasks SET gate_decision = NULL WHERE id = ?').run(taskId);
  }

  /**
   * Put an ended task back in the queue, as a genuinely fresh attempt.
   *
   * Two things a retry is NOT. It is not a repair round: a repair round
   * continues the worker's own session inside the worktree that session
   * remembers, which is right when the critique is about the work and wrong
   * when the operator has just fixed something in the REPO and wants it picked
   * up — that worktree is pinned to a base commit taken before the fix, so the
   * retry re-runs against exactly the state that failed. Dropping the session
   * id sends the next launch cold, into a jail cut from current HEAD.
   *
   * And it is not a promotion: dependency edges only gate a task while it sits
   * at `blocked`, so a retried ticket sent straight to `queued` could be
   * claimed with its dependencies still unfinished. It goes back to `blocked`
   * if anything it waits on has not finished; reconcileBlocked() promotes it
   * when they do.
   */
  retry(taskId: string, note?: string | null, extra?: Record<string, unknown> | null): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    // The run this retry turns away from, for the decision row written at the end.
    const retriedRun = this.latestRun(taskId)?.id ?? null;
    // A retry is a fresh attempt and gets a fresh repair budget: without it a
    // retried ticket that had already spent its repair round fails for good on
    // its first review, with the critique it was retried to address unheard.
    this.db.prepare('UPDATE tasks SET attempts = 0, stop_requeues = 0, repairs = 0, pre_review_repairs = 0 WHERE id = ?').run(taskId);
    // The repair notes still hold the critique that queued the LAST repair
    // round; the review that ended the task came after it. A retry must carry
    // that final critique, or the worker re-fixes what it already fixed and
    // never hears what actually sank it.
    const last = this.verdictsForTask(taskId)[0];
    if (task.status === 'failed' && last?.verdict === 'fail' && last.critique?.trim()) {
      this.db
        .prepare('UPDATE tasks SET repair_notes = ? WHERE id = ?')
        .run(`The previous attempt FAILED review. Fix exactly this:\n\n${last.critique}`, taskId);
    } else if (task.status === 'rejected' && task.error?.trim()) {
      // A human rejection's reason is the critique: it is stored as the
      // status note, and nothing else would carry it to the next attempt.
      const prior = task.repairNotes?.trim();
      // The reason also joins the ticket's standing operator demands. Repair
      // notes are overwritten by every later review round, so on the Kiln
      // phase-3 UI ticket the operator's six findings reached the next round
      // only as the reviewer's restatement of them — and the chair, which
      // judges against acceptance, overruled three as "not in the acceptance
      // criteria". A human's rejection IS acceptance; it must outlive the round.
      const demands = [task.operatorDemands?.trim(), task.error.trim()]
        .filter(Boolean)
        .join('\n\n— a later rejection —\n');
      this.db
        .prepare('UPDATE tasks SET repair_notes = ?, operator_demands = ? WHERE id = ?')
        .run(
          `The previous attempt was REJECTED at the gate by the operator. Fix exactly this:\n\n${task.error}` +
            (prior ? `\n\nStill owed from the earlier review:\n${prior}` : ''),
          demands.slice(-8_000),
          taskId,
        );
    }
    // An operator's note on the retry is theirs to give: it leads the repair
    // notes, so the worker reads it before the critique it qualifies, and joins
    // the standing operator demands, so every reviewer and the chair hold it.
    // On the Kiln polish epic a ticket failed only because the review demanded
    // a report of live browser checks a headless worker cannot run; the
    // operator ran them, and needed a way to say so on the retry.
    const operatorNote = note?.trim();
    if (operatorNote) {
      const fresh = this.getTask(taskId)!;
      const demands = [fresh.operatorDemands?.trim(), `Operator note on retry: ${operatorNote}`]
        .filter(Boolean)
        .join('\n\n— a later note —\n');
      this.db
        .prepare('UPDATE tasks SET repair_notes = ?, operator_demands = ? WHERE id = ?')
        .run(
          `OPERATOR NOTE on this retry (binding; it overrides the critique below where they conflict):\n${operatorNote}` +
            (fresh.repairNotes?.trim() ? `\n\n${fresh.repairNotes.trim()}` : ''),
          demands.slice(-8_000),
          taskId,
        );
      this.record({ taskId, type: 'status', message: `retried with an operator note: ${operatorNote.slice(0, 200)}` });
    }
    this.clearGateDecision(taskId);
    const previous = this.latestRun(taskId);
    if (previous?.sessionId) this.setRunMeta(previous.id, { sessionId: null });
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_deps d JOIN tasks t ON t.id = d.depends_on " +
          "WHERE d.task_id = ? AND t.status != 'done'",
      )
      .get(taskId) as Record<string, unknown>;
    const waiting = Number(pending['n'] ?? 0) > 0;
    // A human-assigned task retries back onto the operator's desk, not into
    // the worker queue — `queued` is the one status a worker can claim from.
    this.setStatus(
      taskId,
      waiting ? 'blocked' : readyStatus(effectiveAssignee(task, undefined, this.defaultAssignee())),
      waiting ? 'retried; waiting on its dependencies' : null,
    );
    this.reviveDependents(taskId);
    // Carry the most recent run that was actually reviewed and produced work,
    // so the retry fixes the critique instead of redoing the ticket. A run that
    // never reached review (canceled, crashed) is not the work being judged.
    const reviewed = new Set(this.verdictsForTask(taskId).map((v) => v.runId));
    const diffRuns = new Set(this.artifactsForTask(taskId).filter((a) => a.type === 'diff').map((a) => a.runId));
    const carry = this.runsForTask(taskId)
      .filter((r) => reviewed.has(r.id) && diffRuns.has(r.id))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    this.db.prepare('UPDATE tasks SET carry_run = ? WHERE id = ?').run(carry?.id ?? null, taskId);
    const retried = this.getTask(taskId)!;
    this.noteDecision({ taskId, runId: retriedRun, action: 'retry', note, statusAfter: retried.status, extra });
    return retried;
  }

  /**
   * Put a ticket that FAILED review back at the human gate, its work intact,
   * for the operator to decide. A review is advice to the gate, not the gate:
   * when the operator has verified the work themselves (or fixed it in the
   * jail), the only alternatives were another paid round or hand-editing the
   * database. Only an operator command calls this; nothing automatic does.
   * Dependents the failure killed are revived to wait on the decision.
   */
  reopen(taskId: string, note?: string | null): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'failed') throw new Error(`task ${taskId} is ${task.status}; only a failed task can be reopened`);
    const last = this.verdictsForTask(taskId)[0];
    if (last?.verdict !== 'fail') throw new Error(`task ${taskId} did not fail review; retry it instead`);
    const run = this.latestRun(taskId);
    // The failed review has to be the LATEST run's. A later run that ended
    // some other way (refused by the core guard, crashed) was never reviewed,
    // and in a reused jail its work sits on top of the reviewed round's:
    // reopening would put that unreviewed tree at the gate.
    if (last.runId !== run?.id) {
      throw new Error(`task ${taskId}'s latest run is not the one that failed review; retry it instead`);
    }
    if (!run?.worktreePath || !fs.existsSync(run.worktreePath)) {
      throw new Error(`task ${taskId} has no work left to decide on (its worktree is gone); retry it instead`);
    }
    const why = note?.trim() ? `reopened by the operator: ${note.trim()}` : 'reopened by the operator after a failed review';
    this.clearGateDecision(taskId);
    this.setStatus(taskId, 'awaiting-approval', this.withCoreGuard(taskId, why.slice(0, 2_000), 2_000));
    this.record({ taskId, type: 'status', message: why.slice(0, 500) });
    this.reviveDependents(taskId);
    const reopened = this.getTask(taskId)!;
    this.noteDecision({ taskId, runId: run.id, action: 'reopen', note, statusAfter: reopened.status });
    return reopened;
  }

  /** The run whose diff the next fresh jail of this task should start from, if any. */
  carryRun(taskId: string): string | null {
    const row = this.db.prepare('SELECT carry_run FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    const v = row?.['carry_run'];
    return typeof v === 'string' && v ? v : null;
  }

  /** Whether the task's current repair round is a conflict round (its notes open with the prefix; a parked one keeps them). */
  inConflictRound(taskId: string): boolean {
    return Boolean(this.getTask(taskId)?.repairNotes?.startsWith(CONFLICT_REPAIR_PREFIX));
  }

  clearCarryRun(taskId: string): void {
    this.db.prepare('UPDATE tasks SET carry_run = NULL WHERE id = ?').run(taskId);
  }

  /**
   * A dead dependency fails its dependents (reconcileBlocked) so nothing hangs
   * on it — but a retry brings the dependency back, and its dependents must
   * come back with it. Without this, one leaf ticket that ran out of repairs
   * failed six downstream tickets of the first Kiln epic, and retrying the leaf
   * left all six dead. Only tasks that failed BECAUSE of this dependency are
   * revived (their error names it), transitively; they wait in `blocked`, and
   * reconcileBlocked re-fails any whose other dependencies are still dead.
   */
  private reviveDependents(taskId: string, seen = new Set<string>()): void {
    if (seen.has(taskId)) return;
    seen.add(taskId);
    const rows = this.db
      .prepare(
        "SELECT t.id AS id FROM task_deps d JOIN tasks t ON t.id = d.task_id " +
          "WHERE d.depends_on = ? AND t.status = 'failed' AND t.error IN (?, ?, ?)",
      )
      .all(
        taskId,
        `dependency ${taskId} ended as failed`,
        `dependency ${taskId} ended as rejected`,
        `dependency ${taskId} ended as canceled`,
      ) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row['id']);
      this.db.prepare('UPDATE tasks SET attempts = 0, stop_requeues = 0 WHERE id = ?').run(id);
      this.setStatus(id, 'blocked', `revived: dependency ${taskId} was retried`);
      this.reviveDependents(id, seen);
    }
  }

  /**
   * Human gate. A task parked at `awaiting-approval` is being *reviewed*; one
   * parked at `awaiting-human` was never worked by a model at all and is being
   * *reported on*. Both are the operator saying "this is finished / this is
   * not", so both decide through here — and `awaiting-human` is deliberately
   * the only other status accepted, so `decide` still cannot close a task that
   * is running, queued or already terminal.
   */
  decide(taskId: string, approved: boolean, note?: string, by: 'human' | 'owner-gate' = 'human'): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'awaiting-approval' && task.status !== 'awaiting-human') {
      throw new Error(`task ${taskId} is ${task.status}, not awaiting-approval or awaiting-human`);
    }
    this.db
      .prepare('UPDATE artifacts SET approved = ? WHERE task_id = ? AND approved IS NULL')
      .run(approved ? 1 : 0, taskId);
    // A decision at the approval gate rules on the run that parked the task
    // there, and that run carries it — with who made it, because the training
    // sets admit only runs a PERSON decided (align/dataset.ts,
    // align/personaData.ts), and the task-level owner-gate marker does not
    // survive a retry. A task finished on the operator's own desk
    // (awaiting-human) has no run under review.
    if (task.status === 'awaiting-approval') {
      const ruled = this.latestRun(taskId);
      const label = `${by === 'owner-gate' ? 'owner-' : ''}${approved ? 'approved' : 'rejected'}`;
      if (ruled) this.db.prepare('UPDATE runs SET decision = ? WHERE id = ?').run(label, ruled.id);
    }
    this.setStatus(taskId, approved ? 'done' : 'rejected', note ?? null);
    return this.getTask(taskId)!;
  }

  /**
   * A daemon stop is not a verdict on the work: put the task back in the queue
   * for when the daemon returns, with its attempt given back — a routine
   * restart must not fail a ticket on its last attempt (and its dependents and
   * epic with it). Crash loops are bounded by recoverOrphans; a daemon that
   * keeps STOPPING mid-run is bounded here, by a count kept on the row: after
   * MAX_STOP_REQUEUES the ticket goes to the operator's desk instead of round
   * again. Retry, a repair round and Give to AI start the count over.
   */
  requeueAfterStop(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET attempts = MAX(attempts - 1, 0), stop_requeues = stop_requeues + 1 WHERE id = ?')
      .run(taskId);
    const stops = Number((this.db.prepare('SELECT stop_requeues AS n FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined)?.['n'] ?? 0);
    if (stops > MAX_STOP_REQUEUES) {
      this.db.prepare("UPDATE tasks SET assignee = 'human' WHERE id = ?").run(taskId);
      this.record({ taskId, type: 'assign', message: 'assigned to human' });
      this.setStatus(taskId, 'awaiting-human', `interrupted by ${stops} daemon stops — hand it back to the AI, or do it yourself`);
      return;
    }
    this.setStatus(taskId, 'queued', STOP_REQUEUE_NOTE);
  }

  /**
   * A run refused by the provider's usage limit (src/providerLimit.ts): the
   * attempt is given back and the task waits in the queue. Unlike a daemon
   * stop this is not counted toward sending the ticket to the operator — a
   * weekly limit can outlast any count, and the scheduler's hold already keeps
   * it from spinning.
   */
  requeueAfterLimit(taskId: string, until: string): void {
    this.db.prepare('UPDATE tasks SET attempts = MAX(attempts - 1, 0) WHERE id = ?').run(taskId);
    this.setStatus(taskId, 'queued', `held: the provider usage limit was reached; claude-code work resumes after ${until}`);
  }

  /**
   * Move a task between the AI and the operator.
   *
   * Only a task that has not started counts: a running or verifying task is
   * refused rather than yanked, because handing a half-done run to a human
   * leaves a live worker writing into a jail nobody is watching, and handing a
   * human's half-done work to a model loses it. Cancel and requeue instead.
   *
   * A terminal task is refused too — reassigning something already closed
   * changes nothing and would only confuse the archive's actuals.
   */
  reassign(taskId: string, assignee: Assignee): Task {
    if (!ASSIGNEES.has(assignee)) throw new Error(`unknown assignee: ${assignee}`);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.isEpic) throw new Error(`task ${taskId} is an epic: reassign its tickets, not the container`);
    const movable = new Set<TaskStatus>(['queued', 'blocked', 'awaiting-human']);
    if (!movable.has(task.status)) {
      throw new Error(`task ${taskId} is ${task.status}: only a task that has not started can be reassigned`);
    }
    // Handing it (back) to the AI is a fresh start for the stop bound.
    this.db
      .prepare(`UPDATE tasks SET assignee = ?, ${assignee === 'ai' ? 'stop_requeues = 0, ' : ''}updated_at = ? WHERE id = ?`)
      .run(assignee, Date.now(), taskId);
    this.record({ taskId, type: 'assign', message: `assigned to ${assignee}` });
    // `blocked` is about dependencies, not about who works it: leave it alone
    // and let reconcileBlocked() promote it to the right ready status later.
    if (task.status !== 'blocked') this.setStatus(taskId, readyStatus(assignee));
    return this.getTask(taskId)!;
  }

  /** Everything sitting on the operator's own desk, oldest first. */
  awaitingHuman(limit = 100): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'awaiting-human' ORDER BY priority DESC, updated_at ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => rowToTask(r, this.depsOf(String(r['id']))));
  }

  /**
   * Cancel a task and everything queued under it. Cancelling an epic while its
   * tickets keep running would leave live workers spending on an epic nobody
   * is waiting for, so the cascade is not optional — and it goes through the
   * same per-child path (status + 'cancel' event), so a running worker still
   * gets its abort.
   */
  cancel(taskId: string, note?: string | null): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error(`task ${taskId} already ${task.status}`);
    this.setStatus(taskId, 'canceled', 'canceled by operator');
    this.emit('cancel', taskId);
    // The reason, when one was given, is in the decision row and its timeline
    // event; the status note stays the fixed sentence other code matches on.
    this.noteDecision({ taskId, runId: this.latestRun(taskId)?.id ?? null, action: 'cancel', note, statusAfter: 'canceled', extra: { statusBefore: task.status } });
    // Parent first: the container is already terminal when its children close,
    // so closeEpicIfComplete cannot overwrite the cancel with a 'failed'.
    this.cancelDescendants(taskId, `parent ${taskId} was canceled`, new Set([taskId]));
    return this.getTask(taskId)!;
  }





  /**
   * Who decides this task at the gate. Only a task that has not been decided
   * can be changed: re-gating something already closed changes nothing.
   */
  setGate(taskId: string, gate: GateMode | null): Task {
    if (gate !== null && !GATES.has(gate)) throw new Error(`unknown gate: ${gate}`);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error(`task ${taskId} is already ${task.status}`);
    this.db.prepare('UPDATE tasks SET gate = ?, updated_at = ? WHERE id = ?').run(gate, Date.now(), taskId);
    // A gate decision already recorded on this attempt would suppress the new
    // gate's run, so re-gating clears it — otherwise handing a ticket to the
    // owner model does nothing and says nothing.
    this.clearGateDecision(taskId);
    this.record({ taskId, type: 'status', message: `gate: decided by ${gate ?? 'the default'}` });
    return this.getTask(taskId)!;
  }

  /**
   * Hand every ticket currently parked at the gate to `gate`.
   *
   * Retroactive by design, and only ever from an explicit operator action —
   * which is exactly the distinction `effectiveGate` draws. An exported
   * FOREMAN_GATE must never reach a backlog that was already waiting when the
   * shell exported it; a person typing this, or pressing the button that calls
   * it, is the sanctioned path for the same effect.
   *
   * Nothing here bypasses `hardHumanReason`. A ticket whose run failed, whose
   * verdict was fail or split, that is S2, that carries allowCore or that its
   * playbook marks hard-human still parks for a person — it simply parks with
   * the owner having declined to decide it rather than never having looked.
   */
  gateWaiting(gate: GateMode): string[] {
    const changed: string[] = [];
    for (const task of this.awaitingApproval(1000)) {
      if (task.gate === gate) continue;
      this.setGate(task.id, gate);
      changed.push(task.id);
    }
    return changed;
  }

  /**
   * The house default for who decides at the gate, set from the board.
   * Null means "not set here", which resolves onward to the playbook and then
   * FOREMAN_GATE — deliberately distinct from being set to 'human'.
   */
  defaultGate(): GateMode | null {
    const raw = this.getSetting('gate.default');
    return raw === 'human' || raw === 'owner' ? raw : null;
  }

  setDefaultGate(gate: GateMode | null): void {
    if (gate === null) {
      this.db.prepare("DELETE FROM settings WHERE key = 'gate.default'").run();
    } else {
      if (!GATES.has(gate)) throw new Error(`unknown gate: ${gate}`);
      this.setSetting('gate.default', gate);
    }
    this.record({ type: 'status', message: `house gate: ${gate ?? 'the environment default'}` });
  }

  // ------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row['value']) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?')
      .run(key, value, Date.now(), value, Date.now());
  }

  /**
   * The house default for who works a task, as set from the board.
   *
   * Resolution below this: FOREMAN_ASSIGNEE, then 'ai'. Above it: the
   * playbook, then the task's own setting. So flipping this switches every
   * task that has no opinion of its own, and overrides nothing that does —
   * which is what makes it safe to flip while work is in flight.
   *
   * Null means "not set from the board", which is deliberately distinct from
   * "set to ai": an operator who has never touched the toggle should keep
   * following FOREMAN_ASSIGNEE if they set one.
   */
  defaultAssignee(): Assignee | null {
    const raw = this.getSetting('assignee.default');
    return raw === 'ai' || raw === 'human' ? raw : null;
  }

  setDefaultAssignee(assignee: Assignee | null): void {
    if (assignee === null) {
      this.db.prepare("DELETE FROM settings WHERE key = 'assignee.default'").run();
    } else {
      if (!ASSIGNEES.has(assignee)) throw new Error(`unknown assignee: ${assignee}`);
      this.setSetting('assignee.default', assignee);
    }
    this.record({ type: 'assign', message: `house default: new tasks go to ${assignee ?? 'the environment default'}` });
  }

  // ------------------------------------------------------- shadow verdicts

  /**
   * Record what a local reviewer WOULD have decided, alongside what the cloud
   * reviewer actually decided. Never consulted for a routing decision — this
   * is evidence, and the only thing that reads it is the agreement report.
   */
  addShadowVerdict(v: {
    taskId: string;
    runId: string;
    playbook: string | null;
    role: string | null;
    authoritative: string;
    shadow: string;
    shadowModel?: string | null;
    shadowCritique?: string | null;
    costUsd?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO shadow_verdicts
           (id,task_id,run_id,playbook,role,authoritative,shadow,shadow_model,shadow_critique,cost_usd,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id('sv'), v.taskId, v.runId, v.playbook, v.role,
        v.authoritative, v.shadow,
        v.shadowModel ?? null,
        v.shadowCritique == null ? null : v.shadowCritique.slice(0, 2000),
        v.costUsd ?? 0, Date.now(),
      );
    this.record({
      taskId: v.taskId,
      type: 'shadow',
      message: `shadow: local said ${v.shadow}, cloud said ${v.authoritative}` +
        (v.shadow === v.authoritative ? ' (agreed)' : ' (DISAGREED)'),
    });
  }

  /**
   * The most recent pairs, returned oldest-first so a trend reads left to right.
   *
   * `ORDER BY created_at ASC LIMIT 2000` took the OLDEST 2000, so once the
   * ledger passed the limit the agreement report and its trend froze on the
   * earliest evidence forever — the exact opposite of what a "is the local
   * reviewer catching up?" number is for, and it would have frozen on the
   * worst data the system ever produced.
   */
  shadowPairs(limit = 2000): ShadowPair[] {
    const rows = (this.db
      .prepare('SELECT * FROM shadow_verdicts ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]).reverse();
    return rows.map((r) => ({
      taskId: String(r['task_id']),
      playbook: r['playbook'] == null ? null : String(r['playbook']),
      role: r['role'] == null ? null : String(r['role']),
      authoritative: String(r['authoritative']) as ShadowPair['authoritative'],
      shadow: String(r['shadow']) as ShadowPair['shadow'],
      at: Number(r['created_at']),
    }));
  }

  shadowCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM shadow_verdicts').get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  // ------------------------------------------------------------------ archive

  /**
   * Fold every task that has been terminal for longer than `days` into the
   * archive. Returns how many were folded.
   *
   * The record is denormalised on purpose. Reading duration and cost back out
   * of `runs` and `receipts` would make the archive only as durable as the
   * ledgers `prune` deletes — and the whole point is that an estimate built
   * from 2025's tickets still works in 2027. So the numbers are copied at fold
   * time and never recomputed.
   *
   * An epic is folded like any other task; its own `points`/duration are the
   * container's, which is exactly the number you want when estimating a whole
   * epic rather than a ticket.
   */
  archiveClosed(days = DEFAULT_ARCHIVE_AFTER_DAYS, now = Date.now()): number {
    const cutoff = now - Math.max(0, days) * 86_400_000;
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE archived_at IS NULL AND status IN (${placeholders}) AND updated_at <= ?
          ORDER BY updated_at ASC`,
      )
      .all(...TERMINAL_STATUSES, cutoff) as Record<string, unknown>[];
    if (!rows.length) return 0;

    const runAgg = this.db.prepare(
      `SELECT COALESCE(MIN(started_at), 0) AS first_start,
              COALESCE(MAX(COALESCE(ended_at, started_at)), 0) AS last_end,
              COALESCE(SUM(tokens_in), 0)  AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(cost_usd), 0)   AS cost_usd,
              COUNT(*) AS runs
         FROM runs WHERE task_id = ?`,
    );
    const lastRun = this.db.prepare(
      'SELECT verdict, summary FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    );
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO archive
        (task_id,archived_at,closed_at,created_at,title,kind,status,repo,playbook,role,runner,assignee,
         epic_id,points,repairs,attempts,duration_ms,cost_usd,tokens_in,tokens_out,verdict,error,acceptance,summary,terms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const stamp = this.db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?');

    let folded = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const taskId = String(row['id']);
        const task = rowToTask(row, []);
        const agg = runAgg.get(taskId) as Record<string, unknown>;
        const last = lastRun.get(taskId) as Record<string, unknown> | undefined;
        const firstStart = Number(agg['first_start'] ?? 0);
        const lastEnd = Number(agg['last_end'] ?? 0);
        insert.run(
          taskId, now, task.updatedAt, task.createdAt,
          task.title, task.kind, task.status,
          task.repo, task.playbook, task.role, task.runner,
          effectiveAssignee(task, undefined, this.defaultAssignee()),
          task.parentId, task.points,
          task.repairs, task.attempts,
          firstStart && lastEnd > firstStart ? lastEnd - firstStart : 0,
          Number(agg['cost_usd'] ?? 0), Number(agg['tokens_in'] ?? 0), Number(agg['tokens_out'] ?? 0),
          last?.['verdict'] == null ? null : String(last['verdict']),
          task.error,
          task.acceptance,
          last?.['summary'] == null ? null : String(last['summary']).slice(0, 1000),
          archiveTerms(task.title, task.acceptance, task.role, task.playbook),
        );
        stamp.run(now, taskId);
        folded++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (folded) this.record({ type: 'archive', message: `archived ${folded} closed task(s) older than ${days}d` });
    return folded;
  }

  /**
   * Put an archived task back in the Closed lane. The archive record is left
   * alone — it is the measurement, and un-hiding a card is not a reason to
   * forget how long the work took.
   */
  unarchive(taskId: string): boolean {
    const info = this.db.prepare('UPDATE tasks SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL').run(taskId);
    return info.changes > 0;
  }

  /** Archived records, newest first. `limit` bounds a board or CLI page. */
  listArchive(limit = 100, offset = 0): ArchiveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM archive ORDER BY archived_at DESC, closed_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Record<string, unknown>[];
    return rows.map(rowToArchive);
  }

  archiveCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM archive').get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  /**
   * Candidate records for a search or an estimate.
   *
   * Narrowed in SQL by (playbook, role) when they are known — the indexed path,
   * and the one that matters, since an estimate for a publishing author ticket
   * has no business scanning software tickets. With neither, it falls back to a
   * bounded recent scan rather than the whole table.
   */
  archiveCandidates(opts: { playbook?: string | null; role?: string | null; limit?: number } = {}): ArchiveRecord[] {
    const limit = opts.limit ?? 500;
    const where: string[] = [];
    const args: Array<string> = [];
    if (opts.playbook) { where.push('playbook = ?'); args.push(opts.playbook); }
    if (opts.role) { where.push('role = ?'); args.push(opts.role); }
    const rows = this.db
      .prepare(`SELECT * FROM archive ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY closed_at DESC LIMIT ?`)
      .all(...args, limit) as Record<string, unknown>[];
    return rows.map(rowToArchive);
  }

  /**
   * What similar past work actually cost, in time and money. Zero tokens: the
   * numbers come off rows that were measured, not from a model asked to guess.
   *
   * The (playbook, role) narrowing is applied as a *hint*, not a filter: if it
   * yields too little to be worth calling an estimate, the search widens to the
   * whole recent archive rather than returning a confident number built on one
   * sample. `samples` on the result is what tells the caller which happened.
   */
  estimateTask(query: { text: string; role?: string | null; playbook?: string | null }): Estimate {
    const narrow = this.archiveCandidates({ playbook: query.playbook, role: query.role });
    const MIN_SAMPLES = 3;
    const pool = narrow.length >= MIN_SAMPLES ? narrow : this.archiveCandidates({});
    return estimateFrom(pool, query);
  }

  /** Depth-first over parent_id, so a nested epic's tickets are reached too. */
  private cancelDescendants(taskId: string, reason: string, seen: Set<string>): void {
    for (const child of this.childrenOf(taskId)) {
      if (seen.has(child.id)) continue; // a parent cycle must not wedge a cancel
      seen.add(child.id);
      if (!TERMINAL_STATUSES.includes(child.status)) {
        this.setStatus(child.id, 'canceled', reason);
        this.emit('cancel', child.id);
        // Foreman's own doing, not a person's word about this ticket: recorded as the system's.
        this.noteDecision({ taskId: child.id, runId: this.latestRun(child.id)?.id ?? null, action: 'cancel', actor: 'system', note: reason, statusAfter: 'canceled', extra: { statusBefore: child.status } });
      }
      // Still recurse through an already-terminal child: a failed nested epic
      // can have live tickets of its own.
      this.cancelDescendants(child.id, reason, seen);
    }
  }

  /**
   * Latest run per task, in one query. The board's snapshot used to issue one
   * `latestRun` per task, so a busy history made `GET /state` linear in the
   * number of tasks for no reason.
   */
  latestRunByTask(): Map<string, Run> {
    // Matching MAX(started_at) and MAX(rowid) separately looks equivalent but
    // is not: a clock step backwards can make the newest row have neither, and
    // the task then vanishes from the snapshot. Pick the row the same way
    // latestRun() does, so the two can never disagree.
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r
          WHERE r.rowid = (
            SELECT r2.rowid FROM runs r2
             WHERE r2.task_id = r.task_id AND (r2.decision IS NULL OR r2.decision != 'abandoned')
             ORDER BY r2.started_at DESC, r2.rowid DESC
             LIMIT 1)`,
      )
      .all() as Record<string, unknown>[];
    return new Map(rows.map((row) => [String(row['task_id']), rowToRun(row)]));
  }

  /** All artifacts, grouped by task, in one query. */
  artifactsByTask(): Map<string, Artifact[]> {
    const rows = this.db.prepare('SELECT * FROM artifacts ORDER BY created_at').all() as Record<string, unknown>[];
    const out = new Map<string, Artifact[]>();
    for (const row of rows) {
      const key = String(row['task_id']);
      const list = out.get(key) ?? [];
      list.push(rowToArtifact(row));
      out.set(key, list);
    }
    return out;
  }

  /**
   * Age out ledger rows that no longer inform anything, keeping every row that
   * belongs to a task still awaiting a decision. Receipts and verdicts grow
   * without bound otherwise; per-task events are already pruned per run.
   */
  pruneLedgers(olderThanDays = 90): { receipts: number; verdicts: number } {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const undecided = "SELECT id FROM tasks WHERE status NOT IN ('done','failed','rejected','canceled')";
    const receipts = this.db
      .prepare(`DELETE FROM receipts WHERE created_at < ? AND (task_id IS NULL OR task_id NOT IN (${undecided}))`)
      .run(cutoff);
    const verdicts = this.db
      .prepare(`DELETE FROM verdicts WHERE created_at < ? AND task_id NOT IN (${undecided})`)
      .run(cutoff);
    return { receipts: Number(receipts.changes), verdicts: Number(verdicts.changes) };
  }

  // ------------------------------------------------------------- verdicts

  addVerdict(v: {
    runId: string;
    taskId: string;
    verdict: CouncilVerdict;
    disagreement: boolean;
    council: AdvisorOpinion[];
    chairSummary?: string | null;
    /** Set only when a chair was actually called, so the ledger names who decided. */
    chairModel?: string | null;
    /** Defaults to the local council; a playbook review chain writes 'crew'. */
    source?: Verdict['source'];
    critique?: string | null;
    costUsd?: number;
    provisional?: boolean;
  }): Verdict {
    const verdictId = id('v');
    const source = v.source ?? 'council';
    this.db
      .prepare(
        `INSERT INTO verdicts (id, run_id, task_id, verdict, disagreement, council_json, chair_summary, chair_model, source, critique, cost_usd, provisional, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        verdictId, v.runId, v.taskId, v.verdict, v.disagreement ? 1 : 0,
        JSON.stringify(v.council), v.chairSummary ?? null, v.chairModel ?? null, source,
        v.critique ?? null, v.costUsd ?? 0, v.provisional ? 1 : 0, Date.now(),
      );
    this.db.prepare('UPDATE runs SET verdict = ? WHERE id = ?').run(v.verdict, v.runId);
    this.record({
      taskId: v.taskId,
      runId: v.runId,
      type: 'verdict',
      stage: 'verify',
      // "split" is the advisors disagreeing; whether a chair then ruled is a
      // separate fact (a conflicted chair hands the split up uncalled).
      message: `${source}: ${v.verdict}${v.disagreement ? (chairRuled({ ...v, chairSummary: v.chairSummary ?? null, source }) ? ' (split, chair ruled)' : ' (split, no ruling)') : ''}`,
    });
    return this.db.prepare('SELECT * FROM verdicts WHERE id = ?').all(verdictId).map(rowToVerdict)[0]!;
  }

  /**
   * Work parked at the gate whose NEWEST verdict is provisional — what the
   * re-check sweep re-reviews once the full council fits. Oldest first, so a
   * backlog drains in the order it was parked.
   *
   * That verdict has to be on the run the re-check would review, the task's
   * latest (the row `latestRun` picks). A run parked for a person with no
   * reviewer called has no verdict of its own, and the provisional one of an
   * EARLIER run listed it: the re-check then reviewed the parked run.
   */
  provisionalAwaiting(limit = 20): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'awaiting-approval'
           AND (SELECT v.provisional FROM verdicts v WHERE v.task_id = t.id
                ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) = 1
           AND (SELECT v.run_id FROM verdicts v WHERE v.task_id = t.id
                ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1)
             = (SELECT r.id FROM runs r WHERE r.task_id = t.id AND ${NOT_ABANDONED}
                ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1)
         ORDER BY t.updated_at ASC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => rowToTask(r, this.depsOf(String(r['id']))));
  }

  verdictsForTask(taskId: string): Verdict[] {
    return this.db
      // rowid breaks the tie: two verdicts in the same millisecond (a council
      // and the crew chain that followed it) must still read newest-first.
      .prepare('SELECT * FROM verdicts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(taskId)
      .map(rowToVerdict);
  }

  /** Accumulate time a run's test commands queued for a verify slot. */
  addVerifyWait(runId: string, ms: number): void {
    this.db.prepare('UPDATE runs SET verify_wait_ms = verify_wait_ms + ? WHERE id = ?').run(Math.round(ms), runId);
  }

  setTestsPassed(runId: string, passed: boolean): void {
    this.db.prepare('UPDATE runs SET tests_passed = ? WHERE id = ?').run(passed ? 1 : 0, runId);
  }

  // ------------------------------------------------------ council memo cache

  /** Cap on distinct cached council opinions; oldest are pruned past it. */
  private static readonly COUNCIL_CACHE_MAX = 5000;

  /**
   * A cached advisor opinion keyed by (model, rubric version, prompt hash). A
   * repair round whose re-review input hashes identically reuses this instead
   * of paying the model again.
   */
  getCachedOpinion(key: string): { verdict: 'pass' | 'fail'; confidence: number; critique: string } | null {
    const row = this.db
      .prepare('SELECT verdict, confidence, critique FROM council_cache WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    const verdict = String(row['verdict']);
    if (verdict !== 'pass' && verdict !== 'fail') return null;
    return { verdict, confidence: Number(row['confidence']), critique: String(row['critique'] ?? '') };
  }

  putCachedOpinion(
    key: string,
    model: string,
    opinion: { verdict: 'pass' | 'fail'; confidence: number; critique: string },
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO council_cache (key, model, verdict, confidence, critique, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(key, model, opinion.verdict, opinion.confidence, opinion.critique, Date.now());
    // Keep the cache bounded; hashes are otherwise permanent.
    this.db
      .prepare(
        `DELETE FROM council_cache WHERE key IN
           (SELECT key FROM council_cache ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(Store.COUNCIL_CACHE_MAX);
  }

  // ------------------------------------------------- crew review memo cache

  /**
   * A cached crew reviewer reply, keyed by (version, model, the exact reviewer
   * prompt) — the whole of what the reviewer was asked, ticket identity
   * included. A retry or a no-op repair round replays it for free instead of
   * paying a hosted model again.
   */
  getCachedReview(key: string): { verdict: 'pass' | 'fail'; critique: string; issuesJson: string } | null {
    const row = this.db
      .prepare('SELECT verdict, critique, issues_json FROM crew_review_cache WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    const verdict = String(row['verdict']);
    if (verdict !== 'pass' && verdict !== 'fail') return null;
    return {
      verdict,
      critique: String(row['critique'] ?? ''),
      issuesJson: String(row['issues_json'] ?? '[]'),
    };
  }

  putCachedReview(
    key: string,
    model: string,
    review: { verdict: 'pass' | 'fail'; critique: string; issuesJson: string },
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO crew_review_cache (key, model, verdict, critique, issues_json, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(key, model, review.verdict, review.critique, review.issuesJson, Date.now());
    this.db
      .prepare(
        `DELETE FROM crew_review_cache WHERE key IN
           (SELECT key FROM crew_review_cache ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(Store.COUNCIL_CACHE_MAX);
  }

  /**
   * Consecutive crew-review failures for a task, newest first, stopping at the
   * first pass. This is the escalation counter: a task whose crew chain keeps
   * rejecting it has to reach a chair, and a pass resets the count so an old
   * bad round cannot escalate a later, unrelated one.
   */
  crewFailureStreak(taskId: string): number {
    const rows = this.db
      .prepare("SELECT verdict FROM verdicts WHERE task_id = ? AND source = 'crew' ORDER BY created_at DESC, rowid DESC")
      .all(taskId) as Record<string, unknown>[];
    let streak = 0;
    for (const row of rows) {
      if (String(row['verdict']) !== 'fail') break;
      streak++;
    }
    return streak;
  }

  // ---------------------------------------------------------- crew report

  /**
   * What each (playbook, role) pair has actually cost and delivered: how many
   * tickets it closed, how often its work passed review the FIRST time, how
   * many repair rounds it needed, and what it spent doing it.
   *
   * Reads tasks, verdicts and receipts only — no model call, no token. The
   * first-review pass rate is the one number that separates "this role is the
   * wrong tier" from "this domain is hard": a tier that keeps failing its first
   * review is paying for a repair round it could have skipped, and a tier that
   * never fails one is paying for headroom it never uses.
   */
  crewReport(): CrewReportRow[] {
    const rows = new Map<string, CrewReportRow>();
    const keyOf = (playbook: string, role: string): string => `${playbook}\u0000${role}`;
    const rowFor = (playbook: string, role: string): CrewReportRow => {
      const key = keyOf(playbook, role);
      const existing = rows.get(key);
      if (existing) return existing;
      const fresh: CrewReportRow = {
        playbook, role, tickets: 0, firstReviewed: 0, firstPassRate: null, firstIncomplete: 0,
        avgRepairs: 0, mapRepairs: 0, costUsd: 0, avgCostUsd: 0,
      };
      rows.set(key, fresh);
      return fresh;
    };

    // Summed over every non-epic ticket of the pair, done or not: a ticket
    // that failed after its repair rounds ran out is exactly what this counts.
    const mapped = this.db
      .prepare(
        `SELECT playbook, role, SUM(pre_review_repairs) AS n FROM tasks
          WHERE playbook IS NOT NULL AND role IS NOT NULL AND is_epic = 0 AND pre_review_repairs > 0
          GROUP BY playbook, role`,
      )
      .all() as Record<string, unknown>[];
    for (const r of mapped) rowFor(String(r['playbook']), String(r['role'])).mapRepairs = Number(r['n'] ?? 0);

    // Completed work, its spend, and its run count. A repair round is a second
    // run on the same ticket, so `runs - tickets` IS the repair count.
    const delivered = this.db
      .prepare(
        `SELECT t.playbook AS playbook, t.role AS role,
                COUNT(*) AS tickets,
                COALESCE(SUM(rc.cost), 0) AS cost_usd,
                COALESCE(SUM(CASE WHEN rn.runs > 1 THEN rn.runs - 1 ELSE 0 END), 0) AS repairs
           FROM tasks t
           LEFT JOIN (SELECT task_id, SUM(cost_usd) AS cost FROM receipts GROUP BY task_id) rc
                  ON rc.task_id = t.id
           LEFT JOIN (SELECT task_id, COUNT(*) AS runs FROM runs GROUP BY task_id) rn
                  ON rn.task_id = t.id
          WHERE t.playbook IS NOT NULL AND t.role IS NOT NULL AND t.is_epic = 0 AND t.status = 'done'
          GROUP BY t.playbook, t.role`,
      )
      .all() as Record<string, unknown>[];
    for (const r of delivered) {
      const row = rowFor(String(r['playbook']), String(r['role']));
      row.tickets = Number(r['tickets'] ?? 0);
      row.costUsd = Number(r['cost_usd'] ?? 0);
      // Clamped per ticket in SQL (a zero-run done ticket contributes 0, not
      // -1), so a group mixing repaired and unrun tickets reports the true
      // per-ticket average instead of letting the negatives cancel repairs.
      row.avgRepairs = row.tickets ? Number(r['repairs'] ?? 0) / row.tickets : 0;
      row.avgCostUsd = row.tickets ? row.costUsd / row.tickets : 0;
    }

    // The FIRST crew verdict per ticket, which is the only one that answers
    // "did this role get it right without a repair round". Deliberately NOT
    // filtered to status='done': a ticket that failed outright is exactly the
    // signal the pass rate exists to carry, so `firstReviewed` can exceed the
    // delivered `tickets` count — the CLI prints both populations. SQLite's documented
    // bare-column rule applies: with a single MIN() aggregate, the other
    // columns come from the row that matched it. rowid is folded into the
    // ordering key because two verdicts CAN share a millisecond, and "first"
    // then has to mean the row that was written first, not either of them. The
    // key stays inside the subquery: it is an int64 nobody reads back.
    //
    // A first round that lost a reviewer (a `review:incomplete` receipt) is no
    // first review either way. Survivors that all PASS write no crew verdict,
    // and survivors that FAIL do: counting only the FAILs would drag every rate
    // down by however often a reviewer drops out. So a ticket leaves the
    // sample when that receipt sits on its first verdict's run or comes before
    // it, or when it never got a verdict at all, and `firstIncomplete` counts it.
    const reviewed = this.db
      .prepare(
        `WITH first_verdict AS (
           SELECT task_id, run_id, verdict, created_at, MIN(created_at * 1000000 + rowid) AS ord
             FROM verdicts WHERE source = 'crew' GROUP BY task_id
         ), lost_first AS (
           SELECT task_id, MIN(created_at) AS at FROM receipts WHERE kind = 'review:incomplete' GROUP BY task_id
         ), lost_runs AS (
           SELECT DISTINCT task_id, run_id FROM receipts WHERE kind = 'review:incomplete' AND run_id IS NOT NULL
         ), first_round AS (
           SELECT t.playbook AS playbook, t.role AS role, v.verdict AS verdict,
                  (lf.task_id IS NOT NULL AND (v.task_id IS NULL OR lr.run_id IS NOT NULL OR lf.at < v.created_at)) AS lost
             FROM tasks t
             LEFT JOIN first_verdict v ON v.task_id = t.id
             LEFT JOIN lost_first lf ON lf.task_id = t.id
             LEFT JOIN lost_runs lr ON lr.task_id = t.id AND lr.run_id = v.run_id
            WHERE t.playbook IS NOT NULL AND t.role IS NOT NULL AND t.is_epic = 0
              AND (v.task_id IS NOT NULL OR lf.task_id IS NOT NULL)
         )
         SELECT playbook, role,
                SUM(CASE WHEN lost THEN 0 ELSE 1 END) AS reviewed,
                SUM(CASE WHEN NOT lost AND verdict = 'pass' THEN 1 ELSE 0 END) AS passed,
                SUM(CASE WHEN lost THEN 1 ELSE 0 END) AS incomplete
           FROM first_round
          GROUP BY playbook, role`,
      )
      .all() as Record<string, unknown>[];
    for (const r of reviewed) {
      const row = rowFor(String(r['playbook']), String(r['role']));
      row.firstReviewed = Number(r['reviewed'] ?? 0);
      row.firstPassRate = row.firstReviewed ? Number(r['passed'] ?? 0) / row.firstReviewed : null;
      row.firstIncomplete = Number(r['incomplete'] ?? 0);
    }

    return [...rows.values()].sort((a, b) =>
      a.playbook === b.playbook ? a.role.localeCompare(b.role) : a.playbook.localeCompare(b.playbook));
  }

  // ------------------------------------------------------------- receipts

  addReceipt(r: {
    taskId?: string | null;
    runId?: string | null;
    kind: string;
    provider: string;
    model: string;
    local: boolean;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    reservedUsd?: number;
    latencyMs?: number;
    /** The alias this call was meant for, when it ran on a smaller model instead. */
    downshiftedFrom?: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO receipts (id, task_id, run_id, kind, provider, model, local, tokens_in, tokens_out, cost_usd, reserved_usd, latency_ms, day, created_at, downshifted_from)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id('rc'), r.taskId ?? null, r.runId ?? null, r.kind, r.provider, r.model, r.local ? 1 : 0,
        r.tokensIn ?? 0, r.tokensOut ?? 0, r.costUsd ?? 0, r.reservedUsd ?? 0, r.latencyMs ?? 0,
        new Date(now).toISOString().slice(0, 10), now, r.downshiftedFrom ?? null,
      );
  }

  /**
   * Today's METERED spend — what the daily cap exists to bound.
   *
   * Subscription calls are deliberately excluded. The Claude CLI aliases carry
   * list prices so a receipt can answer "what would this work cost to
   * reproduce", which is a real question and worth recording. But under a
   * subscription those dollars are never billed, and counting them against a
   * $5 cap means a handful of Opus reviews hard-stop every task on the board
   * over money nobody spent. The cap is a spending control; a subscription is
   * rate-limited by Anthropic, not by this ledger.
   *
   * `spentTodayIncludingSubscription()` is the honest total, and is what the
   * receipts view reports.
   */
  spentToday(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM receipts WHERE day = ? AND provider <> 'claude-cli'")
      .get(new Date().toISOString().slice(0, 10)) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /**
   * Today's NOTIONAL subscription spend — the Claude CLI aliases at list price.
   *
   * Not billed, and so not the daily cap's business; but still bounded, by its
   * own much larger ceiling. The thing worth stopping here is a runaway loop —
   * a gate re-deciding the same ticket every tick — and a loop is just as
   * expensive against a subscription's rate limits as against a card.
   */
  spentTodaySubscription(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM receipts WHERE day = ? AND provider = 'claude-cli'")
      .get(new Date().toISOString().slice(0, 10)) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /** Every dollar recorded today, metered or notional. Reporting, not control. */
  spentTodayIncludingSubscription(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM receipts WHERE day = ?')
      .get(new Date().toISOString().slice(0, 10)) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  spentOnTask(taskId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM receipts WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  receiptsForTask(taskId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM receipts WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as Record<string, unknown>[];
  }

  /** Proof for the S2 claim: did any non-local call happen for this task? */
  nonLocalCallsForTask(taskId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM receipts WHERE task_id = ? AND local = 0')
      .get(taskId) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /**
   * The three receipt reads the spend view needs. Each takes the same window —
   * 'today' (the indexed `day` column, the same one spentToday() uses) or
   * 'all' — so a caller can render totals, a grouping and the tail of the
   * ledger without any of them disagreeing about which rows they counted.
   */
  receiptTotals(day: ReceiptWindow = 'today'): ReceiptTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN local = 1 THEN 1 ELSE 0 END), 0) AS localCalls,
                COALESCE(SUM(cost_usd), 0) AS costUsd,
                COALESCE(SUM(tokens_in), 0) AS tokensIn,
                COALESCE(SUM(tokens_out), 0) AS tokensOut,
                COALESCE(SUM(latency_ms), 0) AS latencyMs
           FROM receipts ${receiptWhere(day)}`,
      )
      .get(...receiptArgs(day)) as Record<string, unknown> | undefined;
    return {
      calls: Number(row?.['calls'] ?? 0),
      localCalls: Number(row?.['localCalls'] ?? 0),
      costUsd: Number(row?.['costUsd'] ?? 0),
      tokensIn: Number(row?.['tokensIn'] ?? 0),
      tokensOut: Number(row?.['tokensOut'] ?? 0),
      latencyMs: Number(row?.['latencyMs'] ?? 0),
    };
  }

  /**
   * Spend grouped by who charged for it (`provider`) or what it was for
   * (`kind`). `by` is a closed union rather than a column name so no caller
   * can ever splice a string into this SQL.
   */
  receiptGroups(by: 'provider' | 'kind', day: ReceiptWindow = 'today'): ReceiptGroup[] {
    const column = by === 'provider' ? 'provider' : 'kind';
    const rows = this.db
      .prepare(
        `SELECT ${column} AS name, COUNT(*) AS calls,
                COALESCE(SUM(cost_usd), 0) AS costUsd,
                COALESCE(SUM(tokens_in), 0) AS tokensIn,
                COALESCE(SUM(tokens_out), 0) AS tokensOut
           FROM receipts ${receiptWhere(day)}
          GROUP BY ${column}
          ORDER BY costUsd DESC, calls DESC`,
      )
      .all(...receiptArgs(day)) as Record<string, unknown>[];
    return rows.map((r) => ({
      name: String(r['name'] ?? 'unknown'),
      calls: Number(r['calls'] ?? 0),
      costUsd: Number(r['costUsd'] ?? 0),
      tokensIn: Number(r['tokensIn'] ?? 0),
      tokensOut: Number(r['tokensOut'] ?? 0),
    }));
  }

  /** The tail of the ledger, newest first. Capped like every other list read. */
  recentReceipts(limit = 50, day: ReceiptWindow = 'today'): Record<string, unknown>[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.floor(limit)) : 50;
    return this.db
      .prepare(`SELECT * FROM receipts ${receiptWhere(day)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...receiptArgs(day), n) as Record<string, unknown>[];
  }

  /**
   * callsToday and nonLocalCallsToday as one grouped query instead of the two
   * separate COUNT(*) scans the /api/state snapshot used to run on every
   * poll. `day` is indexed (idx_receipts_day), so `GROUP BY local` folds both
   * counts into a single pass over the same rows.
   */
  receiptCallCountsByLocal(day: string): { total: number; nonLocal: number } {
    const rows = this.db
      .prepare('SELECT local, COUNT(*) AS n FROM receipts WHERE day = ? GROUP BY local')
      .all(day) as Record<string, unknown>[];
    let total = 0;
    let nonLocal = 0;
    for (const row of rows) {
      const n = Number(row['n'] ?? 0);
      total += n;
      if (Number(row['local']) === 0) nonLocal += n;
    }
    return { total, nonLocal };
  }

  // --------------------------------------------------------------- memory

  /**
   * Write a fact, revising any live belief with the same scope+key. The old
   * row is retired rather than deleted so the revision history survives.
   */
  rememberFact(f: { scope: string; key: string; value: string; confidence?: number; source?: string }): MemoryFact {
    const now = Date.now();
    const prior = this.db
      .prepare('SELECT * FROM memory WHERE scope = ? AND key = ? AND retired_at IS NULL')
      .get(f.scope, f.key) as Record<string, unknown> | undefined;

    if (prior && String(prior['value']) === f.value) {
      const bumped = Math.min(0.99, Number(prior['confidence']) + 0.1);
      this.db.prepare('UPDATE memory SET confidence = ?, updated_at = ? WHERE id = ?')
        .run(bumped, now, String(prior['id']));
      return this.db.prepare('SELECT * FROM memory WHERE id = ?').all(String(prior['id'])).map(rowToMemory)[0]!;
    }
    if (prior) this.db.prepare('UPDATE memory SET retired_at = ? WHERE id = ?').run(now, String(prior['id']));

    const factId = id('m');
    this.db
      .prepare('INSERT INTO memory (id, scope, key, value, confidence, source, supersedes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(factId, f.scope, f.key, f.value, f.confidence ?? 0.6, f.source ?? null, prior ? String(prior['id']) : null, now, now);
    return this.db.prepare('SELECT * FROM memory WHERE id = ?').all(factId).map(rowToMemory)[0]!;
  }

  recallFacts(scope: string, limit = 20): MemoryFact[] {
    return this.db
      .prepare(
        `SELECT * FROM memory WHERE retired_at IS NULL AND scope IN (?, 'global')
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
      )
      .all(scope, limit)
      .map(rowToMemory);
  }

  /**
   * The newest fail verdicts' critiques for one scope's tasks, newest first.
   * Scope 'global' is the tasks with no repo. Read-only: consolidation input.
   */
  failCritiques(scope: string, limit = 200): { taskId: string; critique: string }[] {
    const where = scope === 'global' ? 't.repo IS NULL' : 't.repo = ?';
    const rows = this.db
      .prepare(
        `SELECT v.task_id AS task_id, v.critique AS critique FROM verdicts v
         JOIN tasks t ON t.id = v.task_id
         WHERE v.verdict = 'fail' AND v.critique IS NOT NULL AND TRIM(v.critique) != '' AND ${where}
         ORDER BY v.created_at DESC, v.rowid DESC LIMIT ?`,
      )
      .all(...(scope === 'global' ? [limit] : [scope, limit])) as Record<string, unknown>[];
    return rows.map((r) => ({ taskId: String(r['task_id']), critique: String(r['critique']) }));
  }

  /** Standing operator demands on one scope's tasks, newest first. Read-only: consolidation input. */
  operatorDemandsFor(scope: string, limit = 200): { taskId: string; demands: string }[] {
    const where = scope === 'global' ? 'repo IS NULL' : 'repo = ?';
    const rows = this.db
      .prepare(
        `SELECT id, operator_demands FROM tasks
         WHERE operator_demands IS NOT NULL AND TRIM(operator_demands) != '' AND ${where}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...(scope === 'global' ? [limit] : [scope, limit])) as Record<string, unknown>[];
    return rows.map((r) => ({ taskId: String(r['id']), demands: String(r['operator_demands']) }));
  }

  /**
   * Every scope that still holds a live fact. recallFacts() always folds
   * 'global' in, so a scope picker needs the list of scopes that exist rather
   * than the list a caller happens to have asked for.
   */
  memoryScopes(): string[] {
    return (this.db
      .prepare('SELECT DISTINCT scope FROM memory WHERE retired_at IS NULL ORDER BY scope')
      .all() as Record<string, unknown>[])
      .map((r) => String(r['scope']));
  }

  forgetFact(factId: string): void {
    this.db.prepare('UPDATE memory SET retired_at = ? WHERE id = ?').run(Date.now(), factId);
  }

  // ------------------------------------------------------------ schedules

  addSchedule(input: {
    title: string; spec: string; template?: NewTask; ask?: string | null; repo?: string | null;
    action?: 'task' | 'ask' | 'improve';
  }): Record<string, unknown> {
    const title = input.title?.trim();
    if (!title) throw new Error('schedule title is required');
    const ask = input.ask?.trim() || null;
    const action = input.action ?? (ask ? 'ask' : 'task');
    if (action !== 'improve' && !ask && !input.template?.prompt) {
      throw new Error('a schedule needs either an ask or a template prompt');
    }
    const spec = parseSpec(input.spec).spec;
    const scheduleId = id('s');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO schedules (id, title, spec, template, enabled, next_run_at, created_at, ask, repo, action) VALUES (?,?,?,?,1,?,?,?,?,?)')
      .run(
        scheduleId, title, spec, JSON.stringify(input.template ?? { title, prompt: ask ?? title }),
        nextRunAt(spec, now), now, ask, input.repo ?? null, action,
      );
    this.record({ type: 'status', message: `schedule '${title}' created (${spec})` });
    return this.getSchedule(scheduleId)!;
  }

  getSchedule(scheduleId: string): Record<string, unknown> | null {
    return (this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as Record<string, unknown>) ?? null;
  }

  listSchedules(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as Record<string, unknown>[];
  }

  deleteSchedule(scheduleId: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
  }

  toggleSchedule(scheduleId: string): Record<string, unknown> {
    const row = this.getSchedule(scheduleId);
    if (!row) throw new Error(`schedule not found: ${scheduleId}`);
    const enabled = Number(row['enabled']) === 1 ? 0 : 1;
    this.db.prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?')
      .run(enabled, enabled ? nextRunAt(String(row['spec'])) : Number(row['next_run_at']), scheduleId);
    return this.getSchedule(scheduleId)!;
  }

  /**
   * Fire every schedule that is due and re-arm it. Missed windows fire once,
   * not once per window elapsed, so a laptop that slept overnight does not
   * wake up and enqueue forty copies of the same batch.
   */
  runDueSchedules(now: number = Date.now()): Task[] {
    const due = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? AND COALESCE(action, 'task') = 'task'")
      .all(now) as Record<string, unknown>[];
    const created: Task[] = [];
    for (const row of due) {
      const scheduleId = String(row['id']);
      const spec = String(row['spec']);
      try {
        const template = JSON.parse(String(row['template'])) as NewTask;
        created.push(this.addTask({
          ...template,
          title: template.title || String(row['title']),
          deps: [],
          scheduleId,
        }));
      } catch (err) {
        this.record({ type: 'error', message: `schedule ${scheduleId} failed: ${(err as Error).message}` });
      }
      try {
        this.db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
          .run(now, nextRunAt(spec, now), scheduleId);
      } catch (err) {
        // An unusable spec disables its own schedule rather than wedging the tick.
        this.db.prepare('UPDATE schedules SET enabled = 0, last_run_at = ? WHERE id = ?').run(now, scheduleId);
        this.record({ type: 'error', message: `schedule ${scheduleId} disabled: ${(err as Error).message}` });
      }
    }
    return created;
  }

  /**
   * Standing asks are due separately: they need the planner, which lives with
   * the scheduler, so the store only claims and re-arms them.
   */
  claimDueAsks(now: number = Date.now()): Array<{ id: string; title: string; ask: string; repo: string | null }> {
    const due = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? AND COALESCE(action, 'task') = 'ask'")
      .all(now) as Record<string, unknown>[];
    const out: Array<{ id: string; title: string; ask: string; repo: string | null }> = [];
    for (const row of due) {
      const scheduleId = String(row['id']);
      try {
        this.db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
          .run(now, nextRunAt(String(row['spec']), now), scheduleId);
      } catch (err) {
        this.db.prepare('UPDATE schedules SET enabled = 0, last_run_at = ? WHERE id = ?').run(now, scheduleId);
        this.record({ type: 'error', message: `schedule ${scheduleId} disabled: ${(err as Error).message}` });
        continue;
      }
      out.push({
        id: scheduleId,
        title: String(row['title']),
        ask: String(row['ask']),
        repo: row['repo'] == null ? null : String(row['repo']),
      });
    }
    return out;
  }

  /** Recurring self-improvement rounds, re-armed the same way asks are. */
  claimDueImprovements(now: number = Date.now()): Array<{ id: string; title: string; area: string | null }> {
    const due = this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? AND action = 'improve'")
      .all(now) as Record<string, unknown>[];
    const out: Array<{ id: string; title: string; area: string | null }> = [];
    for (const row of due) {
      const scheduleId = String(row['id']);
      try {
        this.db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
          .run(now, nextRunAt(String(row['spec']), now), scheduleId);
      } catch (err) {
        this.db.prepare('UPDATE schedules SET enabled = 0, last_run_at = ? WHERE id = ?').run(now, scheduleId);
        this.record({ type: 'error', message: `schedule ${scheduleId} disabled: ${(err as Error).message}` });
        continue;
      }
      out.push({
        id: scheduleId,
        title: String(row['title']),
        // An improve schedule stores its optional focus area in the ask column.
        area: row['ask'] == null ? null : String(row['ask']),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ repairs

  /**
   * A repair round for a gap found BEFORE any reviewer ran (acceptance map,
   * scope guard). Counted in its own column against its own cap, so it never
   * changes `repairs` or uses up maxRepairs. False when the cap is spent.
   */
  schedulePreReviewRepair(taskId: string, notes: string, cap: number): boolean {
    const task = this.getTask(taskId);
    if (!task || (task.preReviewRepairs ?? 0) >= cap) return false;
    this.db
      .prepare('UPDATE tasks SET pre_review_repairs = pre_review_repairs + 1, repair_notes = ?, attempts = 0, stop_requeues = 0, gate_decision = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run(notes.slice(0, 8000), 'queued', Date.now(), taskId);
    this.record({ taskId, type: 'status', message: `pre-review repair round ${(task.preReviewRepairs ?? 0) + 1} queued` });
    const parent = this.parentIdOf(taskId);
    if (parent) this.reopenEpicIfClosed(parent);
    return true;
  }

  /**
   * An approval whose merge conflicted, turned into a repair round Foreman
   * prepares: the jail is cut from current main (no base_ref) and the approved
   * run's diff is applied onto it with its conflict markers kept. Counts as a
   * repair round and is capped by maxRepairs. Never lands anything: the task
   * parks at the gate again afterwards. False when the cap is spent.
   * The files are named in the notes when the round carries the diff, in its
   * jail (scheduler.ts); `carry_run` stays set until that round is reviewed, so
   * a stop or a provider-limit requeue mid-round carries the work again.
   */
  scheduleConflictRepair(taskId: string, approvedRunId: string, testCmd: string | null): boolean {
    const task = this.getTask(taskId);
    if (!task || task.repairs >= task.maxRepairs) return false;
    const notes = conflictRepairNotes(null, testCmd);
    this.db
      .prepare('UPDATE tasks SET repairs = repairs + 1, repair_notes = ?, base_ref = NULL, carry_run = ?, attempts = 0, stop_requeues = 0, gate_decision = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run(notes.slice(0, 8000), approvedRunId, 'queued', Date.now(), taskId);
    this.record({ taskId, type: 'status', message: `merge conflict on approval; repair round ${task.repairs + 1} queued: the approved diff is applied onto current main` });
    const parent = this.parentIdOf(taskId);
    if (parent) this.reopenEpicIfClosed(parent);
    return true;
  }

  /** The round's notes, completed once the diff is carried and the conflicted files are known. */
  setRepairNotes(taskId: string, notes: string): void {
    this.db.prepare('UPDATE tasks SET repair_notes = ? WHERE id = ?').run(notes.slice(0, 8000), taskId);
  }

  /**
   * A conflict round that cannot produce a landable result (the diff would not
   * apply, markers left, nothing changed): the task goes back to the gate on the
   * run that was approved, with today's hand-merge message. The round's run is
   * marked abandoned so it is not the run the gate rules on. The round stays
   * counted, so the budget still bounds how often this is tried.
   */
  abandonConflictRound(taskId: string, roundRunId: string, why: string): string {
    const approvedId = this.carryRun(taskId)
      ?? (this.db
        .prepare("SELECT id FROM runs WHERE task_id = ? AND id != ? AND decision IN ('approved','owner-approved') ORDER BY started_at DESC, rowid DESC LIMIT 1")
        .get(taskId, roundRunId) as { id?: string } | undefined)?.id
      ?? null;
    const branch = (approvedId ? this.getRun(approvedId)?.branch : null) ?? 'the approved branch';
    // Every run started after the approved one is dropped, not just this one: an
    // earlier attempt of the round (provider-limit requeue: failed, daemon stop:
    // canceled) keeps its jail, and would otherwise be the run the gate rules on.
    // The gate must only ever be able to land the approved run's branch.
    this.db
      .prepare(
        `UPDATE runs SET decision = 'abandoned'
          WHERE (id = ? AND id IS NOT ?) OR (task_id = ? AND ? IS NOT NULL
            AND rowid > (SELECT rowid FROM runs WHERE id = ?))`,
      )
      .run(roundRunId, approvedId, taskId, approvedId, approvedId);
    this.db.prepare('UPDATE tasks SET repair_notes = NULL, carry_run = NULL, gate_decision = NULL WHERE id = ?').run(taskId);
    const message = `approved, but not landed: merge conflict, aborted — resolve ${branch} by hand: the conflict repair round was dropped (${why}) — resolve it, then approve again`;
    this.record({ taskId, runId: roundRunId, type: 'warning', message: message.slice(0, 1000) });
    this.setStatus(taskId, 'awaiting-approval', this.withCoreGuard(taskId, message));
    return message;
  }

  /** Whether a run of this task other than `exceptRunId` was approved at the gate. */
  hasEarlierApproval(taskId: string, exceptRunId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS x FROM runs WHERE task_id = ? AND id != ? AND decision IN ('approved','owner-approved') LIMIT 1")
        .get(taskId, exceptRunId),
    );
  }

  scheduleRepair(taskId: string, critique: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.repairs >= task.maxRepairs) return false;
    this.db
      // gate_decision goes with attempts: the repaired work is not the work the
      // gate already ruled on, so it is re-gated deliberately.
      .prepare('UPDATE tasks SET repairs = repairs + 1, repair_notes = ?, carry_run = NULL, attempts = 0, stop_requeues = 0, gate_decision = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run(critique.slice(0, 8000), 'queued', Date.now(), taskId);
    this.record({ taskId, type: 'status', message: `repair round ${task.repairs + 1} queued` });
    // This path moves the row by raw SQL, so setStatus's reopen hook never
    // fires: an epic that closed on this ticket has to be reopened by hand.
    const parent = this.parentIdOf(taskId);
    if (parent) this.reopenEpicIfClosed(parent);
    return true;
  }

  stats(): Record<TaskStatus | 'total', number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Record<string, unknown>[];
    const out = {
      queued: 0, blocked: 0, running: 0, verifying: 0, 'awaiting-approval': 0, 'awaiting-human': 0,
      done: 0, failed: 0, rejected: 0, canceled: 0, total: 0,
    } as Record<TaskStatus | 'total', number>;
    for (const r of rows) {
      const n = Number(r['n']);
      out[String(r['status']) as TaskStatus] = n;
      out.total += n;
    }
    return out;
  }
}

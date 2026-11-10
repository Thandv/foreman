import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Artifact, Decision, MemoryFact, Principal, Run, RunEvent, Task, Verdict } from './types.ts';
import type { ArchiveRecord } from './archive.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  repo         TEXT,
  agent        TEXT,
  runner       TEXT NOT NULL,
  sensitivity  TEXT NOT NULL DEFAULT 'S1',
  budget_usd   REAL,
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  progress      REAL NOT NULL DEFAULT 0,
  worktree_path TEXT,
  branch        TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  exit_code     INTEGER,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  summary       TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  run_id  TEXT,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  stage   TEXT,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  path       TEXT NOT NULL,
  summary    TEXT,
  approved   INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL,
  disagreement  INTEGER NOT NULL DEFAULT 0,
  council_json  TEXT NOT NULL,
  chair_summary TEXT,
  critique      TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  run_id      TEXT,
  kind        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  local       INTEGER NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  day         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.6,
  source     TEXT,
  supersedes TEXT,
  retired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS council_cache (
  key        TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  confidence REAL NOT NULL,
  critique   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crew_review_cache (
  key         TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  critique    TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,
  template    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Operator settings the BOARD can change at runtime. Deliberately a table
-- rather than a config file: the daemon is the only writer, a restart must not
-- lose a toggle the operator flipped, and the board needs somewhere to put a
-- setting that is not an environment variable it cannot reach.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Repos whose main failed its own tests (postMerge.ts). A table, not memory:
-- a restarted daemon that forgot a red main would cut new work from it.
-- next_check_at/attempts drive the same-HEAD re-check backoff (scheduler.ts).
CREATE TABLE IF NOT EXISTS red_repos (
  repo          TEXT PRIMARY KEY,
  head          TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  test_cmd      TEXT,
  reason        TEXT NOT NULL,
  since         INTEGER NOT NULL,
  next_check_at INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);

-- Landings in progress (gate.ts): a row is written before the merge and deleted once its ref update is recorded.
-- A row the daemon finds at start is a merge a crash cut short; it holds that repo's dependents until the operator
-- clears it (Store.adoptInterruptedLandings).
CREATE TABLE IF NOT EXISTS landings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo       TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  run_id     TEXT,
  started_at INTEGER NOT NULL
);

-- Scheduler starts (Store.recordDaemonStart): a row per start, marked clean_exit by an orderly stop. A start that finds
-- the previous row unmarked follows a crash; that is how unclean restarts are attributed to the runs in flight.
CREATE TABLE IF NOT EXISTS daemon_starts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  clean_exit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shadow_verdicts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  playbook      TEXT,
  role          TEXT,
  -- The verdict that actually landed, and the one the local reviewer would
  -- have reached. Stored side by side rather than joined at read time: the
  -- authoritative verdict row is deletable (prune, task delete) and the
  -- comparison has to outlive it, exactly like the archive's actuals.
  authoritative TEXT NOT NULL,
  shadow        TEXT NOT NULL,
  shadow_model  TEXT,
  shadow_critique TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive (
  task_id     TEXT PRIMARY KEY,
  archived_at INTEGER NOT NULL,
  closed_at   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  repo        TEXT,
  playbook    TEXT,
  role        TEXT,
  runner      TEXT NOT NULL,
  assignee    TEXT NOT NULL,
  epic_id     TEXT,
  points      INTEGER,
  repairs     INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  verdict     TEXT,
  error       TEXT,
  acceptance  TEXT,
  summary     TEXT,
  terms       TEXT NOT NULL
);

-- One row per decision on a task: approve, reject, cancel, retry, reopen, by a
-- person, the owner model or Foreman itself (a cascade). Append-only: nothing
-- updates, deletes or replaces a row (the triggers below refuse it), and there is no
-- foreign key, so deleting a task or pruning its runs leaves its decisions.
-- Every fact a later tool counts is a column, not prose: as_is/merged/corrected
-- are 0, 1 or NULL (not stated / not an approval), the trees are git tree ids.
CREATE TABLE IF NOT EXISTS decisions (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  run_id           TEXT,
  at               INTEGER NOT NULL,
  action           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  note             TEXT,
  note_cut_bytes   INTEGER NOT NULL DEFAULT 0,
  status_after     TEXT,
  reviewed_tree    TEXT,
  landed_tree      TEXT,
  as_is            INTEGER,
  merged           INTEGER,
  merge_reason     TEXT,
  corrected        INTEGER,
  corrected_source TEXT,
  review_source    TEXT,
  extra            TEXT
);
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions is append-only: a row is never updated'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions is append-only: a row is never deleted'); END;
-- INSERT OR REPLACE removes the row it collides with WITHOUT firing the delete
-- trigger (recursive_triggers is off), so a replace is refused here, by id.
CREATE TRIGGER IF NOT EXISTS decisions_no_replace BEFORE INSERT ON decisions
WHEN EXISTS (SELECT 1 FROM decisions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'decisions is append-only: a row is never replaced'); END;

-- Who may call the API (Store.addPrincipal). The names 'operator', 'owner-model' and 'system' are constants, never
-- rows. A principal is never deleted, only disabled, so the principal id a token names always resolves.
CREATE TABLE IF NOT EXISTS principals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER
);

-- A principal's bearer tokens (Store.addToken). Only the sha256 hex of the secret is kept, never the secret.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   INTEGER,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id, at);
CREATE INDEX IF NOT EXISTS idx_receipts_day ON receipts(day);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_task ON receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope, retired_at);
CREATE INDEX IF NOT EXISTS idx_verdicts_task ON verdicts(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_task    ON runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_task  ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_deps_dep     ON task_deps(depends_on);
CREATE INDEX IF NOT EXISTS idx_archive_role  ON archive(playbook, role, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_at    ON archive(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_role   ON shadow_verdicts(playbook, role, created_at);
`;

/** Additive-only migrations; each is skipped when the column already exists. */
export const COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['tasks', 'test_cmd', 'TEXT'],
  ['tasks', 'merge_on_approve', 'INTEGER NOT NULL DEFAULT 0'],
  ['tasks', 'repair_notes', 'TEXT'],
  ['tasks', 'repairs', 'INTEGER NOT NULL DEFAULT 0'],
  ['tasks', 'max_repairs', 'INTEGER NOT NULL DEFAULT 1'],
  ['tasks', 'schedule_id', 'TEXT'],
  ['tasks', 'parent_id', 'TEXT'],
  ['tasks', 'allow_core', 'INTEGER NOT NULL DEFAULT 0'],
  ['runs', 'verdict', 'TEXT'],
  ['runs', 'tests_passed', 'INTEGER'],
  ['schedules', 'ask', 'TEXT'],
  ['schedules', 'repo', 'TEXT'],
  ['schedules', 'action', 'TEXT'],
  ['runs', 'pid', 'INTEGER'],
  ['tasks', 'role', 'TEXT'],
  ['tasks', 'playbook', 'TEXT'],
  ['tasks', 'points', 'INTEGER'],
  ['tasks', 'acceptance', 'TEXT'],
  // JSON array of paths the ticket may not touch (see scope.ts); NULL when none.
  ['tasks', 'forbidden_paths', 'TEXT'],
  // JSON array of skill names chosen for this ticket (skills.ts); NULL means
  // the role's default. Checked on the way in (queue.ts addTask).
  ['tasks', 'skills', 'TEXT'],
  ['tasks', 'is_epic', 'INTEGER NOT NULL DEFAULT 0'],
  // Which review produced the row ('council' or 'crew') and, for a crew
  // escalation, which model the chair spoke with. `source` is what makes the
  // per-task crew failure streak countable without re-deriving it from prose.
  ['verdicts', 'source', 'TEXT'],
  ['verdicts', 'chair_model', 'TEXT'],
  // Who decides this task at the gate: 'human', 'owner', or NULL to resolve
  // from the playbook and FOREMAN_GATE (see gate.ts:effectiveGate).
  ['tasks', 'gate', 'TEXT'],
  // '<decision>@<epochMs>' the one time the owner gate ran on this task's
  // current attempt. It lives in the row, not in `events`, because the events
  // table is pruned per run (scheduler.ts:pruneEvents) and losing the marker
  // would re-open a per-tick spend loop on a held ticket. Cleared wherever a
  // task is requeued for a genuinely new run.
  ['tasks', 'gate_decision', 'TEXT'],
  // The hosted CLI's own conversation id for this run. A repair round resumes it
  // (`claude --resume`) and sends only the critique instead of the whole brief,
  // so the session's prompt cache and context are reused rather than re-bought.
  ['runs', 'session_id', 'TEXT'],
  // The commit this run's jail was cut from (isolate.ts jailBase). Kept here,
  // outside the jail, and not in the jail's git directory, which the worker's
  // own git writes: everything the run changed is measured from it.
  ['runs', 'base_commit', 'TEXT'],
  // The git tree of exactly what this run's reviewers and the gate were shown
  // (isolate.ts jailTree, taken with the diff artifact). The landing merges
  // that tree or nothing (merge.ts). NULL on a run parked before the check
  // existed, which only a person may land.
  ['runs', 'reviewed_tree', 'TEXT'],
  // The git ref a task's jail is cut from, when it must not be HEAD. A ticket
  // filed by a reviewer is ABOUT work that has not merged: branched from HEAD
  // it opens in a tree where the chapter it critiques does not exist, and the
  // agent then files tickets about the missing file instead of doing the work.
  ['tasks', 'base_ref', 'TEXT'],
  // Who does the WORK: 'ai' (dispatch to a runner) or 'human' (park at
  // awaiting-human and wait for the operator). NULL resolves from the playbook
  // and FOREMAN_ASSIGNEE — see assign.ts:effectiveAssignee. Default 'ai'.
  ['tasks', 'assignee', 'TEXT'],
  // The run whose work a retry carries forward. A worker's changes are never
  // committed in its jail — review reads `git diff HEAD` — so the run's diff
  // artifact is the only copy of that work, and a retry that cut a fresh jail
  // from HEAD threw it away (an earlier UI ticket: an 8-point UI rewritten from
  // nothing to fix three small defects). One-shot: cleared once applied.
  ['tasks', 'carry_run', 'TEXT'],
  ['tasks', 'operator_demands', 'TEXT'],
  // Set when a closed task has been folded into `archive`. The row itself
  // stays put so `trace` still reconstructs it; only the board's Closed lane
  // and the default `ls` stop showing it. Archiving is never deletion.
  ['tasks', 'archived_at', 'INTEGER'],
  // The alias a call was MEANT for when the broker ran it on a smaller model
  // because the intended one did not fit in memory (budget.ts, downshifting).
  ['receipts', 'downshifted_from', 'TEXT'],
  // 1 when a council behind this verdict ran on stepped-down models. The
  // scheduler re-reviews such work with the full council once it fits.
  ['verdicts', 'provisional', 'INTEGER NOT NULL DEFAULT 0'],
  // How this run was decided at the approval gate (Store.decide from
  // awaiting-approval): 'approved' | 'rejected' by a person, 'owner-approved'
  // | 'owner-rejected' by the owner gate. The training sets read the label
  // here: a task's final status says nothing about WHICH run was ruled on —
  // a ticket rejected at the gate and then finished by hand ends `done` — or
  // about who ruled, once a retry has cleared the task's owner-gate marker.
  ['runs', 'decision', 'TEXT'],
  ['runs', 'verify_wait_ms', 'INTEGER NOT NULL DEFAULT 0'],
  // Time this run's gate suites ran, slot wait excluded: the sum over every
  // daemon suite command (gate, its timeout re-run, each playbook check, the
  // revert check) of its wall time less its verify-slot wait. 0 on a run that
  // ran none, or from before it was recorded. Read by `doctor --latency`.
  ['runs', 'suite_ms', 'INTEGER NOT NULL DEFAULT 0'],
  // Time this run's worker's own suite runs queued for a test slot (POST
  // /api/verify-slot, Scheduler.slotQueued), from the first wait opening to
  // the last closing. Apart from verify_wait_ms, which counts the daemon's own
  // gate waits (debrief reads it as that). Read by `doctor --latency`.
  ['runs', 'worker_slot_wait_ms', 'INTEGER NOT NULL DEFAULT 0'],
  // Daemon stops that requeued this ticket since its last fresh start (Retry,
  // a repair round, Give to AI). On the row, not in `events`: pruneEvents would
  // erase the count that bounds a daemon that keeps stopping mid-run.
  ['tasks', 'stop_requeues', 'INTEGER NOT NULL DEFAULT 0'],
  // Repair rounds the pre-review checks (acceptance map, scope guard) queued.
  // Apart from `repairs` so they never use up maxRepairs, and on the row for
  // the same reason as stop_requeues: pruneEvents would erase the count.
  ['tasks', 'pre_review_repairs', 'INTEGER NOT NULL DEFAULT 0'],
  // What a run recorded about itself when it ended (runFacts.ts): model
  // responses seen and the CLI's own num_turns, the turn ceiling in force, how
  // it ended, the brief's size and what boundBrief cut from it (JSON), and the
  // worker's report size before any cut. All NULL on a run from before them.
  ['runs', 'turns', 'INTEGER'],
  ['runs', 'turns_reported', 'INTEGER'],
  ['runs', 'turn_limit', 'INTEGER'],
  ['runs', 'ended_reason', 'TEXT'],
  ['runs', 'brief_bytes', 'INTEGER'],
  ['runs', 'brief_cuts', 'TEXT'],
  ['runs', 'report_bytes', 'INTEGER'],
  // Epoch ms this task entered awaiting-approval (Store.setStatus), kept while
  // it stays parked and cleared by every path that moves it out. Apart from
  // updated_at, which any later write (a gate change) resets. NULL on a task
  // parked before the column existed: readers fall back to updated_at.
  ['tasks', 'awaiting_since', 'INTEGER'],
];

const STATUSES = new Set<string>([
  'queued', 'blocked', 'running', 'verifying', 'awaiting-approval', 'awaiting-human',
  'done', 'failed', 'rejected', 'canceled',
]);

/** The status a timeline line records a move to ("rejected: too long" → rejected), or null. */
function transitionOf(message: string): string | null {
  const head = message.includes(':') ? message.slice(0, message.indexOf(':')) : message;
  return STATUSES.has(head) ? head : null;
}

/**
 * Label the runs decided before `runs.decision` existed, from the status
 * timeline: a move to `done`/`rejected` straight from `awaiting-approval`
 * ruled on the run that was current then (the latest one started before it).
 * The owner gate's decisions carry its own timeline line on that run
 * ("owner-gate: approved — …", or a rejection note it signed), and are
 * labelled as the owner's. A ticket finished on the operator's own desk, or
 * one whose events were pruned, stays unlabelled — no evidence, no label.
 * Only ever fills blanks, so running it again is safe.
 */
export function backfillRunDecisions(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT task_id, ts, message FROM events WHERE type = 'status' AND task_id IS NOT NULL ORDER BY task_id, id")
    .all() as Record<string, unknown>[];
  const runAt = db.prepare(
    'SELECT id FROM runs WHERE task_id = ? AND started_at <= ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
  );
  const label = db.prepare('UPDATE runs SET decision = ? WHERE id = ? AND decision IS NULL');
  const ownerLine = db.prepare(
    "SELECT 1 FROM events WHERE run_id = ? AND type = 'verdict' AND (message LIKE 'owner-gate: approved%' OR message LIKE 'owner-gate: rejected%') LIMIT 1",
  );
  let labelled = 0;
  let task: string | null = null;
  let previous: string | null = null;
  for (const row of rows) {
    const status = transitionOf(String(row['message']));
    if (!status) continue;
    if (row['task_id'] !== task) {
      task = String(row['task_id']);
      previous = null;
    }
    if ((status === 'done' || status === 'rejected') && previous === 'awaiting-approval') {
      const run = runAt.get(task, Number(row['ts'])) as Record<string, unknown> | undefined;
      if (run) {
        const byOwner = Boolean(ownerLine.get(String(run['id']))) || String(row['message']).startsWith('rejected: owner-gate:');
        const decision = `${byOwner ? 'owner-' : ''}${status === 'done' ? 'approved' : 'rejected'}`;
        labelled += Number(label.run(decision, String(run['id'])).changes);
      }
    }
    previous = status;
  }
  return labelled;
}

/**
 * Indexes over columns that only exist after `migrate()` has run. They cannot
 * live in SCHEMA: the base CREATE TABLE above has no `parent_id`, so `CREATE
 * INDEX ... ON tasks(parent_id)` there would fail on a fresh database. Like
 * SCHEMA, this runs on every open and every statement is IF NOT EXISTS, so an
 * existing database picks the index up the next time it is opened.
 */
export const MIGRATED_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at, status, updated_at);
`;

function migrate(db: DatabaseSync): void {
  for (const [table, column, ddl] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (!cols.some((c) => String(c['name']) === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      // Once, when the column arrives: the history it is derived from is pruned
      // as runs accumulate, so later is less than now.
      if (table === 'runs' && column === 'decision') backfillRunDecisions(db);
    }
  }
}

/**
 * The ledger's schema version, stamped in the file header (`PRAGMA
 * user_version`). Bump it, and add its row to test/schema-version.test.ts,
 * whenever SCHEMA, COLUMNS or MIGRATED_INDEXES change.
 */
export const SCHEMA_VERSION = 3;

/** A ledger written by a newer Foreman: this binary must not touch it. */
export class NewerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewerSchemaError';
  }
}

/** A ledger written by an older Foreman, opened by something other than `foreman serve`: only serve migrates. */
export class OlderSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OlderSchemaError';
  }
}

/** Throws NewerSchemaError when `db`'s stamp is ahead of SCHEMA_VERSION; returns the stamp otherwise. */
export function requireKnownSchema(db: DatabaseSync, label: string): number {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    throw new NewerSchemaError(
      `${label} has schema version ${version}, newer than this Foreman's ${SCHEMA_VERSION}: ` +
        'it was written by a newer Foreman; upgrade Foreman to open it. Nothing was changed',
    );
  }
  return version;
}

/**
 * Opens (creating when missing) the ledger at `dbPath`. A brand-new empty file is given the schema by any caller;
 * an existing ledger stamped older than SCHEMA_VERSION is migrated only with `migrate: true` (`foreman serve`), so a
 * CLI from another checkout never rewrites the live ledger's schema.
 */
export function openDb(dbPath: string, opts: { migrate?: boolean } = {}): DatabaseSync {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Before any pragma or DDL: a newer ledger, or an older one this caller may not migrate, is left exactly as it was.
  let version: number;
  try {
    version = requireKnownSchema(db, dbPath);
    if (version < SCHEMA_VERSION && !opts.migrate && !isEmptyDb(db)) {
      throw new OlderSchemaError(
        `${dbPath} has schema version ${version}, older than this Foreman's ${SCHEMA_VERSION}: ` +
          'run foreman serve once to upgrade it. Nothing was changed',
      );
    }
  } catch (err) {
    db.close();
    throw err;
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL + NORMAL is the standard durable-enough pairing: a crash can lose the
  // last transactions, never the database. Everything Foreman stores is
  // reconstructible from the run log and the artifacts on disk.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('PRAGMA cache_size = -8000');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(MIGRATED_INDEXES);
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** True for a file with no schema objects yet: a database this open is creating, not one it would migrate. */
function isEmptyDb(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get() === undefined;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const nnum = (v: unknown): number | null => (v == null ? null : Number(v));
const jsonStrings = (v: unknown): string[] | null => {
  if (v == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
};

/** A JSON column back as the object or array it holds; null when empty or unreadable. */
const jsonObject = (v: unknown): unknown => {
  if (v == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(v));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

export function rowToTask(row: Row, deps: string[] = []): Task {
  return {
    id: str(row['id']),
    title: str(row['title']),
    prompt: str(row['prompt']),
    kind: str(row['kind']) as Task['kind'],
    repo: nstr(row['repo']),
    agent: nstr(row['agent']),
    runner: str(row['runner']) as Task['runner'],
    sensitivity: str(row['sensitivity']) as Task['sensitivity'],
    budgetUsd: nnum(row['budget_usd']),
    priority: num(row['priority']),
    status: str(row['status']) as Task['status'],
    attempts: num(row['attempts']),
    maxAttempts: num(row['max_attempts']),
    error: nstr(row['error']),
    testCmd: nstr(row['test_cmd']),
    mergeOnApprove: num(row['merge_on_approve']) === 1,
    repairNotes: nstr(row['repair_notes']),
    operatorDemands: nstr(row['operator_demands']),
    repairs: num(row['repairs']),
    maxRepairs: num(row['max_repairs']),
    scheduleId: nstr(row['schedule_id']),
    parentId: nstr(row['parent_id']),
    allowCore: num(row['allow_core']) === 1,
    baseRef: str(row['base_ref']),
    role: nstr(row['role']),
    playbook: nstr(row['playbook']),
    points: nnum(row['points']),
    acceptance: nstr(row['acceptance']),
    forbiddenPaths: jsonStrings(row['forbidden_paths']),
    skills: jsonStrings(row['skills']),
    preReviewRepairs: num(row['pre_review_repairs']),
    isEpic: num(row['is_epic']) === 1,
    gate: nstr(row['gate']) as Task['gate'],
    gateDecision: nstr(row['gate_decision']),
    assignee: nstr(row['assignee']) as Task['assignee'],
    archivedAt: nnum(row['archived_at']),
    awaitingSince: nnum(row['awaiting_since']),
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
    deps,
  };
}

export function rowToRun(row: Row): Run {
  return {
    id: str(row['id']),
    taskId: str(row['task_id']),
    status: str(row['status']) as Run['status'],
    stage: str(row['stage']) as Run['stage'],
    progress: num(row['progress']),
    worktreePath: nstr(row['worktree_path']),
    branch: nstr(row['branch']),
    startedAt: num(row['started_at']),
    endedAt: nnum(row['ended_at']),
    exitCode: nnum(row['exit_code']),
    pid: nnum(row['pid']),
    tokensIn: num(row['tokens_in']),
    tokensOut: num(row['tokens_out']),
    costUsd: num(row['cost_usd']),
    summary: nstr(row['summary']),
    verdict: nstr(row['verdict']) as Run['verdict'],
    testsPassed: row['tests_passed'] == null ? null : Number(row['tests_passed']) === 1,
    sessionId: nstr(row['session_id']),
    baseCommit: nstr(row['base_commit']),
    reviewedTree: nstr(row['reviewed_tree']),
    verifyWaitMs: num(row['verify_wait_ms']),
    turns: nnum(row['turns']),
    turnsReported: nnum(row['turns_reported']),
    turnLimit: nnum(row['turn_limit']),
    endedReason: nstr(row['ended_reason']) as Run['endedReason'],
    briefBytes: nnum(row['brief_bytes']),
    briefCuts: jsonObject(row['brief_cuts']) as Run['briefCuts'],
    reportBytes: nnum(row['report_bytes']),
  };
}

const nbool = (v: unknown): boolean | null => (v == null ? null : Number(v) === 1);

export function rowToPrincipal(row: Row): Principal {
  return {
    id: str(row['id']),
    kind: str(row['kind']) as Principal['kind'],
    name: str(row['name']),
    createdBy: str(row['created_by']),
    createdAt: num(row['created_at']),
    disabledAt: nnum(row['disabled_at']),
  };
}

export function rowToDecision(row: Row): Decision {
  return {
    id: str(row['id']),
    taskId: str(row['task_id']),
    runId: nstr(row['run_id']),
    at: num(row['at']),
    action: str(row['action']) as Decision['action'],
    actor: str(row['actor']) as Decision['actor'],
    note: nstr(row['note']),
    noteCutBytes: num(row['note_cut_bytes']),
    statusAfter: nstr(row['status_after']),
    reviewedTree: nstr(row['reviewed_tree']),
    landedTree: nstr(row['landed_tree']),
    asIs: nbool(row['as_is']),
    merged: nbool(row['merged']),
    mergeReason: nstr(row['merge_reason']),
    corrected: nbool(row['corrected']),
    correctedSource: nstr(row['corrected_source']) as Decision['correctedSource'],
    reviewSource: nstr(row['review_source']),
    extra: jsonObject(row['extra']) as Decision['extra'],
  };
}

export function rowToVerdict(row: Row): Verdict {
  return {
    id: str(row['id']),
    runId: str(row['run_id']),
    taskId: str(row['task_id']),
    verdict: str(row['verdict']) as Verdict['verdict'],
    disagreement: num(row['disagreement']) === 1,
    council: JSON.parse(str(row['council_json'] || '[]')) as Verdict['council'],
    chairSummary: nstr(row['chair_summary']),
    chairModel: nstr(row['chair_model']),
    source: (nstr(row['source']) ?? 'council') as Verdict['source'],
    provisional: num(row['provisional']) === 1,
    critique: nstr(row['critique']),
    costUsd: num(row['cost_usd']),
    createdAt: num(row['created_at']),
  };
}

export function rowToMemory(row: Row): MemoryFact {
  return {
    id: str(row['id']),
    scope: str(row['scope']),
    key: str(row['key']),
    value: str(row['value']),
    confidence: num(row['confidence']),
    source: nstr(row['source']),
    supersedes: nstr(row['supersedes']),
    retiredAt: nnum(row['retired_at']),
    createdAt: num(row['created_at']),
    updatedAt: num(row['updated_at']),
  };
}

export function rowToEvent(row: Row): RunEvent {
  return {
    id: num(row['id']),
    taskId: nstr(row['task_id']),
    runId: nstr(row['run_id']),
    ts: num(row['ts']),
    type: str(row['type']) as RunEvent['type'],
    stage: nstr(row['stage']) as RunEvent['stage'],
    message: str(row['message']),
  };
}

export function rowToArtifact(row: Row): Artifact {
  return {
    id: str(row['id']),
    runId: str(row['run_id']),
    taskId: str(row['task_id']),
    type: str(row['type']) as Artifact['type'],
    path: str(row['path']),
    summary: nstr(row['summary']),
    approved: nnum(row['approved']),
    createdAt: num(row['created_at']),
  };
}

export function rowToArchive(row: Row): ArchiveRecord {
  return {
    taskId: str(row['task_id']),
    archivedAt: num(row['archived_at']),
    closedAt: num(row['closed_at']),
    createdAt: num(row['created_at']),
    title: str(row['title']),
    kind: str(row['kind']),
    status: str(row['status']),
    repo: nstr(row['repo']),
    playbook: nstr(row['playbook']),
    role: nstr(row['role']),
    runner: str(row['runner']),
    assignee: str(row['assignee']),
    epicId: nstr(row['epic_id']),
    points: nnum(row['points']),
    repairs: num(row['repairs']),
    attempts: num(row['attempts']),
    durationMs: num(row['duration_ms']),
    costUsd: num(row['cost_usd']),
    tokensIn: num(row['tokens_in']),
    tokensOut: num(row['tokens_out']),
    verdict: nstr(row['verdict']),
    error: nstr(row['error']),
    acceptance: nstr(row['acceptance']),
    summary: nstr(row['summary']),
    terms: str(row['terms']),
  };
}

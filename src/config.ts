import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Type-only edges out of localOnly.ts (roles.ts, types.ts) are erased, so this
// is a leaf import, not a cycle back through the config it is read by.
import { cloudFallback, localOnly } from './localOnly.ts';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return Math.trunc(n);
}

/**
 * An on/off switch that is off unless set: unset, empty or `off` is off, `on` is on (either in any case, spaces
 * trimmed), and anything else throws — a typo is never read as either.
 */
export function onOff(name: string, raw: string | undefined = process.env[name]): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return false;
  if (v === 'on') return true;
  throw new Error(`${name} must be on or off, got ${JSON.stringify(raw)}`);
}

const home = process.env.FOREMAN_HOME
  ? path.resolve(process.env.FOREMAN_HOME)
  : path.join(os.homedir(), '.foreman');
// Resolved once, then handed on: a relative FOREMAN_HOME ('.foreman') left in the environment is resolved again
// against every child's cwd, so a worker in its jail would see a different home, inside the jail, than the daemon.
if (process.env.FOREMAN_HOME) process.env.FOREMAN_HOME = home;

/** Foreman's own source tree root (src/..), resolved from this file, not cwd. */
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  home,
  sourceRoot,
  /**
   * The forged-tool catalog: a git-tracked subfolder of the repo so Foreman can
   * use AND improve its own tools. Runtime state (usage stats, quarantine)
   * lives in `home`, never here, so the toolbox stays clean for version control.
   */
  toolbox: process.env.FOREMAN_TOOLBOX
    ? path.resolve(process.env.FOREMAN_TOOLBOX)
    : path.join(sourceRoot, 'toolbox'),
  dbPath: process.env.FOREMAN_DB ? path.resolve(process.env.FOREMAN_DB) : path.join(home, 'foreman.db'),
  /** Scratch jails and worktrees live here; never inside the target repo. */
  workRoot: path.join(home, 'work'),
  artifactRoot: path.join(home, 'artifacts'),
  port: int('FOREMAN_PORT', 4100),
  host: process.env.FOREMAN_HOST ?? '127.0.0.1',
  maxWorkers: Math.max(1, int('FOREMAN_MAX_WORKERS', 4)),
  /** Tasks allowed to sit in the verify lane at once (see the two-lane scheduler). */
  maxVerifying: Math.max(1, int('FOREMAN_MAX_VERIFYING', Math.max(1, int('FOREMAN_MAX_WORKERS', 4)) * 2)),
  /**
   * Hard ceiling on a single run's wall clock.
   *
   * The default is mode-dependent, which is unusual here and deliberate. A
   * hosted model returns a 3,700-word chapter in a couple of minutes; a local
   * 9B sustains roughly 8-10 tok/s, so the same chapter is ~14 minutes of
   * generation before a single review turn. Under FOREMAN_LOCAL_ONLY a 30
   * minute ceiling therefore does not bound a runaway run — it kills an
   * ordinary one, partway through the work, and the operator sees a timeout
   * where there was no fault. 90 minutes leaves room for a full draft plus its
   * repair round. `foreman drill` checks that this and the output ceiling
   * still agree; FOREMAN_TASK_TIMEOUT_MS overrides either way.
   */
  //
  // A getter, not a value: under FOREMAN_LOCAL_ONLY=auto the mode is only
  // known once the daemon has asked the CLI whether it is signed in — after
  // this module loaded — and it can change while the daemon runs.
  get taskTimeoutMs(): number {
    return int('FOREMAN_TASK_TIMEOUT_MS', localOnly() || cloudFallback() ? 90 * 60 * 1000 : 30 * 60 * 1000);
  },
  /** Log lines retained per run in SQLite (the full log is always on disk). */
  logLinesPerRun: int('FOREMAN_LOG_LINES', 2000),
  /** Days of daily trace files (<home>/traces/YYYY-MM-DD.jsonl) kept on disk. */
  traceRetainDays: int('FOREMAN_TRACE_RETAIN_DAYS', 14),
  /**
   * How long a merged (or archived) task's worktree is kept after it finished.
   * Retry and reopen want the worktree of work that did not land; work that
   * did land is on main and in its diff artifact, so its checkout is just disk.
   */
  jailRetainDays: int('FOREMAN_JAIL_RETAIN_DAYS', 3),
  /**
   * How long a FAILED task's worktree is kept after the task last moved. Longer than the bound above, because a
   * failed task's worktree is what retry and reopen pick up; past it the work is in the run's diff artifact (the
   * sweep checks that first). At least one day; a negative value keeps them for ever.
   */
  failedJailRetainDays: int('FOREMAN_FAILED_JAIL_RETAIN_DAYS', 14),
  schedulerTickMs: int('FOREMAN_TICK_MS', 250),
  /** Deterministic context caps — the token saver. Nothing larger reaches a model. */
  diffCapBytes: int('FOREMAN_DIFF_CAP_BYTES', 24_000),
  /**
   * The same ceiling for a prose review. A manuscript chapter is one file of
   * roughly 25 KB of added text, so the code cap cuts a developmental editor
   * off two-thirds of the way through the draft it was asked to judge — and
   * the letter it writes then reports beats as missing that are simply past
   * the cut. Prose is reviewed whole or it is not reviewed.
   */
  proseDiffCapBytes: int('FOREMAN_PROSE_DIFF_CAP_BYTES', 160_000),
  /**
   * The crew chain's code-review ceiling. The chain is always the hosted
   * Claude CLI (see crewReview), never an 8k-context local model, yet it was
   * held to the 12 KB local-sized cap: on the first Kiln epic an Opus senior
   * passed a 14 KB security module having read only an excerpt of its tests.
   */
  crewCodeDiffCapBytes: int('FOREMAN_CREW_CODE_DIFF_CAP_BYTES', 96_000),
  logTailLines: int('FOREMAN_LOG_TAIL_LINES', 40),
  logTailBytes: int('FOREMAN_LOG_TAIL_BYTES', 4_000),
  memoryBriefBytes: int('FOREMAN_MEMORY_BRIEF_BYTES', 2_000),
  /**
   * Budget for what a repair round must act on: the critique and the
   * operator's demands. These shared the 2 KB memory-fact budget until a
   * Kiln phase-4 worker was cut off mid-critique and said it "could not see"
   * demand 7 — repair notes are stored up to 8 KB, so the worker's brief must
   * hold all of them. Larger than any stored note on purpose.
   */
  repairBriefBytes: int('FOREMAN_REPAIR_BRIEF_BYTES', 16_000),
  /**
   * FOREMAN_REVERT_TESTS=on: after a code ticket's tests pass, each test its diff adds or changes is run with the
   * diff's non-test files put back to the base (verify/revertTests.ts), and the per-test table goes to the reviewer
   * and the owner gate. A reviewer aid: it repairs, holds and fails nothing. Off by default; read once, at start.
   */
  revertTests: onOff('FOREMAN_REVERT_TESTS'),
  /** Automatic repair rounds for a gap found before review (map, scope); apart from maxRepairs. */
  preReviewRepairs: int('FOREMAN_PRE_REVIEW_REPAIRS', 2),
  /**
   * Budget for a ticket's acceptance criteria wherever it is read: the
   * worker's brief, the gate council and the crew review. Plans once cut
   * acceptance to 2 KB at parse time and every reader sliced it again, so on
   * Kiln phase 4b ten tickets lost their last items silently — the worker,
   * every reviewer and the chair judged against a list that ended mid-word.
   * A cut here is marked, never silent.
   */
  acceptanceBytes: int('FOREMAN_ACCEPTANCE_BYTES', 8_000),
  /**
   * Budget for the worker's final report in a review prompt (verify/report.ts).
   * The Kiln trial's reports were 3 to 9 KB and a technical writer's claims
   * table 13.4 KB; the reviewer was shown the last 3000 characters of a 4000
   * character copy. Over the budget the middle is cut, on line breaks, with
   * the number of characters dropped and the path of the whole report.
   */
  reviewReportBytes: int('FOREMAN_REVIEW_REPORT_BYTES', 24_000),
  /**
   * Budget for the source a changed document cites, attached to a review
   * prompt (verify/citedSource.ts). Kiln's lock ADR cites three files and
   * needs about 40 KB of them; what does not fit is named, never dropped
   * silently.
   */
  citedSourceBytes: int('FOREMAN_CITED_SOURCE_BYTES', 64_000),
  /**
   * The skills repository (skills/<name>/ and loadouts.json — see skills.ts),
   * or null. Unset is the feature switched off: no skill is loaded and every
   * brief and review prompt is byte-for-byte what it was before skills existed.
   * A getter, read on each call like FOREMAN_AGENTS_DIR, so a test can point
   * it at a fixture per case.
   */
  get skillsDir(): string | null {
    const raw = process.env.FOREMAN_SKILLS_DIR?.trim();
    return raw ? path.resolve(raw) : null;
  },
  /**
   * Budget for the skills block of one brief. Two full skills at their 4,000
   * byte cap plus the header fit; a cut is marked by boundBrief, never silent.
   * A getter for the same reason as skillsDir.
   */
  get skillBriefBytes(): number {
    return int('FOREMAN_SKILL_BRIEF_BYTES', 9_000);
  },
  /** Output-token ceiling on a council advisor/chair call (num_predict / max_tokens). */
  councilMaxOutputTokens: int('FOREMAN_COUNCIL_MAX_TOKENS', 350),
} as const;

export type Config = typeof config;

/**
 * The URL a client reaches the daemon on. A wildcard bind is reached on
 * loopback, and an IPv6 literal needs its brackets: FOREMAN_HOST=::1 is a
 * loopback bind the server accepts, and `http://::1:4100` is not a URL.
 */
export function daemonUrl(host: string, port: number): string {
  const reach = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${reach.includes(':') ? `[${reach}]` : reach}:${port}`;
}

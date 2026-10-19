import fs from 'node:fs';
import path from 'node:path';
import { terms } from './assistant/memory.ts';
import { config } from './config.ts';
import { sweepOrphanStaging } from './deps.ts';
import { jailChanges, pinnedGit, type Jail } from './isolate.ts';
// Type-only: the Store is always the caller's, so archive.ts keeps no runtime
// edge to queue.ts (which imports this module).
import type { Store } from './queue.ts';

/**
 * The archive is what a closed task becomes once it stops being news.
 *
 * Two problems, one mechanism. The board's Closed lane grows without bound, so
 * a week-old success buries the thing that failed an hour ago; and every closed
 * task is a *measurement* — this role, this many points, took this long, cost
 * this much, needed this many repair rounds — that is thrown away the moment
 * nobody scrolls to it. Archiving folds the row into a compact record that
 * drops out of the lane and stays queryable forever.
 *
 * It is emphatically not deletion. `prune` deletes; `archive` keeps. The task
 * row itself is left in place (so `trace` still reconstructs the whole run) and
 * only gains an `archived_at` stamp; the record in `archive` is a denormalised
 * copy that survives even a later prune of the run and receipt ledgers.
 */

export interface ArchiveRecord {
  taskId: string;
  archivedAt: number;
  /** When the task reached its terminal status — its `updated_at` at fold time. */
  closedAt: number;
  createdAt: number;
  title: string;
  kind: string;
  status: string;
  repo: string | null;
  playbook: string | null;
  role: string | null;
  runner: string;
  assignee: string;
  epicId: string | null;
  points: number | null;
  repairs: number;
  attempts: number;
  /** Wall clock from first run start to last run end. 0 when it never ran. */
  durationMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  verdict: string | null;
  error: string | null;
  acceptance: string | null;
  summary: string | null;
  /** Pre-tokenised title+acceptance, so search is a scan over words not prose. */
  terms: string;
}

/**
 * How long a closed task stays in the Closed lane before it is folded away.
 *
 * A week is the number because the lane's job is "what just happened" — long
 * enough that yesterday's batch is still one glance away, short enough that the
 * lane never needs scrolling. `foreman archive --days N` overrides per run.
 */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 7;

/** The searchable text of one record. Kept in a column so search is one scan. */
export function archiveTerms(title: string, acceptance: string | null, role: string | null, playbook: string | null): string {
  return [...new Set(terms([title, acceptance ?? '', role ?? '', playbook ?? ''].join(' ')))].join(' ');
}

export interface Estimate {
  /** How many archived records the estimate is built from. */
  samples: number;
  /** Median, not mean: one 6-hour outlier must not move the number. */
  medianDurationMs: number;
  medianCostUsd: number;
  medianRepairs: number;
  /** Share of matched records that reached `done`. */
  successRate: number;
  medianPoints: number | null;
  /** The records the estimate drew on, best match first — the evidence. */
  basis: Array<{ taskId: string; title: string; durationMs: number; costUsd: number; status: string; score: number }>;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Score one archived record against a query. Keyword overlap, same shape as
 * memory recall, with two structural bonuses that matter more than any word:
 * an exact (playbook, role) match is the single best predictor of how a ticket
 * will go, because it is literally the same job done before.
 */
export function scoreRecord(
  record: Pick<ArchiveRecord, 'terms' | 'role' | 'playbook'>,
  query: { text: string; role?: string | null; playbook?: string | null },
): number {
  const wanted = new Set(terms(query.text));
  const hay = new Set(record.terms.split(' ').filter(Boolean));
  let overlap = 0;
  for (const t of wanted) if (hay.has(t)) overlap++;
  let score = overlap;
  if (query.playbook && record.playbook === query.playbook) score += 2;
  if (query.role && record.role === query.role) score += 3;
  return score;
}

/**
 * Estimate a not-yet-run task from what actually happened to similar ones.
 *
 * Deterministic and free — no model call. It answers the question a planner
 * cannot answer from the prompt alone ("how long does an author ticket in the
 * publishing playbook really take?") with measurements rather than a guess,
 * and it reports `samples` so a caller can tell a real estimate from one built
 * on two records.
 *
 * Records that never ran (`durationMs === 0`, e.g. a canceled or human-assigned
 * ticket) are excluded from the duration and cost medians but still count
 * toward `successRate`: they say nothing about how long the work takes, and
 * everything about whether work of this shape lands.
 */
export function estimateFrom(records: ArchiveRecord[], query: { text: string; role?: string | null; playbook?: string | null }, limit = 12): Estimate {
  const scored = records
    .map((r) => ({ r, score: scoreRecord(r, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.r.closedAt - a.r.closedAt)
    .slice(0, limit);

  const matched = scored.map((s) => s.r);
  const ran = matched.filter((r) => r.durationMs > 0);
  const points = matched.map((r) => r.points).filter((p): p is number => p != null);

  return {
    samples: matched.length,
    medianDurationMs: Math.round(median(ran.map((r) => r.durationMs))),
    medianCostUsd: median(ran.map((r) => r.costUsd)),
    medianRepairs: median(matched.map((r) => r.repairs)),
    successRate: matched.length ? matched.filter((r) => r.status === 'done').length / matched.length : 0,
    medianPoints: points.length ? median(points) : null,
    basis: scored.map((s) => ({
      taskId: s.r.taskId,
      title: s.r.title,
      durationMs: s.r.durationMs,
      costUsd: s.r.costUsd,
      status: s.r.status,
      score: s.score,
    })),
  };
}

/** Human-readable duration for the CLI and the board, without a dependency. */
export function humanDuration(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

export interface JailSweepResult {
  /** Directories removed this sweep. */
  removed: string[];
  /** Dirty worktrees of a task's last run, kept: unlanded work may still be in them. */
  keptDirty: string[];
  /** Last-run worktrees whose `git status` failed: kept, since nothing proved them clean. */
  keptUnreadable: string[];
  /** Repos whose stale worktree registrations were pruned. */
  repos: string[];
  /**
   * Worktrees of FAILED tasks past their bound that were kept because their work could not be shown recoverable:
   * the last run that used the tree recorded no diff artifact (or its file is gone), and the tree is not provably
   * unchanged. `foreman prune` is the way to drop one by hand.
   */
  keptNoDiff: string[];
  /** `<work>/.<jail>.deps-tmp` directories removed because their jail no longer exists (deps.ts's rule). */
  staging: string[];
}

/** Worktrees removed per sweep, so one sweep never holds the loop for minutes. */
export const JAIL_SWEEP_LIMIT = 40;

function insideWorkRoot(dir: string, workRoot: string): boolean {
  const rel = path.relative(workRoot, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Reclaim the scratch jails and worktrees of work that has landed.
 *
 * Only a task that is `done` (its work merged), or that was archived as
 * rejected/canceled, qualifies — and only once it finished more than
 * `retainDays` ago. A parked, blocked, queued or running task keeps every
 * worktree it has: retry and reopen pick them up, and the diff artifacts
 * point into them. A failed task keeps its own for a longer bound and goes
 * by rules of its own (sweepFailed, below). The last run of a done task also keeps a
 * worktree with uncommitted changes, since an approval that landed nothing
 * ("an interrupted run's work is still in …") leaves its work only there.
 *
 * Branches are left alone (a branch costs nothing and is the record of what
 * landed); `foreman prune` is still the way to drop them. Registrations whose
 * directory is already gone are pruned per repo with `git worktree prune`.
 */
export async function sweepJails(
  store: Store,
  opts: {
    now?: number; retainDays?: number; failedRetainDays?: number; limit?: number; workRoot?: string;
    /** The "has this tree changed since it was cut" check of the failed half, and its time bound; injected in tests. */
    jailChanged?: (jail: Jail) => Promise<boolean>; changeCheckMs?: number;
  } = {},
): Promise<JailSweepResult> {
  const now = opts.now ?? Date.now();
  const retainDays = opts.retainDays ?? config.jailRetainDays;
  const limit = opts.limit ?? JAIL_SWEEP_LIMIT;
  const workRoot = path.resolve(opts.workRoot ?? config.workRoot);
  const result: JailSweepResult = { removed: [], keptDirty: [], keptUnreadable: [], repos: [], keptNoDiff: [], staging: [] };
  const repos = new Set<string>();
  const seen = new Set<string>();
  // A negative bound turns this half off; the failed half below has its own bound and its own off switch.
  const landedOn = Number.isFinite(retainDays) && retainDays >= 0;
  // At least a day: with 0, a sweep landing between an approval marking the
  // task done and the merge committing its worktree would delete the work.
  const cutoff = now - Math.max(1, retainDays) * 86_400_000;
  const rows = !landedOn ? [] : store.db
    .prepare(
      `SELECT r.id AS run_id, r.worktree_path AS worktree_path, t.id AS task_id, t.repo AS repo,
              l.id AS latest, l.worktree_path AS latest_path
         FROM runs r JOIN tasks t ON t.id = r.task_id
         LEFT JOIN runs l ON l.id = (SELECT r2.id FROM runs r2 WHERE r2.task_id = t.id ORDER BY r2.started_at DESC, r2.rowid DESC LIMIT 1)
        WHERE t.updated_at <= ?
          AND (t.status = 'done' OR (t.archived_at IS NOT NULL AND t.status IN ('rejected', 'canceled')))
        ORDER BY t.updated_at ASC`,
    )
    .all(cutoff) as Record<string, unknown>[];

  for (const row of rows) {
    if (result.removed.length >= limit) break;
    const runId = String(row['run_id']);
    const repo = row['repo'] == null ? null : String(row['repo']);
    // Approved, merge still in flight: its worktree is about to be committed.
    if (store.isLanding(String(row['task_id']))) continue;
    if (repo) repos.add(repo);
    // The last run's worktree, whichever row names it: a resumed repair reuses
    // an older run's jail, so the latest run's worktree_path is
    // workRoot/<olderRunId> and the older row would otherwise delete it unchecked.
    const protect = new Set<string>();
    if (row['latest'] != null) protect.add(path.join(workRoot, String(row['latest'])));
    if (row['latest_path'] != null) protect.add(path.resolve(String(row['latest_path'])));
    const candidates = new Set<string>([path.join(workRoot, runId)]);
    if (row['worktree_path'] != null) candidates.add(path.resolve(String(row['worktree_path'])));
    for (const dir of candidates) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!insideWorkRoot(dir, workRoot) || !fs.existsSync(dir)) continue;
      if (repo) {
        if (protect.has(dir)) {
          // Fails closed: a git error (a moved repo, a dangling .git) proves nothing.
          // Pinned, drivers off (isolate.ts pinnedGit): `status` hashes the files a worker changed, through any clean
          // filter the repo's config — which the jail can write — names.
          const pending = await pinnedGit(dir, ['status', '--porcelain'])
            .then((r) => r.stdout.trim())
            .catch(() => null);
          if (pending === null) {
            result.keptUnreadable.push(dir);
            continue;
          }
          if (pending) {
            result.keptDirty.push(dir);
            continue;
          }
        }
        await pinnedGit(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    }
  }
  await sweepFailed(store, {
    now, limit, workRoot, retainDays: opts.failedRetainDays ?? config.failedJailRetainDays,
    jailChanged: opts.jailChanged ?? (async (jail) => (await jailChanges(jail)).changed),
    changeCheckMs: opts.changeCheckMs ?? CHANGE_CHECK_MS,
  }, result, repos, seen);
  // Staging directories whose jail is gone — by this sweep or any other way — under the rule deps.ts already has.
  result.staging = await sweepOrphanStaging(workRoot).catch(() => []);
  for (const repo of repos) {
    if (!fs.existsSync(repo)) continue;
    await pinnedGit(repo, ['worktree', 'prune']).catch(() => {});
    result.repos.push(repo);
  }
  return result;
}

/** How long the failed half waits for one tree's change check before it keeps the tree. */
const CHANGE_CHECK_MS = 60_000;

/** `check`'s answer, or null when it rejects or has not answered within `ms`. A late answer is ignored. */
function answerWithin(ms: number, check: Promise<boolean>): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    check.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** `dir` is at its own place under the work root — itself no link, and none on the way — and has a `.git` entry of its own. */
function isOwnTree(dir: string, workRoot: string): boolean {
  try {
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(workRoot), path.relative(workRoot, dir))) return false;
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** A diff artifact's file as something the work could be recovered from: a regular file with something in it. */
function diffOnDisk(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * The failed half of the sweep. A failed task keeps its worktrees for retry and reopen, and since a run that
 * reaches its deadline keeps its jail too, nothing ever removed them: the work directory only grew. Past
 * `retainDays` (FOREMAN_FAILED_JAIL_RETAIN_DAYS, at least one day) a failed task's worktree goes, under these rules:
 *
 *  - only a task whose status is `failed` now, re-read just before the removal: one at the gate, running, queued
 *    for a repair round or a retry has another status and is never touched;
 *  - the work must be recoverable first. The LAST run that used the tree (a resumed round records the tree of the
 *    round before it) must have recorded a diff artifact whose file is still on disk: the work is then in that
 *    file (and a retry of a reviewed run carries it into its new jail). Without one the tree goes only when it is
 *    provably unchanged since it was cut: isolate.ts jailChanges, the check a run's end makes, through that file's
 *    one pinned git helper (no hooks, no fsmonitor, no extra attributes file, objects as stored). A tree whose
 *    check errors, or does not answer within CHANGE_CHECK_MS, is kept — never swept on doubt;
 *  - a scratch directory (a task with no repo) has no diff to recover it from, and is kept.
 *
 * What is kept is reported (`keptNoDiff`, `keptUnreadable`), so the operator sees what did not go and why.
 */
async function sweepFailed(
  store: Store,
  opts: { now: number; limit: number; workRoot: string; retainDays: number; jailChanged: (jail: Jail) => Promise<boolean>; changeCheckMs: number },
  result: JailSweepResult,
  repos: Set<string>,
  seen: Set<string>,
): Promise<void> {
  if (!Number.isFinite(opts.retainDays) || opts.retainDays < 0) return;
  const cutoff = opts.now - Math.max(1, opts.retainDays) * 86_400_000;
  const tasks = store.db
    .prepare("SELECT id, repo FROM tasks WHERE status = 'failed' AND updated_at <= ? ORDER BY updated_at ASC")
    .all(cutoff) as Record<string, unknown>[];
  for (const t of tasks) {
    if (result.removed.length >= opts.limit) break;
    const taskId = String(t['id']);
    const repo = t['repo'] == null ? null : String(t['repo']);
    // Oldest first, so the last entry for a tree is the last run that used it.
    const runs = store.db
      .prepare('SELECT id, worktree_path, branch, base_commit, status FROM runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(taskId) as Record<string, unknown>[];
    if (runs.some((r) => String(r['status']) === 'running')) continue;
    const lastUser = new Map<string, Record<string, unknown>>();
    for (const r of runs) {
      for (const dir of new Set([path.join(opts.workRoot, String(r['id'])), ...(r['worktree_path'] == null ? [] : [path.resolve(String(r['worktree_path']))])])) {
        lastUser.set(dir, r);
      }
    }
    const diffs = new Map<string, string[]>();
    for (const a of store.artifactsForTask(taskId)) if (a.type === 'diff') diffs.set(a.runId, [...(diffs.get(a.runId) ?? []), a.path]);
    for (const [dir, run] of lastUser) {
      if (result.removed.length >= opts.limit) break;
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!insideWorkRoot(dir, opts.workRoot) || !fs.existsSync(dir)) continue;
      if (!repo) {
        result.keptNoDiff.push(dir);
        continue;
      }
      // The path has to BE the tree. A link at a run's place sent `git worktree remove --force` to whatever it named
      // (another ticket's live jail went, unsaved work and all) and the change check into it (`git add -N` in the
      // real repo). And a tree with no `.git` of its own is read by git as the repo above it — the daemon's home is
      // inside Foreman's own checkout — whose clean status then passed for "unchanged". Neither is touched or asked.
      if (!isOwnTree(dir, opts.workRoot)) {
        result.keptUnreadable.push(dir);
        continue;
      }
      repos.add(repo);
      if (!(diffs.get(String(run['id'])) ?? []).some(diffOnDisk)) {
        // No diff to recover the work from: the tree goes only if it holds none.
        // Kept on any doubt: an error, or no answer within the bound, proves nothing about the tree.
        const changes = await answerWithin(opts.changeCheckMs, opts.jailChanged({
          dir, repo: path.resolve(repo),
          branch: run['branch'] == null ? null : String(run['branch']),
          ...(run['base_commit'] == null ? {} : { baseCommit: String(run['base_commit']) }),
        }));
        if (changes === null) {
          result.keptUnreadable.push(dir);
          continue;
        }
        if (changes) {
          result.keptNoDiff.push(dir);
          continue;
        }
      }
      // The check above awaited: a retry or a reopen in the meantime owns the tree again.
      if (store.getTask(taskId)?.status !== 'failed') continue;
      await pinnedGit(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    }
  }
}

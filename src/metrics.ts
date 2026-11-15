/**
 * GET /api/metrics: a read-only view of what Foreman already measures, as JSON or Prometheus text. Nothing here
 * writes, and nothing new is counted: the numbers come from the ledger, the tick's own stage timing
 * (Scheduler.tickStageMs), the verify-slot queue and the event loop's delay histogram.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { computeLatencyReport, percentile } from './latency.ts';
import type { Store } from './queue.ts';
import { TICK_STAGES, type TickStage } from './scheduler.ts';
import type { TaskStatus } from './types.ts';
import { verifySlotStats } from './verify/slots.ts';

/** The runs the gate-wait percentiles are taken over, newest first. */
export const GATE_WAIT_RUNS = 100;
/** The key a ticket parked at the gate with no repo is counted under. */
const NO_REPO = '(none)';

// Sampled from the first import (the daemon's server) on; the timer it uses does not keep the process alive.
const loopDelay = monitorEventLoopDelay();
loopDelay.enable();

export interface Metrics {
  /** Epoch ms the numbers were read at. */
  at: number;
  /** p99 of the event loop's delay since the daemon started, in ms; null before the first sample. */
  eventLoopLagP99Ms: number | null;
  /** How long each tick stage took the last time it ran, in ms, in tick order. */
  tickStageMs: Partial<Record<TickStage, number>>;
  tasksByStatus: Record<TaskStatus | 'total', number>;
  /** Suite runs queued for a verify slot right now. */
  verifySlotWaiters: number;
  /** Time decided tickets sat at the gate, over the last GATE_WAIT_RUNS runs (src/latency.ts `gate-wait`). */
  gateWait: { samples: number; p50Ms: number; p90Ms: number };
  /** Per repo: p95 of how long its tickets now at awaiting-approval have been there (since their last update), ms. */
  awaitingApprovalAgeP95Ms: Record<string, number>;
  /**
   * Per repo: p95 of how long its tickets now at awaiting-approval have been parked (since they entered the status;
   * since their last update for a ticket parked before that was recorded), ms.
   */
  awaitingSinceParkP95Ms: Record<string, number>;
  /** Per repo whose main is red now: whole minutes since it went red. */
  redRepoMinutes: Record<string, number>;
}

export function collectMetrics(store: Store, stageMs: ReadonlyMap<TickStage, number>, now: number): Metrics {
  const tickStageMs: Partial<Record<TickStage, number>> = {};
  for (const stage of TICK_STAGES) {
    const ms = stageMs.get(stage);
    if (ms !== undefined) tickStageMs[stage] = ms;
  }

  const gate = computeLatencyReport(store.recentRunsForLatency(GATE_WAIT_RUNS)).stages.find((s) => s.stage === 'gate-wait');

  const parked = store.db
    .prepare("SELECT repo, updated_at, COALESCE(awaiting_since, updated_at) AS parked_at FROM tasks WHERE status = 'awaiting-approval'")
    .all() as Array<{ repo: string | null; updated_at: number; parked_at: number }>;
  const awaitingApprovalAgeP95Ms = p95ByRepo(parked.map((row) => [row.repo, now - row.updated_at]));
  const awaitingSinceParkP95Ms = p95ByRepo(parked.map((row) => [row.repo, now - row.parked_at]));

  const redRepoMinutes: Record<string, number> = {};
  for (const [repo, red] of store.redRepoList()) {
    redRepoMinutes[repo] = Math.floor(Math.max(0, now - (red.since ?? now)) / 60_000);
  }

  return {
    at: now,
    eventLoopLagP99Ms: loopDelay.count === 0 ? null : loopDelay.percentile(99) / 1e6,
    tickStageMs,
    tasksByStatus: store.stats(),
    verifySlotWaiters: verifySlotStats().waiting,
    gateWait: { samples: gate?.count ?? 0, p50Ms: gate?.medianMs ?? 0, p90Ms: gate?.p90Ms ?? 0 },
    awaitingApprovalAgeP95Ms,
    awaitingSinceParkP95Ms,
    redRepoMinutes,
  };
}

/** p95 of the ages per repo (no repo under NO_REPO), repos sorted; a negative age counts as 0. */
function p95ByRepo(ages: Array<[repo: string | null, ageMs: number]>): Record<string, number> {
  const byRepo = new Map<string, number[]>();
  for (const [repo, age] of ages) {
    const key = repo ?? NO_REPO;
    byRepo.set(key, [...(byRepo.get(key) ?? []), Math.max(0, age)]);
  }
  const out: Record<string, number> = {};
  for (const [repo, list] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
    out[repo] = percentile(list.sort((a, b) => a - b), 0.95);
  }
  return out;
}

/** A Prometheus label value: backslash, double quote and newline escaped. */
function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** The Prometheus text exposition format (0.0.4) of `m`; every metric is a gauge. */
export function toProm(m: Metrics): string {
  const out: string[] = [];
  const gauge = (name: string, help: string, samples: Array<[string, number]>): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
  };
  const by = (key: string, rec: Record<string, number>): Array<[string, number]> =>
    Object.entries(rec).map(([k, v]) => [`{${key}="${label(k)}"}`, v]);

  if (m.eventLoopLagP99Ms !== null) {
    gauge('foreman_event_loop_lag_p99_ms', 'p99 event loop delay since the daemon started, ms.', [['', m.eventLoopLagP99Ms]]);
  }
  gauge('foreman_tick_stage_ms', 'How long each tick stage took the last time it ran, ms.', by('stage', m.tickStageMs));
  gauge('foreman_tasks', 'Tasks by status.', by('status', m.tasksByStatus).filter(([labels]) => labels !== '{status="total"}'));
  gauge('foreman_verify_slot_waiters', 'Suite runs queued for a verify slot.', [['', m.verifySlotWaiters]]);
  gauge('foreman_gate_wait_ms', 'Time decided tickets sat at the gate, ms.', [
    ['{quantile="0.5"}', m.gateWait.p50Ms],
    ['{quantile="0.9"}', m.gateWait.p90Ms],
  ]);
  gauge('foreman_gate_wait_samples', 'Gate waits the quantiles are taken over.', [['', m.gateWait.samples]]);
  gauge('foreman_awaiting_approval_age_p95_ms', 'p95 age of tickets awaiting approval, per repo, ms.', by('repo', m.awaitingApprovalAgeP95Ms));
  gauge(
    'foreman_awaiting_approval_since_park_p95_ms',
    'p95 time tickets awaiting approval have been parked, per repo, ms.',
    by('repo', m.awaitingSinceParkP95Ms),
  );
  gauge('foreman_red_repo_minutes', 'Minutes each red repo has been red.', by('repo', m.redRepoMinutes));
  return `${out.join('\n')}\n`;
}

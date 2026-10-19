/**
 * Per-stage wall-clock reporting, derived entirely from data Foreman already
 * records: the `stage` events written by `Store.setRunStage` (one per run,
 * timestamped), plus the owning task's current status/updated_at for the
 * one stage (`gate`) whose "end" is a human decision rather than another
 * stage event. No new instrumentation — `foreman doctor --latency` is a
 * read-only report over the events table.
 */

/** The stage rail as reported by `doctor --latency`; `admit` is omitted (near-instant, not interesting) and `gate` is reported as the human wait, not the instant it was reached. */
export const LATENCY_STAGES = ['isolate', 'plan', 'work', 'test', 'verify', 'gate-wait'] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

const TASK_ENDED_STATUSES = new Set(['done', 'failed', 'rejected', 'canceled']);

export interface StageEventInput {
  stage: string;
  ts: number;
}

/** Everything needed to derive stage durations for one run. */
export interface RunLatencyInput {
  runId: string;
  taskId: string;
  /** This run's `type = 'stage'` events, any order. */
  events: StageEventInput[];
  /** The owning task's *current* status (may have moved on since this run ended). */
  taskStatus: string;
  taskUpdatedAt: number;
}

export interface StageStat {
  stage: LatencyStage;
  /** How many runs contributed a sample for this stage. */
  count: number;
  medianMs: number;
  p90Ms: number;
  /** Share of the sum of per-stage medians, i.e. of a "typical" run. */
  shareOfTotalPct: number;
}

export interface LatencyReport {
  /** How many runs were inspected (not all necessarily contributed every stage). */
  sampleRuns: number;
  stages: StageStat[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Duration of stage X is the gap to the *next* recorded stage event in the
 * same run — whatever stage that turns out to be. This falls out naturally
 * when a run skips a stage (e.g. no test command: `work` runs straight into
 * `verify`), without special-casing which stages a task kind visits.
 */
export function computeLatencyReport(runs: RunLatencyInput[]): LatencyReport {
  const samples = new Map<LatencyStage, number[]>(LATENCY_STAGES.map((s) => [s, []]));

  for (const run of runs) {
    const events = [...run.events].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < events.length; i++) {
      const cur = events[i]!;
      if (cur.stage === 'admit') continue;

      if (cur.stage === 'gate') {
        // The run itself ends the instant it reaches the gate; the wait that
        // matters is how long the task then sat at awaiting-approval, which
        // only the task's own updated_at (stamped by the eventual decision)
        // can tell us. A task still awaiting a decision has no end yet.
        if (TASK_ENDED_STATUSES.has(run.taskStatus) && run.taskUpdatedAt > cur.ts) {
          samples.get('gate-wait')!.push(run.taskUpdatedAt - cur.ts);
        }
        continue;
      }

      const next = events[i + 1];
      if (!next) continue;
      if ((LATENCY_STAGES as readonly string[]).includes(cur.stage)) {
        samples.get(cur.stage as LatencyStage)!.push(next.ts - cur.ts);
      }
    }
  }

  const medians = new Map<LatencyStage, number>();
  for (const stage of LATENCY_STAGES) {
    const sorted = [...samples.get(stage)!].sort((a, b) => a - b);
    medians.set(stage, percentile(sorted, 0.5));
  }
  const total = [...medians.values()].reduce((n, v) => n + v, 0);

  const stages: StageStat[] = LATENCY_STAGES.map((stage) => {
    const sorted = [...samples.get(stage)!].sort((a, b) => a - b);
    const medianMs = medians.get(stage)!;
    return {
      stage,
      count: sorted.length,
      medianMs,
      p90Ms: percentile(sorted, 0.9),
      shareOfTotalPct: total > 0 ? (medianMs / total) * 100 : 0,
    };
  });

  return { sampleRuns: runs.length, stages };
}

/** e.g. `340ms`, `1.2s`, `4.5m` — plain, no external formatting deps. */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

import type { Broker } from '../budget.ts';
import type { NewTask } from '../queue.ts';
import type { Stage, Task } from '../types.ts';
import { echoRunner } from './echo.ts';
import { shellRunner } from './shell.ts';
import { claudeCodeRunner, codexCliRunner } from './cliRunners.ts';
import { apiRunner } from './api.ts';

export interface RunnerContext {
  task: Task;
  runId: string;
  /** The jail. Runners must not write outside it. */
  dir: string;
  signal: AbortSignal;
  /** The metered path to any model call. Runners must not call models directly. */
  broker: Broker;
  stage(stage: Stage, message?: string): void;
  /**
   * Record (null = clear) the pid/pgid of a spawned child on the run row, so
   * a daemon that dies without cleaning up can reap survivors on restart.
   */
  child(pid: number | null): void;
  /**
   * Record the hosted CLI's own conversation id for this run. Persisted on the
   * run row so the next repair round can `--resume` it and send only the
   * critique instead of re-buying the whole brief.
   */
  session(id: string): void;
  log(line: string): void;
  progress(fraction: number): void;
  usage(u: { tokensIn?: number; tokensOut?: number; costUsd?: number }): void;
  /**
   * Queue follow-up work (a tool build, a decomposed sub-task). The new task
   * goes through admission, the gate and every other rail like any other.
   */
  enqueue(task: NewTask): Task;
  /**
   * A previous run's CLI session this attempt should continue instead of
   * starting cold. Set only by the scheduler, only for a repair round, and only
   * once per session (see scheduler.ts:resumableSession).
   */
  resumeSession?: string | null;
}

export interface RunnerResult {
  ok: boolean;
  summary: string;
  /** The worker's whole final message when `summary` is a bounded copy of it; checks that parse the report's tail read this. */
  report?: string;
  exitCode?: number | null;
  /**
   * What the runner knows about its own run, for the run row (runFacts.ts). All optional: a runner that cannot tell
   * leaves them out and the columns stay null. `turns` is model responses seen in the stream, `turnsReported` the
   * CLI's own `num_turns`, `turnLimit` the ceiling it was started with, `endedBy` set only when the run stopped on
   * its turn ceiling or on the out-of-jail tripwire.
   */
  turns?: number | null;
  turnsReported?: number | null;
  turnLimit?: number | null;
  endedBy?: 'turn-ceiling' | 'tripwire' | null;
}

export interface Runner {
  id: Task['runner'];
  /**
   * True when the prompt is a natural-language brief that may be augmented
   * with repair notes and remembered facts. False when the prompt is executed
   * literally (the shell runner), where extra prose would be run as code.
   */
  takesBrief: boolean;
  /**
   * False for runners whose output is not real work (the demo runner), so the
   * council is not asked to review a simulation and rightly reject it.
   */
  verifiable: boolean;
  /** Human-readable reason this runner cannot run here, or null if it can. */
  preflight(task: Task): Promise<string | null>;
  run(ctx: RunnerContext): Promise<RunnerResult>;
}

const REGISTRY = new Map<Task['runner'], Runner>(
  [echoRunner, shellRunner, claudeCodeRunner, codexCliRunner, apiRunner].map((r) => [r.id, r]),
);

export function getRunner(id: Task['runner']): Runner {
  const runner = REGISTRY.get(id);
  if (!runner) throw new Error(`no runner registered for ${id}`);
  return runner;
}

export const runnerIds = (): Task['runner'][] => [...REGISTRY.keys()];

import type { AbortCause } from './abort.ts';
import type { BriefCut } from './context.ts';
import type { RunnerResult } from './runners/index.ts';
import type { RunEndedReason } from './types.ts';

/**
 * What a run records about itself on its own row when it ends: how many turns
 * the worker took against which ceiling, how the run ended, how large its
 * brief was and what was cut from it, and how long the worker's report was
 * before anything bounded it. `foreman debrief` had to read the first three
 * out of the wording of a failure message and could not see the rest at all.
 *
 * The scheduler fills this in as the run goes (scheduler.ts execute) and
 * writes it once, in its `finally`. Nothing here decides anything: these are
 * records of what already happened.
 */
export interface RunFacts {
  /** Model responses the worker's stream showed, summed over every launch of this run (a background-test resume is a second one). */
  turns: number | null;
  /** The CLI's own `num_turns`, summed the same way. It is not the same count as `turns`, and the ceiling caps the other one. */
  turnsReported: number | null;
  /** The `--max-turns` the worker was started with; null when no ceiling was passed. */
  turnLimit: number | null;
  briefBytes: number | null;
  briefCuts: BriefCut[] | null;
  reportBytes: number | null;
  /** How the worker itself stopped, when the runner said: on its turn ceiling or on the out-of-jail tripwire. */
  endedBy: 'turn-ceiling' | 'tripwire' | null;
  /** The worker returned and said it had finished. */
  workerOk: boolean | null;
  /** The run left through the scheduler's catch. */
  threw: boolean;
  providerLimited: boolean;
}

export function newRunFacts(): RunFacts {
  return {
    turns: null, turnsReported: null, turnLimit: null, briefBytes: null, briefCuts: null, reportBytes: null,
    endedBy: null, workerOk: null, threw: false, providerLimited: false,
  };
}

/** The brief as it is about to be sent, and the cuts made while it was built. */
export function noteBrief(facts: RunFacts, brief: string, cuts: BriefCut[]): void {
  facts.briefBytes = Buffer.byteLength(brief, 'utf8');
  facts.briefCuts = cuts;
}

const add = (a: number | null, b: number | null | undefined): number | null => (b == null ? a : (a ?? 0) + b);

/**
 * The worker's return. Its report is measured here, before boundSummary or any
 * reviewer's cap touches it; a runner that returns no report of its own (only
 * a summary, which may already be a bounded copy) leaves the size unknown.
 */
export function noteResult(facts: RunFacts, result: RunnerResult): void {
  facts.turns = add(facts.turns, result.turns);
  facts.turnsReported = add(facts.turnsReported, result.turnsReported);
  if (result.turnLimit != null) facts.turnLimit = result.turnLimit;
  facts.endedBy = result.endedBy ?? null;
  facts.workerOk = result.ok;
  if (result.report !== undefined) facts.reportBytes = Buffer.byteLength(result.report, 'utf8');
}

/**
 * The one resume of a worker that ended its turn with a test run still in the
 * background. Its turns add up either way. When it worked (`report` is the
 * joined report the run goes on with) it is also how the worker ended; when it
 * failed the scheduler keeps the first result, and so does this.
 */
export function noteResumed(facts: RunFacts, resumed: RunnerResult, report?: string): void {
  facts.turns = add(facts.turns, resumed.turns);
  facts.turnsReported = add(facts.turnsReported, resumed.turnsReported);
  if (report === undefined) return;
  facts.endedBy = resumed.endedBy ?? null;
  facts.workerOk = resumed.ok;
  facts.reportBytes = Buffer.byteLength(report, 'utf8');
}

/**
 * The one word for how the run ended. A run that left through the scheduler's
 * catch ended on what stopped it: a cancel, its deadline, the provider's
 * refusal, else how the worker itself stopped, else an error. A run that went
 * on to its review ended `ok` unless the worker did not (its ceiling, the
 * tripwire, a failure) or it was canceled on the way; a deadline that came
 * during review does not end a run, so it is not recorded as one. `ok` says
 * the run reached its normal end, not that its tests or its review passed:
 * those are `tests_passed` and `verdict`. A daemon stop is none of the
 * recorded states and is left null rather than given a name it does not have.
 */
export function endedReason(facts: RunFacts, cause: AbortCause | null, runStatus: string | null | undefined): RunEndedReason | null {
  const worker = facts.endedBy ?? (facts.workerOk === false ? 'error' : null);
  if (facts.threw) {
    if (cause === 'cancel') return 'canceled';
    if (cause === 'stop') return null;
    if (cause === 'deadline') return 'deadline';
    if (facts.providerLimited) return 'provider-limit';
    return worker ?? 'error';
  }
  if (runStatus === 'canceled') return cause === 'stop' ? null : 'canceled';
  return worker ?? (facts.workerOk === true ? 'ok' : null);
}

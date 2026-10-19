/**
 * Why a run was stopped. The scheduler aborts a run's controller for three
 * different reasons that call for three different endings: an operator cancel
 * (the run is over, and nothing it does afterwards may count), a daemon stop
 * (the task goes back in the queue for when the daemon returns) and the run's
 * own deadline (at review, the run goes on with what it has; before that, it is
 * ended like any timed-out run).
 */
export type AbortCause = 'cancel' | 'stop' | 'deadline';

/** Every cause a signal was aborted for — an AbortSignal keeps only its first reason. */
const causes = new WeakMap<AbortSignal, Set<AbortCause>>();

/**
 * Abort with a cause. The reason is still an AbortError, so anything awaiting
 * the signal (fetch, a child process) fails exactly as it did without one. A
 * cause that arrives after the signal is already aborted is still recorded: a
 * cancel that lands after the deadline fired must still read as a cancel.
 */
export function abortFor(controller: AbortController | undefined, cause: AbortCause): void {
  if (!controller) return;
  const seen = causes.get(controller.signal) ?? new Set<AbortCause>();
  seen.add(cause);
  causes.set(controller.signal, seen);
  if (!controller.signal.aborted) controller.abort(new DOMException(cause, 'AbortError'));
}

/**
 * The cause that decides how a run ends; null when it was not aborted, or was
 * aborted without one. A cancel outranks a stop, and a stop a deadline, in
 * whatever order they arrived: the operator's word is final, and a shutdown
 * is not the run running out of time.
 */
export function abortCause(signal: AbortSignal | null | undefined): AbortCause | null {
  if (!signal?.aborted) return null;
  const seen = causes.get(signal);
  if (!seen) return null;
  for (const cause of ['cancel', 'stop', 'deadline'] as const) if (seen.has(cause)) return cause;
  return null;
}

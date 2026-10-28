/**
 * Contains the two ways a stray error ends the daemon without a word: an unhandled promise rejection (fatal by
 * default) and an uncaught exception (the default skips the lock release, the trace flush and the 'exit' handlers'
 * orderly path). A rejection is written, recorded once per window per message, and the daemon keeps running; an
 * exception is recorded and ends the daemon through `shutdown(1)`, once; later ones are only written, at most
 * MAX_LATER_WRITTEN of them (on a closed stderr each write raises another exception, EPIPE, so an unbounded write
 * would feed itself for the whole drain).
 *
 * It installs no signal listener and no 'exit' listener: the freeze registry (runners/freezeRecord.ts) decides what
 * to do from the signal listeners it finds, and `shutdown` ends in process.exit, which its 'exit' listener answers.
 */

export const REJECTION_WINDOW_MS = 60_000;
// Distinct messages remembered at once; past this the expired ones go first, then the oldest.
const MAX_TRACKED = 64;
export const MAX_LATER_WRITTEN = 10;

export interface ProcessErrorDeps {
  record: (type: 'error', message: string) => void;
  shutdown: (code: number) => void | Promise<void>;
  now: () => number;
  write: (line: string) => void;
}

export interface ProcessErrorHandlers {
  onRejection: (reason: unknown) => void;
  onException: (err: unknown) => void;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return 'unprintable value';
  }
}

export function processErrorHandlers(deps: ProcessErrorDeps): ProcessErrorHandlers {
  const { record, shutdown, now, write } = deps;
  const say = (line: string): void => {
    try {
      write(`${line}\n`);
    } catch {
      /* a closed stderr must not turn one error into two */
    }
  };
  const seen = new Map<string, { at: number; suppressed: number }>();
  let recording = false;
  let ending = false;
  let later = 0;

  const onRejection = (reason: unknown): void => {
    if (recording) return;
    const message = describe(reason);
    say(`unhandled rejection: ${message}`);
    const at = now();
    const prior = seen.get(message);
    if (prior && at - prior.at < REJECTION_WINDOW_MS) {
      prior.suppressed++;
      return;
    }
    if (seen.size >= MAX_TRACKED) {
      for (const [key, v] of seen) if (at - v.at >= REJECTION_WINDOW_MS) seen.delete(key);
      if (seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value as string);
    }
    // Stamped before the attempt: a record that throws still counts against the window.
    const suppressed = prior?.suppressed ?? 0;
    seen.set(message, { at, suppressed: 0 });
    recording = true;
    try {
      record('error', `unhandled rejection: ${message}${suppressed ? ` (${suppressed} more in the last window)` : ''}`);
    } catch (err) {
      say(`could not record the unhandled rejection: ${describe(err)}`);
    } finally {
      recording = false;
    }
  };

  const onException = (err: unknown): void => {
    const line = `uncaught exception: ${err instanceof Error && err.stack ? err.stack : describe(err)}`;
    if (!ending || later++ < MAX_LATER_WRITTEN) say(line);
    if (ending) return;
    ending = true;
    try {
      record('error', `uncaught exception: ${describe(err)}`);
    } catch {
      /* best effort: the daemon is going down either way */
    }
    try {
      void Promise.resolve(shutdown(1)).catch((e: unknown) => say(`shutdown failed: ${describe(e)}`));
    } catch (e) {
      say(`shutdown failed: ${describe(e)}`);
    }
  };

  return { onRejection, onException };
}

/** Install the handlers on `process`; the returned function removes exactly those two listeners. */
export function containProcessErrors(deps: ProcessErrorDeps): () => void {
  const { onRejection, onException } = processErrorHandlers(deps);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.removeListener('unhandledRejection', onRejection);
    process.removeListener('uncaughtException', onException);
  };
}

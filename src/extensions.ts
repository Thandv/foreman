import type { Store } from './queue.ts';

/**
 * What an optional subsystem (alignment and personas today) contributes to the daemon, so the scheduler runs it
 * without importing it. The daemon's entry point registers each one before the scheduler starts.
 */

/** A machine-wide reason to start no new work. Work already running is left alone. */
export interface DispatchHold {
  /** The hold kind each queued ticket records while it lasts. */
  readonly kind: string;
  /** Recorded once when the hold lifts. */
  readonly released: string;
  /**
   * Read on every tick: null when nothing holds dispatch, else the event recorded once when the hold starts and the
   * message each queued ticket is held with.
   */
  current(): { paused: string; held: string } | null;
}

export interface Extension {
  readonly name: string;
  /**
   * Runs once when the scheduler starts, not awaited: a failure is recorded as a warning and never stops the queue
   * from booting.
   */
  onStart?(store: Pick<Store, 'record'>): Promise<void>;
  readonly dispatchHold?: DispatchHold;
}

const registered: Extension[] = [];

/** Adds an extension; a second one with the same name is refused. */
export function registerExtension(ext: Extension): void {
  if (registered.some((e) => e.name === ext.name)) throw new Error(`extension ${ext.name} is already registered`);
  registered.push(ext);
}

export function registeredExtensions(): readonly Extension[] {
  return registered;
}

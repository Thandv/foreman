/**
 * The one deadline a run has, as a clock that can be stopped.
 *
 * A run's budget is for its own work. Time it spends queued behind other runs
 * — for a test slot, for the verify lane, or (through the slot wrapper) for the
 * slot its own worker asked for — is not its time: while any such wait is open
 * the timer is stopped, and the deadline moves on by the wait. Waits are named
 * by key, so two that overlap are counted once.
 *
 * A worker's own slot wait (keys starting `worker-slot`) is the one wait the
 * worker itself can start, so its credit is capped in total
 * (FOREMAN_SLOT_WAIT_CREDIT_MS, default 30 minutes): past the cap the clock
 * runs again even while that wait is still open.
 */

export const DEFAULT_SLOT_WAIT_CREDIT_MS = 30 * 60_000;

/** The total a run may be credited for its worker's own slot waits. Read per clock, so tests can set it per case. */
export function slotWaitCreditMs(): number {
  const ms = Number(process.env['FOREMAN_SLOT_WAIT_CREDIT_MS']);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SLOT_WAIT_CREDIT_MS;
}

/** setTimeout/clearTimeout, injectable with the clock so a test moves time by hand. */
export interface ClockTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ClockTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The longest delay setTimeout takes; a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

const CAPPED_PREFIX = 'worker-slot';

export class RunClock {
  private readonly budgetMs: number;
  private readonly onExpire: () => void;
  private readonly now: () => number;
  private readonly timers: ClockTimers;
  private readonly capMs: number;
  private readonly startedAt: number;
  /** Open waits, by key. */
  private readonly keys = new Set<string>();
  /** Open waits that are not a worker's own: these stop the clock without limit. */
  private uncapped = 0;
  /** Settled paused time: how far the deadline has moved. */
  private credit = 0;
  /** The part of `credit` given for worker-slot waits alone. */
  private workerCredit = 0;
  /** Up to when `credit` is settled. */
  private mark: number;
  private timer: unknown = null;
  private over = false;

  constructor(budgetMs: number, onExpire: () => void, now: () => number = Date.now, timers: ClockTimers = realTimers) {
    this.budgetMs = budgetMs;
    this.onExpire = onExpire;
    this.now = now;
    this.timers = timers;
    this.capMs = slotWaitCreditMs();
    this.startedAt = now();
    this.mark = this.startedAt;
    this.arm();
  }

  /** Open a wait. A key that is already open is not opened twice. */
  pause(key: string): void {
    if (this.over || this.keys.has(key)) return;
    this.settle();
    this.keys.add(key);
    if (!key.startsWith(CAPPED_PREFIX)) this.uncapped++;
    this.arm();
  }

  /** Close a wait. A key that is not open is ignored. */
  resume(key: string): void {
    if (this.over || !this.keys.has(key)) return;
    this.settle();
    this.keys.delete(key);
    if (!key.startsWith(CAPPED_PREFIX)) this.uncapped--;
    this.arm();
  }

  /** The wall-clock instant the run expires at, as things stand: it moves on while a wait is open. */
  get deadlineAt(): number {
    return this.startedAt + this.budgetMs + this.credit + this.pending(this.now());
  }

  /** Paused time not counted against the budget so far. */
  get pausedMs(): number {
    return this.credit + this.pending(this.now());
  }

  /** The run is over: no expiry after this. */
  stop(): void {
    this.over = true;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  /** What the open waits are owed since `mark`: all of it, or for worker-slot waits alone what is left of the cap. */
  private pending(at: number): number {
    if (!this.keys.size) return 0;
    const elapsed = Math.max(0, at - this.mark);
    return this.uncapped > 0 ? elapsed : Math.min(elapsed, Math.max(0, this.capMs - this.workerCredit));
  }

  private settle(): void {
    const at = this.now();
    const owed = this.pending(at);
    this.credit += owed;
    if (this.keys.size && this.uncapped === 0) this.workerCredit += owed;
    this.mark = at;
  }

  /** (Re)start the timer for the moment the run would expire if nothing else changed; none while an uncapped wait is open. */
  private arm(): void {
    this.timers.clear(this.timer);
    this.timer = null;
    if (this.over || this.uncapped > 0) return;
    const left = this.startedAt + this.budgetMs + this.credit - this.now();
    // A worker-slot wait holds the deadline still for what is left of its cap, and no longer.
    const held = this.keys.size ? Math.max(0, this.capMs - this.workerCredit) : 0;
    this.timer = this.timers.set(() => this.fire(), Math.min(MAX_DELAY_MS, Math.max(0, left + held)));
  }

  private fire(): void {
    if (this.over) return;
    this.settle();
    if (this.uncapped > 0) return;
    const left = this.startedAt + this.budgetMs + this.credit - this.now();
    const held = this.keys.size ? Math.max(0, this.capMs - this.workerCredit) : 0;
    // A timer that came early (or a delay that was clamped) is not an expiry: wait out the rest.
    if (left + held > 0) return this.arm();
    this.over = true;
    this.timer = null;
    this.onExpire();
  }
}

/** Minutes to one decimal place, for a message: 60, 12.5, 0.1. */
function minutes(ms: number): number {
  return Math.round(ms / 6_000) / 10;
}

/** What a run that reached its deadline is recorded with (tasks.error, the run's summary). */
export function deadlineNote(budgetMs: number, stage: string | null, pausedMs: number): string {
  return `run deadline (${minutes(budgetMs)} min) reached during ${stage ?? 'the run'}; ${minutes(pausedMs)} min queued were not counted`;
}

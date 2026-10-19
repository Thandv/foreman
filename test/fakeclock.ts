// A clock and timers a test moves by hand, for src/runClock.ts: nothing here waits on the wall clock.
import { RunClock, type ClockTimers } from '../src/runClock.ts';

export class FakeTime implements ClockTimers {
  private at = 1_000_000;
  private seq = 0;
  private readonly due = new Map<number, { when: number; fn: () => void }>();

  now = (): number => this.at;

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { when: this.at + Math.max(0, ms), fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.due.delete(handle);
  }

  /** Move time on, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      let next: [number, { when: number; fn: () => void }] | null = null;
      for (const entry of this.due) if (entry[1].when <= end && (!next || entry[1].when < next[1].when)) next = entry;
      if (!next) break;
      this.due.delete(next[0]);
      this.at = Math.max(this.at, next[1].when);
      next[1].fn();
    }
    this.at = end;
  }
}

/**
 * A run deadline the test fires by hand, for a test whose subject is what a run does when the deadline comes, not how
 * long it takes to come. Real time still passes (a worker's own timeouts are read off the wall clock), but it never
 * spends the budget: `expire()` moves the clock past the budget and runs the timer.
 */
export class HandFiredDeadline {
  private skew = 0;
  private fire: (() => void) | null = null;

  /** For SchedulerOptions.runClock. */
  readonly clock = (budgetMs: number, onExpire: () => void): RunClock =>
    new RunClock(budgetMs, onExpire, () => Date.now() + this.skew, {
      set: (fn) => { this.fire = fn; return 1; },
      clear: () => { this.fire = null; },
    });

  /** The deadline comes now. */
  expire(): void {
    this.skew += 365 * 24 * 3_600_000;
    this.fire?.();
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Store } from './queue.ts';
import type { RunEvent } from './types.ts';

const DAY_MS = 86_400_000;
const TRACE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface TracerOptions {
  /** Directory the daily files go in. Defaults to <home>/traces. */
  dir?: string;
  /** Injectable clock; the file is chosen per write from it. */
  now?: () => number;
  /** Days of files kept; older ones are deleted. Defaults to FOREMAN_TRACE_RETAIN_DAYS (14). */
  retainDays?: number;
  /** Buffered lines are appended at least this often. */
  flushMs?: number;
  /** …or as soon as this many bytes are buffered. */
  flushBytes?: number;
}

/**
 * Append-only observability sink. Everything the board shows is derived from
 * SQLite; this exists so a run can still be reconstructed after the events
 * table has been pruned, and so an external collector can be pointed at it.
 *
 * One file per UTC day, chosen at write time — a name fixed at daemon start
 * kept a week-long daemon appending to its first day's file. Lines are
 * buffered and appended in batches (on an interval, past a size, and on
 * stop()) so a busy run is not one synchronous write per event on the loop.
 */
export class Tracer {
  private readonly store: Store;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly retainDays: number;
  private readonly flushMs: number;
  private readonly flushBytes: number;
  private readonly sink: string | undefined;
  private readonly onEvent: (ev: RunEvent) => void;
  private day = '';
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(store: Store, opts: TracerOptions = {}) {
    this.store = store;
    this.dir = opts.dir ?? path.join(config.home, 'traces');
    this.now = opts.now ?? Date.now;
    this.retainDays = Math.max(1, opts.retainDays ?? config.traceRetainDays);
    this.flushMs = opts.flushMs ?? 1_000;
    this.flushBytes = opts.flushBytes ?? 64 * 1024;
    fs.mkdirSync(this.dir, { recursive: true });
    this.sink = process.env['FOREMAN_TRACE_SINK'];
    this.onEvent = (ev) => this.write(ev);
    this.onExit = () => this.flush();
  }

  /** Last chance on any exit, crash or process.exit: flush is synchronous, so it runs inside 'exit'. */
  private readonly onExit: () => void;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.day = dayOf(this.now());
    this.sweep();
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref();
    this.store.on('event', this.onEvent);
    process.on('exit', this.onExit);
  }

  stop(): void {
    this.store.off('event', this.onEvent);
    process.off('exit', this.onExit);
    clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
    this.started = false;
  }

  /** Today's file, by the injected clock. */
  get path(): string {
    return this.fileFor(dayOf(this.now()));
  }

  /** Append everything buffered to the current day's file. */
  flush(): void {
    if (!this.buffer.length) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      fs.appendFileSync(this.fileFor(this.day), chunk);
    } catch {
      /* tracing must never take the daemon down */
    }
  }

  private fileFor(day: string): string {
    return path.join(this.dir, `${day}.jsonl`);
  }

  /** Delete daily files older than the retention window. */
  private sweep(): void {
    const cutoff = dayOf(this.now() - this.retainDays * DAY_MS);
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = TRACE_FILE.exec(name);
      if (!m || m[1]! >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
      } catch (err) {
        // Not recorded as an event: this runs inside the store's synchronous listener, so recording would recurse.
        const code =(err as NodeJS.ErrnoException).code ?? (err as Error).message;
        process.stderr.write(`trace sweep could not remove ${name}: ${code}\n`);
      }
    }
  }

  private write(ev: RunEvent): void {
    if (!this.started) return;
    const day = dayOf(this.now());
    if (day !== this.day) {
      // Midnight: what was buffered belongs to the day it was written on.
      this.flush();
      this.day = day;
      this.sweep();
    }
    const line = `${JSON.stringify(ev)}\n`;
    this.buffer.push(line);
    this.bufferedBytes += line.length;
    // An error or warning is what a crash right after it would most need.
    if (this.bufferedBytes >= this.flushBytes || ev.type === 'error' || ev.type === 'warning') this.flush();
    if (this.sink) {
      // Fire-and-forget: a slow or dead collector must not stall a run.
      void fetch(this.sink, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env['FOREMAN_TRACE_KEY'] ? { authorization: `Bearer ${process.env['FOREMAN_TRACE_KEY']}` } : {}),
        },
        body: JSON.stringify({ source: 'foreman', ...ev }),
      }).catch(() => {});
    }
  }
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Full reconstruction of one task, for export or a bug report. */
export function traceTask(store: Store, taskId: string): unknown {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return {
    task,
    runs: store.runsForTask(taskId),
    verdicts: store.verdictsForTask(taskId),
    artifacts: store.artifactsForTask(taskId),
    receipts: store.receiptsForTask(taskId),
    events: store.eventsForTask(taskId, 5000),
    exportedAt: new Date().toISOString(),
  };
}

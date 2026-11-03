import fs from 'node:fs';
import type { TestContext } from 'node:test';

/**
 * node:test runs a test's `t.after` hooks in the order they were registered. A fixture that registers the removal of
 * its temp dir before the test registers the stop of a Scheduler (or server, or child) that writes into it has the dir
 * removed under a running writer, and the removal fails with ENOTEMPTY. These two helpers keep the order out of the
 * registration order: `stopsFirst` hooks do their stopping, and the dirs named to `removeAfterStops` are removed once
 * the last of them has finished (or by their own hook, when the test registered no stopper).
 */
const dirs = new WeakMap<TestContext, string[]>();
const stoppers = new WeakMap<TestContext, number>();

function flush(t: TestContext): void {
  for (const dir of dirs.get(t)?.splice(0) ?? []) fs.rmSync(dir, { recursive: true, force: true });
}

/** Remove `dir` after the test's `stopsFirst` hooks have all finished. Returns `dir`. */
export function removeAfterStops(t: TestContext, dir: string): string {
  const list = dirs.get(t) ?? [];
  list.push(dir);
  dirs.set(t, list);
  t.after(() => {
    if (!stoppers.get(t)) flush(t);
  });
  return dir;
}

/** Register a stopping hook (scheduler stop, store close, server close, kill); the dirs go once every one has run. */
export function stopsFirst(t: TestContext, stop: () => void | Promise<void>): void {
  stoppers.set(t, (stoppers.get(t) ?? 0) + 1);
  t.after(async () => {
    try {
      await stop();
    } finally {
      const left = (stoppers.get(t) ?? 1) - 1;
      stoppers.set(t, left);
      if (left === 0) flush(t);
    }
  });
}

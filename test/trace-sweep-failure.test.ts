import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Tracer } from '../src/trace.ts';

function scratch(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-trace-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** rmSync fails for the one file named `bad` and works for the rest; returns a restore function and the stderr taken. */
function failRmFor(t: TestContext, bad: string): { restore: () => void; stderr: string[] } {
  const realRm = fs.rmSync;
  const rm = t.mock.method(fs, 'rmSync', ((p: fs.PathLike, o?: fs.RmOptions) => {
    if (path.basename(String(p)) === bad) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return realRm(p, o);
  }) as typeof fs.rmSync);
  const stderr: string[] = [];
  const err = t.mock.method(process.stderr, 'write', ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return {
    restore: () => {
      rm.mock.restore();
      err.mock.restore();
    },
    stderr,
  };
}

test('a failed delete of one stale trace file is reported on stderr and the sweep removes the other', (t) => {
  const dir = scratch(t);
  const store = new Store(':memory:');
  let now = Date.UTC(2026, 0, 15, 23, 59, 0);
  const tracer = new Tracer(store, { dir, now: () => now, retainDays: 14 });
  tracer.start();
  t.after(() => {
    tracer.stop();
    store.close();
  });
  // Both are kept at the first sweep (exactly at the cutoff), and both are stale once the clock is a day on.
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, '2025-12-31.jsonl'), '{}\n');
  now = Date.UTC(2026, 0, 16, 0, 0, 1);
  const { restore, stderr } = failRmFor(t, '2025-12-31.jsonl');
  let stored: ReturnType<Store['record']> | undefined;
  try {
    assert.doesNotThrow(() => {
      stored = store.record({ type: 'status', message: 'first event of the new day' });
    }, 'record returns');
  } finally {
    restore();
  }
  assert.ok(stored, 'record handed back the event');
  assert.ok(store.eventsSince(0).some((e) => e.message === 'first event of the new day'), 'the event is stored');
  assert.equal(fs.existsSync(path.join(dir, '2026-01-01.jsonl')), false, 'the other stale file is gone');
  assert.equal(fs.existsSync(path.join(dir, '2025-12-31.jsonl')), true, 'the file that could not be removed is still there');
  const lines = stderr.join('').split('\n').filter((l) => l.includes('2025-12-31.jsonl'));
  assert.equal(lines.length, 1, 'one stderr line names the failed file');
  assert.match(lines[0]!, /EACCES/);
  assert.equal(stderr.join('').includes('2026-01-01.jsonl'), false, 'and none names the file that was removed');
});

test('Tracer.start does not throw when deleting a stale trace file fails', (t) => {
  const dir = scratch(t);
  const store = new Store(':memory:');
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
  const tracer = new Tracer(store, { dir, now: () => Date.UTC(2026, 0, 15, 12, 0, 0), retainDays: 14 });
  t.after(() => {
    tracer.stop();
    store.close();
  });
  const { restore, stderr } = failRmFor(t, '2020-01-01.jsonl');
  try {
    assert.doesNotThrow(() => tracer.start());
  } finally {
    restore();
  }
  assert.ok(stderr.join('').includes('2020-01-01.jsonl'), 'the failure is named on stderr');
});

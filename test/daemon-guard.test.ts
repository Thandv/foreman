import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { containProcessErrors, processErrorHandlers, REJECTION_WINDOW_MS } from '../src/daemonGuard.ts';
import { isProtectedPath } from '../src/security/coreGuard.ts';

function rig(opts: { recordThrows?: boolean } = {}) {
  const recorded: string[] = [];
  const written: string[] = [];
  const shutdowns: number[] = [];
  const clock = { t: 1_000_000 };
  const handlers = processErrorHandlers({
    record: (_type, message) => {
      recorded.push(message);
      if (opts.recordThrows) throw new Error('ledger closed');
    },
    shutdown: (code) => void shutdowns.push(code),
    now: () => clock.t,
    write: (line) => void written.push(line),
  });
  return { handlers, recorded, written, shutdowns, clock };
}

const listeners = (name: string): Function[] => (process as NodeJS.EventEmitter).listeners(name);
const OTHERS =['SIGHUP', 'SIGTERM', 'SIGINT', 'exit'] as const;

test('containProcessErrors adds one rejection and one exception listener, touches no signal or exit listener, and uninstall removes both', () => {
  const before = {
    rejection: process.listenerCount('unhandledRejection'),
    exception: process.listenerCount('uncaughtException'),
    others: OTHERS.map(listeners),
  };
  const off = containProcessErrors({ record: () => {}, shutdown: () => {}, now: Date.now, write: () => {} });
  try {
    assert.equal(process.listenerCount('unhandledRejection'), before.rejection + 1);
    assert.equal(process.listenerCount('uncaughtException'), before.exception + 1);
    OTHERS.forEach((s, i) => assert.deepEqual(listeners(s), before.others[i], `${s} listeners unchanged`));
  } finally {
    off();
  }
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection);
  assert.equal(process.listenerCount('uncaughtException'), before.exception);
  OTHERS.forEach((s, i) => assert.deepEqual(listeners(s), before.others[i], `${s} listeners unchanged after uninstall`));
});

test('the same rejection twice in the window is recorded once, the next record carries the suppressed count, and shutdown is never called', () => {
  const r = rig();
  r.handlers.onRejection(new Error('boom'));
  r.clock.t += 1000;
  r.handlers.onRejection(new Error('boom'));
  r.clock.t += 1000;
  r.handlers.onRejection(new Error('boom'));
  assert.deepEqual(r.recorded, ['unhandled rejection: Error: boom']);
  assert.equal(r.written.length, 3, 'every rejection is still written to stderr');
  r.clock.t += REJECTION_WINDOW_MS;
  r.handlers.onRejection(new Error('boom'));
  assert.deepEqual(r.recorded, ['unhandled rejection: Error: boom', 'unhandled rejection: Error: boom (2 more in the last window)']);
  r.handlers.onRejection('another');
  assert.equal(r.recorded.length, 3, 'a different message is its own record');
  assert.deepEqual(r.shutdowns, []);
});

test('a record that throws inside the rejection handler: one stderr line for it, no recursion, no rethrow, and the window still holds', () => {
  const r = rig({ recordThrows: true });
  r.handlers.onRejection(new Error('boom'));
  assert.equal(r.recorded.length, 1);
  assert.equal(r.written.filter((l) => l.startsWith('could not record')).length, 1);
  r.handlers.onRejection(new Error('boom'));
  assert.equal(r.recorded.length, 1, 'the failed attempt counted against the window');
  assert.equal(r.written.filter((l) => l.startsWith('could not record')).length, 1);
  assert.deepEqual(r.shutdowns, []);
});

test('a record that re-enters the rejection handler does not recurse', () => {
  const recorded: string[] = [];
  const h = {} as { onRejection: (r: unknown) => void };
  Object.assign(h, processErrorHandlers({
    record: (_t, m) => {
      recorded.push(m);
      h.onRejection(new Error('from inside record'));
    },
    shutdown: () => {},
    now: () => 5,
    write: () => {},
  }));
  h.onRejection(new Error('outer'));
  assert.deepEqual(recorded, ['unhandled rejection: Error: outer']);
});

test('onException records, then calls shutdown(1) exactly once, even when record throws and when a second exception follows', () => {
  const r = rig({ recordThrows: true });
  r.handlers.onException(new Error('first'));
  r.handlers.onException(new Error('second'));
  assert.deepEqual(r.shutdowns, [1]);
  assert.equal(r.recorded.length, 1, 'the first exception was recorded (and its record threw)');
  const ok = rig();
  ok.handlers.onException(new Error('only'));
  assert.deepEqual(ok.recorded, ['uncaught exception: Error: only']);
  assert.deepEqual(ok.shutdowns, [1]);
});

test('a shutdown that rejects or throws is said on stderr and not rethrown', async () => {
  for (const shutdown of [() => { throw new Error('sync'); }, () => Promise.reject(new Error('async'))]) {
    const written: string[] = [];
    const { onException } = processErrorHandlers({ record: () => {}, shutdown, now: Date.now, write: (l) => void written.push(l) });
    onException(new Error('x'));
    await new Promise((r) => setImmediate(r));
    assert.ok(written.some((l) => l.startsWith('shutdown failed')), written.join('|'));
  }
});

test('src/daemonGuard.ts is a protected path', () => {
  assert.equal(isProtectedPath('src/daemonGuard.ts'), true);
});

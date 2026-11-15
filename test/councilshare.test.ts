import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { Scheduler, withDeadline } from '../src/scheduler.ts';
import { RunClock } from '../src/runClock.ts';

const ollamaInFlight = (b: Broker): number =>
  (b as unknown as { inFlight: Map<string, number> }).inFlight.get('ollama') ?? 0;

/** A broker whose chat settles only when its signal aborts, a turn later, as a real fetch does. */
function hangingBroker(store: Store): Broker {
  return new Broker(store, {
    guardResidency: false,
    fitsFn: async () => true,
    chatFn: (o) =>
      new Promise((_resolve, reject) => {
        o.signal?.addEventListener('abort', () => setImmediate(() => reject(new Error('aborted'))), { once: true });
      }),
  });
}

const waitsOn = (signal: AbortSignal): Promise<never> =>
  new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('stop')), { once: true }));

test('a council that outlives its share is aborted by the time withDeadline returns null', async () => {
  const run = new AbortController();
  let seen: AbortSignal | undefined;
  const out = await withDeadline((signal) => { seen = signal; return waitsOn(signal); }, 1, run.signal);
  assert.equal(out, null);
  assert.equal(seen?.aborted, true);
  assert.equal(run.signal.aborted, false, "the run's own controller is untouched");
});

test('an abandoned council has released its ollama slot before the next stage starts', async () => {
  const store = new Store(':memory:');
  const b = hangingBroker(store);
  const run = new AbortController();
  const out = await withDeadline(
    (signal) => b.call({ taskId: null, runId: null, kind: 'verify', alias: 'local-fast', messages: [{ role: 'user', content: 'r' }], sensitivity: 'S1', signal }),
    1,
    run.signal,
  );
  assert.equal(out, null);
  assert.equal(ollamaInFlight(b), 0);
  assert.equal(run.signal.aborted, false);
});

test("the run's own abort still reaches the council through the share", async () => {
  const run = new AbortController();
  const p = withDeadline((signal) => waitsOn(signal), 60_000, run.signal);
  run.abort();
  await assert.rejects(p, /stop/);
});

test('the shadow council is aborted the same way when its share runs out', async () => {
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'sh', prompt: 'x', runner: 'echo' });
  const r = store.startRun(t.id);
  const run = new AbortController();
  let shadowSignal: AbortSignal | undefined;
  const sched = new Scheduler(store, {
    tickMs: 5,
    verifyEnabled: false,
    verify: (args) => { shadowSignal = args.signal; return waitsOn(args.signal); },
  });
  type Shadow = { recordShadowVerdict(...a: unknown[]): Promise<void> };
  // A blown deadline gives the 1s floor share.
  await (sched as unknown as Shadow).recordShadowVerdict(t, r.id, {}, 'pass', run.signal, () => {}, Date.now() - 1);
  assert.ok(shadowSignal, 'the shadow council was started');
  assert.equal(shadowSignal.aborted, true);
  assert.equal(run.signal.aborted, false);
});

test('a council that ignores the abort still gives the next stage its turn: the settle wait is bounded', { timeout: 10_000 }, async () => {
  const run = new AbortController();
  assert.equal(await withDeadline(() => new Promise<never>(() => {}), 1, run.signal, 20), null);
});

test("the run's council (not just the shadow) gets the share's signal, and the share's expiry aborts it", async () => {
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'c', prompt: 'true', runner: 'shell', maxAttempts: 1 });
  let councilSignal: AbortSignal | undefined;
  const sched = new Scheduler(store, {
    verifyEnabled: true,
    taskTimeoutMs: 60_000,
    // A deadline already past (its expiry never fires) gives the council the 1s floor share.
    runClock: (budget, onExpire) => new RunClock(budget, onExpire, () => Date.now() - 3_600_000, { set: () => null, clear: () => {} }),
    verify: (args) => { councilSignal = args.signal; return waitsOn(args.signal); },
  });
  try {
    await sched.drain(20_000);
    assert.ok(councilSignal, 'the council was started');
    assert.equal(councilSignal.aborted, true);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.ok(store.eventsForTask(t.id).some((e) => /council ran out of its share/.test(e.message)));
  } finally {
    await sched.stop();
    store.close();
  }
});

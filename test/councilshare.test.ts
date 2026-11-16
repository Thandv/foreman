import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { Scheduler, withDeadline } from '../src/scheduler.ts';

const ollamaInFlight = (b: Broker): number =>
  (b as unknown as { inFlight: Map<string, number> }).inFlight.get('ollama') ?? 0;

/** A broker whose chat settles only when its signal aborts. */
function hangingBroker(store: Store): Broker {
  return new Broker(store, {
    guardResidency: false,
    fitsFn: async () => true,
    chatFn: (o) =>
      new Promise((_resolve, reject) => {
        o.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
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

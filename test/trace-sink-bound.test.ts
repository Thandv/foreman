import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scratchDir } from './env.ts';
import { Store } from '../src/queue.ts';
import { Tracer } from '../src/trace.ts';

/** Replace fetch with a sink that never answers: each post stays pending until its signal aborts. */
function hungSink(t: TestContext): { started: () => number; pending: () => number } {
  let started = 0;
  let pending = 0;
  t.mock.method(globalThis, 'fetch', ((_url: unknown, init?: RequestInit) => {
    started++;
    pending++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        pending--;
        reject(init.signal?.reason);
      });
    });
  }) as typeof fetch);
  return { started: () => started, pending: () => pending };
}

function tracerWithSink(t: TestContext, sinkTimeoutMs?: number): { store: Store; tracer: Tracer; dir: string } {
  process.env['FOREMAN_TRACE_SINK'] = 'http://127.0.0.1:1/collect';
  t.after(() => delete process.env['FOREMAN_TRACE_SINK']);
  const dir = scratchDir('foreman-trace-sink-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(':memory:');
  const tracer = new Tracer(store, { dir, ...(sinkTimeoutMs ? { sinkTimeoutMs } : {}) });
  tracer.start();
  t.after(() => {
    tracer.stop();
    store.close();
  });
  return { store, tracer, dir };
}

test('a never-answering sink holds at most 32 posts in flight and the rest are counted as drops', (t) => {
  const sink = hungSink(t);
  const { store, tracer } = tracerWithSink(t);
  for (let i = 0; i < 1000; i++) store.record({ type: 'log', message: `noise ${i}` });
  assert.equal(sink.started(), 32, 'only the cap of posts is started');
  assert.equal(sink.pending(), 32);
  assert.equal(tracer.sinkPending, 32);
  assert.equal(tracer.sinkDrops, 968, 'every post over the cap is dropped, not queued');
});

test('a hung sink is released by the post timeout and posting resumes', async (t) => {
  const sink = hungSink(t);
  const { store, tracer } = tracerWithSink(t, 50);
  for (let i = 0; i < 40; i++) store.record({ type: 'log', message: `noise ${i}` });
  assert.equal(tracer.sinkPending, 32);
  assert.equal(tracer.sinkDrops, 8);
  // Each post's own timeout aborts it; wait on the counter, not on a fixed sleep. The deadline only
  // bounds the failure path, so a broken timeout fails the test instead of spinning its process forever.
  const until = Date.now() + 4000;
  while (tracer.sinkPending > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(tracer.sinkPending, 0, 'the post timeout released every hung post');
  assert.equal(sink.pending(), 0, 'every hung post was aborted');
  store.record({ type: 'log', message: 'after the timeout' });
  assert.equal(tracer.sinkPending, 1, 'a new event is posted once the hung ones are released');
  assert.equal(sink.started(), 33);
  assert.equal(tracer.sinkDrops, 8);
});

test('the JSONL file has every event, byte for byte, whatever the sink drops', (t) => {
  hungSink(t);
  const { store, tracer } = tracerWithSink(t);
  let expected = '';
  const capture = (ev: unknown): void => {
    expected += `${JSON.stringify(ev)}\n`;
  };
  store.on('event', capture);
  t.after(() => store.off('event', capture));
  for (let i = 0; i < 1000; i++) store.record({ type: 'log', message: `noise ${i}` });
  tracer.flush();
  assert.equal(tracer.sinkDrops, 968);
  assert.equal(fs.readFileSync(tracer.path, 'utf8'), expected);
});

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

function tracerWithSink(t: TestContext): { store: Store; tracer: Tracer; dir: string } {
  process.env['FOREMAN_TRACE_SINK'] = 'http://127.0.0.1:1/collect';
  t.after(() => delete process.env['FOREMAN_TRACE_SINK']);
  const dir = scratchDir('foreman-trace-sink-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(':memory:');
  const tracer = new Tracer(store, { dir });
  tracer.start();
  t.after(() => {
    tracer.stop();
    store.close();
  });
  return { store, tracer, dir };
}

test('pin: a never-answering sink gets one pending post per event, without bound', (t) => {
  const sink = hungSink(t);
  const { store } = tracerWithSink(t);
  for (let i = 0; i < 1000; i++) store.record({ type: 'log', message: `noise ${i}` });
  assert.equal(sink.started(), 1000, 'every event starts a post');
  assert.equal(sink.pending(), 1000, 'and every post is still pending');
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';

test('today: a throwing event listener makes record() throw and starves the listeners after it', () => {
  const store = new Store(':memory:');
  try {
    let later = 0;
    store.on('event', () => {
      throw new Error('listener broke');
    });
    store.on('event', () => later++);
    assert.throws(() => store.record({ type: 'status', message: 'x' }), /listener broke/);
    assert.equal(later, 0);
    assert.equal(store.eventsSince(0).length, 1, 'the row was written before the emit');
  } finally {
    store.close();
  }
});

test('a once listener fires exactly once across two record() calls', () => {
  const store = new Store(':memory:');
  try {
    let fired = 0;
    store.once('event', () => fired++);
    store.record({ type: 'status', message: 'a' });
    store.record({ type: 'status', message: 'b' });
    assert.equal(fired, 1);
    assert.equal(store.listenerCount('event'), 0);
  } finally {
    store.close();
  }
});

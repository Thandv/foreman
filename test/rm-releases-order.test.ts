import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { FILED_PREFIX } from '../src/verify/followUpChain.ts';

/** work ticket `w`; follow-ups `f1` (edge to w) and `f2` (edge to w and an ORDER edge to f1). */
function fixture(store: Store) {
  const add = (title: string, over: Partial<Parameters<Store['addTask']>[0]> = {}) =>
    store.addTask({ title, prompt: 'p', runner: 'echo', ...over });
  const w = add('work');
  const f1 = add('f1', { prompt: `${FILED_PREFIX}reviewer: one`, parentId: w.id, deps: [w.id] });
  const f2 = add('f2', { prompt: `${FILED_PREFIX}reviewer: two`, parentId: w.id, deps: [w.id, f1.id] });
  store.setStatus(w.id, 'done');
  return { w, f1, f2 };
}

const drops = (store: Store, id: string) => store.decisionsForTask(id).filter((d) => d.action === 'deps-drop');

test('rm of a ticket later siblings are ordered behind succeeds, and the sibling is queued after reconcile', () => {
  const store = new Store(':memory:');
  const { w, f1, f2 } = fixture(store);
  store.deleteTask(f1.id);
  assert.equal(store.getTask(f1.id), null);
  assert.deepEqual(store.getTask(f2.id)!.deps, [w.id]);
  store.reconcileBlocked();
  assert.equal(store.getTask(f2.id)!.status, 'queued');
  store.close();
});

test('rm releasing an order edge writes one deps-drop decision through dropDependency', () => {
  const store = new Store(':memory:');
  const { f1, f2 } = fixture(store);
  store.deleteTask(f1.id);
  const rows = drops(store, f2.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, 'human');
  assert.ok(rows[0]!.note!.includes(f1.id));
  store.close();
});

test('rm still refuses a ticket with a real (non-order) dependent, changing nothing', () => {
  const store = new Store(':memory:');
  const a = store.addTask({ title: 'a', prompt: 'p' });
  const b = store.addTask({ title: 'b', prompt: 'p', deps: [a.id] });
  assert.throws(() => store.deleteTask(a.id), /depend on it/);
  assert.ok(store.getTask(a.id));
  assert.deepEqual(store.getTask(b.id)!.deps, [a.id]);
  // a follow-up's edge to its own parent is a real dependency too
  const { w } = fixture(store);
  assert.throws(() => store.deleteTask(w.id), /depend on it/);
  assert.equal(drops(store, b.id).length, 0);
  store.close();
});

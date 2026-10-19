import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { relevantFacts } from '../src/assistant/memory.ts';

function scratch(): { store: Store; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-memscope-'));
  const store = new Store(path.join(dir, 'foreman.db'));
  return { store, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const keys = (facts: { key: string }[]): string[] => facts.map((f) => f.key).sort();
const VALUE = 'rejected parser tokeniser rewrite';
const QUERY = 'parser tokeniser rewrite';

test('a repo-A preference never reaches a repo-B brief', () => {
  const { store, done } = scratch();
  store.rememberFact({ scope: '/repoA', key: 'preference:a1', value: VALUE, confidence: 0.9 });
  assert.deepEqual(relevantFacts(store, '/repoB', QUERY), []);
  done();
});

test('a global preference is dropped from a repo task brief', () => {
  const { store, done } = scratch();
  store.rememberFact({ scope: 'global', key: 'preference:g1', value: VALUE, confidence: 0.9 });
  assert.deepEqual(relevantFacts(store, '/repoB', QUERY), []);
  done();
});

test('a matching preference in the same repo is still recalled', () => {
  const { store, done } = scratch();
  store.rememberFact({ scope: '/repoB', key: 'preference:b1', value: VALUE, confidence: 0.9 });
  store.rememberFact({ scope: '/repoA', key: 'preference:a1', value: VALUE, confidence: 0.9 });
  assert.deepEqual(keys(relevantFacts(store, '/repoB', QUERY)), ['preference:b1']);
  done();
});

test('a task with no repo (scope global) still receives matching global facts', () => {
  const { store, done } = scratch();
  store.rememberFact({ scope: 'global', key: 'preference:g1', value: VALUE, confidence: 0.9 });
  store.rememberFact({ scope: '/repoA', key: 'preference:a1', value: VALUE, confidence: 0.9 });
  assert.deepEqual(keys(relevantFacts(store, 'global', QUERY)), ['preference:g1']);
  done();
});

test('a same-repo fact with no term overlap is not returned', () => {
  const { store, done } = scratch();
  store.rememberFact({ scope: '/repoB', key: 'preference:b2', value: 'unrelated words only', confidence: 0.9 });
  assert.deepEqual(relevantFacts(store, '/repoB', QUERY), []);
  done();
});

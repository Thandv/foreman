// Ported from the author's earlier tools (test coverage is new).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('happy path: a document sharing vocabulary with the query scores higher', () => {
  const res = run({
    query: 'bootstrap confidence interval',
    documents: [
      'A moving-block bootstrap resamples whole blocks to build a confidence interval.',
      'The weather today is sunny with a light breeze.',
    ],
    k: 2,
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hits.length, 2);
  assert.equal(out.hits[0].index, 0);
  assert.ok(out.hits[0].score > out.hits[1].score);
  assert.equal(out.hits[1].score, 0); // no shared vocabulary at all
});

test('k truncates the number of hits', () => {
  const res = run({ query: 'alpha', documents: ['alpha', 'alpha beta', 'gamma delta'], k: 1 });
  const out = JSON.parse(res.stdout);
  assert.equal(out.hits.length, 1);
});

test('k defaults to 5', () => {
  const docs = Array.from({ length: 8 }, (_, i) => `document number ${i}`);
  const res = run({ query: 'document', documents: docs });
  const out = JSON.parse(res.stdout);
  assert.equal(out.hits.length, 5);
});

test('deterministic: identical input always produces identical output', () => {
  const input = { query: 'garden tool shed', documents: ['garden tool shed inventory', 'unrelated text here'] };
  const a = run(input);
  const b = run(input);
  assert.equal(a.stdout, b.stdout);
});

test('an exact match scores a perfect (or near-perfect) 1.0 against itself', () => {
  const res = run({ query: 'kelly criterion position sizing', documents: ['kelly criterion position sizing'] });
  const out = JSON.parse(res.stdout);
  assert.ok(Math.abs(out.hits[0].score - 1) < 1e-9);
});

test('rejects malformed input: empty query', () => {
  const res = run({ query: '', documents: ['a'] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: documents not an array of strings', () => {
  const res = run({ query: 'x', documents: [1, 2, 3] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('}}}');
  assert.notEqual(res.status, 0);
});

test('tokenizes letters in any script, not just ASCII', () => {
  const res = run({ query: 'кошка café', documents: ['собака бежит', 'кошка сидит', 'un café noir'], k: 3 });
  assert.equal(res.status, 0, res.stderr);
  const { hits } = JSON.parse(res.stdout);
  assert.ok(hits.find((h) => h.index === 1).score > 0, 'Cyrillic overlap must score above zero');
  assert.ok(hits.find((h) => h.index === 2).score > 0, '"café" must match "café", not just "caf"');
  assert.equal(hits.find((h) => h.index === 0).score, 0);
});

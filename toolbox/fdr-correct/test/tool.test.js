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

test('known worked example matches a hand-computed BH-FDR result', () => {
  const res = run({ pvalues: [0.01, 0.02, 0.03, 0.5, 0.8], alpha: 0.05 });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rejected, [true, true, true, false, false]);
  const expectedQ = [0.05, 0.05, 0.05, 0.625, 0.8];
  for (let i = 0; i < out.qvalues.length; i += 1) {
    assert.ok(Math.abs(out.qvalues[i] - expectedQ[i]) < 1e-9);
  }
});

test('unsorted input is corrected but returned in original order', () => {
  const res = run({ pvalues: [0.8, 0.03, 0.5, 0.01, 0.02], alpha: 0.05 });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rejected, [false, true, false, true, true]);
});

test('alpha defaults to 0.05 when omitted', () => {
  const res = run({ pvalues: [0.001, 0.5] });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rejected.length, 2);
});

test('rejects malformed input: missing pvalues', () => {
  const res = run({ alpha: 0.1 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: p-value out of [0,1]', () => {
  const res = run({ pvalues: [0.1, 1.5] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
});

test('empty pvalues array is rejected', () => {
  const res = run({ pvalues: [] });
  assert.notEqual(res.status, 0);
});

test('rejects a JSON "null" input with the clean object-shape message, not a raw TypeError', () => {
  const res = run('null');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /input must be a JSON object/);
  assert.doesNotMatch(res.stderr, /Cannot read propert/);
});

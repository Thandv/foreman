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

const SERIES = [0.01, -0.02, 0.015, 0.03, -0.01, 0.02, 0.005, 0.012, -0.008, 0.018];

test('happy path: mean statistic returns a sane interval', () => {
  const res = run({ series: SERIES, statistic: 'mean', iterations: 200, seed: 7 });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.level, 0.95);
  assert.ok(out.lo <= out.estimate + 1e-9);
  assert.ok(out.hi >= out.estimate - 1e-9);
  assert.ok(out.se >= 0);
});

test('seeded determinism: same input + seed always produces the same output', () => {
  const a = run({ series: SERIES, statistic: 'sharpe', iterations: 300, seed: 123, blockSize: 3 });
  const b = run({ series: SERIES, statistic: 'sharpe', iterations: 300, seed: 123, blockSize: 3 });
  assert.equal(a.stdout, b.stdout);
});

test('different seeds generally produce different resample paths', () => {
  const a = run({ series: SERIES, statistic: 'median', iterations: 300, seed: 1 });
  const b = run({ series: SERIES, statistic: 'median', iterations: 300, seed: 2 });
  assert.notEqual(a.stdout, b.stdout);
});

test('omitting seed defaults to the fixed constant 42, not real randomness', () => {
  const a = run({ series: SERIES, statistic: 'mean', iterations: 200 });
  const b = run({ series: SERIES, statistic: 'mean', iterations: 200, seed: 42 });
  assert.equal(a.stdout, b.stdout);
});

test('rejects malformed input: bad statistic enum', () => {
  const res = run({ series: SERIES, statistic: 'stddev' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: series too short', () => {
  const res = run({ series: [1], statistic: 'mean' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('{not json');
  assert.notEqual(res.status, 0);
});

test('rejects a JSON "null" input with the clean object-shape message, not a raw TypeError', () => {
  const res = run('null');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /input must be a JSON object/);
  assert.doesNotMatch(res.stderr, /Cannot read propert/);
});

test('a constant float series has a Sharpe-like ratio of exactly 0, not a rounding artefact', () => {
  const res = run({ series: [0.1, 0.1, 0.1], statistic: 'sharpe' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.estimate, 0);
  assert.equal(out.lo, 0);
  assert.equal(out.hi, 0);
});

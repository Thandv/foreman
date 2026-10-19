import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../src/tools/schema.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function call(input) {
  const res = run(input);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function close(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be within ${tol} of ${expected}`);
}

// Source of truth: Wikipedia "Standard deviation" worked example.
// Data [2,4,4,4,5,5,7,9]: mean 5, population variance 4 (population stdev 2).
// Sample (n-1) variance = 32/7, sample stdev = sqrt(32/7).
test('describe: matches the textbook worked example (Wikipedia, Standard deviation)', () => {
  const out = call({ mode: 'describe', series: [2, 4, 4, 4, 5, 5, 7, 9] });
  assert.equal(out.n, 8);
  close(out.mean, 5);
  close(out.stdev, Math.sqrt(32 / 7));
  assert.equal(out.min, 2);
  assert.equal(out.max, 9);
  close(out.median, 4.5);
});

test('describe: quartiles use linear interpolation between order statistics', () => {
  // [1,2,3,4,5,6,7,8,9] (n=9): idx = p*8. q1 idx=2 -> 3; q2 idx=4 -> 5; q3 idx=6 -> 7.
  const out = call({ mode: 'describe', series: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  close(out.quartiles.q1, 3);
  close(out.quartiles.q2, 5);
  close(out.quartiles.q3, 7);
});

test('describe: rejects an empty series', () => {
  const res = run({ mode: 'describe', series: [] });
  assert.notEqual(res.status, 0);
});

// Paired t-test, closed form cross-check: for df=2, the Student's t CDF has
// an elementary closed form (a standard identity, see e.g. Wikipedia
// "Student's t-distribution", table of special cases): F(t) = 1/2 + t/(2*sqrt(2+t^2)).
// Two-tailed p = 1 - |t|/sqrt(2+t^2). This is an independent formula from the
// tool's incomplete-beta implementation, so agreement is a real cross-check.
function closedFormDf2P(t) {
  return 1 - Math.abs(t) / Math.sqrt(2 + t * t);
}

test('ttest: paired, exact zero difference gives t=0, p=1', () => {
  const out = call({ mode: 'ttest', a: [1, 2, 3], b: [2, 2, 2], paired: true });
  // d = [-1, 0, 1] -> mean 0 -> t = 0 exactly, and p at t=0 is exactly 1
  // (regularized incomplete beta I_1(a,b) = 1 for any a,b).
  close(out.t, 0);
  assert.equal(out.df, 2);
  close(out.p, 1);
});

test('ttest: paired, df=2 closed-form cross-check', () => {
  // a-b = [1,2,3] i.e. differences [1,2,3]: mean 2, sample variance 1, stdev 1.
  const out = call({ mode: 'ttest', a: [5, 7, 9], b: [4, 5, 6], paired: true });
  const expectedT = 2 / (1 / Math.sqrt(3));
  close(out.t, expectedT, 1e-9);
  assert.equal(out.df, 2);
  close(out.p, closedFormDf2P(expectedT), 1e-9);
});

test('ttest: independent samples (Welch), df=2 closed-form cross-check', () => {
  // a=[1,3] mean=2 var=2; b=[10,12] mean=11 var=2; equal n and var -> df collapses to 2.
  const out = call({ mode: 'ttest', a: [1, 3], b: [10, 12] });
  const expectedT = (2 - 11) / Math.sqrt(2 / 2 + 2 / 2); // -9/sqrt(2)
  close(out.t, expectedT, 1e-9);
  close(out.df, 2, 1e-9);
  close(out.p, closedFormDf2P(expectedT), 1e-9);
});

test('ttest: rejects mismatched lengths for a paired test', () => {
  const res = run({ mode: 'ttest', a: [1, 2, 3], b: [1, 2], paired: true });
  assert.notEqual(res.status, 0);
});

// Regression: hand-computed OLS on x=[1,2,3,4], y=[2,4,5,4].
// xmean=2.5, ymean=3.75, Sxy=3.5, Sxx=5 -> slope=0.7, intercept=2.0,
// SSres=2.3, SStot=4.75 -> r2 = 1-2.3/4.75 = 49/95.
test('regression: hand-computed OLS fit', () => {
  const out = call({ mode: 'regression', x: [1, 2, 3, 4], y: [2, 4, 5, 4] });
  close(out.slope, 0.7);
  close(out.intercept, 2.0);
  close(out.r2, 49 / 95);
  close(out.stderr, Math.sqrt(2.3 / 2) / Math.sqrt(5));
});

test('regression: perfect linear fit has r2=1 and stderr=0', () => {
  const out = call({ mode: 'regression', x: [1, 2, 3, 4], y: [3, 5, 7, 9] }); // y = 2x+1
  close(out.slope, 2);
  close(out.intercept, 1);
  close(out.r2, 1);
  close(out.stderr, 0);
});

// Correlation: same x,y as the regression example above. For simple linear
// regression, r^2 (correlation) equals r2 (regression) and r's sign matches
// the slope's sign — an internal cross-check between two independently
// computed formulas (Sxy/sqrt(Sxx*Syy) vs the regression SS decomposition).
test('correlation: pearson r matches sqrt(r2) from the regression example', () => {
  const out = call({ mode: 'correlation', a: [1, 2, 3, 4], b: [2, 4, 5, 4], method: 'pearson' });
  close(out.r, Math.sqrt(49 / 95));
});

// Spearman: a=[1,2,3,4,5] ranks 1..5; b=[2,1,4,3,5] ranks [2,1,4,3,5], no
// ties, so the elementary formula rho = 1 - 6*sum(d^2)/(n(n^2-1)) applies
// exactly (Wikipedia "Spearman's rank correlation coefficient").
// d = [-1,1,-1,1,0], sum(d^2) = 4 -> rho = 1 - 24/120 = 0.8.
test('correlation: spearman matches the elementary no-ties formula', () => {
  const out = call({ mode: 'correlation', a: [1, 2, 3, 4, 5], b: [2, 1, 4, 3, 5], method: 'spearman' });
  close(out.r, 0.8);
});

test('correlation: rejects mismatched lengths', () => {
  const res = run({ mode: 'correlation', a: [1, 2, 3], b: [1, 2] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: bad mode', () => {
  const res = run({ mode: 'nope' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
});

test('rejects a JSON "null" input with a clean message, not a raw TypeError', () => {
  const res = run('null');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /input must be a JSON object/);
  assert.doesNotMatch(res.stderr, /Cannot read propert/);
});

// --- degenerate inputs: NaN/Infinity must never leak out as bare `null`
// without explanation. JSON.stringify silently turns both into `null`, so
// every one of these previously produced a schema-violating output (the
// runner's output validator requires "number", got "null") and would
// eventually self-quarantine the tool after 3 strikes. The fix widens the
// affected output fields to accept null and requires a "notes" entry
// explaining why. Each case here asserts the RAW output validates against
// the tool's own manifest output schema (src/tools/schema.ts's validate()),
// not just that the field "looks" null.

test('describe: a single-element series has an undefined stdev (null + note), and the output still validates', () => {
  const out = call({ mode: 'describe', series: [42] });
  assert.equal(out.stdev, null);
  assert.ok(out.notes.some((n) => /stdev undefined for n<2/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('regression: exactly 2 points has an undefined stderr (null + note), and the output still validates', () => {
  const out = call({ mode: 'regression', x: [1, 2], y: [3, 5] });
  assert.equal(out.stderr, null);
  assert.equal(out.slope, 2);
  assert.ok(out.notes.some((n) => /stderr undefined for n<3/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('regression: constant x (zero variance) has undefined slope/intercept/r2/stderr, and the output still validates', () => {
  const out = call({ mode: 'regression', x: [5, 5, 5], y: [1, 2, 3] });
  assert.equal(out.slope, null);
  assert.equal(out.intercept, null);
  assert.equal(out.r2, null);
  assert.equal(out.stderr, null);
  assert.ok(out.notes.some((n) => /x has zero variance/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('correlation: a constant series has an undefined r/p (null + note), and the output still validates', () => {
  const out = call({ mode: 'correlation', a: [7, 7, 7, 7], b: [1, 2, 3, 4] });
  assert.equal(out.r, null);
  assert.equal(out.p, null);
  assert.ok(out.notes.some((n) => /zero variance/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('ttest: zero-variance groups with equal means gives an undefined t/df/p (null + note), and the output still validates', () => {
  const out = call({ mode: 'ttest', a: [3, 3, 3], b: [3, 3, 3] });
  assert.equal(out.t, null);
  assert.equal(out.df, null);
  assert.equal(out.p, null);
  assert.ok(out.notes.some((n) => /zero variance/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('ttest: zero-variance groups with different means (perfect separation) gives an undefined t, and the output still validates', () => {
  const out = call({ mode: 'ttest', a: [3, 3, 3], b: [5, 5, 5] });
  assert.equal(out.t, null);
  assert.ok(out.notes.length > 0, `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('ttest: paired, zero-variance differences with a nonzero mean gives an undefined t, and the output still validates', () => {
  const out = call({ mode: 'ttest', a: [5, 6, 7], b: [1, 2, 3], paired: true });
  assert.equal(out.t, null);
  assert.ok(out.notes.some((n) => /unbounded t/.test(n)), `notes: ${JSON.stringify(out.notes)}`);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

test('every normal (non-degenerate) result also validates and carries an empty notes array', () => {
  const out = call({ mode: 'describe', series: [2, 4, 4, 4, 5, 5, 7, 9] });
  assert.deepEqual(out.notes, []);
  assert.deepEqual(validate(out, MANIFEST.output), []);
});

// A constant series of non-representable decimals (three 0.1s) sums to
// 0.30000000000000004, so a naive mean is 0.10000000000000002 and leaves a
// ~1e-17 spread that used to surface as skewness -1, a nonzero stdev, a
// 5.8e16 regression stderr, r=0/p=1 instead of "undefined", and a t of ~4.5e15.
test('constant float series are treated as exactly constant in every mode', () => {
  const d = call({ mode: 'describe', series: [0.1, 0.1, 0.1] });
  assert.equal(d.mean, 0.1);
  assert.equal(d.stdev, 0);
  assert.equal(d.skewness, 0);

  const c = call({ mode: 'correlation', a: [0.1, 0.1, 0.1], b: [1, 2, 3] });
  assert.equal(c.r, null);
  assert.equal(c.p, null);

  const r = call({ mode: 'regression', x: [0.1, 0.1, 0.1], y: [1, 2, 3] });
  assert.equal(r.slope, null);
  assert.equal(r.stderr, null);

  const t = call({ mode: 'ttest', a: [0.1, 0.1, 0.1], b: [0.2, 0.2, 0.2] });
  assert.equal(t.t, null);
  assert.equal(t.p, null);
});

test('correlation: r is clamped to [-1, 1] when rounding overshoots a perfect fit', () => {
  const out = call({ mode: 'correlation', a: [0.1, 0.2, 0.3, 0.4, 0.7], b: [0.3, 0.6, 0.9, 1.2, 2.1] });
  assert.equal(out.r, 1);
  assert.equal(out.p, 0);
  const neg = call({ mode: 'correlation', a: [0.1, 0.2, 0.3, 0.4, 0.7], b: [-0.3, -0.6, -0.9, -1.2, -2.1] });
  assert.ok(neg.r >= -1 && neg.r <= -0.999999);
});

#!/usr/bin/env node
// Ported from the author's earlier tools.
//
// Moving-block bootstrap confidence interval for a statistic (mean, median,
// or Sharpe-like mean/stdev ratio) computed on a possibly-autocorrelated
// series. Resampling whole contiguous blocks (rather than single points)
// preserves short-range dependence, so the interval reflects the real
// sampling variability of the estimator instead of understating it the way
// an IID bootstrap would on serially-correlated data (e.g. daily returns).
//
// Determinism: randomness comes from a seeded mulberry32 PRNG (a small,
// public-domain 32-bit generator), not Math.random() or Node's crypto. The
// same {series, statistic, blockSize, iterations, level, seed} always
// produces byte-identical output, in this process or any other — that's
// what makes the tool's own tests (and any caller relying on it) reproducible.
// Omitting `seed` uses a fixed default (42), not real randomness, so the
// tool never becomes non-deterministic by accident.
//
// stdin: { series: number[], statistic: "mean"|"median"|"sharpe",
//          blockSize?: number, iterations?: number, level?: number, seed?: number }
// stdout: { estimate, lo, hi, se, level }
'use strict';

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** mulberry32: tiny, fast, seeded 32-bit PRNG. Public domain. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arithmetic mean; a constant series returns its value exactly, so rounding
 * in the sum can't fake a nonzero stdev (three 0.1s used to give a
 * "Sharpe" of ~5.9e15 instead of 0). */
function mean(xs) {
  if (xs.every((x) => x === xs[0])) return xs[0];
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdevSample(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

function sharpeLike(xs) {
  const sd = stdevSample(xs);
  if (sd === 0) return 0;
  return mean(xs) / sd;
}

const STATISTICS = { mean, median, sharpe: sharpeLike };

/** Resample `x` by concatenating random contiguous blocks of length `block`,
 * then truncating back to the original length. */
function movingBlockResample(x, block, rand) {
  const n = x.length;
  const nBlocks = Math.ceil(n / block);
  const out = [];
  for (let b = 0; b < nBlocks; b += 1) {
    const start = Math.floor(rand() * (n - block + 1));
    for (let k = 0; k < block; k += 1) out.push(x[start + k]);
  }
  return out.slice(0, n);
}

/** Linear-interpolation percentile, matching numpy's default. */
function percentile(sortedValues, p) {
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

function blockBootstrapCi(x, statFn, { iterations, blockSize, level, seed }) {
  const rand = mulberry32(seed);
  const block = Math.max(2, Math.min(x.length, blockSize));
  const estimate = statFn(x);
  const vals = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    vals[i] = statFn(movingBlockResample(x, block, rand));
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const a = (1 - level) / 2;
  const lo = percentile(sorted, 100 * a);
  const hi = percentile(sorted, 100 * (1 - a));
  return { estimate, lo, hi, se: stdevSample(vals), level };
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const series = args.series;
  if (!Array.isArray(series) || series.length < 2) {
    return fail('series must be an array of at least 2 numbers');
  }
  for (const v of series) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return fail(`series must contain only finite numbers; got ${JSON.stringify(v)}`);
    }
  }
  const statistic = args.statistic;
  if (!Object.prototype.hasOwnProperty.call(STATISTICS, statistic)) {
    return fail(`statistic must be one of: ${Object.keys(STATISTICS).join(', ')}`);
  }
  const iterations = args.iterations === undefined ? 1000 : args.iterations;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) {
    return fail('iterations must be an integer in [1, 100000]');
  }
  const level = args.level === undefined ? 0.95 : args.level;
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0 || level >= 1) {
    return fail('level must be a finite number in (0, 1)');
  }
  const defaultBlock = Math.max(2, Math.round(0.05 * series.length));
  const blockSize = args.blockSize === undefined ? defaultBlock : args.blockSize;
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    return fail('blockSize must be a positive integer');
  }
  const seed = args.seed === undefined ? 42 : args.seed;
  if (!Number.isInteger(seed)) {
    return fail('seed must be an integer');
  }

  const result = blockBootstrapCi(series, STATISTICS[statistic], { iterations, blockSize, level, seed });
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

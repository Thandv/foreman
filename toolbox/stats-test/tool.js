#!/usr/bin/env node
// Inspired by simple-statistics (ISC); reimplemented from the underlying
// formulas (Wikipedia's "Standard deviation", "Skewness", "Student's
// t-test", "Simple linear regression", "Pearson correlation coefficient"
// and "Spearman's rank correlation coefficient" articles), not from its
// source.
//
// The t-distribution CDF needed for two-tailed p-values is computed via the
// regularized incomplete beta function I_x(a,b), using the standard
// continued-fraction algorithm (Lentz's method, as published in Numerical
// Recipes and widely reused under that name) together with a Lanczos
// approximation of log-gamma. This is a well known, general-purpose
// numerical method — not vendored from any specific library — implemented
// here from its published mathematical description. Accuracy: the
// continued fraction is iterated to a relative tolerance of 3e-14 (its
// documented convergence criterion), so the resulting p-values are accurate
// to double-precision (~1e-12 or better) for the df/t ranges this tool is
// meant for; it is not a fast closed-form approximation.
//
// stdin:
//   { mode: "describe", series }
//     -> { n, mean, median, stdev, min, max, quartiles: {q1,q2,q3}, skewness }
//   { mode: "ttest", a, b, paired? }
//     -> { t, df, p }
//   { mode: "regression", x, y }
//     -> { slope, intercept, r2, stderr }
//   { mode: "correlation", a, b, method?: "pearson"|"spearman" }
//     -> { r, p }
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

function isNumberArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

// --- basic moments ---------------------------------------------------------

/**
 * Arithmetic mean. A constant series returns its value exactly: summing
 * then dividing would round (e.g. three 0.1s average to 0.10000000000000002),
 * leaving a tiny nonzero spread that every downstream variance, skewness,
 * t-statistic and correlation would then treat as real signal.
 */
function mean(xs) {
  if (xs.every((x) => x === xs[0])) return xs[0];
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample variance (Bessel-corrected, ddof=1); NaN for n<2 (undefined). */
function sampleVariance(xs, m = mean(xs)) {
  if (xs.length < 2) return NaN;
  const ss = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  return ss / (xs.length - 1);
}

function populationVariance(xs, m = mean(xs)) {
  const ss = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  return ss / xs.length;
}

/** Linear-interpolation ("R-7" / numpy default) percentile of a value already sorted ascending. */
function percentileSorted(sorted, p) {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] + weight * (sorted[hi] - sorted[lo]);
}

function describe(series) {
  const notes = [];
  const n = series.length;
  const sorted = [...series].sort((a, b) => a - b);
  const m = mean(series);
  let stdev;
  if (n < 2) {
    stdev = null;
    notes.push('stdev undefined for n<2 (sample standard deviation needs at least 2 observations)');
  } else {
    stdev = Math.sqrt(sampleVariance(series, m));
  }
  const popStdev = Math.sqrt(populationVariance(series, m));
  // Fisher-Pearson moment coefficient of skewness (g1): third standardised moment.
  // Guarded at popStdev===0 (constant series) so this is 0, never NaN.
  const skewness = popStdev === 0 ? 0 : series.reduce((s, x) => s + (x - m) ** 3, 0) / n / popStdev ** 3;
  return {
    n,
    mean: m,
    median: percentileSorted(sorted, 0.5),
    stdev,
    min: sorted[0],
    max: sorted[n - 1],
    quartiles: { q1: percentileSorted(sorted, 0.25), q2: percentileSorted(sorted, 0.5), q3: percentileSorted(sorted, 0.75) },
    skewness,
    notes,
  };
}

// --- incomplete beta / t-distribution CDF ---------------------------------

const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS_COEF[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i += 1) a += LANCZOS_COEF[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction evaluation used inside the incomplete beta function (Lentz's method). */
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a,b). */
function regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(logBt);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed P(|T| > |t|) for a Student's t distribution with `df` degrees of freedom. */
function tTwoTailedP(t, df) {
  if (!Number.isFinite(t)) return 0;
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(df / 2, 0.5, x);
}

// --- t-tests ---------------------------------------------------------------

/** Welch's t-test (unequal variances, unequal n). */
function welchTTest(a, b) {
  const notes = [];
  const na = a.length;
  const nb = b.length;
  const ma = mean(a);
  const mb = mean(b);
  const va = sampleVariance(a, ma);
  const vb = sampleVariance(b, mb);
  const seA = va / na;
  const seB = vb / nb;
  let t = null;
  let df = null;
  if (seA + seB === 0) {
    // Both samples have zero variance: the standard error is 0, so t (and
    // the df formula, which divides by the same quantity) is 0/0 or an
    // unbounded ratio — neither is a finite, JSON-representable number.
    notes.push('t and df undefined: both samples have zero variance (division by zero in the standard error)');
  } else {
    const tRaw = (ma - mb) / Math.sqrt(seA + seB);
    const dfRaw = (seA + seB) ** 2 / (seA ** 2 / (na - 1) + seB ** 2 / (nb - 1));
    t = Number.isFinite(tRaw) ? tRaw : null;
    df = Number.isFinite(dfRaw) ? dfRaw : null;
    if (t === null) notes.push('t undefined: not a finite number for this input');
    if (df === null) notes.push('df undefined: not a finite number for this input');
  }
  const p = t === null || df === null ? null : tTwoTailedP(t, df);
  return { t, df, p, notes };
}

/** Paired t-test on the a-b differences. */
function pairedTTest(a, b) {
  const notes = [];
  const n = a.length;
  const d = a.map((v, i) => v - b[i]);
  const md = mean(d);
  const sd = Math.sqrt(sampleVariance(d, md));
  const df = n - 1;
  let t;
  if (sd === 0) {
    t = null;
    notes.push(
      md === 0
        ? 't undefined: differences have zero variance and zero mean (division by zero, 0/0)'
        : 't undefined: differences have zero variance with a nonzero mean (unbounded t, perfect separation)',
    );
  } else {
    t = md / (sd / Math.sqrt(n));
  }
  const p = t === null ? null : tTwoTailedP(t, df);
  return { t, df, p, notes };
}

// --- regression --------------------------------------------------------

function regression(x, y) {
  const notes = [];
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  if (sxx === 0) {
    // x is constant: no line y = slope*x + intercept can be fit (the
    // formula divides by sxx, which would be 0/0 or an unbounded ratio).
    notes.push('slope/intercept/r2/stderr undefined: x has zero variance (all x values equal), no line can be fit');
    return { slope: null, intercept: null, r2: null, stderr: null, notes };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = intercept + slope * x[i];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  let stderr;
  if (n > 2) {
    stderr = Math.sqrt(ssRes / (n - 2)) / Math.sqrt(sxx);
  } else {
    stderr = null;
    notes.push('stderr undefined for n<3 (zero residual degrees of freedom)');
  }
  return { slope, intercept, r2, stderr, notes };
}

// --- correlation -------------------------------------------------------

function pearsonR(a, b) {
  const n = a.length;
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const r = sab / Math.sqrt(saa * sbb);
  // Rounding can push a perfect correlation a hair past +/-1; clamp it back.
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : r;
}

/** Average ranks (1-based), tied values get the mean of the ranks they span. */
function ranks(xs) {
  const idx = xs.map((v, i) => i).sort((i, j) => xs[i] - xs[j]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j += 1;
    const avgRank = (i + j) / 2 + 1; // 1-based average of ranks i+1..j+1
    for (let k = i; k <= j; k += 1) r[idx[k]] = avgRank;
    i = j + 1;
  }
  return r;
}

function correlation(a, b, method) {
  const notes = [];
  const n = a.length;
  const r = method === 'spearman' ? pearsonR(ranks(a), ranks(b)) : pearsonR(a, b);
  if (!Number.isFinite(r)) {
    // Zero-variance series (constant values) make Pearson's r a 0/0 ratio.
    notes.push('r and p undefined: a series has zero variance (constant values), correlation is undefined');
    return { r: null, p: null, notes };
  }
  const df = n - 2;
  let p;
  if (df <= 0) {
    p = null;
    notes.push('p undefined: fewer than 3 points (zero degrees of freedom) for the correlation significance test');
  } else if (Math.abs(r) >= 1) {
    p = 0;
  } else {
    const t = (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
    p = tTwoTailedP(t, df);
  }
  return { r, p, notes };
}

// --- main --------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const mode = args.mode;

  if (mode === 'describe') {
    if (!isNumberArray(args.series)) return fail('series must be a non-empty array of finite numbers');
    process.stdout.write(JSON.stringify(describe(args.series)));
    return;
  }

  if (mode === 'ttest') {
    if (!isNumberArray(args.a) || !isNumberArray(args.b)) return fail('a and b must be non-empty arrays of finite numbers');
    if (args.a.length < 2 || args.b.length < 2) return fail('a and b need at least 2 observations each');
    const paired = Boolean(args.paired);
    if (paired && args.a.length !== args.b.length) return fail('a and b must be the same length for a paired t-test');
    const result = paired ? pairedTTest(args.a, args.b) : welchTTest(args.a, args.b);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (mode === 'regression') {
    if (!isNumberArray(args.x) || !isNumberArray(args.y)) return fail('x and y must be non-empty arrays of finite numbers');
    if (args.x.length !== args.y.length) return fail('x and y must be the same length');
    if (args.x.length < 2) return fail('regression needs at least 2 points');
    process.stdout.write(JSON.stringify(regression(args.x, args.y)));
    return;
  }

  if (mode === 'correlation') {
    if (!isNumberArray(args.a) || !isNumberArray(args.b)) return fail('a and b must be non-empty arrays of finite numbers');
    if (args.a.length !== args.b.length) return fail('a and b must be the same length');
    if (args.a.length < 2) return fail('correlation needs at least 2 points');
    const method = args.method === undefined ? 'pearson' : args.method;
    if (method !== 'pearson' && method !== 'spearman') return fail('method must be "pearson" or "spearman"');
    process.stdout.write(JSON.stringify(correlation(args.a, args.b, method)));
    return;
  }

  return fail('mode must be one of "describe", "ttest", "regression", "correlation"');
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

#!/usr/bin/env node
// Ported from the author's earlier tools.
//
// Benjamini-Hochberg false-discovery-rate control. Given a set of raw
// p-values from many simultaneous hypothesis tests, returns which ones
// survive FDR correction at level `alpha`, plus each test's q-value
// (the smallest FDR at which that test would be rejected).
//
// stdin: { pvalues: number[], alpha?: number }
// stdout: { rejected: boolean[], qvalues: number[] }
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

/** Index order that would sort `values` ascending (stable). */
function argsort(values) {
  return values
    .map((v, i) => i)
    .sort((i, j) => (values[i] - values[j]) || (i - j));
}

/**
 * Benjamini-Hochberg step-up procedure.
 *
 * 1. Sort p-values ascending.
 * 2. q_i = p_i * m / rank_i  (rank is 1-based).
 * 3. Enforce monotonicity by taking a running minimum from the largest
 *    rank down to the smallest (numpy's `minimum.accumulate` on the
 *    reversed array — hand-rolled here as a right-to-left scan).
 * 4. Clip to [0, 1].
 * 5. A test is rejected where its (monotone) q-value <= alpha.
 * 6. Unsort back to the caller's original order.
 */
function benjaminiHochberg(pvalues, alpha) {
  const m = pvalues.length;
  if (m === 0) return { rejected: [], qvalues: [] };

  const order = argsort(pvalues);
  const ranked = order.map((i) => pvalues[i]);
  const q = ranked.map((p, idx) => (p * m) / (idx + 1));

  // Running minimum from the right (min-accumulate on the reversed array).
  for (let i = q.length - 2; i >= 0; i -= 1) {
    if (q[i + 1] < q[i]) q[i] = q[i + 1];
  }
  for (let i = 0; i < q.length; i += 1) {
    q[i] = Math.min(1, Math.max(0, q[i]));
  }

  const qvalues = new Array(m);
  const rejected = new Array(m);
  order.forEach((originalIndex, idx) => {
    qvalues[originalIndex] = q[idx];
    rejected[originalIndex] = q[idx] <= alpha;
  });
  return { rejected, qvalues };
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

  const pvalues = args.pvalues;
  if (!Array.isArray(pvalues) || pvalues.length === 0) {
    return fail('pvalues must be a non-empty array of numbers');
  }
  for (const p of pvalues) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      return fail(`each pvalue must be a finite number in [0, 1]; got ${JSON.stringify(p)}`);
    }
  }
  const alpha = args.alpha === undefined ? 0.05 : args.alpha;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    return fail('alpha must be a finite number in (0, 1]');
  }

  const result = benjaminiHochberg(pvalues, alpha);
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

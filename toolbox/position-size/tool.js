#!/usr/bin/env node
// Ported from the author's earlier tools.
//
// DESCRIPTIVE ANALYSIS ONLY. Computes position-size MULTIPLIERS from
// statistics you provide (win rate, average win/loss, volatility, a risk-off
// score). It does not look at live market data, does not place an order,
// and does not tell you what to buy — it is a sizing calculator for a
// position you are already considering, meant to be combined with your own
// hard risk caps. Not financial advice.
//
// The original module gated everything behind an `enabled` config flag that
// made sense inside a long-running service (a hard off-switch). This standalone
// tool drops that flag — a caller invoking it has already opted in — but
// keeps every other behaviour: the fractional-Kelly clamp, the min-samples
// no-op, the volatility-targeting clamp, and the asymmetric risk-off ramp.
//
// stdin: {
//   winRate, avgWin, avgLoss, samples,
//   annualizedVol?, targetVol?, riskOffScore?,
//   config?: { fraction?, targetKelly?, minMult?, maxMult?, minSamples?,
//              volMinMult?, volMaxMult?, keepFullBelow?, floorMult?,
//              aggressiveness?, calmBoost? }
// }
// stdout: { kellyF, kellyMult, volMult, riskOffMult, combined }
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

const DEFAULTS = {
  fraction: 0.5,
  targetKelly: 0.1,
  minMult: 0.3,
  maxMult: 2.0,
  minSamples: 20,
  volMinMult: 0.3,
  volMaxMult: 1.2,
  keepFullBelow: 0.25,
  floorMult: 0.0,
  aggressiveness: 2.0,
  calmBoost: 1.0,
};

/** f* = p - (1-p)/R, R = avgWin/avgLoss (positive magnitudes). Negative => no edge. */
function kellyFraction(p, avgWin, avgLoss) {
  if (avgWin <= 0) return -1;
  const R = avgWin / Math.max(avgLoss, 1e-9);
  if (R <= 0) return -1;
  return p - (1 - p) / R;
}

/** Size multiplier in [minMult, maxMult]. 1.0x with too few samples (no-op
 * until a strategy proves itself). */
function kellyMultiplier(kellyF, samples, cfg) {
  if (samples < cfg.minSamples) return 1.0;
  const fUsed = Math.max(0, kellyF) * cfg.fraction;
  const mult = cfg.targetKelly > 0 ? fUsed / cfg.targetKelly : 1.0;
  return Math.max(cfg.minMult, Math.min(cfg.maxMult, mult));
}

/** target/recent, clamped. Down-weights turbulent names. 1.0x when unknown/off. */
function volMultiplier(annualizedVol, targetVol, cfg) {
  const target = targetVol || 0;
  if (target <= 0 || !annualizedVol || annualizedVol <= 0) return 1.0;
  return Math.max(cfg.volMinMult, Math.min(cfg.volMaxMult, target / annualizedVol));
}

/** Asymmetric de-risk ramp off a risk_off score in [0,1]:
 *   score <= keepFullBelow -> 1.0x (stay fully invested)
 *   above the gate         -> ramp down to floorMult, steepened by aggressiveness
 *   score == 1.0            -> floorMult
 * Two-sided when calmBoost > 1: in the all-clear zone it levers up to
 * calmBoost, ramping back to 1.0x at the gate. 1.0x when score is unknown
 * (fail-safe: a data hiccup never de-risks or blocks trading by accident). */
function riskOffMultiplier(score, cfg) {
  if (score === null || score === undefined) return 1.0;
  const s = Math.max(0, Math.min(1, score));
  const gate = cfg.keepFullBelow;
  const floor = cfg.floorMult;
  const agg = Math.max(1e-6, cfg.aggressiveness);
  const boost = Math.max(1.0, cfg.calmBoost);
  if (gate >= 1.0) return boost;
  if (s <= gate) {
    if (gate > 0) return boost + (1.0 - boost) * (s / gate);
    return s <= 0 ? boost : 1.0;
  }
  let x = (s - gate) / (1.0 - gate);
  x **= 1.0 / agg;
  return Math.max(floor, 1.0 - x * (1.0 - floor));
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
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

  const { winRate, avgWin, avgLoss, samples } = args;
  if (typeof winRate !== 'number' || !Number.isFinite(winRate) || winRate < 0 || winRate > 1) {
    return fail('winRate must be a finite number in [0, 1]');
  }
  if (typeof avgWin !== 'number' || !Number.isFinite(avgWin)) return fail('avgWin must be a finite number');
  if (typeof avgLoss !== 'number' || !Number.isFinite(avgLoss)) return fail('avgLoss must be a finite number');
  // A signed loss (-0.015) would be floored to 1e-9 inside kellyFraction,
  // making every strategy look loss-free and sizing it at maxMult. Refuse it.
  if (avgLoss < 0) return fail(`avgLoss must be a non-negative magnitude (e.g. 0.015, not -0.015); got ${avgLoss}`);
  if (!Number.isInteger(samples) || samples < 0) return fail('samples must be a non-negative integer');

  const rawCfg = args.config && typeof args.config === 'object' ? args.config : {};
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (rawCfg[key] !== undefined) {
      if (typeof rawCfg[key] !== 'number' || !Number.isFinite(rawCfg[key])) {
        return fail(`config.${key} must be a finite number`);
      }
      cfg[key] = rawCfg[key];
    }
  }

  const annualizedVol = args.annualizedVol === undefined ? null : numOr(args.annualizedVol, null);
  const targetVol = args.targetVol === undefined ? 0 : numOr(args.targetVol, 0);
  const riskOffScore = args.riskOffScore === undefined ? null : numOr(args.riskOffScore, null);
  if (args.annualizedVol !== undefined && annualizedVol === null) return fail('annualizedVol must be a finite number');
  if (args.targetVol !== undefined && !(typeof args.targetVol === 'number' && Number.isFinite(args.targetVol))) {
    return fail('targetVol must be a finite number');
  }
  if (args.riskOffScore !== undefined) {
    if (typeof args.riskOffScore !== 'number' || !Number.isFinite(args.riskOffScore) || args.riskOffScore < 0 || args.riskOffScore > 1) {
      return fail('riskOffScore must be a finite number in [0, 1]');
    }
  }

  const kellyF = kellyFraction(winRate, avgWin, avgLoss);
  const kellyMult = kellyMultiplier(kellyF, samples, cfg);
  const volMult = volMultiplier(annualizedVol, targetVol, cfg);
  const riskOffMult = riskOffMultiplier(riskOffScore, cfg);
  const combined = kellyMult * volMult * riskOffMult;

  process.stdout.write(JSON.stringify({ kellyF, kellyMult, volMult, riskOffMult, combined }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

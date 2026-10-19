#!/usr/bin/env node
// Ported from the author's earlier tools (returns_from_prices,
// annualised_volatility, sharpe_ratio, sortino_ratio, max_drawdown,
// portfolio_metrics, correlation_matrix, and a backtest's summarize and
// _metrics).
//
// DESCRIPTIVE ANALYSIS ONLY. This tool computes numbers from data the
// caller provides (prices, returns, or recorded trades). It does not look
// at live market data, does not predict prices, does not recommend
// positions, and never places an order. Not financial advice.
//
// stdin: {
//   prices?: number[], returns?: number[], returnsByAsset?: {[name]: number[]},
//   trades?: [{strategy, pnlPct}], riskFreeRate?: number, periodsPerYear?: number
// }
// stdout: whichever of the metrics below the input allows, named clearly.
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

function isFiniteNumberArray(a) {
  return Array.isArray(a) && a.every((v) => typeof v === 'number' && Number.isFinite(v));
}

// --- returns --------------------------------------------------------------

/** returns[i] = prices[i+1] / prices[i] - 1. Throws on a non-positive price. */
function returnsFromPrices(prices) {
  if (prices.length < 2) return [];
  const out = [];
  for (let i = 0; i < prices.length - 1; i += 1) {
    const prev = prices[i];
    const curr = prices[i + 1];
    if (prev <= 0) throw new Error(`non-positive price in series: ${prev}`);
    if (curr < 0) throw new Error(`negative price in series: ${curr}`);
    out.push(curr / prev - 1);
  }
  return out;
}

// --- risk metrics -----------------------------------------------------------

/** Arithmetic mean; a constant series returns its value exactly, so rounding
 * in the sum can't fake a nonzero spread (and a ~1e17 Sharpe ratio). */
function mean(xs) {
  if (xs.every((x) => x === xs[0])) return xs[0];
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdevSample(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

/** Sample stdev of returns, annualised by sqrt(periodsPerYear). 0 for <2 obs. */
function annualisedVolatility(returns, periodsPerYear) {
  if (returns.length < 2) return 0;
  return stdevSample(returns) * Math.sqrt(periodsPerYear);
}

/** Annualised Sharpe. Returns null (undefined) for fewer than 2 observations. */
function sharpeRatio(returns, rf, periodsPerYear) {
  if (returns.length < 2) return null;
  const rfPerPeriod = rf / periodsPerYear;
  const sd = stdevSample(returns);
  if (sd === 0) return 0;
  const excess = mean(returns) - rfPerPeriod;
  return (excess / sd) * Math.sqrt(periodsPerYear);
}

/** Annualised Sortino. null when undefined (fewer than 2 observations);
 * +Infinity/-Infinity is not valid JSON, so an unbounded result is reported
 * as null with a note instead of silently clamped. */
function sortinoRatio(returns, rf, target, periodsPerYear, notes) {
  if (returns.length < 2) return null;
  const rfPerPeriod = rf / periodsPerYear;
  const excess = mean(returns) - rfPerPeriod;
  const downsideSquared = returns.map((r) => Math.min(r - target, 0) ** 2);
  const dd = Math.sqrt(downsideSquared.reduce((a, b) => a + b, 0) / returns.length);
  if (dd === 0) {
    if (excess === 0) return 0;
    notes.push('sortino undefined: zero downside deviation with a nonzero excess return (reported as null)');
    return null;
  }
  return (excess / dd) * Math.sqrt(periodsPerYear);
}

/** Largest peak-to-trough decline, as a non-positive fraction. Accepts
 * either prices or an equity curve — the math is the same. */
function maxDrawdown(pricesOrEquity) {
  if (!pricesOrEquity.length) return 0;
  let peak = pricesOrEquity[0];
  let worst = 0;
  for (const v of pricesOrEquity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

function equityCurve(returns) {
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  return equity;
}

// --- correlation ------------------------------------------------------------

function pearson(a, b) {
  const n = a.length;
  if (n === 0) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** All series must share a length — caller aligns by date first. */
function correlationMatrix(returnsByAsset) {
  const names = Object.keys(returnsByAsset);
  if (!names.length) return {};
  const n = returnsByAsset[names[0]].length;
  for (const k of names) {
    if (returnsByAsset[k].length !== n) {
      throw new Error(`series '${k}' has length ${returnsByAsset[k].length}, expected ${n}; align inputs to common dates first`);
    }
  }
  // Null-prototype objects: an asset named "__proto__" must stay a key, not
  // silently replace the object's prototype and vanish from the output.
  const out = Object.create(null);
  for (const a of names) {
    out[a] = Object.create(null);
    for (const b of names) {
      out[a][b] = a === b ? 1 : pearson(returnsByAsset[a], returnsByAsset[b]);
    }
  }
  return out;
}

// --- trades / strategy summary (ported from a backtest summarize) ---------

/** f* = p - (1-p)/R, R = avgWin/avgLoss (both positive magnitudes). Negative => no edge. */
function kellyFraction(p, avgWin, avgLoss) {
  if (avgWin <= 0) return -1;
  const R = avgWin / Math.max(avgLoss, 1e-9);
  if (R <= 0) return -1;
  return p - (1 - p) / R;
}

function summarizeTrades(trades) {
  const byStrategy = new Map();
  for (const t of trades) {
    if (!byStrategy.has(t.strategy)) byStrategy.set(t.strategy, []);
    byStrategy.get(t.strategy).push(t.pnlPct);
  }
  const out = Object.create(null); // see correlationMatrix: keeps "__proto__" a key
  for (const [strategy, pnls] of byStrategy) {
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0).map((p) => -p);
    const p = pnls.length ? wins.length / pnls.length : 0;
    const aw = wins.length ? mean(wins) : 0;
    const al = losses.length ? mean(losses) : 0;
    out[strategy] = {
      trades: pnls.length,
      winRate: round(p, 3),
      avgWinPct: round(aw * 100, 3),
      avgLossPct: round(al * 100, 3),
      expectancyPct: round((pnls.length ? mean(pnls) : 0) * 100, 4),
      totalPct: round(pnls.reduce((a, b) => a + b, 0) * 100, 2),
      kellyF: round(kellyFraction(p, aw, al), 4),
    };
  }
  return out;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// --- top-level bundle for a returns series (folds in a backtest _metrics) ---

function returnsBundle(returns, prices, rf, periodsPerYear, notes) {
  const equity = prices && prices.length ? prices : equityCurve(returns);
  const total = prices && prices.length
    ? prices[prices.length - 1] / prices[0] - 1
    : equity[equity.length - 1] - 1;
  return {
    n: returns.length,
    totalReturn: total,
    annualizedReturn: mean(returns) * periodsPerYear,
    volatility: annualisedVolatility(returns, periodsPerYear),
    sharpe: sharpeRatio(returns, rf, periodsPerYear),
    sortino: sortinoRatio(returns, rf, 0, periodsPerYear, notes),
    maxDrawdown: maxDrawdown(equity),
  };
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

  const { prices, returns: givenReturns, returnsByAsset, trades } = args;
  const riskFreeRate = args.riskFreeRate === undefined ? 0 : args.riskFreeRate;
  const periodsPerYear = args.periodsPerYear === undefined ? 252 : args.periodsPerYear;

  if (typeof riskFreeRate !== 'number' || !Number.isFinite(riskFreeRate)) {
    return fail('riskFreeRate must be a finite number');
  }
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1) {
    return fail('periodsPerYear must be a positive integer');
  }
  if (prices !== undefined && !isFiniteNumberArray(prices)) return fail('prices must be an array of finite numbers');
  if (givenReturns !== undefined && !isFiniteNumberArray(givenReturns)) return fail('returns must be an array of finite numbers');
  if (returnsByAsset !== undefined) {
    if (returnsByAsset === null || typeof returnsByAsset !== 'object' || Array.isArray(returnsByAsset)) {
      return fail('returnsByAsset must be an object of name -> number[]');
    }
    for (const [k, v] of Object.entries(returnsByAsset)) {
      if (!isFiniteNumberArray(v)) return fail(`returnsByAsset.${k} must be an array of finite numbers`);
    }
  }
  if (trades !== undefined) {
    if (!Array.isArray(trades) || !trades.every((t) => t && typeof t.strategy === 'string' && typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct))) {
      return fail('trades must be an array of {strategy: string, pnlPct: number}');
    }
  }

  if (prices === undefined && givenReturns === undefined && returnsByAsset === undefined && trades === undefined) {
    return fail('provide at least one of: prices, returns, returnsByAsset, trades');
  }

  const notes = [];
  const output = {};

  let returns = givenReturns;
  if (prices !== undefined) {
    // Validate prices even when explicit returns are also given: the prices
    // still feed totalReturn and maxDrawdown, where a zero or negative price
    // would produce Infinity (emitted as a bare null) or a drawdown past -100%.
    let derived;
    try {
      derived = returnsFromPrices(prices);
    } catch (err) {
      return fail(err.message);
    }
    if (returns === undefined) returns = derived;
  }

  if (returns !== undefined) {
    if (returns.length < 2) {
      notes.push('fewer than 2 returns available: skipped volatility/sharpe/sortino/drawdown/totalReturn');
    } else {
      Object.assign(output, returnsBundle(returns, prices, riskFreeRate, periodsPerYear, notes));
    }
  }

  if (returnsByAsset !== undefined) {
    try {
      output.correlationMatrix = correlationMatrix(returnsByAsset);
    } catch (err) {
      return fail(err.message);
    }
  }

  if (trades !== undefined) {
    output.strategySummary = summarizeTrades(trades);
  }

  if (notes.length) output.notes = notes;

  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

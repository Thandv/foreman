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

test('happy path: returns bundle from a returns series', () => {
  const res = run({ returns: [0.01, -0.02, 0.015, 0.03, -0.01] });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.n, 5);
  assert.ok(Number.isFinite(out.sharpe));
  assert.ok(Number.isFinite(out.maxDrawdown));
});

test('hand-checked sharpe ratio matches an independently computed value', () => {
  const returns = [0.02, -0.01, 0.03, -0.02];
  const periodsPerYear = 4;
  // Hand computation, done independently of tool.js's implementation.
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const ss = returns.reduce((s, r) => s + (r - mean) ** 2, 0);
  const sd = Math.sqrt(ss / (n - 1)); // sample stdev, ddof=1
  const expectedSharpe = (mean / sd) * Math.sqrt(periodsPerYear);

  const res = run({ returns, periodsPerYear, riskFreeRate: 0 });
  const out = JSON.parse(res.stdout);
  assert.ok(Math.abs(out.sharpe - expectedSharpe) < 1e-9, `${out.sharpe} vs ${expectedSharpe}`);
});

test('hand-checked max drawdown from an equity curve built off returns', () => {
  const returns = [0.1, -0.5, 0.2]; // 1 -> 1.1 -> 0.55 -> 0.66
  // equity: [1, 1.1, 0.55, 0.66]; peak after step1=1.1; trough 0.55 -> dd = 0.55/1.1 - 1 = -0.5
  const res = run({ returns });
  const out = JSON.parse(res.stdout);
  assert.ok(Math.abs(out.maxDrawdown - -0.5) < 1e-9, out.maxDrawdown);
});

test('constant returns: zero volatility and zero sharpe (no division by zero)', () => {
  const res = run({ returns: [0.01, 0.01, 0.01, 0.01] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.volatility, 0);
  assert.equal(out.sharpe, 0);
});

test('sortino is null (not Infinity, which is invalid JSON) when downside deviation is zero with positive excess', () => {
  const res = run({ returns: [0.05, 0.05, 0.05, 0.06] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.sortino, null);
  assert.ok(out.notes.some((n) => n.includes('sortino undefined')));
});

test('prices are converted to returns and produce a totalReturn matching price ratio', () => {
  const res = run({ prices: [100, 110, 99, 108.9] });
  const out = JSON.parse(res.stdout);
  const expectedTotal = 108.9 / 100 - 1;
  assert.ok(Math.abs(out.totalReturn - expectedTotal) < 1e-9);
});

test('returnsByAsset produces a symmetric correlation matrix with 1.0 on the diagonal', () => {
  const res = run({
    returnsByAsset: {
      a: [0.01, 0.02, -0.01, 0.03],
      b: [0.02, 0.04, -0.02, 0.06], // perfectly correlated with a
    },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.correlationMatrix.a.a, 1);
  assert.equal(out.correlationMatrix.b.b, 1);
  assert.ok(Math.abs(out.correlationMatrix.a.b - 1) < 1e-9);
  assert.ok(Math.abs(out.correlationMatrix.a.b - out.correlationMatrix.b.a) < 1e-12);
});

test('trades produce a per-strategy summary with a Kelly fraction', () => {
  const res = run({
    trades: [
      { strategy: 'meanrev', pnlPct: 0.02 },
      { strategy: 'meanrev', pnlPct: -0.01 },
      { strategy: 'meanrev', pnlPct: 0.015 },
      { strategy: 'trend', pnlPct: -0.03 },
    ],
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.strategySummary.meanrev.trades, 3);
  assert.ok(out.strategySummary.meanrev.winRate > 0.5);
  assert.equal(out.strategySummary.trend.trades, 1);
  assert.ok(out.strategySummary.trend.kellyF < 0); // all losses -> no edge
});

test('rejects malformed input: nothing usable provided', () => {
  const res = run({ riskFreeRate: 0.01 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('{{{');
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: non-positive price', () => {
  const res = run({ prices: [100, 0, 90] });
  assert.notEqual(res.status, 0);
});

test('manifest description states this is descriptive analysis only, not advice, never trades', async () => {
  const { default: fs } = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const d = manifest.description.toLowerCase();
  assert.ok(d.includes('not financial advice'));
  assert.ok(d.includes('never places an order') || d.includes('never place an order'));
});

test('constant float returns give exactly zero volatility and sharpe, not a ~1e17 ratio', () => {
  // three 0.1s sum to 0.30000000000000004; a naive mean leaves a fake ~1e-16 spread
  const res = run({ returns: [0.1, 0.1, 0.1] });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.volatility, 0);
  assert.equal(out.sharpe, 0);
});

test('a negative price is rejected, even as the last price or alongside explicit returns', () => {
  assert.notEqual(run({ prices: [10, 11, -5] }).status, 0);
  assert.notEqual(run({ prices: [0, 11, 5], returns: [0.1, 0.2] }).status, 0);
  // a final price of exactly 0 (total loss) is still legal
  const ok = run({ prices: [10, 11, 0] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).maxDrawdown, -1);
});

test('a strategy or asset named "__proto__" is kept as an ordinary key', () => {
  const t = JSON.parse(run({ trades: [{ strategy: '__proto__', pnlPct: 0.1 }] }).stdout);
  assert.deepEqual(Object.keys(t.strategySummary), ['__proto__']);
  assert.equal(t.strategySummary['__proto__'].trades, 1);
  const c = JSON.parse(run('{"returnsByAsset":{"__proto__":[1,2,3],"b":[1,3,2]}}').stdout);
  assert.deepEqual(Object.keys(c.correlationMatrix), ['__proto__', 'b']);
  assert.equal(c.correlationMatrix.b['__proto__'], 0.5);
});

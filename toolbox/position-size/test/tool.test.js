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

test('happy path: hand-checked kelly fraction and multiplier', () => {
  const res = run({ winRate: 0.55, avgWin: 0.02, avgLoss: 0.015, samples: 40 });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  // f* = p - (1-p)/R, R = 0.02/0.015 = 4/3 => f* = 0.55 - 0.45/(4/3) = 0.2125
  assert.ok(Math.abs(out.kellyF - 0.2125) < 1e-9);
  // fUsed = max(0,0.2125)*0.5 = 0.10625; mult = 0.10625/0.1 = 1.0625
  assert.ok(Math.abs(out.kellyMult - 1.0625) < 1e-9);
  assert.equal(out.volMult, 1);
  assert.equal(out.riskOffMult, 1);
  assert.ok(Math.abs(out.combined - out.kellyMult) < 1e-9);
});

test('min-samples no-op: kellyMult is 1.0x below the sample threshold regardless of edge', () => {
  const res = run({ winRate: 0.9, avgWin: 0.05, avgLoss: 0.01, samples: 3 });
  const out = JSON.parse(res.stdout);
  assert.equal(out.kellyMult, 1.0);
});

test('negative edge (avgWin <= 0) yields kellyF = -1 and a floor-clamped kellyMult', () => {
  const res = run({ winRate: 0.4, avgWin: 0, avgLoss: 0.02, samples: 50 });
  const out = JSON.parse(res.stdout);
  assert.equal(out.kellyF, -1);
  assert.equal(out.kellyMult, 0.3); // clamped to default minMult
});

test('volatility targeting scales down a turbulent position, clamped to volMaxMult', () => {
  const res = run({
    winRate: 0.5, avgWin: 0.01, avgLoss: 0.01, samples: 0,
    annualizedVol: 0.05, targetVol: 0.5, // target way above recent vol -> would lever, but clamped
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.volMult, 1.2); // default volMaxMult
});

test('risk-off ramp: full exposure below the gate, floor at score 1.0', () => {
  const below = JSON.parse(run({ winRate: 0.5, avgWin: 0.01, avgLoss: 0.01, samples: 0, riskOffScore: 0.1 }).stdout);
  assert.equal(below.riskOffMult, 1.0);
  const atMax = JSON.parse(run({ winRate: 0.5, avgWin: 0.01, avgLoss: 0.01, samples: 0, riskOffScore: 1.0 }).stdout);
  assert.equal(atMax.riskOffMult, 0.0); // default floorMult
});

test('risk-off score omitted is fail-safe: 1.0x, never blocks or de-risks', () => {
  const res = run({ winRate: 0.5, avgWin: 0.01, avgLoss: 0.01, samples: 0 });
  const out = JSON.parse(res.stdout);
  assert.equal(out.riskOffMult, 1.0);
});

test('rejects malformed input: winRate out of range', () => {
  const res = run({ winRate: 1.5, avgWin: 0.01, avgLoss: 0.01, samples: 10 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: missing required field', () => {
  const res = run({ winRate: 0.5, avgWin: 0.01, samples: 10 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('nope');
  assert.notEqual(res.status, 0);
});

test('manifest description states this is descriptive analysis only, not advice, never trades', async () => {
  const { default: fs } = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const d = manifest.description.toLowerCase();
  assert.ok(d.includes('not financial advice'));
  assert.ok(d.includes('never places an order'));
});

test('rejects a signed (negative) avgLoss instead of treating it as a loss-free edge', () => {
  const res = run({ winRate: 0.5, avgWin: 0.02, avgLoss: -0.02, samples: 30 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /avgLoss must be a non-negative magnitude/);
  // zero average loss (no losing trades yet) is still accepted
  assert.equal(run({ winRate: 0.5, avgWin: 0.02, avgLoss: 0, samples: 30 }).status, 0);
});

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

test('happy path: single buy fully matched by a single sell', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'buy', qty: 10, price: 100, date: '2026-01-05' },
      { symbol: 'ACME', side: 'sell', qty: 10, price: 120, date: '2026-03-01' },
    ],
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].cost, 1000);
  assert.equal(out.events[0].proceeds, 1200);
  assert.equal(out.events[0].gain, 200);
  assert.equal(out.leftoverLots.length, 0);
  assert.equal(out.errors.length, 0);
});

test('partial-lot split: a sell spanning two buy lots leaves a partial lot open', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'buy', qty: 10, price: 100, date: '2026-01-05' },
      { symbol: 'ACME', side: 'buy', qty: 5, price: 110, date: '2026-02-01' },
      { symbol: 'ACME', side: 'sell', qty: 12, price: 120, date: '2026-03-01' },
    ],
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].qty, 10);
  assert.equal(out.events[0].buyDate, '2026-01-05');
  assert.equal(out.events[1].qty, 2);
  assert.equal(out.events[1].buyDate, '2026-02-01');
  assert.equal(out.leftoverLots.length, 1);
  assert.equal(out.leftoverLots[0].qty, 3);
  assert.equal(out.errors.length, 0);
});

test('oversell produces a clean error entry, not a thrown exception, and matches what it can', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'buy', qty: 5, price: 100, date: '2026-01-05' },
      { symbol: 'ACME', side: 'sell', qty: 8, price: 120, date: '2026-03-01' },
    ],
  });
  assert.equal(res.status, 0); // the tool itself does not fail
  const out = JSON.parse(res.stdout);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].qty, 5);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /oversell/);
  assert.equal(out.leftoverLots.length, 0);
});

test('FX: per-order fx overrides the date map, and the date map applies by default', () => {
  const res = run({
    orders: [
      { symbol: 'EU', side: 'buy', qty: 10, price: 100, date: '2026-01-05' }, // uses fx map: 0.9
      { symbol: 'EU', side: 'sell', qty: 10, price: 120, date: '2026-03-01', fx: 2 }, // overrides map
    ],
    fx: { '2026-01-05': 0.9, '2026-03-01': 0.5 },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.events[0].cost, 900); // 10 * 100 * 0.9
  assert.equal(out.events[0].proceeds, 2400); // 10 * 120 * 2 (per-order override)
});

test('every event carries buyFx/sellFx for auditability', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'buy', qty: 10, price: 100, date: '2026-01-05' },
      { symbol: 'ACME', side: 'sell', qty: 10, price: 120, date: '2026-03-01' },
    ],
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.events[0].buyFx, 1);
  assert.equal(out.events[0].sellFx, 1);
});

test('a non-empty fx map with a missing date for a leg is reported as a structured error and does NOT fabricate a rate-1 gain', () => {
  const res = run({
    orders: [
      { symbol: 'EU', side: 'buy', qty: 10, price: 100, date: '2026-01-05' }, // no entry for this date in fx
      { symbol: 'EU', side: 'sell', qty: 10, price: 120, date: '2026-03-01' },
    ],
    fx: { '2026-03-01': 0.5 }, // present and non-empty, but missing 2026-01-05
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // The buy leg is skipped outright: it never becomes a lot, so the sell
  // cannot match anything and produces no event at all.
  assert.equal(out.events.length, 0);
  assert.equal(out.leftoverLots.length, 0);
  assert.ok(
    out.errors.some((e) => e.symbol === 'EU' && e.date === '2026-01-05' && /missing FX rate/.test(e.message)),
    `expected a missing-FX error naming symbol EU and date 2026-01-05, got ${JSON.stringify(out.errors)}`,
  );
});

test('a non-empty fx map with an entry for every leg date applies normally (no errors)', () => {
  const res = run({
    orders: [
      { symbol: 'EU', side: 'buy', qty: 10, price: 100, date: '2026-01-05' },
      { symbol: 'EU', side: 'sell', qty: 10, price: 120, date: '2026-03-01' },
    ],
    fx: { '2026-01-05': 0.9, '2026-03-01': 0.5 },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.errors.length, 0);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].buyFx, 0.9);
  assert.equal(out.events[0].sellFx, 0.5);
});

test('an empty fx map ({}) behaves like no fx map at all: missing dates default to 1, no errors', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'buy', qty: 10, price: 100, date: '2026-01-05' },
      { symbol: 'ACME', side: 'sell', qty: 10, price: 120, date: '2026-03-01' },
    ],
    fx: {},
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.errors.length, 0);
  assert.equal(out.events[0].buyFx, 1);
  assert.equal(out.events[0].sellFx, 1);
});

test('orders out of chronological order are still matched FIFO by date, not input order', () => {
  const res = run({
    orders: [
      { symbol: 'ACME', side: 'sell', qty: 5, price: 130, date: '2026-04-01' },
      { symbol: 'ACME', side: 'buy', qty: 5, price: 90, date: '2026-01-01' },
    ],
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].buyDate, '2026-01-01');
  assert.equal(out.events[0].sellDate, '2026-04-01');
});

test('rejects malformed input: bad side', () => {
  const res = run({ orders: [{ symbol: 'X', side: 'short', qty: 1, price: 1, date: '2026-01-01' }] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: missing orders', () => {
  const res = run({});
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('[[[');
  assert.notEqual(res.status, 0);
});

test('a date that names an Object.prototype member is not mistaken for an fx-map entry', () => {
  const res = run({
    orders: [
      { symbol: 'A', side: 'buy', qty: 1, price: 10, date: 'constructor' },
      { symbol: 'A', side: 'sell', qty: 1, price: 12, date: 'toString' },
    ],
    fx: { '2026-01-01': 2 },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.events, []);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0].message, /missing FX rate/);
});

test('rejects a zero or negative fx rate, per-order or in the map', () => {
  const order = { symbol: 'A', side: 'buy', qty: 1, price: 10, date: 'd' };
  assert.notEqual(run({ orders: [{ ...order, fx: -1 }] }).status, 0);
  assert.notEqual(run({ orders: [{ ...order, fx: 0 }] }).status, 0);
  assert.notEqual(run({ orders: [order], fx: { d: 0 } }).status, 0);
});

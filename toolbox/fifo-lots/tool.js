#!/usr/bin/env node
// Ported from the author's earlier tools (compute_events), GENERALIZED: the
// jurisdiction-specific constants (tax rate, loss carryforward, central-bank
// FX lookup) lived in a different function
// (summarize_years) and are not ported here at all — compute_events itself
// is already jurisdiction-agnostic FIFO matching. The only change is that FX
// conversion now comes entirely from the input: an optional per-order `fx`,
// falling back to an optional `fx` map keyed by date, falling back to 1
// (i.e. no conversion) — instead of a central-bank rate-lookup callback.
//
// stdin: { orders: [{symbol, side: "buy"|"sell", qty, price, date, fx?}], fx?: {date: rate} }
// stdout: { events: [{symbol, qty, buyDate, sellDate, cost, proceeds, gain}],
//           leftoverLots: [{symbol, qty, price, date, fx}],
//           errors: [{symbol, date, side, message}] }
//
// Oversell (a sell whose quantity exceeds the FIFO lots on hand) is reported
// as an entry in `errors`, not thrown — the caller gets a clean, structured
// answer describing exactly what could and couldn't be matched.
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

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** FIFO-match buys/sells per symbol, converting each leg to a common
 * currency using per-order or per-date FX. Orders are processed in date
 * order (stable for equal dates, preserving input order). */
function fifoLots(orders, fxMap) {
  const sorted = orders
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.date < b.o.date ? -1 : a.o.date > b.o.date ? 1 : a.i - b.i))
    .map((x) => x.o);

  // Only treat a caller-supplied fx map as "in play" if it actually has
  // entries. With no fx map at all, every leg keeps the old behaviour of
  // defaulting to 1 (no conversion) — there is nothing to be missing from.
  const hasFxMap = fxMap && Object.keys(fxMap).length > 0;

  const lots = new Map(); // symbol -> array of { qty, price, date, fx }, oldest first
  const events = [];
  const errors = [];

  for (const o of sorted) {
    const { symbol, side, qty, price, date } = o;
    if (!(price > 0) || !(qty > 0)) {
      errors.push({ symbol, date, side, message: `skipped: non-positive price or qty (price=${price}, qty=${qty})` });
      continue;
    }

    let fx;
    if (o.fx !== undefined) {
      fx = o.fx;
    } else if (hasFxMap) {
      if (!Object.hasOwn(fxMap, date)) {
        // This leg (buy or sell) has no per-order fx and no entry in the
        // map for its own date: silently defaulting to 1 here fabricates a
        // gain or loss out of nothing. Report it and skip the leg entirely
        // — a buy is never added to its symbol's lots, and a sell never
        // attempts to match — rather than guess a conversion rate.
        errors.push({
          symbol,
          date,
          side,
          message: `missing FX rate for ${symbol} on ${date}: an fx map was given but has no rate for this date, and the order carries no per-order fx override`,
        });
        continue;
      }
      fx = fxMap[date];
    } else {
      fx = 1;
    }

    if (!lots.has(symbol)) lots.set(symbol, []);
    const symLots = lots.get(symbol);

    if (side === 'buy') {
      symLots.push({ qty, price, date, fx });
    } else if (side === 'sell') {
      let remaining = qty;
      while (remaining > 1e-9 && symLots.length) {
        const lot = symLots[0];
        const matched = Math.min(remaining, lot.qty);
        const cost = matched * lot.price * lot.fx;
        const proceeds = matched * price * fx;
        events.push({
          symbol,
          qty: round(matched, 6),
          buyDate: lot.date,
          sellDate: date,
          cost: round(cost, 2),
          proceeds: round(proceeds, 2),
          gain: round(proceeds - cost, 2),
          buyFx: lot.fx,
          sellFx: fx,
        });
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= 1e-9) symLots.shift();
      }
      if (remaining > 1e-9) {
        errors.push({
          symbol,
          date,
          side,
          message: `oversell: ${round(remaining, 6)} units of ${symbol} on ${date} exceed the FIFO lots on hand`,
        });
      }
    } else {
      errors.push({ symbol, date, side, message: `unknown side '${side}': expected "buy" or "sell"` });
    }
  }

  const leftoverLots = [];
  for (const [symbol, symLots] of lots) {
    for (const lot of symLots) {
      leftoverLots.push({ symbol, qty: round(lot.qty, 6), price: lot.price, date: lot.date, fx: lot.fx });
    }
  }
  return { events, leftoverLots, errors };
}

function validOrder(o) {
  return o && typeof o === 'object'
    && typeof o.symbol === 'string' && o.symbol.length > 0
    && (o.side === 'buy' || o.side === 'sell')
    && typeof o.qty === 'number' && Number.isFinite(o.qty)
    && typeof o.price === 'number' && Number.isFinite(o.price)
    && typeof o.date === 'string' && o.date.length > 0
    && (o.fx === undefined || (typeof o.fx === 'number' && Number.isFinite(o.fx) && o.fx > 0));
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

  const { orders, fx } = args;
  if (!Array.isArray(orders) || orders.length === 0) return fail('orders must be a non-empty array');
  for (const o of orders) {
    if (!validOrder(o)) {
      return fail(`each order needs {symbol: string, side: "buy"|"sell", qty: number, price: number, date: string, fx?: positive number}; got ${JSON.stringify(o)}`);
    }
  }
  let fxMap = {};
  if (fx !== undefined) {
    if (fx === null || typeof fx !== 'object' || Array.isArray(fx)) return fail('fx must be an object mapping date -> rate');
    for (const [k, v] of Object.entries(fx)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fail(`fx.${k} must be a positive finite number`);
    }
    fxMap = fx;
  }

  const result = fifoLots(orders, fxMap);
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));

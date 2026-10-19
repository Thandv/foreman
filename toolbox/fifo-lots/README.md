# fifo-lots

FIFO lot matcher. Ported from the author's earlier tools
(`compute_events`), generalized: jurisdiction-specific tax constants (rate,
loss carryforward) lived in a different function and are not ported at all —
`compute_events` itself was already jurisdiction-agnostic FIFO matching. The
only change is that FX conversion now comes straight from the input (a
per-order `fx`, or a `fx: {date: rate}` map, or 1 by default) instead of a
central-bank rate-lookup callback.

Sells are matched against the oldest open buy lots per symbol, oldest first.
An **oversell** — a sell whose quantity exceeds the lots on hand — is
reported in `errors`, not thrown, so you still get every event that *could*
be matched.

## FX and missing dates

FX conversion is per-leg: each buy and each sell resolves its own rate from
its per-order `fx` if present, else the top-level `fx` date map, else 1 (no
conversion) — but **only when no `fx` map was given at all**. If you *do*
pass a non-empty `fx` map, that changes the contract: a leg with no
per-order `fx` and no entry in the map for its own date is **not** silently
defaulted to 1. Doing that would fabricate a gain or loss out of a missing
rate. Instead that leg is skipped — a buy is never added to its symbol's
lots, a sell never attempts to match — and a structured entry naming the
symbol and date is pushed onto `errors`.

Every emitted event also carries `buyFx` and `sellFx` — the rate actually
applied to each leg — so the conversion behind `cost`/`proceeds`/`gain` is
auditable rather than implicit.

## Input

```json
{
  "orders": [
    { "symbol": "ACME", "side": "buy", "qty": 10, "price": 100, "date": "2026-01-05" },
    { "symbol": "ACME", "side": "buy", "qty": 5, "price": 110, "date": "2026-02-01" },
    { "symbol": "ACME", "side": "sell", "qty": 12, "price": 120, "date": "2026-03-01" }
  ]
}
```

## Output

The sell above matches 10 units from the first lot and 2 from the second,
leaving 3 units of the second lot open:

```json
{
  "events": [
    { "symbol": "ACME", "qty": 10, "buyDate": "2026-01-05", "sellDate": "2026-03-01", "cost": 1000, "proceeds": 1200, "gain": 200, "buyFx": 1, "sellFx": 1 },
    { "symbol": "ACME", "qty": 2, "buyDate": "2026-02-01", "sellDate": "2026-03-01", "cost": 220, "proceeds": 240, "gain": 20, "buyFx": 1, "sellFx": 1 }
  ],
  "leftoverLots": [
    { "symbol": "ACME", "qty": 3, "price": 110, "date": "2026-02-01", "fx": 1 }
  ],
  "errors": []
}
```

## Example

```
echo '{"orders":[{"symbol":"ACME","side":"buy","qty":10,"price":100,"date":"2026-01-05"},{"symbol":"ACME","side":"sell","qty":12,"price":120,"date":"2026-03-01"}]}' | node tool.js
```

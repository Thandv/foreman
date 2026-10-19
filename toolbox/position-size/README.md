# position-size

**Descriptive analysis only. Not financial advice. Never places an order.**

Ported from the author's earlier tools (zero imports in the
original). Computes three independent size multipliers and their product:

- **Kelly** (`kellyF`, `kellyMult`): fractional-Kelly off your win-rate/
  avg-win/avg-loss edge, clamped to `[minMult, maxMult]`. A no-op (`1.0x`)
  until `samples >= minSamples` (default 20) — an edge estimate on a
  handful of trades isn't trustworthy enough to size on yet.
- **Volatility targeting** (`volMult`): `targetVol / annualizedVol`,
  clamped. Down-weights turbulent positions. `1.0x` if either volatility
  input is missing or `targetVol` is 0.
- **Risk-off** (`riskOffMult`): an asymmetric ramp off a `riskOffScore` in
  `[0,1]` — stay fully invested below `keepFullBelow`, de-risk hard (with
  convexity set by `aggressiveness`) above it, optionally levering up to
  `calmBoost` in the all-clear zone. `1.0x` when the score is omitted
  (fail-safe: unknown data never de-risks or blocks sizing by accident).

`combined = kellyMult * volMult * riskOffMult` — apply this on top of your
own hard risk caps, never in place of them.

The original gated all of this behind an `enabled` config flag meant for a
long-running service's off-switch; this standalone tool drops that flag since
calling it is itself the opt-in.

## Input

```json
{ "winRate": 0.55, "avgWin": 0.02, "avgLoss": 0.015, "samples": 40 }
```

## Output

```json
{ "kellyF": 0.2125, "kellyMult": 1.0625, "volMult": 1.0, "riskOffMult": 1.0, "combined": 1.0625 }
```

## Example

```
echo '{"winRate":0.55,"avgWin":0.02,"avgLoss":0.015,"samples":40}' | node tool.js
```

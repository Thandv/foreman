# bootstrap-ci

Moving-block bootstrap confidence interval. Ported from
the author's earlier tools (numpy-based) to a
dependency-free implementation with a hand-rolled seeded PRNG
(mulberry32, 32-bit, public domain).

Resampling whole contiguous blocks — rather than single independent points —
preserves short-range autocorrelation, so the resulting interval reflects an
estimator's true sampling variability on serially-correlated data (e.g. daily
returns), unlike a naive IID bootstrap.

## Determinism

Randomness comes entirely from a seeded PRNG, not `Math.random()`. The same
`{series, statistic, blockSize, iterations, level, seed}` always produces
byte-identical output — in this process, in a fresh one, on any machine. If
`seed` is omitted it defaults to `42` (a fixed constant, not real randomness),
so the tool is deterministic by default too.

## Input

```json
{ "series": [0.01, -0.02, 0.015, 0.03, -0.01, 0.02, 0.005], "statistic": "mean", "iterations": 500, "seed": 1 }
```

- `series` (required): numeric series, at least 2 points.
- `statistic` (required): `"mean"`, `"median"`, or `"sharpe"` (raw
  mean/sample-stdev ratio on the series as given — annualise separately).
- `blockSize` (optional): block length. Default `max(2, round(0.05 * n))`. A value
  below 2 is raised to 2 and one above `n` is lowered to `n`, as in the original.
- `iterations` (optional): resample count. Default `1000`.
- `level` (optional): confidence level. Default `0.95`.
- `seed` (optional): PRNG seed. Default `42`.

## Output

```json
{ "estimate": 0.007142857142857, "lo": -0.0071, "hi": 0.0186, "se": 0.0068, "level": 0.95 }
```

## Example

```
echo '{"series":[0.01,-0.02,0.015,0.03,-0.01,0.02,0.005],"statistic":"mean","seed":1}' | node tool.js
```

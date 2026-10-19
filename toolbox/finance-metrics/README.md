# finance-metrics

**Descriptive analysis only. Not financial advice. Never places an order.**

Ported from the author's earlier tools (`returns_from_prices`,
`annualised_volatility`, `sharpe_ratio`, `sortino_ratio`, `max_drawdown`,
`portfolio_metrics`, `correlation_matrix` — CSV readers left behind, arrays
in instead; and a backtest's `summarize` and `_metrics`).

Computes whichever metrics your input allows:

- `prices` and/or `returns` -> `totalReturn`, `annualizedReturn`,
  `volatility`, `sharpe`, `sortino`, `maxDrawdown`.
- `returnsByAsset` -> `correlationMatrix` (Pearson, pairwise).
- `trades` -> `strategySummary` (win rate, avg win/loss, expectancy,
  Kelly fraction, per strategy).

`sharpe`/`sortino` are `null` when they're undefined for the input (fewer
than 2 observations, or a Sortino ratio that would be +/-Infinity — not
valid JSON, so it's reported as `null` with a note instead).

## Input

```json
{ "returns": [0.01, -0.02, 0.015, 0.03, -0.01], "riskFreeRate": 0.0, "periodsPerYear": 252 }
```

## Output

```json
{
  "n": 5,
  "totalReturn": 0.02443854589999983,
  "annualizedReturn": 1.2599999999999998,
  "volatility": 0.3174901573277509,
  "sharpe": 3.968626966596885,
  "sortino": 7.93725393319377,
  "maxDrawdown": -0.019999999999999997
}
```

## Example

```
echo '{"returns":[0.01,-0.02,0.015,0.03,-0.01]}' | node tool.js
```

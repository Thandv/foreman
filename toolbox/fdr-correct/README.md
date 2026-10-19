# fdr-correct

Benjamini-Hochberg false-discovery-rate (FDR) correction for a batch of
p-values. Ported from the author's earlier tools
(numpy-based) to a dependency-free hand-rolled `argsort` + min-accumulate
implementation.

When you test many hypotheses at once (many assets, timeframes, estimators),
comparing each raw p-value to `alpha` individually inflates the false-positive
rate. BH-FDR controls the *expected proportion* of false discoveries among
the rejected tests instead.

## Input

```json
{ "pvalues": [0.01, 0.02, 0.03, 0.5, 0.8], "alpha": 0.05 }
```

- `pvalues` (required): array of raw p-values in `[0, 1]`.
- `alpha` (optional): target FDR level, default `0.05`.

## Output

```json
{
  "rejected": [true, true, true, false, false],
  "qvalues": [0.05, 0.05, 0.05, 0.625, 0.8]
}
```

`rejected[i]` / `qvalues[i]` correspond to `pvalues[i]` — the output is in
the same order as the input, not sorted.

## Example

```
echo '{"pvalues":[0.01,0.02,0.03,0.5,0.8],"alpha":0.05}' | node tool.js
```

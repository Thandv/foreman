# stats-test

Descriptive statistics and classical hypothesis tests, dependency-free.

## Input

Describe:

```json
{ "mode": "describe", "series": [2, 4, 4, 4, 5, 5, 7, 9] }
```

T-test (Welch's by default, paired on request):

```json
{ "mode": "ttest", "a": [1, 3], "b": [10, 12] }
```

Regression:

```json
{ "mode": "regression", "x": [1, 2, 3, 4], "y": [2, 4, 5, 4] }
```

Correlation:

```json
{ "mode": "correlation", "a": [1, 2, 3, 4], "b": [2, 4, 5, 4], "method": "pearson" }
```

## Output

- `describe` -> `{ n, mean, median, stdev, min, max, quartiles: {q1,q2,q3}, skewness, notes }`
- `ttest` -> `{ t, df, p, notes }` (two-tailed p-value)
- `regression` -> `{ slope, intercept, r2, stderr, notes }`
- `correlation` -> `{ r, p, notes }`

`stdev` is the sample (Bessel-corrected, n-1) standard deviation. Quartiles
use linear interpolation between order statistics (the "R-7" / numpy-default
method). `skewness` is the Fisher-Pearson moment coefficient (g1).

The two-tailed p-values (`ttest`, `correlation`) come from the Student's t
distribution CDF, computed via the regularized incomplete beta function
using a continued-fraction expansion (see the header comment in `tool.js`
for the algorithm and its accuracy).

### Degenerate inputs: `null` fields and `notes`

Some legal inputs have no well-defined answer for one or more fields — a
single-element series has no sample standard deviation, a zero-variance
t-test has no defined t-statistic, a constant-x regression can't fit a
slope, a constant series has no correlation coefficient, and so on. Rather
than silently emitting `NaN`/`Infinity` (which `JSON.stringify` turns into a
bare, unexplained `null` and which would fail this tool's own output
schema), every field that goes `null` for such an input is paired with a
human-readable entry in the `notes` array explaining why, e.g.:

```json
{ "mode": "describe", "n": 1, "stdev": null, "notes": ["stdev undefined for n<2 (sample standard deviation needs at least 2 observations)"], ... }
```

`notes` is always present and is an empty array when nothing in the result
is null. Every nullable field's manifest description also names the
condition that produces it.

## Example

```
echo '{"mode":"ttest","a":[1,3],"b":[10,12]}' | node tool.js
```

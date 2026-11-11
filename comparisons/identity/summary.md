# Identity bench

## A. Comparable: per-request latency (ms), 200 requests each

| daemon | auth | request | p50 | p95 |
|---|---|---|---|---|
| base | off | GET /api/state | 0.51 | 0.68 |
| base | off | POST /api/tasks | 0.68 | 0.85 |
| branch | off | GET /api/state | 0.49 | 0.65 |
| branch | off | POST /api/tasks | 0.66 | 0.82 |
| branch | bearer | GET /api/state | 0.52 | 0.64 |
| branch | bearer | POST /api/tasks | 0.7 | 0.85 |

## B. NEW CAPABILITY (branch only; not a speed-up, nothing to compare it with)

Approve to merged through the fake GitLab, from the approving call to Foreman's "merged" event. The person's wait is not
in it. MR poll interval 100 ms.

| mode | approve to merged (ms) |
|---|---|
| single-principal | 700.37 |
| four-eyes | 678.89 |

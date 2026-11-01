## Known limitations

- `claude-code` / `codex-cli` stream parsing is fixture-tested against recorded transcripts
  covering every branch (tool_use routing, chunk-split lines, malformed JSON, error results),
  but has still not been exercised against a live run — a CLI update could drift the shapes.
- Local 8–14B reviewers are noisy: expect confident misreadings. The disagreement gate exists
  precisely for that — in the live run below, one advisor misread a diff and the chair caught it.
  Wire a stronger chair through the gateway for higher-stakes review.
- Throughput with local models is council-bound: `maxWorkers` 4 against
  `FOREMAN_OLLAMA_CONCURRENCY` 2 means workers idle in `verifying`.
- One daemon owns the queue, enforced by a pidfile lock in `$FOREMAN_HOME` (a stale lock from a
  dead pid is reclaimed; a live one refuses startup). The lock is advisory per-home — two daemons
  pointed at different homes but the same `FOREMAN_DB` are not caught.
- Slow SSE readers get a bounded buffer (1000 events past socket saturation), then are dropped;
  a dropped board reconnects with `?since=` and catches up from SQLite.
- Each runner child's pgid is recorded on its run row: a clean SIGINT/SIGTERM kills the groups
  on the way down, and startup recovery kills any recorded group that survived a killed daemon
  before requeueing. Children of a SIGKILLed daemon therefore live until the next
  `foreman serve`, and pid reuse after a very long outage could kill an innocent group.
- The recurrence language is not cron (see `schedule`); missed windows fire once, not once per
  window elapsed.


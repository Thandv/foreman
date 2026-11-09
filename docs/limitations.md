## Known limitations

- `claude-code` / `codex-cli` stream parsing is fixture-tested against recorded transcripts
  covering every branch (tool_use routing, chunk-split lines, malformed JSON, error results),
  and `claude-code` runs live every day. A CLI update could still drift the shapes.
- Local 8–14B reviewers are noisy: expect confident misreadings. The disagreement gate exists
  precisely for that — in the live run under "Verified live" in `docs/tests.md`, one advisor
  misread a diff and the chair caught it. Wire a stronger chair through the gateway for
  higher-stakes review.
- Throughput with local models is council-bound: `maxWorkers` 4 against
  `FOREMAN_OLLAMA_CONCURRENCY` 2 means workers idle in `verifying`.
- One daemon owns the queue, enforced by a pidfile lock in `$FOREMAN_HOME` (a stale lock from a
  dead pid is reclaimed; a live one refuses startup). The lock is advisory per-home — two daemons
  pointed at different homes but the same `FOREMAN_DB` are not caught.
- Slow SSE readers get a bounded buffer (1000 events past socket saturation), then are dropped;
  a dropped board reconnects with `?since=` and catches up from SQLite.
- Each runner child's pid (which is its process-group id, since it is detached) is recorded on its
  run row. On SIGINT, SIGTERM or SIGHUP `foreman serve` stops dispatching and aborts every post-merge
  check. It gives approvals already landing up to 60 s, then waits up to 60 s for the scheduler to
  stop, which aborts every active run (SIGTERM to its process groups, SIGKILL to what is left 5 s
  later). If the scheduler has not stopped by then, or when it has stopped but runs never settled,
  `killLiveRunGroups()` SIGKILLs every recorded run group and the process groups under it. Startup
  recovery does the same for any group still recorded as running before it requeues. That kill goes by
  pid alone, with no start-time check, so pid reuse after a very long outage could kill an innocent
  group. Children of a SIGKILLed daemon live until the next `foreman serve`.
- Leftover reaping is separate, and covers every command started through `spawnStreaming`: runner
  children (the `claude-code` worker included), test commands and checks. When one exits, what it
  left running is found by pid and start time (on Linux from `/proc`, not `ps`) and ended. While
  Foreman has process groups stopped (SIGSTOP), it records them in `<home>/frozen/`, and on exit,
  SIGHUP, SIGTERM or SIGINT it sends them SIGTERM and SIGCONT. If the daemon is killed first, the
  next `foreman serve` sweeps `frozen/` before its scheduler starts, and signals a group only when a
  fresh snapshot matches a member's pid and start time. A process that called `setsid` and lost its
  parent before any of the reaper's samples (every 3 s by default, while the command runs) saw it is
  tied to nothing and escapes. Claude Code's Bash tool starts every command in its own session, so
  for the `claude-code` worker, which is not sandboxed, only those samples tie its Bash commands'
  leftovers to the run.
- The sandbox exists only on macOS. On Linux the default `FOREMAN_SANDBOX=tests` makes `foreman serve`
  refuse to start (its start-up self-test fails); set `FOREMAN_SANDBOX=off` and test commands run
  unconfined. `FOREMAN_SANDBOX=all` is accepted but behaves as `tests`.
- The approve and `landed` endpoints take no proof of who is calling, and the routes record the caller as `human`.
  The `x-foreman-run` header on `POST /api/verify-slot` is not authenticated: anything that can
  reach the port may send any run id. The API binds loopback only unless `FOREMAN_ALLOW_REMOTE=1`.
- Until workers are sandboxed, a worker can write the real repo's `.git/config`, `hooks/`, `info/` or a
  `refs/replace`/`refs/notes` ref by path. Foreman only detects that (a baseline taken at jail creation, compared
  at collection and at landing; docs/security.md) and holds or refuses for a person; it restores nothing. The
  baseline is a file the unsandboxed worker could rewrite too, as could the worker-suite line's mtimes.
- Crash attribution (`daemon_starts`, docs/OPERATING.md) is not tamper-proof while workers are unsandboxed: a worker
  can write the ledger, mark a start clean, or kill the daemon itself, so the count and the crash-loop hold are a
  guard against honest crash loops, not a security boundary.
- The recurrence language is not cron (see `schedule`); missed windows fire once, not once per
  window elapsed.

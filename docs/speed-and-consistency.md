## Speed and consistency

```bash
foreman doctor --latency          # per-stage medians and p90, suite time and slot waits, over recent runs
foreman receipts                  # spend and stage medians together
foreman prune --days 90           # worktrees, branches, old ledger rows, dep caches
```

**Old worktrees.** Once an hour the daemon removes the worktrees of work that
landed more than `FOREMAN_JAIL_RETAIN_DAYS` (3) ago, and of tasks that have been
`failed` for more than `FOREMAN_FAILED_JAIL_RETAIN_DAYS` (14; at least 1;
negative keeps them). A failed task's worktree goes only when the last run that
used it recorded a diff artifact that is still on disk (the work is then in
that file), or when the tree is unchanged; otherwise it is kept and the
daemon's log says how many were (`foreman prune` drops them by hand). After
that, `foreman reopen` of such a task answers that its worktree is gone. A task
at the gate, running, queued or blocked is never touched.

**Dependency provisioning.** A git worktree never carries a gitignored
`node_modules`, so the test gate used to run against an uninstalled tree — not
merely paying an install, but *failing*, turning a good change into a `fail`
verdict and a wasted repair round. Jails are now provisioned from the repo's own
tree when it matches its lockfile, else from a lockfile-keyed cache
(`$FOREMAN_HOME/deps-cache`), else one cached `npm ci --ignore-scripts`; `foreman prune` keeps the
newest five cached installs (`--keep-deps N`). The default is a copy rather than a symlink, because a symlink is
writable through — a runner could edit the operator's dependencies, which is the
one thing the jail promises it cannot do. On macOS the copy is made with
`/bin/cp -c -R`, which on APFS is a copy-on-write clone: measured on a mid-sized TypeScript repo's
install (290 entries, 26 MB) about 40 ms and 0.1 MB of disk per jail. Node's own
copy does not clone there whatever it is asked (the same tree: about 75 ms and
the full 27.6 MB, every jail), so it is only the fallback — Linux, a volume that
cannot clone, a failed `cp` — and the run's `deps:` line then says "by plain
copy". The tree is built beside the jail and renamed into place, so a copy that
fails half-way leaves no partial `node_modules` for the next run to trust.
A `node_modules` that git tracks is left alone. One the repo does not ignore is
still provisioned, carrying its own `.gitignore` (`*`) inside the placed tree so
it stays out of the diff; nothing outside the jail is changed (with
`FOREMAN_DEPS_MODE=symlink` such a repo gets nothing).
`FOREMAN_DEPS_MODE=symlink|off` overrides.

**Two-lane scheduler.** A worker slot covers admit→test; the council stage is
pure model wait and runs in a separate, capped verify lane. Work on one task now
overlaps another's review at the same `maxWorkers`. `foreman ls` and the board
show both numbers.

**Deterministic verdicts.** Every council and chair call pins `temperature 0`
and a prompt-derived seed, and the opinion cache key covers both — so a decoding
change is a cache miss rather than a silent reuse of a verdict produced under
different settings.

**Roster pre-warm.** At boot, rung-0's models are warmed sequentially and the
loop stops as soon as a load evicts a model it just warmed (measured: warming
three in parallel on this machine left exactly one resident). `FOREMAN_PREWARM=off`
skips it. `doctor` reports whether `OLLAMA_NUM_PARALLEL` lets both advisors share one load,
and which of those models were resident before its own checks loaded them
(`warm models resident before doctor pinged them: …`).

**Fast-verify tier** (`FOREMAN_FAST_VERIFY=1`, default off). The one change here
that trades thoroughness for speed. Docs/whitespace/config-only diffs under a
line threshold get one review instead of the full council; anything code-bearing
or security-adjacent gets the full council regardless of the flag, and a fast
review that does not pass falls through to the full council rather than ending
the task.


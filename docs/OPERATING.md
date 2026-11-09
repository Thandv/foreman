# Operating Foreman

Scope: running, monitoring, backing up and recovering a Foreman install. The reader is the person who runs the
daemon and decides at the gate. Command text below is checked by `scripts/checks/ops-commands.ts` (a
`foreman <cmd>` that the CLI does not have fails `npm run verify`). Every command here talks to the daemon unless
it says otherwise, and none runs inside a worker session (see [Commands](commands.md#commands)).

## Deciding on a task

| Command | What it does |
|---|---|
| `foreman approve <taskId> [--note <text>]` | Accepts the staged work. Waits for the merge (behind any landing already under way in the repo), not for the check on the merged `HEAD`, which runs on in the background. Prints `merge: <reason>` and `main check: pending`; a red main shows as `MAIN IS RED` on the timeline. |
| `foreman approve <taskId> --as-is <tree sha>` | Lands work whose tree changed after its review. The refusal prints the tree to name; naming it is the decision. Recorded as corrected unless it is the reviewed tree. |
| `foreman retry <taskId> [--note <text>]` | Requeues a task that ended (`failed`, `rejected` or `canceled`). The note is binding on the worker and on every reviewer; write what to do differently. `--skills <a>[,<b>]\|default` changes the skills for the new attempt. |
| `foreman reopen <taskId> [--note <text>]` | Puts a task that failed review back at the human gate with its work intact, for you to decide. Nothing runs again. |
| `foreman cancel <taskId> [--note <text>] [--cascade]` | Stops a queued or running task. A task that is already closed is refused. The note is recorded and never blocks the cancel. Its dependents wait in `blocked` for you to drop, land or retry it; `--cascade` fails them instead. |

`reject` and `cancel` differ: `reject` answers work that is waiting for you; `cancel` stops a task that is not decided.
Every approve, reject, cancel, retry and reopen is one row in the ledger's `decisions` table.

**What cancel does to the worktree.** Cancelling a running task ends its run, and a worktree that run created is removed
with it, unless the run had already reached its review: reviewed work that is cancelled is kept on disk for you to
inspect (`src/scheduler.ts`, the `keepJail` branch). Cancelling a queued task removes nothing: a worktree kept from an
earlier attempt (after a stop or a timeout) stays. A worktree that a cancel leaves behind is removed later by
`foreman prune` and by the retention sweep (`FOREMAN_JAIL_RETAIN_DAYS`, `FOREMAN_FAILED_JAIL_RETAIN_DAYS`). Cancelling
a parent also cancels its descendants.

## Housekeeping

- **Prune.** `foreman prune [--days N] [--keep-deps N]` removes worktrees and branches of finished tasks (approved
  work only once it has landed), trims receipts and verdicts of closed tasks older than `--days` (default 90) and
  keeps the newest `--keep-deps` dependency caches (default 5). It prints what it removed and what is still awaiting a
  decision.
- **Backup.** `foreman backup [--to <dir>]` takes one verified, gzipped copy of the database now, with or without the
  daemon (the copy is read through a read-only connection). The daemon also takes one a day; it keeps 7 dailies and 4
  weeklies, in `FOREMAN_BACKUP_COPY_DIR` too when that is set. Set `FOREMAN_BACKUP_COPY_DIR` to a second disk: a
  backup next to the database does not survive that disk, and Foreman warns when both are on one disk.
  `FOREMAN_BACKUP=off` turns the daily one off.
- **Restore.** `foreman restore <file.gz>` replaces the database with a backup. It refuses while the daemon runs and
  when the file fails its integrity check or is not a Foreman database (no `tasks`, `runs` or `events` table), and it moves the current database aside as `foreman.db.before-restore-<timestamp>` rather than deleting it.
  Stop the daemon first (`foreman stop`), restore, then `foreman serve`.
- **Doctor.** `foreman doctor` probes the models, runners, agents and budget, and runs a scratch-jail check that the
  suite wrapper a worker uses works from inside a jail. `--bench` scores each local model and re-points the roster;
  `--latency [--n N]` prints median and p90 time per stage over the last N runs (default 20). These two read the
  database directly and need no daemon.
- **Hold new work.** `foreman hold --reason <text>` stops the daemon claiming queued tasks; `foreman resume` lifts the
  hold, and the next tick claims again. Everything else in each tick keeps running: work already running finishes,
  schedules still queue their batches, the owner gate still decides, blocked tasks are still reconciled, and the
  re-checks (provisional reviews, red mains, dirty checkouts) still run. The hold and its reason are in `GET /api/state`
  (`dispatchHold`, `null` when there is none), and setting or lifting it records a status event. It is kept in memory
  only: a daemon restart clears it. It is not the pause `foreman stop` makes, which stops every stage.
- **A crash mid-merge.** A daemon that dies while an approval is merging leaves a `landings` row. At the next start
  that repo is listed in `GET /api/state` (`landInterrupted`: repo, task id, when its merge began), the ticket's
  timeline carries a `land-interrupted(<repo>)` warning, and every `blocked` dependent in that repo stays blocked. The
  merge may or may not have happened: check the checkout (`git status`, `git log`), finish or undo the merge by hand,
  then run `foreman land-clear <repo>`; the next tick releases the held work. It is kept until you clear it, across
  restarts.
- **A crash, and a crash loop.** Each start writes a `daemon_starts` row, and an orderly stop (`foreman stop`, or a
  signal the daemon shuts down on) marks it `clean_exit` last, so a stop that runs out of time counts as a crash. After
  a clean stop, recovery is unchanged. After a crash, one task in flight is taken as the likely cause: its attempt is
  spent, and when none are left it fails with `in flight across N daemon crashes`, N being the crashes in a row since
  the last clean stop. Several tasks in flight cannot be told apart, so each gets its attempt back as a daemon stop
  does, and shares that count: past 3 such requeues the ticket goes to `awaiting-human`. Two or more starts after a
  crash within 10 minutes, with other than exactly one task in flight now, start the daemon under the dispatch hold
  above, its reason beginning `crash loop:`; find the cause, then `foreman resume`.
- **Restart.** There is no `restart` command. Run `foreman stop` (it waits up to 90 seconds for in-flight work to wind
  down, then reports the daemon still shutting down) and then `foreman serve`. Under launchd, the plist
  `foreman service` prints sets `KeepAlive` to `SuccessfulExit = false`: launchd restarts the daemon only after a
  crash (a non-zero exit, as an uncaught exception gives), not after `foreman stop` (SIGTERM, a clean exit 0). So after
  a stop the daemon stays down; start it again with `launchctl kickstart` or `foreman serve`, and unload the job when
  it must not come back, as for a restore. The plist carries every `FOREMAN_*` variable set in the shell where you ran
  `foreman service` (values XML-escaped), plus `PATH` and `HOME`, and `FOREMAN_HOME` as an absolute path. Variables
  whose names look secret (a `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `AUTH` name segment) are
  left out, so no secret lands in clear in the plist; a warning on stderr names each one and never prints its value.
  Foreman has no way to load such values from a file, so features that need them (gateway models need
  `FOREMAN_GATEWAY_KEY`; the trace sink needs `FOREMAN_TRACE_KEY`) work only when you start the daemon by hand with the
  variable set (`FOREMAN_GATEWAY_KEY=... foreman serve`). The plist names `node` by its stable Homebrew path
  (`/opt/homebrew/bin/node`) rather than the versioned Cellar path when both are the same binary, so `brew upgrade node`
  does not break it. Set your settings before running it, and regenerate and reload the job after changing them. A stop
  is not a verdict on work in flight: running tasks go back in the queue, with their worktrees kept.

## Debug logging

Set `FOREMAN_DEBUG=1` in the daemon's environment (in the launchd plist's `EnvironmentVariables`, then reload the job) and read the lines tagged debug in `<home>/daemon.err.log`. Unset it to turn them off.

## Reading a failed run

1. `foreman show <taskId>`: the status, the `error:` line, the council's verdicts and each reviewer's critique, the
   decisions recorded on the task, and the last 25 timeline events.
2. `foreman trace <taskId>`: the full JSON reconstruction, for what `show` cuts.
3. Read the **note** before the code. The `error:` line is the note of the task's latest status change: for a
   `failed` task, the critique or the error that ended it. A repair round's brief opens with what ended the run before
   it (a time limit, a turn limit, a provider limit, a cancel). A run that reaches `FOREMAN_TASK_TIMEOUT_MS` is a
   timeout, not a cancel, and its worktree is kept.
4. Decide: `retry --note` when the work should run again with new instructions; `reopen` when the work is right and
   you want to decide yourself (then `approve` or `reject` it at the gate). When it is wrong and not worth another
   attempt, leave it: a `failed` task is already closed, and `reject` does not apply to it.

## Load

- `FOREMAN_MAX_WORKERS` (default 4) is how many tasks run at once.
- `FOREMAN_MAX_VERIFYING` (default twice `FOREMAN_MAX_WORKERS`) is how many may sit in review at once.
- `FOREMAN_MAX_VERIFIES` (default 2) is the suite-runner count: the cap on test commands Foreman itself starts at once,
  first come first served across all tasks (gate checks, playbook checks, the post-merge check and its re-run). A
  worker waits in line for a slot to run its own suite; that wait is not charged to its run, up to
  `FOREMAN_SLOT_WAIT_CREDIT_MS` (default 30 minutes), and a wrapper that waits longer than `FOREMAN_SLOT_WAIT_MS`
  (default 10 minutes) gives up without running the suite.
- `FOREMAN_OLLAMA_CONCURRENCY` (default 2) caps simultaneous local model calls; a call beyond it waits its turn,
  whether a worker or a reviewer made it. With local models, raising `FOREMAN_MAX_WORKERS` without it lengthens that
  wait rather than the work done at once.
- `FOREMAN_DAILY_USD_CAP` (default 5) is the spend cap per day.

Start low: four workers with two suite runners fits a laptop. Raise `FOREMAN_MAX_VERIFIES` only when suite runs are
the wait and the machine has cores to spare. Settings are read at `foreman serve`; restart to change them. See
[Configuration](configuration.md) for the full list.

## Traps

- **A jail cut before a gate change fails the new gate.** A worktree is cut from the repository's `HEAD` when the run
  starts, and Foreman does not rebase or re-cut it. If the test command, a test file or the gate itself changed on
  `main` afterwards, the run's checks use the old files and can fail against the new rules. The run log says
  `jail is <n> commits behind main` and the failure note says the failing tests may be ones `main` has since changed.
  A new attempt after a failure cuts a new worktree (only a `claude-code` repair round resumes the kept one), so
  `retry` picks up the current `HEAD`. See [Lifecycle](lifecycle.md).
- **Scratch daemons evict Ollama models.** `foreman serve` warms the first-rung models at boot, and that loads them
  into memory. A second daemon on another `FOREMAN_HOME` and port, started to try something, does the same and can push
  out the models the real daemon had resident. Start scratch daemons with `FOREMAN_PREWARM=off`.
- **`kind=writing` lands nothing.** Only `--kind code` merges on approval; other kinds (`writing`, `research`,
  `general`) are approved without a merge, and the CLI prints `NOT MERGED` with the path of the work. Land it by hand,
  or requeue it as `--kind code`.
- **A shell-runner prompt is the command.** With `--runner shell` the ticket's prompt text is run verbatim as a shell
  command in the worktree, with no model between you and it. Write only a command; prose will be executed as one. It
  runs confined to the worktree only when the sandbox is on (see [Security](security.md)).

# Foreman — parallel agent mission control

Drop N tasks into a queue. Foreman runs them **simultaneously** in isolated workers, verifies
each result with a **multi-model council**, and parks everything at a human gate. By default nothing merges,
nothing lands, until you click (an opt-in owner gate can approve for you).

Foreman is **dependency-free at runtime**: Node built-ins only (`node:sqlite`, `node:http`, native
TypeScript execution). `typescript` and `@types/node` are dev-only.

## Requirements

- macOS 14+ or Linux. On Linux the test sandbox is unavailable, so set `FOREMAN_SANDBOX=off` first (see
  [Safety model](#safety-model)); the sandbox is macOS-only (`sandboxAvailable()` in `src/security/sandbox.ts`).
- Node of the version in `.node-version` (24).
- git.
- The `claude` CLI, for the `claude-code` worker.
- Ollama, optional: local models for the council and local-only mode.

## Install

```bash
git clone https://github.com/Thandv/foreman.git && cd foreman
npm ci          # dev-only dependencies
npm link        # puts `foreman` on your PATH
```

Quick start repeats these three steps, then starts the daemon.

## Quick start

Needs Node 24 or later and git (`.node-version` pins 24).

```bash
git clone https://github.com/Thandv/foreman.git && cd foreman
npm ci                     # dev-only dependencies (the TypeScript compilers)
npm link                   # puts `foreman` on your PATH (package.json `bin`)
foreman serve              # daemon + board on http://127.0.0.1:4100; startup prints `home <absolute path>` (the resolved `FOREMAN_HOME`; the `foreman up` line names the db)
```

`foreman serve` exits 0 after a SIGINT, SIGTERM or SIGHUP (an orderly stop: in-flight work is drained, the lock is released;
in-flight merges, then runs, get up to a minute each; past that it says so, kills the runs' process groups and exits
anyway), 1 when it refuses to start (sandbox self-test, a held lock, a port in use) and 1 after an uncaught
exception, also one that arrives during a signal's stop. It records the first uncaught exception as an `error` event and
then stops the same orderly way (`src/daemonGuard.ts`); the next ten are only written to stderr. An unhandled promise
rejection does not stop it: it is written to stderr, recorded as an `error` event at most once a minute per message (the next
record carries the count it suppressed), and the daemon keeps running.

`npm link` writes to npm's global prefix. With a system-installed Node that may be a directory you
cannot write to; set a user prefix first, e.g. `npm_config_prefix=~/.npm-global npm link`, and put
`~/.npm-global/bin` on your PATH. If port 4100 is taken, start with `FOREMAN_PORT=<port>` (and keep it
set for the other commands) to move the board.

Open <http://127.0.0.1:4100> for the board. In a second terminal:

```bash
foreman demo               # seed a batch of echo-runner tasks; nothing prints while they run
foreman doctor             # what models, runners and agents are actually available
foreman stop               # stop the daemon and wait for it to exit
```

`demo` only queues the tasks and prints their ids and the board URL; watch them run on the board or with
`foreman watch`. One demo task ("Broken migration check") fails on purpose; `foreman ls --all` shows
it. `doctor` can take a few minutes when local models are slow to answer, as when memory is short: each
model that does not answer waits up to 45 seconds, and the model checks stop after 4 minutes. It prints
that first.

Without `npm link`, use `alias foreman='node /path/to/foreman/src/cli.ts'`, or run
`node src/cli.ts <command>` from the checkout. Every `foreman …` command in this README is the same
as `node src/cli.ts …`. In `doctor`, `verify lane N/M` is the number of tasks parked for review
against the lane's size (`FOREMAN_MAX_VERIFYING`, default twice `FOREMAN_MAX_WORKERS`); it is not
`FOREMAN_MAX_VERIFIES`, which caps the test commands Foreman spawns at once.

> Deviation from the original plan: it specified pnpm + Fastify + better-sqlite3. Node ships
> stable `node:sqlite`, a test runner and TS type-stripping — so the same architecture is built
> on built-ins.

## Daily operation

- `foreman add` queues a task; `foreman ls` and `foreman watch` show progress; the board shows everything.
- Each finished task waits at the gate. Read the result and the council's verdict, then `foreman approve <id>` or
  `foreman reject <id>` (or click on the board). `foreman retry`, `reopen`, `cancel` and `rm` cover the rest.
- `foreman doctor` shows which models, runners and agents are available; `foreman stop` stops the daemon.
- Every command is listed in [docs/commands.md](docs/commands.md); settings are in [docs/configuration.md](docs/configuration.md).

## Safety model

In brief; the full text is [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

- **Sandbox.** `FOREMAN_SANDBOX` is `off`, `tests` or `all`; unset means `tests` (`sandboxMode()` in `src/security/sandbox.ts`).
  It runs test commands, playbook checks, `shell` tasks, the `api` runner's shell and tool calls and the post-merge
  check under macOS `sandbox-exec`: they write only their jail and a private temp/home, read nothing a person owns, and
  cannot open the control port. `FOREMAN_SANDBOX_ALLOW=fsevents` lets file watching work inside it (off by default);
  see [The sandbox](docs/security.md#the-sandbox-foreman_sandbox).
- **`all` behaves as `tests`.** It is accepted, but the claude-code worker is not sandboxed yet
  (header comment of `src/security/sandbox.ts`). A claude-code worker runs as you, with your files and the daemon's API in reach.
- **Linux.** There is no sandbox: `sandboxAvailable()` answers that it needs macOS `sandbox-exec`
  (`src/security/sandbox.ts`), and with the sandbox on the command is not run (`sandboxState()`) and `foreman serve`
  refuses to start. Set `FOREMAN_SANDBOX=off` to run without any sandbox.
- **The API is unauthenticated.** It binds loopback only (`127.0.0.1`) unless `FOREMAN_ALLOW_REMOTE=1` is set
  (the `LOOPBACK` check in `src/server.ts`). Approve takes no proof of who is calling: anything that can reach the port can approve a
  task, and the route records the caller as `human` (the approve route in `src/server.ts`).

## Known limitations

The same list as [docs/limitations.md](docs/limitations.md), kept here because `foreman improve` reads this
section as evidence; `test/readme-limitations-copy.test.ts` keeps the two equal.

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
- The approve endpoint takes no proof of who is calling, and the route records the caller as `human`.
  The `x-foreman-run` header on `POST /api/verify-slot` is not authenticated: anything that can
  reach the port may send any run id. The API binds loopback only unless `FOREMAN_ALLOW_REMOTE=1`.
- Until workers are sandboxed, a worker can write the real repo's `.git/config`, `hooks/`, `info/` or a
  `refs/replace`/`refs/notes` ref by path. Foreman only detects that (a baseline taken at jail creation, compared
  at collection and at landing; docs/security.md) and holds or refuses for a person; it restores nothing. The
  baseline is a file the unsandboxed worker could rewrite too, as could the worker-suite line's mtimes.
- The recurrence language is not cron (see `schedule`); missed windows fire once, not once per
  window elapsed.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Operating Foreman](docs/OPERATING.md) · [The lifecycle](docs/lifecycle.md) · [The board](docs/board.md) · [Assistant mode](docs/assistant-mode.md) · [Crews, the model roster and personas](docs/crews.md) · [Tool forge](docs/tool-forge.md) · [Self-improvement](docs/self-improvement.md) · [Alignment](docs/alignment.md) · [Speed and consistency](docs/speed-and-consistency.md) · [Runners and local-only mode](docs/runners.md) · [Retiring the cloud reviewer](docs/retiring-the-cloud-reviewer-on-evidence.md) · [Who does the work](docs/who-does-the-work-and-where-closed-work-goes.md) · [Model plane, sensitivity and budget](docs/model-plane-sensitivity-and-budget.md) · [Agents](docs/agents.md) · [Skills](docs/skills.md) · [Commands](docs/commands.md) · [Configuration](docs/configuration.md) · [Security](docs/security.md) · [Known limitations](docs/limitations.md) · [Tests](docs/tests.md) · [License and contributing](docs/license-and-contributing.md)

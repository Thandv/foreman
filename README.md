# Foreman — parallel agent mission control

Drop N tasks into a queue. Foreman runs them **simultaneously** in isolated workers, verifies
each result with a **multi-model council**, and parks everything at a human gate. Nothing merges,
nothing lands, until you click.

All eleven phases of the original build plan are implemented — v1 (0–5: the queue,
isolation, council, routing, board, memory) and v2 (6–10: tool forge, assistant
mode, self-improvement, alignment, model roster). Foreman is **dependency-free at runtime** —
Node 24+ built-ins only (`node:sqlite`, `node:http`, native TypeScript execution). `typescript`
and `@types/node` are dev-only.

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

## The sandbox (`FOREMAN_SANDBOX`)

Moved to [docs/security.md](docs/security.md#the-sandbox-foreman_sandbox), including `FOREMAN_SANDBOX_ALLOW`.

## Known limitations

The same list as [docs/limitations.md](docs/limitations.md), kept here because `foreman improve` reads this
section as evidence; `test/readme-limitations-copy.test.ts` keeps the two equal.

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

## Documentation

[The lifecycle](docs/lifecycle.md) · [The board](docs/board.md) · [Assistant mode](docs/assistant-mode.md) · [Crews, the model roster and personas](docs/crews.md) · [Tool forge](docs/tool-forge.md) · [Self-improvement](docs/self-improvement.md) · [Alignment](docs/alignment.md) · [Speed and consistency](docs/speed-and-consistency.md) · [Runners and local-only mode](docs/runners.md) · [Retiring the cloud reviewer](docs/retiring-the-cloud-reviewer-on-evidence.md) · [Who does the work](docs/who-does-the-work-and-where-closed-work-goes.md) · [Model plane, sensitivity and budget](docs/model-plane-sensitivity-and-budget.md) · [Agents](docs/agents.md) · [Skills](docs/skills.md) · [Commands](docs/commands.md) · [Configuration](docs/configuration.md) · [Security](docs/security.md) · [Known limitations](docs/limitations.md) · [Tests](docs/tests.md) · [License and contributing](docs/license-and-contributing.md)


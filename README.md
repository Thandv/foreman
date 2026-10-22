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

## The lifecycle

```
queue → admit → isolate → plan/work/test → verify → gate → merge
         │        │                          │        │
      security  worktree                  council  your click
       scan      jail                     + tests
```

1. **admit** — the task (and any agent definition) is scanned. A blocking finding refuses the
   task outright and is **not configurable**. Uses `frisk-scan` when installed; the built-in
   ruleset always runs.
2. **isolate** — a code task with `--repo` gets a **git worktree on its own branch**, outside your
   checkout, one branch *per run*. Everything else gets a scratch directory. A repo with
   uncommitted changes is refused and never retried.
3. **work** — the runner drives the task, streaming stage, log, progress and token events.
4. **test** — the project's own test command (detected, or `--test-cmd`) must pass. A failing
   suite fails the task **without paying for the council**.
5. **verify** — two *different* models review the diff against a per-kind rubric. Agreement is
   the verdict; **disagreement escalates to a chair** that reads both arguments. A council that
   cannot be reached returns `split`, never a pass. The same holds for a crew review chain: one
   reviewer's fail fails the ticket, and a reviewer whose call errors or times out can never give a
   pass, so a chain whose other reviewers all passed is recorded as `split` and parked for you, with
   the lost reviewer's error on the timeline (a council `fail` still stands and gets its repair
   round; a chain that lost every reviewer leaves the council's verdict to stand). Checks only a person can run (live in a browser
   or app, visual, or acceptance items marked `(operator)`) are yours at the gate: reviewers never
   fail a headless worker for not running them.
6. **gate** — `fail` gets one repair round with the critique fed back to the worker, then fails
   for good. `pass`/`split` park at `awaiting-approval` for you. A rejection's note, and a
   `retry --note`, become **operator demands**: binding on every later reviewer and the chair,
   and only you can waive one. A review is advice to the gate: `foreman reopen <id>` puts a
   review-failed task back at `awaiting-approval`, work intact, when you have verified it yourself.
7. **merge** — approving a code task merges its branch `--no-ff`. It refuses on a dirty repo and
   aborts cleanly on conflict; your checkout is never left mid-merge.

### Three outcomes of the test stage that are not "a test failed"

Each of these parks the ticket at `awaiting-approval` for a person, with the reason as the gate
note. No reviewer is called, no verdict is written, no repair round is spent, and the owner-model
gate never approves one: besides the note, a gate that timed out twice or failed is recorded on the
run as checks that did not pass, and a code run with no recorded diff is held as such, so a later
re-review or a rewritten note does not hand one to the owner model.

- **Nothing to change.** A code run in a repo that ends well with an empty diff runs no test
  command and no reviewer. The gate note is
  `no change produced — approve to close as "nothing to change", or reject with what is missing. Worker said: <last 600 characters of its summary>`.
  Approving marks the ticket `done` with merge reason `closed: nothing to change`; nothing is
  merged (the landing checks still run, so a worktree that gained changes after the park is refused
  as work that changed after review). A conflict-repair round with an empty diff is abandoned as
  before.
- **The gate timed out.** A test command that Foreman kills at `FOREMAN_TEST_TIMEOUT_MIN`, or
  whose own last line says `TIMEOUT` (`verify: TIMEOUT after 1200s`; npm's notices after it are
  skipped), with nothing in the output that says a test or check failed (TAP `not ok`, `✖`, a
  `failing tests:` section, a closing `fail N` count, `verify: FAIL`, and the failure lines of
  pytest, cargo, go, jest, vitest, mocha and tsc), is run **once** more through a verify slot. If the second run passes, the run goes on to review
  and its timeline carries `first gate run timed out, second passed`. If it fails a test, that is
  a failure as usual. If it times out again the gate note is
  `gate timed out twice (<N> s each); not charged to the worker — started and not finished: <tests>`
  (or `cannot tell which test did not finish`) followed by the end of the output; the run's checks
  are recorded as not passed. The test stage can therefore take twice the timeout; the re-run's
  time does not count toward the run deadline (it is still killed at `FOREMAN_TEST_TIMEOUT_MIN`).
  Playbook checks are not re-run.
- **The jail is behind main.** When the test stage starts on a jail whose base is not the repo's
  `HEAD`, the run log says `jail is <n> commits behind main; <m> of them change test files: <up to 5 paths>`.
  "Test files" are paths under `test/`, `tests/`, `__tests__/`, `spec/` or named `*.test.*` /
  `*.spec.*`, files the test command names (`npm run verify` → `scripts/verify.sh`), and
  skip lists such as `test-skips.txt`. If the tests then fail and `m > 0`, the failure note to the
  worker and at the gate starts with that line and
  `the failing tests may be ones main has since changed: compare before repairing`. If every
  failing test file the output names is one of those changed paths and the run's own diff changes
  none of them, the ticket parks with that note instead of repairing; if the output names no
  failing file, or the ticket itself changed one, it is repaired as usual with the note. Foreman does not rebase or re-cut the jail.

A test command, a playbook check, the post-merge check and a shell ticket's command do not inherit
`FORCE_COLOR`, `NO_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `NODE_DISABLE_COLORS` or `COLORTERM` from
the daemon, so a suite prints the same whatever started the daemon. `TERM` is passed on.
`FOREMAN_TEST_KEEP_ENV=FORCE_COLOR` passes one through to test commands.

### A worker's `FOREMAN_HOME`

A daemon started with a relative `FOREMAN_HOME` (`.foreman`) resolves it once, at start (`src/config.ts`
writes the absolute path back into its own environment). `claudeWorkerEnv` and `workerEnv` set a worker's
`FOREMAN_HOME` to that resolved `config.home`, never the inherited text: a relative one resolves against the
worker's cwd, its jail, and the sandbox then refuses the suite run with `the run's jail (…) contains Foreman's
home`. Inside a worker run the CLI is refused (see Commands), so a worker's `foreman` command does not reach the ledger
by accident.

When a freeze recorder is installed (`src/runners/freezeRecord.ts`), `LeftoverReaper` writes the process groups it
is about to SIGSTOP to `<FOREMAN_HOME>/frozen/` first and forgets them once the reap has settled. If that write is
refused (a FAILED recorder, or a sandbox that keeps a jail out of Foreman's home), nothing is stopped: the leftovers
get SIGTERM, the grace and SIGKILL without a freeze, and the daemon log says `freeze record failed, leftovers are
ended without a freeze`. Foreman's own processes always install one (below); only code that uses `LeftoverReaper`
without one (a library caller, a test) writes nothing, and its reap is as it was before the record existed.

Foreman's own processes install the recorder (`src/runners/freezeInstall.ts`) for the absolute `FOREMAN_HOME` and write a
presence marker there: every `foreman` command (after the worker ledger guard, so a refused command writes nothing),
`foreman serve` (after its start-up sweep below, so its own marker is never read by it), and `src/verify/testSlot.ts`.
The marker is removed at a clean exit. A process ended by a signal it does not handle (Ctrl-C of `foreman watch`, a
SIGTERM, a SIGKILL) leaves its marker, and the next `foreman serve` sweep removes it with any other dead recorder's
files. The process's identity is its pid and its zone-free start time; if that cannot be read, the recorder is FAILED.
A worker's `testSlot.ts` is not itself sandboxed in this build (the `claude-code` worker is not; see below), so it
records like any other Foreman process: its marker, and the suite's leftover groups it freezes, go in the daemon's
home, which its `FOREMAN_HOME` names. The suite it runs is in the `tests` sandbox, which closes Foreman's home. A
recorder in a process that cannot write Foreman's home or read its own start (one inside the sandbox: the home is
closed and, on macOS, `ps` is refused) is FAILED: it prints `foreman: freeze recorder not installed (…); leftover
process groups of commands run here are ended with SIGTERM and SIGKILL without being frozen first` on stderr, the
command runs and its result is unchanged, and its leftovers are ended without a freeze. No variable is added to a
worker's env.
Foreman's own suite run under `testSlot.ts` never records into the daemon's home: `test/env.ts` gives every test
process a temp `FOREMAN_HOME`. Its process guard (`test/helpers/procguard.ts`) still watches the real homes' `frozen/`,
and counts only what the test itself can have done there: records of live processes that are not the test's (the
markers of `foreman` commands run meanwhile, the daemon's recorded groups) are left out, and a `frozen/` the suite may
not list (a sandboxed run) is not watched.

`foreman serve` sweeps `<FOREMAN_HOME>/frozen/` once, after taking the daemon lock and before the scheduler starts
(`src/runners/freezeSweep.ts`, reading with `freezeRead.ts`): groups a dead recorder left stopped are ended. A group is
signalled only when a fresh process snapshot shows one of its recorded members with the same pid AND start, still in
that group; never a group a live recorder holds, pgid 0 or 1, the daemon's own group or an ancestor's. It sends SIGTERM
then SIGCONT, waits the grace (2 s), takes a second fresh snapshot, sends SIGKILL only to the groups it still matches,
and then removes the record. If that second snapshot is null or throws, no SIGKILL is sent, the record is kept for the
next start, and the log says so. A dead recorder's record with nothing left to signal (no groups, no group that still
matches, or only groups not to be touched) is removed at once; a record that cannot be read is skipped and left. A
`<record>.json.tmp` that a dead recorder left between its write and its rename is removed unread (a regular file only);
a live recorder's is left. If `frozen/` is not a directory owned by this user, or is group- or other-writable, the
sweep logs it and does nothing. At
most 64 files are read per sweep; the reader's cursor is kept in `<FOREMAN_HOME>/frozen/cursor` (mode 0600; an invalid
one starts over). The whole sweep is capped at the grace plus 5 s of wall-clock time: an error or an overrun is logged
(`freeze sweep failed: …`, `freeze sweep: gave up after … ms`) and serve starts regardless. `FOREMAN_FREEZE_SWEEP_GRACE_MS`,
`FOREMAN_FREEZE_SWEEP_CAP_MS` and `FOREMAN_FREEZE_SWEEP_FAULT=hang|throw` (for tests) shorten the timings or make the
snapshot hang or throw.

Out of scope and unchanged: a worker can still reach the daemon's HTTP API through `FOREMAN_PORT` (the
`x-foreman-run` header is unauthenticated), and an unsandboxed `claude-code` worker can still open
`<home>/foreman.db` directly (`node:sqlite`, `sqlite3`). `FOREMAN_SANDBOX=all` is meant to close that, but in this build
it behaves as `tests` and the `claude-code` worker is not sandboxed, so nothing closes it yet.

### A worker's own suite run, and the run deadline

A `claude-code` worker runs the full suite through the slot wrapper,
`node <foreman>/src/verify/testSlot.ts [-- <cmd>]`, which takes one of the `FOREMAN_MAX_VERIFIES`
slots from the daemon and runs the command while it holds it.

- **One suite run per ticket at a time.** The worker session carries `FOREMAN_RUN_ID`; the wrapper
  sends it, and the daemon refuses a second request for the same run while the first is open. The
  second invocation runs nothing, takes no slot and exits **4** with
  `testSlot: a suite run for this ticket is already in progress (started <N> s ago, pid <p>); wait for it — its full output will be at <path>`.
  The claim lasts as long as the first wrapper's connection, so a wrapper that died holds nothing.
  Other tickets, and a wrapper started with no run id (by hand), are not held to each other. With
  no daemon to ask, or one started before this version, the wrapper runs as it did before and
  nothing enforces the rule. Exit codes: 0 passed, 1 failed, 2 nothing was run (refused command,
  no command, `--saved` with nothing saved), 3 no slot within `FOREMAN_SLOT_WAIT_MS`, 4 already running.
- **The output is saved, not streamed.** Every line goes to
  `<TMPDIR>/foreman-suite-output/<run>-<ms>-<pid>.log` (folder `0700`, file `0600`; never inside
  the working tree — a `TMPDIR` inside it falls back to `/tmp`). Lines reach the file within a
  second, so a wrapper that is killed loses at most that. The newest three files per run are kept,
  and anything in the folder older than seven days is removed. Nothing is printed while the suite
  runs; at the end the wrapper prints the last 20 lines (40 when it failed), then the failing
  tests, then `testSlot: full output saved to <path> (<n> lines)`. The file is what Foreman's
  line reader passes on: blank lines are dropped, a line over 1 MB is split, bytes that are not
  UTF-8 are replaced. `testSlot.ts --saved` prints this run's newest saved output and runs nothing
  (exit 2 when there is none). The folder is shared by every ticket while workers are unsandboxed.
- **A worker's wait for a slot is not charged to its run**, up to `FOREMAN_SLOT_WAIT_CREDIT_MS`
  (30 minutes for the whole run; `0` gives none). Past that the run's clock runs again even while
  the wrapper is still waiting. The `x-foreman-run` header is not authenticated: any local
  process that can reach the daemon can stop another run's clock (up to that cap), or hold a
  run's claim so its wrapper exits 4 for as long as the connection stays open.
- **A run that reaches `FOREMAN_TASK_TIMEOUT_MS` is a timeout, never a cancel.** The run ends
  `failed` and the task is requeued while attempts remain
  (`attempt <n> failed: run deadline (<N> min) reached during <stage>; <M> min queued were not counted`),
  or `failed` with that message after the last one. Its worktree is kept. The next attempt starts
  in a new worktree; a repair round on `claude-code` resumes its session in the kept one, and the
  whole tree is diffed, guarded and reviewed as usual. The notes of a repair round open
  with what happened to the run before, from that run's record: `Your previous run reached its time
  limit during its <stage> stage; nothing was rejected. …` after a deadline (likewise a turn limit,
  a provider limit, a cancel, an error, a pre-review repair, a park the operator sent back). A round
  after a red test stage opens `The project's tests failed at the gate (<cmd>); nothing was reviewed yet.`
  Only a round that follows a reviewer's `fail` opens `… was REJECTED by the verification council`. A task requeued this way does not fail its
  dependents; one that ends `failed` gives them `dependency <id> ended as failed`, and
  `foreman retry <id>` revives them. A core-guard, admission or sensitivity refusal, and a budget
  hard-stop, keep their own outcome when they coincide with the deadline. An operator cancel and a
  daemon stop are unchanged.

## The board

`http://127.0.0.1:4100` — five lanes (Queue · Working · Yours to do · Your call · Closed), a worker-pool gauge
and today's spend. Cards show a live stage rail, progress bar and verdict chip. Click one for the
drawer: **Activity** (live log), **Council** (every advisor's verdict, confidence and critique,
plus the chair's reasoning), **Artifacts** (coloured diff viewer), **Receipts** (per-call tokens,
cost, latency, local-vs-cloud), **Prompt** — and Approve / Reject / Cancel / Retry.

## Assistant mode

```bash
foreman ask "Summarise last week's commits and draft the release note"      # plan it
foreman ask "..." --yes                                                      # queue the plan
foreman schedule add "morning triage" --spec "daily 07:30" --ask "triage my inbox"
```

A planner turns a request into a task DAG — kinds, runners, dependencies, and
any tool that must be built first — and shows it. Nothing is queued until you
confirm. An unreachable planner degrades to a single task rather than an error.

Memory grows with use: every run leaves an episode, every gate decision leaves a
preference ("rejected: you touched unrelated files again"), and recall is
relevance-ranked with preferences outranking episodes. `foreman memory
consolidate` compacts episodes into durable facts — and refuses to retire what
it could not compact.

## Crew mode

```bash
foreman crew init                          # install the seed playbooks
foreman playbooks                          # list loaded playbooks + refusals
foreman build "add token auth to the api"  # classify → epic of role-assigned tickets
foreman build "write a novella about ..." --auto
foreman build --from-epic t_abc123        # clone a past epic, zero planning tokens
foreman build "..." --gate owner          # let the owner model approve its own crew's green work
foreman build "..." --revise               # one revision round when the senior critic calls the plan risky
```

A **playbook** makes Foreman run an ask the way the matching real-world
organization would: `software` (dev/senior/qa/architect; code review by a senior and, concurrently, an architect who is served `review-architecture` and `security-review`), `publishing`
(author/dev-editor/copyeditor/beta-reader/critic…, editorial letters), `investment` (analyst,
devil's-advocate senior, independent risk — analysis only, never execution),
`research` (assistant/researcher, internal + peer review). Playbooks are
markdown files with JSON front matter under `$FOREMAN_HOME/playbooks/`,
admission-scanned like agents; roles map to model tiers — owner
(`FOREMAN_MODEL_OWNER`, default `opus`; `fable` is deprecated but still honoured when pinned) plans, chairs escalations; senior
(`opus`) reviews and challenges; worker (`sonnet`) executes.

A reviewer entry may carry its own `skills`: `{"role": "lead", "style": "code-review", "skills": ["a", "b"]}`.
Names are checked like a ticket's skills (a valid name, a loaded skill, in that
role's default or allowed loadout, at most two); with `FOREMAN_SKILLS_DIR`
unset only the shape and the name are checked. A bad list never refuses the
playbook: malformed names are dropped, a list that is not an array or has no
valid name gives no skills (never the role's default), a well-formed name the
catalog will not serve is kept on the list (crew review checks it again against
the catalog as it is when it serves, so a skill added later is served without a
restart), and each problem comes
back as a `warnings` entry on the load result naming the playbook, the
reviewer's index and role, and the skill. The daemon logs each distinct warning
once per process when it loads the playbooks; `foreman playbooks` (next to its
refusals) and `foreman build` (before the plan) print them; a name that is not a well-formed skill name is printed quoted, cut to 80 characters, with anything unprintable shown as `?`. Leave the key out and the reviewer is
unchanged: its prompt carries its role's usual skills, byte for byte as before.
With the key, the review prompt carries exactly those skills (full text, bounded by
`FOREMAN_SKILL_BRIEF_BYTES`) and `skills: []` carries none. A listed skill the catalog
refuses or lacks is left out and the rest are served; if none can be served, or the
catalog cannot be read, the prompt has no skills block, and the role's default never
stands in. Either way the review runs, and a `status` event on the ticket,
`crew review skills {…}`, records the reviewer's role, the skills served and each name
left out with its reason (the same JSON as a run's `skills` event, but not that event
type, so the debrief and a resumed round's skills check do not read it). The review
cache key (`crew_review_cache`) covers the reviewer's role, style and skill list as well
as the model and the prompt, so two reviewers on the same model and diff, such as an
architect and a senior on the senior tier, never replay each other's verdict. That key
is new: after a rollout every cached review misses once, which costs one paid re-review
for each ticket in flight.

With `--repo`, the planner and the plan critic get a zero-token repo snapshot
(tracked files, the README, and any file the ask names) — they have no tools,
so without it they plan blind. Planning has its own timeout
(`FOREMAN_PLAN_TIMEOUT_MS`, default 8 min).

The senior's review of a plan is kept, not only printed. Each note that names a
ticket — by its plan label (`t4`, `t4/t5`, `t1-t6`) or its title — is put at the
end of that ticket's brief under `PLAN REVIEW NOTE (from the senior's review of
the plan; the brief and acceptance outrank it; say in your report how you
handled it)`, where the ticket's worker and its reviewers both read it. A note
that names no ticket of the plan is recorded on the epic. Each note is one line
of at most 600 characters (a cut is marked), and `foreman build` prints under
the review where every note went, including one it could not match to a ticket.
With `--revise` the first review goes to the planner and the notes kept are
those of the review of the revised plan.

Only a `code` ticket merges on approval and has the repo's suite as its gate. So
in a repo with a test command of its own, a ticket planned as `writing` whose
deliverable is a file in that repo (a README, `docs/`, an ADR, help text) is
queued as `code`, and the printed plan says so on the ticket: `kind writing →
code (deliverable is a file in a gated repo)`. A manuscript (no test command), a
plan under a playbook whose reviewers do not review code (publishing, research)
or a plan with no repo keeps `writing`. And `foreman approve` on a ticket that does
not merge ends with `NOT MERGED: …`, naming the worktree its work is still in.

Headless `claude-code` workers cannot have a command approved, so they get a
scoped shell allowlist (`npm run`, `npm test`, `npx tsc`, `node --test`, the
ticket's test command, read-only git) and are told so in their brief; other
tools go through an `npm run` script that lands in the reviewed diff.
`FOREMAN_CLAUDE_ALLOWED_TOOLS` (`;`-separated, or `none`) replaces the list.

A `claude-code` worker does not run as your own CLI. It gets its own config
directory (`CLAUDE_CONFIG_DIR`, under `$FOREMAN_HOME/claude-config` or
`FOREMAN_CLAUDE_CONFIG_DIR`) holding a Foreman-written `CLAUDE.md`, only the
project's settings (`--setting-sources project`), no MCP servers
(`--strict-mcp-config` with an empty config), no auto-memory and no `CLAUDE.md`
discovery — so nothing is written under your `~/.claude`, and your global
instructions, knowledge files and MCP servers never reach a ticket. Its
environment is an allowlist of the daemon's, not a copy: a shell and toolchain
(`PATH`, `HOME`, locale, temp dir), proxy and CA settings, what the test-slot
wrapper reads, and every `CLAUDE_*` / `ANTHROPIC_*` variable. `AWS_*` passes
only with `CLAUDE_CODE_USE_BEDROCK` on, `GOOGLE_*` only with
`CLAUDE_CODE_USE_VERTEX`; anything else a project's tests need is named in
`FOREMAN_CLAUDE_ENV_ALLOW` (comma-separated, exact names). Each ticket has
its own directory under that root (`tasks/<ticket id>`), so one ticket's session
cannot leave settings or history for another's. Sign-in is left alone: no
`CLAUDE_*` variable is removed, `--bare` is not used, and the worker is told to
read its credentials where your own CLI keeps them
(`CLAUDE_SECURESTORAGE_CONFIG_DIR`: empty for the default keychain item, or the
daemon's own `CLAUDE_CONFIG_DIR`), not in its new config directory. An `Edit` or
`Write` aimed outside the worker's jail stops the run and fails it before review.
The crew reviewer reads code diffs up to `FOREMAN_CREW_CODE_DIFF_CAP_BYTES`
(96 KB) and is told the test stage's outcome. A failing review's blockers go
into the repair round instead of being filed as tickets, and `retry` revives the
dependents a failed ticket took down, carries its final critique, and grants a
fresh repair round.

**Follow-ups a reviewer files.** A follow-up waits for the ticket it was filed on
to land and is then cut from main. It is held for a person when that ticket is
(`gate human` on the ticket is copied to it; a ticket opted in to the owner gate
does not opt its follow-ups in). Two fixed rules, no model, decide what else it
waits for: follow-ups filed on the same ticket run one at a time, in filing
order; and a follow-up waits for any other open ticket in the same repo that
names a file its brief names — in the diff that ticket's latest run recorded,
or, for another follow-up, in its brief (up to 40 open tickets are compared; a
brief that names no file is ordered only by the first rule). Each wait is on the
follow-up's timeline (`waits for t_…: both name src/helper/packages.ts`). These
waits are an order, not a dependency: when a ticket a follow-up is ordered
behind ends canceled, failed or rejected, the follow-up is not failed — the next
in line may start. Only the ticket it was filed on is a real dependency: if that
one ends failed, rejected or canceled, its follow-ups go with it
(`dependency <id> ended as …`; `foreman retry` of it revives them). Follow-ups
are ordered automatically; tickets you queue yourself are not — order those with
`--after`, which is a real dependency as before. A follow-up that asks for work no worker on this host can do — a request
to run, re-run, recapture, reproduce, test or verify something on another OS, another machine, a
phone or a Mac of another architecture (`recapture on Linux`, `test on an Intel Mac`) — is filed
as `(operator) …`, assigned to you (the board's Yours to do) and never sent to a runner; its
timeline says why (`filed for the operator: …`). It waits for the ticket it was filed on like any
follow-up, but the AI's follow-ups of that ticket do not queue behind it. A mere description of an OS (`crashes on Linux`,
`taken on macOS`, `make it work on Windows`) is an ordinary follow-up.

An owner-tier planner decomposes the ask into an epic of tickets (roles,
dependencies, acceptance criteria, points) shown before queuing. In the
verify lane, the playbook's reviewer chain reads the diff — code review,
editorial letter, devil's advocate, or peer review — memoized by prompt
hash; failures feed the repair loop, side-issues file as depth-capped child
tickets, and repeated failure or council disagreement escalates to the
playbook's chair. Epics close when their tickets do, writing a deterministic
retrospective (zero tokens) that future plans reuse as precedent.
Classification is keyword-first (free); the owner model is consulted only on
ambiguity. `FOREMAN_CREW_REVIEW=escalate` (default) skips the Claude chain
when the local council passes unanimously on a small diff; `=always` runs the
chain regardless and therefore skips the local council entirely (its verdict
would be overridden anyway, and it is serialized on the local model slots) —
the council still runs as the fallback when the chain is unavailable. Approval is yours by
default; `foreman build --gate owner` (or `FOREMAN_GATE=owner`, which a playbook
that says `human` still overrides) lets the owner model sign off tickets that
already went green — never an S2, `allowCore`, budget-stopped, failed-test or
failed-review ticket, and never anything it is unsure about, which parks for you
with its reasoning on the task timeline. `FOREMAN_GATE=owner` applies only to
tickets that park while it is set, never to a backlog that was already waiting
when you exported it — retroactive auto-approval needs `--gate owner` or a
playbook that asks for it. Gates run one at a time and stop at the daily cap.
Tickets of the same epic that reach the gate together are decided in one call,
up to five at a time — each still passes every hard-human check on its own, and
each still gets its own decision, event and durable marker; `FOREMAN_GATE_BATCH=off`
goes back to one call per ticket.

### What a reviewer is given, and what holds a pass

**The acceptance map.** A code ticket's worker ends its report with an
`ACCEPTANCE MAP`, one line per numbered acceptance item, and a check with no
model in it reads the map before any reviewer is called. A line has one of
these forms. `<test file> :: <exact test title>`, a test of this change: the
file is in the diff and the title is in a hunk that adds a line. The same
form, a test that was already there: the file is a test file in the work tree
and the title is the title of a test in it — for an item that says something
stays as it was. `(diff) <path>`: the path is in the diff; when the item does
not name that file the line is still accepted for an item the diff itself can
show, so an item that says code stayed the same can point at the file whose
diff shows it. `(operator)` or `(review)`: only for an item the acceptance text
marks that way. A short item that only says the gate passes needs no line. Two
things keep the relaxed forms from carrying a ticket: an item that asks for a
test in so many words (`(test)`, "a test pins…", "fails without the change",
"add a test for…", "a route test shows…", "is unit-tested", "Route tests: …" —
not "the existing tests pass unchanged") takes only a test of this change, and
when the diff changes code at least one item must be mapped to a test of this
change in a test file — `(diff) README.md` on every line is a gap on every
line, and `README.md :: 403` or `src/x.ts :: return` beside them is no test. Anything else is a gap, named (`unmapped`, `test
file not in diff`, `test file not in diff or tree`, `test name not found`,
`file not in diff`, `item asks for a test…`, `no changed test is mapped to any
item…`, `not exempt`), and costs a repair round with no reviewer called. What
the check cannot tell is whether a mapped test or file really proves its item:
that is the reviewer's status per item, below.

**The worker's report.** A worker's whole final message is stored once per run
as a `report` artifact, `$FOREMAN_HOME/artifacts/<run id>.report.md`, beside the
run's diff and log; `foreman show` lists it. (Over 256 KB the middle is cut and
the file says how much. The shell and demo runners write no report.) The run
row and the board still show a 4000-character copy. A crew reviewer is given the report whole up to
`FOREMAN_REVIEW_REPORT_BYTES` (24 KB); a longer one keeps its first lines and
its last lines — the acceptance map is at the end — and the cut, always between
two lines, says how many characters were dropped and names the stored file. With
no diff (a research ticket) the worker's answer is the work under review, and
the reviewers get it from the same stored text. The owner gate's prompt reads
the same stored report, its first and last lines within 6000 characters (it
used to read the first 2000 characters of the run row's copy, which never
reached the acceptance map). A line of the report that starts the way one of
Foreman's own lines does (`FOREMAN CHECK`, `--- added by Foreman…`, `SOURCE THE
DOCUMENT CITES`, …) reaches the reviewer marked `[worker's text]` — also when
it is written with a hidden character (the set a skill file is refused for),
with Cyrillic or Greek letters that print as Latin ones, with another dash, or
after a line break other than LF. It is a mark on look-alikes, not a parser:
the reviewer is told above the report that all of it is the worker's claims.

**The source a document cites.** A reviewer sees the diff, not the repo. When
the diff adds or changes a prose file (`.md`, `.txt`, `.rst`, anything under
`docs/` that is not code or config), the repo files its added lines cite —
`src/x.ts`, `src/x.ts:123`, `test/y.test.ts:10-20`, a backticked file name —
and the files the worker's report cites are read from the work tree and
attached under `SOURCE THE DOCUMENT CITES`: each numbered by its own lines, 40
lines each side of a cited line, 12 each side of a backticked name given on the
same line as the file, else the first 80 lines. The block holds at most
`FOREMAN_CITED_SOURCE_BYTES` (64 KB) and names every file it left out (the
files the document itself cites are given their room before the files only the
report names; when both cite one file and both do not fit, the lines and names
the document cites in it are the ones shown, and the block says so; past the
first 40 cited paths the rest are counted); a cited
path that is not a regular file git lists in that tree — a link, a hard link,
a FIFO, a file over 1 MB, a binary — is named as not read. A code-only diff
gets no such block. The list of tracked files is unchanged.

**"Could not check" is not a pass.** For a ticket with numbered acceptance
items a crew reviewer's reply carries a status per item: `met`, `partial`,
`missing` or `not-verifiable` (it was not shown what it needed). Items marked
`(operator)` are yours and are not asked for, nor is an item that only says
the gate passes once Foreman's own gate run has passed. Foreman reads that
list, not the prose. A reply that says pass with a `partial` or `missing` item
is recorded as a fail and goes to a repair round with a `FOREMAN CHECK` line
naming the item. A reply that says pass with a `not-verifiable` item — or with
an item it gave no status — is recorded as `split`: it parks for you with the
note `the reviewer could not verify acceptance item 3 (…) — a person decides`
(or `gave no status for acceptance items 1, 2` when the reply did not fill the
field in), spends no repair round (a worker cannot fix what the reviewer was
not shown), and is not signed off by the owner model, whatever a chair or a
local-council re-review of the same run says. Two things lift it: a retry (new
work, a new review), and a crew re-review you ask for (`foreman reverify`) in
which the reviewer does verify every item. A status may carry its evidence
(`met (asserted in the new test)`); `met as far as shown` is not a status, and
a `met` whose evidence says what was not checked counts as not-verifiable. A ticket with no numbered acceptance, the
local council, and verdicts recorded before this existed are not affected. On
the board such a card reads `held for you`, not `no verdict`, and does not
offer Re-review first (the same reviewer would give the same reply); in the
shadow-agreement ledger a pair whose cloud verdict is such a `split` is kept
and not scored.

**Pre-existing assertions.** When a run's diff modifies a test file that was
there before the run, a check with no model in it lists what a reader would
want a reason for: an assertion line removed or changed (also a later line of
an assertion written over several lines, such as the expected text on a line
of its own under `assert.equal(`), a value an assertion
checks redefined (`const saved = …` narrowed while `assert.doesNotMatch(saved,
…)` stays), a value only handed to an asserted call redefined (a fixture:
`const root = project({…})` under `assert.deepEqual(declared(root), [])`), a
test declaration removed or changed, a `.skip` / `.only` / `todo` added, a
test file deleted. A line that only moved or was re-indented is not
listed, a renamed test file is compared with what it was, and new tests and
added assertions are never listed. It is not a repair demand. The list goes to
the reviewers as a `FOREMAN CHECK` block (file, line, old and new text), and
onto the run as an `assertions` artifact
(`$FOREMAN_HOME/artifacts/<run id>.assertions.json`, shown by `foreman show`).
The reviewers are given every finding, always. A finding also holds the gate
for a person — `the diff changes pre-existing assertions: 1 in
test/preview.test.ts`, and the owner model does not sign the work off — only
when it is in a test file the ticket does not name. "The ticket" is what was
written before the run: the task's title, prompt and acceptance; never the
worker's report or diff, nor a critique of its work, nor a note given with a
retry, a rejection or any other decision (the ledger's `human` is whoever
called the route, and a pasted note is often a reviewer's). A ticket a model
wrote from what earlier runs produced is not read at all, so nothing on it is
released: a follow-up a reviewer filed (its prompt starts `Filed by …`, and
its parent is a work ticket, not an epic), a ticket a worker queued from
inside its run, and an `improve:` proposal. A file is named by its
repo-relative path, by the end of that path from a directory boundary, by an
absolute path under the ticket's repo, or by its bare file name, as a whole
word (`data.test.ts` does not name `a.test.ts`, and `src/a.test.ts` does not
name `test/a.test.ts`), in the exact case, and a renamed file by the name it
had before the run. A sentence that says to leave something as it is names
nothing — one with `do not`, `don't`, `never`, `must not`, `unchanged`,
`unmodified`, `untouched`, `must pass` or `without changing` in it, and the
list under such a line that ends in a colon: `Do not change: test/a.test.ts`
and `the tests in test/a.test.ts pass unchanged` hold that file's findings.
It is a test of words, so `in test/a.test.ts, don't pre-create b.txt` holds
them too; say what to change in a sentence of its own. Nothing the diff does
releases a hold: adding tests to
the file does not. On the ledger this holds 196 runs of 97 tickets, where
holding for every finding held 252 runs of 122. The hold is decided when the
findings are recorded and kept with them (each finding's `hold` in the JSON file; the block says it per
finding); in doubt — no task to read, 200 findings or more — it holds. A
redefined fixture alone is listed for the reviewers and is never such a hold.

`foreman crew report` reads tasks, verdicts and receipts (zero tokens) for the
per-role scoreboard: tickets delivered, first-review pass rate, average repair
rounds and cost per ticket, plus advisory tier suggestions — a worker role that
keeps failing its first review, a senior role that never does. It never edits a
playbook; the tier is yours to change.

## Tool forge

```bash
foreman tools ls | show <name> | rm <name> | quarantine <name> | release <name>
```

The `api` runner can `find_tool`, `use_tool`, and `build_tool`. A build is not
inline: it queues a separate `tool` task that must produce the full layout
(manifest with a JSON-schema contract, entry, tests, README), pass **its own
tests**, survive an admission scan of every source file, and be approved by you
— only then is it registered. Tools run with an allowlisted environment, speak
JSON on stdin/stdout, and are quarantined after three consecutive failures.

Registered tools live in a git-tracked **`toolbox/`** subfolder of the repo (see
`toolbox/README.md`), so Foreman can both use and improve its own tools. Only
tool *source* is stored there — usage stats and quarantine state are kept in
`$FOREMAN_HOME/tool-state.json`, out of version control, so the toolbox stays clean
for git. Set `FOREMAN_TOOLBOX` to point the catalog elsewhere. A pre-existing
`$FOREMAN_HOME/tools` catalog is migrated into `toolbox/` once, on first start.

## Self-improvement

```bash
foreman improve                    # propose, show, queue nothing
foreman improve --yes              # queue it against the foreman repo
foreman schedule add "weekly self-improvement" --spec "weekly sun 09:00" --improve
```

Foreman reads its own ledgers — outcomes by runner, council verdicts, top
errors, rejections with reasons, quarantined tools, and this README's own
limitations list — and proposes one fix, queued as an ordinary code task with
the full suite as its gate.

**The guardrails are code, not prose.** `PROTECTED_PATHS` (security scanning
and the core guard, the merge logic, the jail, tool registration, the daemon
lock, the guardrail file itself, the tests that pin the guard, and the files
that hold the rules around it: the gate, the scheduler, the queue, the HTTP API
and the store's schema) are enforced on the change, not on the request. Admission
flags a task against foreman whose text spells one of them out (exact spelling,
outside a "do not touch" list) with a warning; if the ticket parks, the warning
leads its note at the gate. It is a hint for the reader, not a check, and it
does not refuse the task, because a brief that only describes such a file names
it too.
The **run's change** is
checked after the worker finishes, and again after the test command — because
either can write anything inside the jail — from git's own list of paths that
differ from the commit the jail was cut from, so work the worker committed in
the jail counts. That commit is kept on the run's row in the store, not in the
jail. And the **landing** is checked: on approval the branch is resolved to one
commit, git is asked what merging that commit would change in the checkout
(not what the branch's own history names), and a protected path is refused; the
ticket goes back to the gate unlanded. The merge is of that same commit, runs
with hooks off, and is checked once more after it is made: a protected path in
the merge, or left changed in the checkout, undoes it. A task that does not
merge on approval (every `improve` task) is checked at approval too: what its
worktree and branch hold is listed, and with a protected path in it the ticket
goes back to the gate instead of being marked done. Past that point the branch
is the operator's to merge by hand, and nothing checks what is added to it
later. A listing that fails, or
names nothing for a change that exists, is a refusal. The rule applies to any
task whose repo is the foreman repository — a sub-directory, a symlink, another
spelling or a linked worktree of it included — not just ones queued by
`improve`. A change to foreman is never signed off by the owner model; it
waits for a person. That is a rule about the owner gate, not proof of a person:
the approve endpoint takes no credential, and a jail is a git worktree, not a
sandbox. A process a run leaves behind runs as the same user and can call
`/approve` on its own ticket, queue a ticket carrying `allowCore`, or write the
store's file. What such a call cannot do is land a protected path without
`allowCore`: the landing check runs whoever approves, which is why the gate,
scheduler, queue, API and schema sources are on the list. A change to any
other foreman source can still be landed that way. A worker also shares the
repo's git config and can name programs git itself runs (a merge driver, a
filter), which the landing check answers only by putting protected files back.
Run-time refusals
are fatal, never retried. Foreman never infers `--allow-core`; it is set only by
whoever queues the task.
Improve tasks are lowest priority, budget-capped, and **never merge on
approval**.

### Debrief: what one finished epic shows

```bash
foreman debrief <epicId>                          # collect, one model call, write the report
foreman debrief <epicId> --notes review-r1.md     # attach notes kept outside the ledger (repeatable)
foreman debrief <epicId> --no-model               # the deterministic part only
foreman debrief <taskId> --json                   # a one-ticket debrief, the whole document on stdout
```

The first step of Foreman learning from its own runs, and the only one built. It
needs no daemon and writes nothing but its own files and the spend receipt of
its model call: `$FOREMAN_HOME/debriefs/<id>.md` (for a person), `<id>.json`
(the data, versioned), and one row in the ledger's `receipts` table for each
attempt of the call (normally one), which is how Foreman's own spend report
and budget come to see it. The ledger is read through a connection that cannot write it, and neither
that connection nor the one that writes the receipt runs a schema statement, so
a debrief run from another checkout does not migrate a live ledger, and a
mistyped `FOREMAN_HOME` is an error, not a new empty database. A ledger whose
`receipts` table this checkout cannot write gets no model call (the report says
why). With `--no-model` nothing opens the ledger for writing. The two
files are written through a rename inside a `debriefs` directory that must be a
real directory. A debrief of an epic that is still running is written, and says
at the top that it is not finished.

**Collect** (no model). Per ticket of the epic, the follow-ups reviewers filed
from it, any ticket outside it that waits on one, and — two steps out — the
follow-ups filed on those and the tickets queued behind them (what lies further
is named under the cuts): role, kind, runner, gate
(and whether it was the house default), every run with its base commit, cost and
the skills its brief carried, every verdict with the reviewer's own "not
checked" / "UNVERIFIED" / "could not open" / "cut" sentences, pre-review and
review repair rounds, operator actions with their notes in order, review issues
that were not filed, failures by cause (turn ceiling, run deadline in both
wordings, provider limit, the out-of-jail tripwire, a suite TIMEOUT, a failing
suite with its first failing line, the sandbox notice, merge conflicts),
cascades and revivals, approvals that did not merge, report cuts, time from
queue to gate and gate to landing, and per-role numbers beside `foreman crew
report`'s history. Events the ledger has pruned are read back from the daily
trace files, and a run's skills line from its run log. Every text field is
bounded head-and-tail with the cut marked, and the whole document has a ceiling
(`DEBRIEF_CAPS` in `src/debrief.ts`).

**Gate disagreement** is classified per ticket from what the ledger can show:
`rejected-at-gate` (an operator rejection), `corrected-at-gate` (`--as-is`, a
landing refused because the work changed after review, or an approval note that
uses a correction phrase), `overruled-at-gate` (a person approved what the
review failed), `approved-unverified` (a person approved while the latest
verdict was `split`: no reviewer's verdict stood behind it; counted as a signal),
`agreed`, `unknown`. A ticket parked on a split that nobody has decided reads
`waiting for a person: reviewer could not verify acceptance items …`. Each class carries `how` it was reached:
`ledger` (a recorded fact), `note-wording` (a phrase match on the approval
note's free text: "no corrections needed" reads as corrected, "fixed two things,
landed" reads as agreed) or `nothing`. A class read from wording is a reading,
not a record; the report counts the two apart and quotes every such note.
`agreed` means only that no disagreement is on record: a fix placed on top of
approved work outside Foreman is invisible unless the approval note says so or
the review notes are supplied with `--notes`. The report lists this, and
everything else it cannot see, under "Not visible to this debrief".

**What the ledger records for it.** Every approve, reject, cancel, retry and
reopen is one row in the ledger's `decisions` table, written once and never
changed (the table refuses an update or a delete, and a row outlives its
ticket): who decided (`human`, `owner-model`, or `system` for a cancel that
cascaded from a parent), the whole note (bounded at 16 KB, marked if cut), the
status the ticket was left in, and for an approval the reviewed tree, the tree
that landed, `as_is`, `merged`, the merge's own reason, `review_source` and
`corrected`. `corrected` is 1 for an `--as-is` landing of a tree other than
the reviewed one (by definition) or when the operator says so:

```sh
foreman approve <id> --corrected --note "landed r2's on-top patch by hand"
foreman approve <id> --clean --review-source "independent reviewer, verify 3040/0/1"
foreman cancel <id> --note "superseded by t_…"
```

It is 0 for `--clean` and NULL when neither was given: "not stated", never
guessed from the note's wording. `--corrected` and `--clean` go with `approve`
only: on `reject`, `retry` and `reopen` the CLI refuses them, and so do the routes
(400, nothing done). A cancel is never refused over its note: a body that is
missing, empty, not JSON or too large cancels all the same, and the answer (and
the CLI) then says `note not recorded: <reason>`. Each command prints the row it recorded, and
`foreman show <id>` lists a ticket's decisions. The owner gate's hold is not a
decision and writes no row (its timeline line says why it held). Each decision
also leaves a short `decision` line on the ticket's timeline, which, like a
run's `skills` line, is never pruned. A run row records `turns` (model
responses seen in the worker's stream), `turns_reported` (the CLI's own
`num_turns`, which counts differently), `turn_limit`, `ended_reason` (`ok`,
`turn-ceiling`, `deadline`, `provider-limit`, `tripwire`, `canceled`, `error`;
NULL for a daemon stop), `brief_bytes`, `brief_cuts` (which sections were cut,
and by how much) and `report_bytes`. `foreman debrief` reads all of these
first: a class resting on `corrected` is `how: ledger`, a cancel carries its
note, turn-ceiling and deadline stops are counted from `ended_reason`, and the
report says "briefs: N of M runs had a section cut". Tickets and runs from
before these records read exactly as they did, from the note's wording.

What these records are not. `human` means "the approve, reject, cancel, retry
or reopen route was called": the API has no credential (see the note on
authentication below), so the CLI, the board, `curl`, and any process on this
machine that calls the route (one a worker left behind included) is recorded
as `human`. `owner-model` and `system` are written only from inside the
daemon. `landed_tree` is read from the merge commit main received (its second
parent), not from the branch name, and is NULL when git could not say. A
daemon killed between a merge and its row leaves a `done` ticket with no row:
the debrief then classes that ticket from the note's wording, as it did
before, and says `note-wording`. Approvals that did not land write a row too,
so count landings with `merged = 1` (and closed tickets with
`status_after = 'done'`, which also covers a ticket that merges nothing).

The rows outlive the ticket: `foreman rm <id>` removes the ticket and its
timeline (the `decision` lines with it) but not its `decisions` rows, whatever
its sensitivity; `foreman show` can no longer list them, they are still in the
ledger file, and the ledger backup copies them like every other table. Nothing
prunes them and no command removes one. To take out a
note that should not have been written (a pasted secret), stop the daemon and
do it by hand; the trigger comes back the next time the ledger is opened:

```sh
sqlite3 "${FOREMAN_HOME:-$HOME/.foreman}/foreman.db" "DROP TRIGGER decisions_no_delete; DELETE FROM decisions WHERE id = 'd_…';"
```

The same note may also be in the ticket's memory fact (`foreman memory`), in
its `operator_demands` after a retry, and in backups made since.

**Diagnose** (one call, owner tier, through the broker). The collected data, the
notes and the loaded skills go in as data, never as instructions; the reply must
be findings in fixed bins, each quoting its evidence. The reply is checked in
code: a finding that cites a ticket or a quote not in the data is dropped (the
check shows the quoted text exists, not that it supports the finding), a
finding resting on one ticket with no rejection or correction is kept as an
observation and can carry no proposal, a proposal that names a core-guarded
file is dropped, so is a `skill-edit` whose target names no loaded skill, at
most three proposals survive, and whatever was dropped is listed with its
reason and the proposed change. A proposal whose wording reads as weakening a check, gate, scan or
permission is dropped too, but that is a phrase filter and not a safety review:
"raise the turn ceiling" or "run the scan only on risky tickets" passes it, so
read every proposal as a stranger's suggestion. In the Markdown report the
model's text, ticket titles and ledger text are escaped so that none of it can
start a heading, a link, an image or HTML. An S2 epic is diagnosed on a local
model or not at all, and it is S2 if any ticket whose text the document shows
is S2: a ticket of the epic, a follow-up, an outside ticket that waits on one,
or a follow-up listed under any of them. `--notes` files have no sensitivity of
their own: on an S1 epic they go to the hosted model with the rest. The call
cost about US$0.55 for a 19-ticket epic; it is not made when its estimate is
above `--max-usd` (default 1). A call that fails, is over the limit or returns
something unreadable leaves the deterministic report, with a line saying so,
and exit 0.

**The proposals are suggestions for a person.** Nothing is applied or queued.
The next step in the design (a proposal becoming a pending skill edit with a
replay measurement attached) is not built, and neither is running the debrief
automatically when an epic closes.

## Model roster

```bash
foreman doctor --bench             # score every local model, re-point the roster
```

Twelve probes (4 reasoning, 4 code review, 4 instruction fidelity), each scored
by **code, not by another model**, measuring score, tokens/s and cold start.
Probes require bare answers, so a hedge like "no idea" is not a correct "no".

Switching is deterministic and logged in the receipts:

- **Ladder** — priority and repair history set the starting rung; a `split`
  verdict escalates one rung (`council@r0` → `council@r1` in the ledger). S2
  never escalates off the machine.
- **Roster** — rungs follow the measurements, not the alias names.
- **VRAM guard** — dispatching a non-resident model while a different one is
  mid-call would evict and reload it, so those calls serialise instead.
  Resident models still run in parallel; an unreadable runtime never blocks.

The first real bench here: `qwen3.5:9b` and `qwen2.5-coder:14b` scored 1.00;
`llama3.1:8b` scored **0.25 on reasoning** — independently confirming a live run
in which it misread a diff twice.

### Which model sits where

| Seat | Model | Why |
|---|---|---|
| Council advisors (code) | 2B on rung 0, then the 9B + coder-14B | cheap first for diffs; two *different* models, never one model counted twice |
| Council advisors (prose) | 9B + coder-14B at every rung | the 2B returned nothing on a 6,000-token chapter; llama benched 0.25 |
| Council chair | the strongest reasoner not already seated; **opus at the top rung** when the cloud is allowed and the task is not S2 | the chair decides every disagreement — it used to be llama or the 2B |
| Chair already argued a side | nobody — the vote is a `split`, which escalates or parks | one model re-reading its own vote is not a decision |
| A seat answered nothing usable and the rest passed | nobody — the round is a `split`; it climbs only to a rung with *different* advisors (never under memory pressure), and keeps its earlier verdict if that rung hears from fewer advisors (a lone FAIL there still stands); otherwise it parks for you | the survivor's PASS is not the council's; a lone FAIL still stands (fail-closed). A crew chain of two or more reviewers applies the same rule (no crew verdict, so the council's stands; a `review:incomplete` receipt marks it either way) |
| Playbook classifier (ambiguous asks) | `haiku` (`FOREMAN_MODEL_ROUTER`) | a one-word pick; it used to consult fable |
| Owner / senior / worker | opus / opus / sonnet (fable deprecated 2026-10-05) — or the local roster under local-only or the Claude fallback | `FOREMAN_MODEL_OWNER` / `_SENIOR` / `_WORKER` override |
| `api` runner, no routed model | coder-14B for code, 9B otherwise | llama is never a fallback worker |

`llama3.1:8b` sits in no review seat in any mode. On a 17 GB machine the coder-14B
(~10 GB resident) only fits when the desktop is quiet — `doctor` warns when the
machine is swapping, and a local call that stalls says so instead of reporting a bare
timeout.

### Smaller models when memory is short, re-checked when it frees up

On a 17 GB machine the strong local models only fit when the desktop is quiet, so
every local alias has a **step-down chain** of cheaper models already pulled:

| Asked for | Steps down to |
|---|---|
| `local-code` (coder-14B, ~9 GB) | `local-code-small` (coder-7B, ~4.7 GB) → `local-fast` (2B) |
| `local-reason` (9B) / `local-general` | `local-fast` (2B) |

Before each local call the broker checks whether the model fits: its size plus a rough
KV cache for the window, against reclaimable memory, plus idle models Ollama would evict,
plus a paging allowance (`FOREMAN_PAGING_ALLOWANCE_GB`, default 7). The allowance is
calibrated on this machine, where the 9B loaded at 0.8 GB reclaimable and the 14B could not.
If the model doesn't fit, the first one down the chain that fits runs instead. A local call
that stalls before its first token is also retried one step down instead of failing the task.
Adopted personas and cloud models never step down. `FOREMAN_DOWNSHIFT=off` disables it.

Nothing about a step-down is silent. The receipt records `downshifted_from`. A council
review that used any stepped-down model is a **provisional** verdict: the card gets a
*provisional* chip and the owner model never auto-approves it. Its opinions are not cached,
so a later check cannot replay them. Once a minute, when no work and no review is running,
the scheduler finds the oldest provisional task at the gate whose **full** council fits now
and re-reviews it with `reverify`, keeping the work. A re-check that comes back provisional
again backs off for 15 minutes. `FOREMAN_RECHECK_MS` sets the interval, and a negative value
turns it off. The re-check only ever reviews a ticket whose provisional verdict is on its
latest run, and never a run that parked for a person with no reviewer called (a gate that timed
out twice, a red gate on a jail behind main, a run that changed nothing): those wait for you,
whatever an earlier run's verdict was. `foreman reverify <id>` still re-reviews one when you ask.

## Training a persona on the work, not on reports about it

```bash
foreman persona ingest publishing.author --manuscript <chapters-dir> --style STYLE_SHEET.md
foreman persona train publishing.author
foreman persona adopt publishing.author --judge opus
```

`persona build` mines Claude Code session history, which is right for a coding
persona and wrong for an authoring one. Measured: `publishing.author` trained on
108 history samples failed its gate against an Opus judge **0W 0L 8T** — every
metric identical to the base. The adapter was fine; the corpus was summaries of
drafting sessions (*"Chapter 7 is drafted at …, 3,872 words"*, median 215
characters). It had been taught to write status reports and was then judged on
prose it had never seen.

`persona ingest` builds from the manuscript instead: continuation pairs split at
paragraph boundaries, headings and author-query blocks stripped. 20 chapters →
659 pairs of the actual target voice. Passages rather than whole chapters
because a chapter is ~5,500 tokens against a 1,024 window — and because
"continue this scene in this voice" is the drafting job stated exactly.

`--judge` picks who runs the blind A/B. While a subscription lasts, use a cloud
model: it is the third arm the gate needs, and a local judge's verdict on local
work is the thing `foreman agreement` exists to validate.

**Dispatch pauses while a trainer holds the local-model lock.** A trainer or an
adoption gate owns the machine's inference for hours, and starting new work
under it is how a 17 GB machine ends up 33 GB into swap — a collision that
happened once for real. Running work finishes; only new dispatch waits.
`FOREMAN_IGNORE_TRAINING_LOCK=1` opts out.

## Alignment (LoRA on your own history)

```bash
foreman align status | extract | build | train
```

Builds SFT data from your Claude Code sessions and DPO pairs from Foreman's own
gate ledger (an approval is "like this"; a rejection with a reason is "not like
that"; a chair overruling an advisor is a judgement about a judgement).
The label is the run you decided at the approval gate (`runs.decision`), never
where the task ended up: a ticket you rejected and then finished by hand teaches
nothing, a ticket's earlier attempts are not its approved answer, and the owner
gate's decisions are labelled as its own (`owner-approved` / `owner-rejected`)
so a retry cannot pass them off as yours. Decisions from before the column
existed are read back from the status timeline.

**Redaction is a hard dependency, not a nicety.** Sixteen credential shapes,
plus home paths, usernames, emails and a high-entropy sweep; `assertClean`
re-checks every sample and drops any that still matches a key shape. It is
tested against a planted-secret corpus, and `assertClean` is itself tested to
fail on unredacted input.

Adoption is gated, not vibes: an adapter ships only if it beats the base on the
golden set, wins a blind A/B judged by a **third** model with alternating arm
order, and regresses on nothing in a 20-prompt safety set (10 must-refuse, 10
must-help, so refusing everything scores 0.5). A losing candidate stays on disk
and is simply never registered as an alias. Every alignment call is pinned S2.

## Speed and consistency

```bash
foreman doctor --latency          # per-stage medians and p90 over recent runs
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
`/bin/cp -c -R`, which on APFS is a copy-on-write clone: measured on Kiln's
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

## Runners

| Runner | What it does | Verified |
|---|---|---|
| `echo` | walks the stage rail without a model; a prompt containing "fail" fails on purpose | yes — used throughout the suite |
| `shell` | runs the prompt verbatim as a shell command in the jail | yes — end-to-end on a real repo |
| `api` | tool loop (`list_dir`/`read_file`/`write_file`/`run_shell`/`done`) against the model plane | yes — including jail-escape and destructive-command refusal |
| `claude-code` | drives `claude -p` headless, parsing `stream-json` into stages, logs and tokens | CLI present and preflights; parsing is fixture-tested against recorded transcripts, **not yet against a live run** |
| `codex-cli` | same shape for `codex exec --json` | as above |

## Local-only mode

```bash
export FOREMAN_LOCAL_ONLY=1
foreman drill                    # readiness: probes scored by code, not by a model
foreman doctor                   # mode, resolved tiers, and whether every persona is served
```

**Unset, the flag means `auto`.** Foreman asks the Claude CLI whether it is signed in at
boot, in `doctor` and `drill`, and every five minutes; a real call failing on authentication
counts too. While the CLI is down, only what depended on it falls back: default tiers route
to the local roster, crew tickets use the `api` runner, owner/router calls are skipped (each
already degrades), every gate is yours, and queued `claude-code` tickets **wait** — held, not
failed, attempts untouched. Codex and gateway models are unaffected. Recovery needs one real
call to succeed; `auth status` alone cannot prove it (it reports `loggedIn:true` for invalid
credentials). The board shows a **Claude offline** chip. `FOREMAN_LOCAL_ONLY=0` turns the
fallback off; `=1` is the strict mode below.

`FOREMAN_LOCAL_ONLY=1` is the mode for when there is no cloud. Tiers collapse onto the local roster, cloud aliases are
never registered (not merely refused later), `claude-code`/`codex-cli` are refused **at
admission**, crew tickets run on the `api` runner, owner gating is abolished so every gate is
human, and `llama3.1:8b` is pinned out of every review seat. It loosens capability and never
safety: admission BLOCK, the jail, `PROTECTED_PATHS`, merge-only-on-approval,
split-never-passes and redaction are untouched.

Running local-only, `drill` found three real defects. The load-bearing one: a **non-streaming**
request sends no response headers until generation completes, and undici gives up waiting
after 300s — so on a machine that sustains ~8 tok/s, every generation past ~2,500 tokens
died. Both model paths stream now, and the call ceiling is an *idle* timeout (reset by every
chunk) rather than a total duration guessed from an assumed token rate.

## Retiring the cloud reviewer, on evidence

```bash
export FOREMAN_SHADOW_LOCAL=1   # while a cloud reviewer is still deciding tickets
foreman agreement               # per role: samples, agreement, trend, false passes
```

Every ticket a cloud model reviews also gets a **shadow verdict** from a local reviewer —
recorded, never binding, never seen by the gate. The cloud reviewer is retirable for a role
when, over **≥30 samples**, the local one **agrees ≥90%** of the time with **at most one false
pass in thirty**.

The thresholds live in `src/agreement.ts`, were fixed before the first sample was collected, and
are pinned by a test — because the way a gate gets retired early is by deciding what "good
enough" means while looking at a number that will not clear. The two errors are not symmetric
and are scored separately: a local reviewer that *fails* work the cloud passed is expensive, one
that *passes* work the cloud failed is the error that lands bad work once the cloud is gone.
Scoring is per (playbook, role), because a model ready for copyedit and hopeless at
developmental edit is not "85% agreed".

`foreman drill`'s `gate-retirable` probe reports the same verdict.

## Who does the work, and where closed work goes

```bash
foreman add "…" --assignee human     # parks at `awaiting-human`; no worker ever claims it
foreman assign <taskId> ai|human     # move an unstarted task either way
```

Every task has an **assignee** — `ai` by default, which is what Foreman is for. `human` is the
other setting: the task never dispatches to a runner at all, it parks in the board's *Yours to
do* lane, and it closes through the same gate an AI task does. Resolution runs task →
playbook role → playbook → `FOREMAN_ASSIGNEE` → `ai`, so a playbook can claim one role for the
operator permanently (`"publisher": { "tier": "owner", "assignee": "human" }`) — which is how a
rule like "no binding ruling is authored by a model" becomes code rather than prose.

```bash
foreman archive                      # closed work, newest first
foreman archive estimate "draft chapter 21" --role author --playbook publishing
```

Closed tasks fold into the **archive** a week after they close, on an hourly sweep, so the
Closed lane stays "what just happened" instead of growing without bound. Archiving is never
deletion: the task row stays (so `trace` still reconstructs it) and a denormalised record —
duration, cost, tokens, repair rounds, points, verdict — is written alongside it. That record
is denormalised on purpose, because `prune` deletes the ledgers it would otherwise point at,
and it is what `estimate` reads: a **median over comparable past work**, zero tokens, reporting
its own sample count and evidence so a real estimate is distinguishable from one built on two
rows.

## Model plane, sensitivity and budget

Aliases default to local Ollama models (`local-fast`, `local-general`, `local-reason`,
`local-code`) — so an **S2** task can be served without a network hop. Add cloud aliases through
`$FOREMAN_HOME/models.json` or `FOREMAN_GATEWAY_URL` (any OpenAI-compatible gateway, e.g. LiteLLM).

- **S2 is enforced, not advisory.** A non-local alias throws before the request is built, hosted
  CLI runners are refused at admission, and `nonLocalCallsForTask()` proves after the fact that
  nothing left the machine.
- **Every model call goes through the broker**: reserve against the caps → wait for a provider
  slot → call → settle into a receipt. Runners cannot call models directly.
- Per-task ceilings (`--budget`) and a daily cap (`FOREMAN_DAILY_USD_CAP`, default $5). A breach
  **hard-stops the task at `awaiting-approval`** rather than failing it. Local calls are free and
  are never blocked by a cap.
- Ollama is driven through its **native** `/api/chat` with `think:false` — the OpenAI-compatible
  route silently ignores that flag and costs minutes per call.

## Agents

Drop `.json` or `.md` (front-matter) definitions in `$FOREMAN_HOME/agents` — or point
`FOREMAN_AGENTS_DIR` at another catalog's build output. Each is admission-scanned at load; a
blocked definition is dropped from the catalog entirely rather than left selectable. Select with
`--agent <id>`; the `api` runner uses its system prompt and preferred model.

## Skills

A **skill** is a short text procedure a crew role carries into a ticket (how to write a failing test
first, how to review for silent failures). Skills live in a separate repository; point
`FOREMAN_SKILLS_DIR` at it. Until that is set the feature is off: no skill is loaded and every brief
and review prompt is byte-for-byte what it is without skills. Skills are text Foreman reads and puts
in a prompt. It never runs anything from that directory and never writes to it.

```
<dir>/skills/<name>/skill.json   name (= the directory), description, roles ["software.dev"], status
<dir>/skills/<name>/full.md      at most 4,000 bytes — Claude workers and the crew reviewers
<dir>/skills/<name>/card.md      at most 1,200 bytes — a local-model worker
<dir>/loadouts.json              {"roles": {"software.dev": {"default": ["a"], "allowed": ["a", "b"]}}}
```

Every skill is checked at load, and one that fails is refused — listed with its reason, never
served: a name that is not `[a-z0-9-]{1,64}` or does not match its directory; a file over its cap;
a status of `retired` (or none of `draft`, `measured`, `adopted`); a skill directory or file that is
a symlink (links are not followed, so nothing outside the directory is read) or not a regular file;
bytes that are not UTF-8; zero-width, bidi, control or other invisible characters (variation
selectors and filler characters included); a line that opens like one of Foreman's own brief sections
(a `---` rule, `ACCEPTANCE CRITERIA`, `TEST GATE`, `## role:` and the like); an injection phrase
("ignore previous instructions", "system prompt", "you are now"); or a blocking finding from the same
admission scan agents and playbooks pass. The phrase list catches the stock wording only: a skill is
still text you put in front of a model, so read what you install.

Foreman picks the skills, by rule; the worker never chooses. In order: the ticket's own list, else the
names its playbook lists for the role — an optional `"skills": {"dev": ["a", "b"]}` key in the
playbook's front matter — else the role's loadout `default`. Each name must be in that role's loadout
(`allowed` or `default`) and the skill's own `roles` must list `<playbook>.<role>`. At most two are
served; a name that is left out is named, with the reason, in the block (when nothing at all is
served the brief carries no block, and `foreman skills show` prints the reasons). The block follows the role prompt, hard constraints and tools in
the worker's brief, under a header that says the ticket's brief, acceptance and operator demands
outrank it, and is bounded by `FOREMAN_SKILL_BRIEF_BYTES` (9,000) with any cut marked. A crew
reviewer gets its own `## role:` prompt from the playbook (bounded at 4,000 bytes, under a line saying it reviews
with no tools and must say what it could not check) and then its role's skills (full text), between its review style
and the reply contract.
A worker gets `card.md` when its role's tier resolves to a local model (or the crew is on the local
plane); everything else gets `full.md`. The choice is made from the role's tier, not the ticket: a
ticket routed to a local model by an adopted persona still gets `full.md`.

```bash
foreman skills                          # loaded skills, refused ones with reasons, loadouts
foreman skills show software dev        # exactly the block that role's brief carries
```

Both read `FOREMAN_SKILLS_DIR` from the shell they run in, as does the `skills:` line of
`foreman doctor` — the daemon uses the value it was started with.

**A ticket's own skills.** A ticket may name up to two skills that replace its role's default — a bug
with an unknown cause is better served by a debugging procedure than by "write the test first". The
list is stored on the ticket (`tasks.skills`; empty means the role's default) and is checked when it is
set, by one rule for every way in: each name must be a loaded skill, on the role's loadout, that lists
the role; two at most; the ticket must be an agent-less playbook role; skills must be on. A request
that fails is refused whole, naming the skill and what the role may carry — nothing is trimmed quietly.
(Spaces around a name are ignored and a repeated name counts once; a list of more than 16 entries is
refused without being read.)

- **The planner.** With skills on, the planning prompt lists, for each role of the playbook that has a
  choice, its default and what it may carry instead, with each skill's `when` line. A skill the playbook
  names only on a reviewer entry for a role, and that is not in that role's ticket default, is left off
  that role's menu (a role with nothing else to choose is not listed). This filters the menu only:
  `checkTicketSkills` still accepts such a skill when an operator names it on a ticket, because
  `loadouts.json` decides what a role may carry. The section is held to 2,048 bytes and a `when` line is
  never cut: the defaults' `when` lines go first, then whole entries from the end (one line, `(N more
  not shown)`, counts them), then roles from the end of the playbook's list — and once an entry or a
  role has gone the plan check says so (`skills-prompt-trimmed`). A ticket in the plan may then carry
  `"skills": ["name"]`. A name that fails the check is dropped from that ticket and shown as a
  `skill-dropped` warning in the plan check — the plan still stands — and `foreman build` prints each
  ticket's skills. `--from-epic` keeps each cloned ticket's list. A follow-up a reviewer files carries
  its parent's list (none stays none); a name its own role may not carry is left off and named in a
  warning on its timeline, never costing the follow-up. One a worker files starts on its role's default.
- **Self-epic warning.** When a plan's repo is the Foreman checkout itself, the plan check warns
  (`core-file-refused`, never blocking) on each ticket whose title, prompt or acceptance names a
  core-guarded path (`PROTECTED_PATHS`): `likely refused at admission: consider hand work`, with the
  ticket ref and the path. A mention after `do not touch`, `do not edit`, `excludes`, `must not edit`,
  `never edit` or `e.g.` in the same sentence is not counted. Other repos never get it.
- **`foreman show <id>`** prints the ticket's list, or `role default: …` as the shell's skills dir has it.
- **`foreman add … --playbook <p> --role <r> --skills a,b`** and **`foreman retry <id> --skills a,b`**
  (`--skills default` clears the list). The daemon checks the list; a refused one queues nothing and
  requeues nothing, and the ticket is as it was. A retry without `--skills` keeps the ticket's list.
  The CLI reads the answer back: a daemon still running a build from before this (it would drop the
  list unseen) is caught there, and the ticket is canceled rather than run on the wrong skills.

The list is checked again each time a brief is built, against the skills as they are then. A name
that has stopped passing (retired, refused, taken off the role's list) is left out and the brief says
so; if none of the ticket's names is left, the role's usual skills are carried and the brief says that
too. A repair round carries the same skills as the first; a resumed round, which sends the critique
alone, is sent the block again only when the skills are no longer the ones its session began with.
Each run starts with a `skills` event on the run — JSON with the role, whose list was used (`ticket`,
`playbook` or `default`), the text given (`full` or `card`), the skills in the brief and every name
left out with its reason; the same line is in the run's log. A crew reviewer carries its role's
default, or the `skills` list of its playbook entry (see above).

## Commands

```
serve · stop · add · ls · show · approve · reject · cancel · retry [--note] · reopen [--note] · rm · watch · demo
doctor      probe every model, runner and agent
receipts    spend ledger — today, or one task
verdict     the council's opinions for a task
memory      list / add / rm learned facts (scoped per repo, with belief revision)
schedule    add / ls / rm / toggle recurring batches ("every 30m", "daily 07:30", "weekly mon 09:00")
prune       drop worktrees and branches of finished tasks (approved work only once it has landed), closed tasks' receipts and verdicts older than `--days` (90), and all but `--keep-deps` (5) dep caches
trace       full JSON reconstruction of a task
debrief     what one finished epic shows: collected facts, findings, at most 3 suggestions (see Self-improvement)
service     print a launchd plist for this install
help        the full usage text (also `foreman --help`)
assign      who does a task: `assign <taskId> ai|human`
gate        who decides at the gate: `gate <taskId>|--waiting|--house owner|human`
archive     closed work older than a week; `archive sweep | estimate | unarchive`
reverify    re-run the review on work already done, keeping the work
tools       the forged-tool catalog: `tools ls|show|rm|quarantine|release`
backup      one verified, gzipped copy of the database, now (the daemon also takes one a day)
restore     replace the database with a backup; refuses while the daemon runs
ask         plan a request, then queue it
build       plan a crew epic (the owner decomposes it), then queue it
improve     let Foreman work on Foreman
crew        `crew init` copies the seed playbooks; `crew report` shows per-role delivery and spend
playbooks   list loaded playbooks (and refused ones)
playbook    `playbook forge "<domain>"` drafts a playbook; `playbook pending|approve|reject` manage drafts
skills      list loaded skills; `skills show <playbook> <role>` prints a role's skills block
persona     train an author persona on the work itself (see Training a persona)
align       LoRA alignment on your own history (see Alignment)
prose       `prose audit <dir>` and `prose import <file> --out <dir>` for manuscripts
agreement   how often the local reviewer would have decided what the cloud reviewer did
drill       local-only readiness probes (see Local-only mode)
```

**Inside a worker run the CLI refuses.** A worker session carries `FOREMAN_RUN_ID`; with it set, every
`foreman` command except `help` (and `--help`) exits 2 with `foreman: worker ledger guard: …` before it opens, creates or
locks anything (`ls`, `add`, `restore`, `serve`, `approve`, `doctor`, …). The ledger is the daemon's.
`testSlot.ts` is not `cli.ts` and is unaffected. A suite started by a worker does not inherit the marker
(the wrapper drops it; `test/env.ts` clears it too). The guard is not a fence: a worker that unsets or empties
`FOREMAN_RUN_ID` (`env -u FOREMAN_RUN_ID …`) is not refused, and see "A worker's `FOREMAN_HOME`".

`foreman add` flags: `--kind --runner --repo --agent --priority --after --sensitivity --budget
--test-cmd --no-merge --repairs --prompt --role --playbook --assignee --skills --allow-core` (see Skills;
`--allow-core` is not in `foreman help`, see Self-improvement).

## Configuration

`FOREMAN_HOME` (`~/.foreman`) · `FOREMAN_DB` · `FOREMAN_PORT` (4100) · `FOREMAN_HOST` (127.0.0.1)
· `FOREMAN_MAX_WORKERS` (4) · `FOREMAN_MAX_VERIFIES` (2: the cap on test commands Foreman
itself spawns at once, FIFO across all tasks — gate checks, playbook checks, the post-merge main check
and its re-run; it does not cover tests a worker runs inside its own session) · `FOREMAN_TASK_TIMEOUT_MS` (30m; 90m on the local plane) · `FOREMAN_SLOT_WAIT_CREDIT_MS` (30m: how much of a worker's own wait for a test slot is not charged to its run) · `FOREMAN_DAILY_USD_CAP` (5) ·
`FOREMAN_VERIFY=off` · `FOREMAN_OLLAMA_URL` · `FOREMAN_GATEWAY_URL` / `_KEY` / `_ALIASES` ·
`FOREMAN_OLLAMA_CONCURRENCY` (2) · `FOREMAN_MODEL_TIMEOUT_MS` (180s) · `FOREMAN_CLAUDE_BIN` /
`_ARGS` / `_PERMISSION_MODE` / `_CONFIG_DIR` (`$FOREMAN_HOME/claude-config`) / `_ENV_ALLOW` · `FOREMAN_CODEX_BIN` / `_ARGS` · `FOREMAN_AGENTS_DIR` · `FOREMAN_SKILLS_DIR` (unset: skills off) · `FOREMAN_SKILL_BRIEF_BYTES` (9000) ·
`FOREMAN_API_ALLOW_SHELL=0` · `FOREMAN_TRACE_SINK` / `_KEY` · `FOREMAN_GATE=human|owner` (human) · `FOREMAN_LOCAL_ONLY=auto|1|0` (auto) ·
`FOREMAN_MODEL_ROUTER` (haiku) · `FOREMAN_DOWNSHIFT=off` · `FOREMAN_PAGING_ALLOWANCE_GB` (7) ·
`FOREMAN_RECHECK_MS` (60s; negative = off) ·
`FOREMAN_ASSIGNEE=ai|human` (ai) · `FOREMAN_BACKUP=off` · `FOREMAN_BACKUP_DIR` (`$FOREMAN_HOME/backups`) · `FOREMAN_BACKUP_COPY_DIR` (unset: `serve` warns; a second copy on another disk) · `FOREMAN_PREWARM=off` · `FOREMAN_ARCHIVE_AFTER_DAYS` (7) · `FOREMAN_JAIL_RETAIN_DAYS` (3) · `FOREMAN_FAILED_JAIL_RETAIN_DAYS` (14) ·
`FOREMAN_LOCAL_MAX_OUTPUT_TOKENS` · `FOREMAN_LOCAL_NUM_CTX` · `FOREMAN_SHADOW_LOCAL` ·
`FOREMAN_IGNORE_TRAINING_LOCK` · `FOREMAN_TEST_TIMEOUT_MIN` (30) · `FOREMAN_TEST_REAL_HOME=1` · `FOREMAN_TEST_KEEP_ENV` ·
`FOREMAN_REVERT_TESTS=on` (off) — see [The revert check, per test](#the-revert-check-per-test-foreman_revert_tests) ·
`FOREMAN_SANDBOX=off|tests|all` (tests) · `FOREMAN_SANDBOX_RO` · `FOREMAN_SANDBOX_DENY_PORTS` (8000,8001,8002,3010) · `FOREMAN_SANDBOX_ALLOW=fsevents` — see [The sandbox](#the-sandbox-foreman_sandbox) ·
`FOREMAN_CREW_REVIEW=always|escalate` (escalate) · `FOREMAN_REVIEW_REPORT_BYTES` (24000) · `FOREMAN_CITED_SOURCE_BYTES` (64000) · `FOREMAN_GATE_BATCH=off` (on) ·
`FOREMAN_TOOL_SURFACE=sparse` (off; api runner lists only the role's own tools in full, the rest by name — experiment E-M) ·
`FOREMAN_API_REPEAT_NUDGE` / `_STOP` (3 / 5; the api runner tells a model it made the same call with the same result — or was refused, whatever it asked — N times in a row, then ends the run; 0 turns it off).

A daemon stop (`foreman stop`, a launchd restart, an upgrade) is not a verdict on the work in flight: each running
ticket goes back in the queue with its attempt given back, and its worktree is kept; the fourth stop since the ticket
last started fresh sends it to your desk instead (Give to AI puts it back in the queue with the count started over; so
do Retry and a repair round). A cancel ends the run for good — a Retry you issue meanwhile stands. Marking a ticket
done from your own desk lands nothing; if an interrupted run's worktree is still on disk, you are told where it is, so
you can commit and merge that work yourself.

## Security posture

- The API can queue shell commands. It binds loopback only; anything else needs
  `FOREMAN_ALLOW_REMOTE=1`, and there is still **no authentication** — this is a local tool.
- Runners never touch your checkout: worktree or scratch dir, always. Approval is the only path
  by which anything reaches your repo.
- The `api` runner's file tools are contained to the jail (symlinks included) and its
  model-authored shell commands are screened by the same block rules as task admission. That
  screening is a guardrail, **not a sandbox** — the sandbox is `FOREMAN_SANDBOX` (below), which
  confines the command to the jail unless it is `off`.
  Set `FOREMAN_API_ALLOW_SHELL=0` to remove the tool.
- A test command Foreman runs (the gate, playbook checks, the post-merge check) runs code a worker
  wrote, so it gets the same environment as a model-authored shell command: credential-shaped
  variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, …) are dropped, and `HOME`/`TMPDIR` are throwaway
  directories (`FOREMAN_TEST_REAL_HOME=1` keeps the real home — only with `FOREMAN_SANDBOX=off`;
  with the sandbox on, a run that sets it fails saying so). `FOREMAN_TEST_KEEP_ENV=NAME,…`
  passes named variables through for a suite that needs one.
- Admission BLOCK is non-overridable by config, by design.

## The revert check, per test (`FOREMAN_REVERT_TESTS`)

"This test would fail on the old code" is a claim a reviewer makes without running anything. With
`FOREMAN_REVERT_TESTS=on` (off by default; unset, empty or `off` is off, anything but `on`/`off` refuses to start;
read once when the daemon starts) Foreman runs it, per test, and tells the reviewer what it found. It decides nothing.

- **When**: a `code` ticket in a repo, whose worker finished and whose test step ran and passed, with a diff that
  adds or changes at least one test and also changes something besides tests and docs. Never for other kinds, never
  on red tests, never on a test-only or docs-only diff.
- **Which tests**: read off the source, not run to find out (`src/verify/testNames.ts`). In each changed JS/TS test
  file, the node:test calls (`test`, `it`, `describe`, `suite`, their `.skip`/`.only`/`.todo`, and a subtest's
  `t.test`) whose own lines the diff touches — a new test, an edited one, a renamed one — and every test under a
  `describe` whose own lines (a hook, a shared fixture) changed, and every test a changed loop or case table
  generates. Changed lines in no test (imports, helpers) are counted and named, not attributed to a test.
- **How**: a scratch worktree at the run's base gets the test-side files of the **reviewed tree** (never the live
  worktree), so only the diff's code change is put back. Each changed test file is run once there, with the test
  script's own node flags but its reporters replaced by TAP, `--test-timeout=60000` per test,
  `--test-force-exit`, and a `--test-name-pattern` per changed test (the outermost test around a subtest) when every
  name on the way is known; a filter that misses is retried once unfiltered. Results are matched to the call that
  defines each test by the location node reports, so a test named in a loop gets one row per case. Only a test script
  of the form `node … --test …` can be aimed at one file; any other gives `could not run` for every test.
- **What each test gets**: `fails without the change` (with its first failure line), `passes without the change`
  ("either it does not test the change, or it pins behaviour that must not change — the reviewer decides"), or
  `could not run` (timed out, the file did not load at the base, skipped, never reported, or the check itself failed —
  any failure of the check is `could not run` for every test, never a clean result).
- **Where it goes**: a `FOREMAN REVERT CHECK` note to the crew reviewer (and to a re-review), a section of the owner
  gate's evidence, `<FOREMAN_HOME>/artifacts/<run>.revert-tests.json` with a `revert-tests` artifact row (its summary
  is what `foreman show` prints), and the run's entry in `foreman debrief`. **No repair round, no hold, no failed
  stage comes from it**; the reviewer may still fail the work on what it shows.
- **Cost and bounds**: every command takes a verify slot and runs under the sandbox like the test command. The run's
  deadline is stopped for the whole check (it is Foreman's aid, not the ticket's work; a cancel or a stop still ends
  it). A file's run is killed at 30 s plus 60 s per changed test in it, at most
  300 s; the whole check has 600 s of **run time** (slot waits are not counted). A file that hangs at the base costs
  at most that bound, and its tests are `could not run`.

## The sandbox (`FOREMAN_SANDBOX`)

A jail is a git worktree, not a boundary. A test command is code a worker wrote, and without a
sandbox it runs as you: it can write the real repository's `.git` (move `main`, plant a hook),
your home, Foreman's database, and call the daemon's own API. `FOREMAN_SANDBOX` puts those
commands under macOS `sandbox-exec`.

| Value | What happens |
|---|---|
| `tests` (default) | The repo's test command, playbook checks, `shell` tickets, the `api` runner's `run_shell` and `use_tool` (a catalog tool), the post-merge check and a worker's own suite run (`src/verify/testSlot.ts`) run sandboxed. |
| `all` | Reserved for sandboxing the worker too. **In this build it behaves exactly as `tests`**; `serve` says so at start. |
| `off` | No sandbox: everything runs as it did before. This is the rollback — set it and restart. |

Any other value is an error: `serve` refuses to start and a run fails with the reason.

**What a sandboxed command can do.** Read and write its jail, and a private `HOME` and `TMPDIR`
made for that run and removed after it. Read the operating system and the toolchains (`/usr`,
`/bin`, `/System`, `/Library`, `/opt/homebrew`, `/Applications`, `/private/etc`). In a worktree
jail, read the real repository's `.git` — so `git status`, `diff` and `log` work — but not write
it: `git add`, `commit` and `update-ref` there fail (a repository the suite makes for itself,
inside the jail or under `TMPDIR`, takes commits normally). Use loopback networking, unix sockets
inside its own directories, and pseudo-terminals it allocates itself. Read the task of another
process in the same sandbox (how AddressSanitizer names a file and line).
If the node Foreman runs on is installed under your home or a temp dir (nvm, an unpacked
tarball), its install root (`<root>/bin/node`) is readable too, never writable, and does not take
a `FOREMAN_SANDBOX_RO` place. It is opened only when it holds a node install and nothing else, is not inside
Foreman's home, the real repository or the jails' directory, and neither is nor contains your
home, a temp dir root or Foreman's home; otherwise `foreman doctor`
and `serve` print `sandboxed commands may not find node: …` with the fix. A version manager that
puts a shim or symlink directory on `PATH` instead (volta, fnm) needs that directory in `FOREMAN_SANDBOX_RO`.

**What it cannot do.** Write anywhere else. Read, list or stat anything under `/Users`,
`/Volumes`, the shared temp dirs (`/tmp`, `/var/tmp`, `/var/folders`), or Foreman's home (the
database, artifacts, other runs' jails).
Reach the daemon's port (`FOREMAN_PORT`) or the ports in `FOREMAN_SANDBOX_DENY_PORTS`. Reach any
address off this machine, or resolve a name. Signal a process outside the sandbox. Run the
`launchctl` program, or start another `sandbox-exec`. `/Users` and `/Volumes` themselves can be
stat-ed (a program can see that they are directories); nothing in them can. Two things this does
**not** add up to are under "Known limits of the test sandbox" below.

**What a suite can trip over** (each one broke a real gate when this was first run on it):

- **Setuid programs do not start**: `ps`, and anything else with the setuid bit (`top`, `sudo`). macOS starts none inside
  any sandbox, whatever the profile says. A test that shells out to `ps` to read a child's memory
  has to ask the child instead.
- **`/tmp` is not writable.** Only `$TMPDIR` is; a test that hard-codes `/tmp` or `/private/tmp`
  fails with `EPERM`.
- **`$TMPDIR` is not empty after a compile**: `xcrun` (behind `clang`, `clang++`, `swiftc`) keeps
  its lookup cache `xcrun_db` in the user's temp dir, and inside the sandbox that is the run's own
  `TMPDIR`. A test that requires an empty temp dir must not count it.
- **File watching** needs `FOREMAN_SANDBOX_ALLOW=fsevents` (below).
- A tool under your home is not there: `FOREMAN_SANDBOX_RO` (below).

**What it does NOT cover — read this before relying on it.**

- **The `claude-code` and `codex-cli` workers themselves are not sandboxed.** A worker session
  still runs as you, with your files and the daemon's API in reach. Only the commands listed above
  are confined. A worker's own suite run goes through the slot wrapper, which takes its verify
  slot from the daemon *outside* the sandbox and then runs the suite *inside* it.
- Foreman's own git calls in a jail, and dependency provisioning (`npm ci`), are not sandboxed.
- Loopback is every address of this machine: any local service that is not on the closed-port
  list (Ollama, a gateway, a dev server) can be called from a test command. The list is a
  deny-list of at most four ports besides the daemon's.
- Everything in the jail, and in a worktree jail the real repository's whole `.git` (all history,
  every unmerged branch, its config), is readable. No CPU, memory or disk limits.
- macOS only: on another system the default refuses to run test commands until you set
  `FOREMAN_SANDBOX=off`. `sandbox-exec` is deprecated by Apple and still what the platform's own
  tools use.

**Known limits of the test sandbox.** Things a sandboxed command can still do, stated plainly:

- **It can ask launchd to unload or remove one of your jobs.** Refusing the `launchctl` program
  does not prevent the request underneath it: in the adversarial review a small program written
  for the purpose, run inside this sandbox, removed a job of the same user that had just been
  submitted for the test. No profile rule tried closed that on macOS 14.7. So a hostile test
  command could stop one of your LaunchAgents (a watchdog, a bot) until it is loaded again.
  Creating a job that way was refused by launchd in the same review, and a sandboxed command
  cannot write a file under `~/Library/LaunchAgents` (a test covers the write).
- **It can read the initial arguments and environment of its ancestor processes — the Foreman
  daemon included.** The variables Foreman strips from a test command's own environment (keys,
  tokens) are still readable this way if the daemon was *started* with them: the review recovered
  secrets planted on the launching process, and no profile rule tried closed it. Processes that
  are not its ancestors did not show theirs. So **do not start the daemon with a secret in its
  environment**; a secret the daemon needs belongs in a file only you can read (mode 0600) outside
  any jail. A test command has no network beyond loopback, but it can write what it read into
  the jail or its output, where a worker (which does have the network) or a person will see it.
- **Catalog tools are sandboxed from this build on.** The `api` runner's `use_tool` runs a tool
  under the same sandbox as `run_shell`: the ticket's jail, a private `HOME` and `TMPDIR`, the
  toolbox readable and not writable. A tool that reads anything else of yours stops working
  until that tree is named in `FOREMAN_SANDBOX_RO` (the toolbox takes one of its four places
  unless it is listed there itself); one that writes outside the jail stops working under the
  sandbox. If the toolbox itself is somewhere
  the sandbox cannot give back (inside Foreman's home), the call is refused, not run unconfined.

**It fails closed.** With the switch on, if `/usr/bin/sandbox-exec` is missing, is not
executable, or the sandbox does not start, the command is **not run**: the run fails with a line
that names the reason and `FOREMAN_SANDBOX=off`. `serve` runs a self-test at start (a sandboxed
no-op must succeed, a sandboxed write into Foreman's home must fail) and refuses to start if it
does not hold; `foreman doctor` prints the same check. A failed sandboxed test run ends with
`foreman: this ran sandboxed (FOREMAN_SANDBOX=tests): …` so the cause is easy to find. A process
that is already inside a sandbox (Foreman's own suite, run by Foreman's gate) cannot nest one and
runs its commands under the sandbox it is already in.

**`foreman doctor` also runs a worker's suite in a jail.** Its last check line is
`worker suite in a jail: ok` or `worker suite in a jail: FAIL <reason>`. Doctor cuts a scratch
jail of the Foreman checkout it runs from (`createJail` under `<home>/work`, named
`doctor-<pid>`), gives it its dependencies from the repo's or the cache's `node_modules`
(`provisionDeps`, never `npm install`), and starts `node src/verify/testSlot.ts -- node -e 0` in
it with the environment a worker gets, the sandbox on and a 60 s timeout. A repo that is dirty or
refused, a provisioning error, a timeout or a non-zero exit is a `FAIL` with the reason (a relative
`FOREMAN_HOME` that reached a worker shows as `contains Foreman's home`); the other lines still
print, and the jail is removed either way. A jail that could not be removed is never a plain `ok`:
the line is `FAIL … jail left at <path>`. The check sets `FOREMAN_PORT=0`, so the wrapper finds no
daemon to ask and runs `node -e 0` **unslotted** (`testSlot: no Foreman daemon … running … unslotted`);
it does not take a test slot.

**Knobs.**

- `FOREMAN_SANDBOX_RO=/abs/one:/abs/two` — up to four extra **read-only** trees, for a suite that
  needs a tool or toolchain under your home (a prose linter, a virtualenv). Anything listed is
  readable by every test command, so name the one subtree that is needed. A path inside Foreman's
  home is refused, and so is a tree that **is or contains** something the sandbox closes: `/`,
  `/Users`, your home, `/Volumes`, `/private`, `/tmp`, `/var`, `/var/tmp`, `/var/folders` and your
  temp dir, `/var/root`, `/var/db/sudo`, `/opt/homebrew/var`, `/usr/local/var`, `/Library/Keychains`,
  Foreman's home, the directory above the run's jail, and the real repository or the
  directory above it (also in the `/System/Volumes/Data/…` spelling). With such an entry set,
  every sandboxed command is refused with a line naming it, and `serve` does not start (an entry
  that only contains a ticket's real repository is found when that ticket's command runs, not at
  start: `serve` comes up and each such run is refused) — if
  Foreman's home is inside the source checkout (`…/foreman/.foreman`), list `…/foreman/toolbox`,
  not `…/foreman`. Foreman's and Kiln's
  own gates need none (Kiln's needs `FOREMAN_SANDBOX_ALLOW=fsevents`, and its tests must not
  depend on `ps`, on writing `/private/tmp`, or on an empty `TMPDIR` after a compile — see "What a
  suite can trip over"). A gate script that calls the forged tools (the manuscript repos'
  `scripts/gate.sh`) needs the toolbox named and readable — a test command's `HOME` is a
  throwaway, so `$HOME/Projects/foreman/toolbox` is not there:
  `FOREMAN_TOOLBOX=/Users/you/Projects/foreman/toolbox FOREMAN_SANDBOX_RO=/Users/you/Projects/foreman/toolbox`.
- `FOREMAN_SANDBOX_DENY_PORTS=8000,8001,8002,3010` — the loopback ports closed besides the
  daemon's (default: common local dashboard and git-forge ports). Setting it **replaces** the list; at
  most four; empty closes only the daemon's port. A suite that itself serves on one of these
  ports cannot connect to it: change the list or the suite's port.
- `FOREMAN_SANDBOX_ALLOW=fsevents` — allowances that are **off unless named**, because each lets
  a little of the outside in; an unknown name is an error. `fsevents` is file watching (node's
  `fs.watch` on a directory, anything built on FSEvents). Without it a watcher fails or never
  fires, and a suite that waits on one hangs until its timeout — **Kiln's gate needs it** (the
  preview live-reload test). What it costs, measured: a sandboxed command can then also learn the
  *names* — never the contents — of files created and then deleted or renamed away *directly
  inside* a directory above its jail, `TMPDIR` or `HOME` (your home's top level, the shared temp
  dir). Files that stay, anything deeper and every other tree are not reported.
- `FOREMAN_TEST_REAL_HOME=1` is refused while the sandbox is on. `FOREMAN_DEPS_MODE=symlink`
  points a jail's `node_modules` at the real repository, which a sandboxed command cannot read:
  use the default (`clone`).

**Rollback.** `FOREMAN_SANDBOX=off`, restart the daemon. Nothing is stored; tickets already
parked are unaffected either way.

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

## Tests

```bash
npm run verify    # typecheck, then the whole suite (about 2,500 tests); the gate to run before a commit
npm test          # the suite alone
npm run typecheck      # the native compiler (tsgo, @typescript/native-preview), the one the gate runs
npm run typecheck:tsc  # tsc 5.9, the reference: run it when the two might disagree
foreman drill     # the live readiness suite — real models, answers checked by code
```

Covered: DAG promotion and dependency-failure propagation, exactly-once claim, crash recovery,
orphaned-process-group reaping on recovery, pid recording over a child's lifetime, the daemon
pidfile lock (live conflict and stale reclaim), pool concurrency, cancel and timeout aborts,
worktree jails and dirty-repo refusal, per-run branch uniqueness, the test gate short-circuiting
the council, council agreement / disagreement→chair / unreachable→split / unparseable→not-pass,
budget cap breach, provider concurrency, receipts on success *and* failure, S2 refusal of cloud
models and hosted runners, admission blocks and their false-positive rate on ordinary prompts,
agent-catalog refusal, api-runner jail escape and destructive-command refusal, merge
only-when-approved, merge refusal on a dirty repo, prune keeping undecided branches and approved work that has not landed, memory
belief revision, schedule parsing and single-fire re-arming, HTTP routes, path-traversal
containment, SSE streaming and slow-client drop policy, claude/codex stream parsing on recorded
fixtures, chunk-split line reassembly, and trace-sink delivery plus sink-failure isolation.

### Verified live (not just unit-tested)

A real `shell` code task on a scratch git repo: worktree cut → change applied → `npm test` passed
→ two local models reviewed the diff → **they disagreed** → the chair (`qwen3.5:9b`) read both and
correctly identified that `llama3.1:8b` had misread the diff → verdict `pass` → approved → branch
merged `--no-ff` → repo clean → `prune` reclaimed all three branches. Four council calls, all
local, $0.00, every one on the receipts ledger.

## License and contributing

Copyright 2026 Gokul P M. Foreman is licensed under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and how to propose a change;
[SECURITY.md](SECURITY.md) covers how to report a vulnerability privately.

It is a personal project, developed and run on one Mac: expect rough edges outside that setup.

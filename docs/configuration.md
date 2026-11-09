## Configuration

Every `FOREMAN_*` variable `src/` reads has one row below; `scripts/checks/config-truth.ts` (run by `npm run verify`)
fails when a variable is read and has no row, or has a row and is never read. "Unset" means the variable is not in the
environment. Leave a variable unset rather than empty or wrong. A number read in `src/config.ts` keeps its default when
empty, and a value that is not a number throws. The numbers read in `budget.ts` and the slot code check the parsed
value and keep the default. A reader written as `value ?? default` uses an empty value as it is: an empty path or URL
stays empty (for example `FOREMAN_TOOLS_DIR`, `FOREMAN_OLLAMA_URL`), an empty number reads as 0, and a value that is
not a number reads as NaN (for example `FOREMAN_HIGH_PRIORITY`, `FOREMAN_TOOL_QUARANTINE_AFTER`,
`FOREMAN_TOOL_TIMEOUT_MS`, `FOREMAN_PREWARM_TIMEOUT_MS`, `FOREMAN_FAST_VERIFY_MAX_LINES`, `FOREMAN_IMPROVE_PRIORITY`,
`FOREMAN_IMPROVE_BUDGET_USD`, `FOREMAN_MODEL_TIMEOUT_MS`, `FOREMAN_API_MAX_TURNS`). `FOREMAN_RUN_ID`,
`FOREMAN_RUN_TOKEN` and `FOREMAN_WORKER_TEST_CMD` are set by Foreman for a worker's session, never by you, and a few more are read only by
tests; none of those is in the table. Two families are read under names built at run time, so they are not rows:
`FOREMAN_MODEL_<ALIAS>` pins the model behind a gateway alias (`src/models.ts`), and `FOREMAN_PERSONA_URL_<ID>`
overrides a persona's server URL (default `http://127.0.0.1:<port>/v1`, `src/align/personas.ts`).

| Name | Default | Effect | Read in |
|---|---|---|---|
| `FOREMAN_HOME` | `~/.foreman` | Foreman's data directory: ledger, work trees, artifacts, traces, backups. A relative value is resolved once and written back, so every child sees the same absolute path | `src/config.ts` |
| `FOREMAN_DB` | `$FOREMAN_HOME/foreman.db` | Path of the SQLite ledger | `src/config.ts` |
| `FOREMAN_TOOLBOX` | `<repo>/toolbox` | The forged-tool catalog (git-tracked source of the tools) | `src/config.ts`, `src/tools/catalog.ts` |
| `FOREMAN_TOOLS_DIR` | `$FOREMAN_TOOLBOX` | Overrides the catalog directory outright (used in tests) | `src/tools/catalog.ts` |
| `FOREMAN_PORT` | `4100` | Port the daemon and board listen on; workers use it to reach the daemon for a test slot | `src/config.ts` |
| `FOREMAN_HOST` | `127.0.0.1` | Address the daemon binds. A non-loopback address is refused unless `FOREMAN_ALLOW_REMOTE=1` | `src/config.ts` |
| `FOREMAN_ALLOW_REMOTE` | unset | `1` lets the daemon bind a non-loopback address; the API can run shell commands, so this is an explicit decision | `src/server.ts` |
| `FOREMAN_ALLOWED_HOSTS` | unset | Comma-separated extra `Host` names the API accepts, for a reverse proxy or a LAN name (loopback and the bind address are always accepted) | `src/server.ts` |
| `FOREMAN_MAX_WORKERS` | `4` | Tasks run at once in the work lane (at least 1) | `src/config.ts` |
| `FOREMAN_MAX_VERIFYING` | `2 x FOREMAN_MAX_WORKERS` | Tasks allowed in the verify lane at once (at least 1) | `src/config.ts` |
| `FOREMAN_MAX_VERIFIES` | `2` | Cap on test commands running at once, FIFO across all tasks: gate checks, playbook checks, the post-merge main check and its re-run, and a worker's full-suite run through the slot wrapper (`src/verify/testSlot.ts`, which leases a slot from the daemon). A single-file `node --test` a worker runs directly takes no slot | `src/verify/slots.ts` |
| `FOREMAN_SLOT_WAIT_MS` | `600000` (10 min) | How long the slot wrapper waits for a slot before giving up | `src/verify/testSlot.ts` |
| `FOREMAN_SLOT_WAIT_CREDIT_MS` | `1800000` (30 min) | How much of a worker's own wait for a test slot is not charged to its run clock | `src/runClock.ts` |
| `FOREMAN_TASK_TIMEOUT_MS` | `1800000` (30 min); `5400000` (90 min) on the local plane | Hard ceiling on one run's wall clock; the local default applies under local-only mode or the cloud fallback | `src/config.ts` |
| `FOREMAN_TEST_TIMEOUT_MIN` | `30` | Minutes before a test command Foreman runs is killed | `src/verify/tests.ts` |
| `FOREMAN_TEST_REAL_HOME` | unset | `1` runs test commands with the real home instead of a private one; refused while the sandbox is on | `src/verify/tests.ts` |
| `FOREMAN_TEST_KEEP_ENV` | unset | Comma-separated variable names a test command keeps from the daemon's environment | `src/verify/tests.ts` |
| `FOREMAN_TICK_MS` | `250` | Scheduler tick interval | `src/config.ts` |
| `FOREMAN_LOG_LINES` | `2000` | Log lines kept per run in SQLite (the full log stays on disk). A runner's own output is recorded as events only up to twice this many lines per run; later lines go only to the run log file, with one "further output is in the run log" event when the cap is hit and one event with the total line count at run end. Foreman's own notes (council, gate, follow-ups) are never capped. Progress events are throttled to a changed value plus 1 s elapsed or a move of 0.01 | `src/config.ts` |
| `FOREMAN_TRACE_RETAIN_DAYS` | `14` | Days of daily trace files kept | `src/config.ts` |
| `FOREMAN_JAIL_RETAIN_DAYS` | `3` | Days a merged or archived task's worktree is kept (at least 1); negative keeps them | `src/config.ts` |
| `FOREMAN_FAILED_JAIL_RETAIN_DAYS` | `14` | Days a failed task's worktree is kept after it last moved (at least 1); negative keeps it for ever | `src/config.ts` |
| `FOREMAN_ARCHIVE_AFTER_DAYS` | `7` | Days after a task closes before it is archived; `0` archives at once, negative turns the sweep off | `src/scheduler.ts` |
| `FOREMAN_RECHECK_MS` | `60000` | Interval of the re-check of verdicts made while a model had stepped down; negative turns it off | `src/scheduler.ts` |
| `FOREMAN_REDCHECK_MS` | `15000` | How often the repos marked red are looked at: a moved HEAD is re-checked then, the same HEAD only after a backoff (10, 30, 60 minutes, then hourly) and while a verify slot is free | `src/scheduler.ts` |
| `FOREMAN_REVERIFY_WAIT_MS` | `900000` (15 min) | How long `foreman reverify` waits for one review | `src/cli.ts` |
| `FOREMAN_DIFF_CAP_BYTES` | `24000` | Largest code diff shown to a reviewer | `src/config.ts` |
| `FOREMAN_PROSE_DIFF_CAP_BYTES` | `160000` | The same cap for a prose review | `src/config.ts` |
| `FOREMAN_CREW_CODE_DIFF_CAP_BYTES` | `96000` | The same cap for the crew chain's code review | `src/config.ts` |
| `FOREMAN_LOG_TAIL_LINES` | `40` | Lines of the run's log tail shown to the review council | `src/config.ts` |
| `FOREMAN_LOG_TAIL_BYTES` | `4000` | Byte budget for that log tail | `src/config.ts` |
| `FOREMAN_MEMORY_BRIEF_BYTES` | `2000` | Byte budget for remembered facts in a brief | `src/config.ts` |
| `FOREMAN_REPAIR_BRIEF_BYTES` | `16000` | Byte budget for the critique and operator demands a repair round acts on | `src/config.ts` |
| `FOREMAN_ACCEPTANCE_BYTES` | `8000` | Byte budget for a ticket's acceptance criteria wherever it is read; a cut is marked | `src/config.ts` |
| `FOREMAN_REVIEW_REPORT_BYTES` | `24000` | Byte budget for the worker's final report in a review prompt | `src/config.ts` |
| `FOREMAN_CITED_SOURCE_BYTES` | `64000` | Byte budget for the source a changed document cites, attached to a review | `src/config.ts` |
| `FOREMAN_PRE_REVIEW_REPAIRS` | `2` | Automatic repair rounds for a gap found before review (acceptance map, scope), apart from the normal repair count | `src/config.ts` |
| `FOREMAN_REVERT_TESTS` | off | `on` runs each test a code diff adds or changes with the diff's non-test files put back to base, and shows the per-test table to the reviewer and the owner gate. Anything but `on`/`off` throws. See [The revert check, per test](security.md#the-revert-check-per-test-foreman_revert_tests) | `src/config.ts` |
| `FOREMAN_DEBUG` | off | `1` writes one `[foreman debug]` line per event to stderr: model and HTTP calls (start, end, status, ms, sizes), subprocess spawns (program name, argument count, cwd, exit code, ms) and swallowed errors (error type only). Never a prompt, body, argument, URL query or error message; secrets are redacted. Unset or `0`: no output at all | `src/config.ts` |
| `FOREMAN_VERIFY` | on | `off` skips the review (the pre-review checks, the council and the crew chain). The tests still run and a failure still sends the work back; work that passes parks for approval unreviewed | `src/scheduler.ts` |
| `FOREMAN_POSTMERGE_CHECK` | on | `off` skips the main check after a merge | `src/postMerge.ts` |
| `FOREMAN_FAST_VERIFY` | off | `1` or `on` gives a whitespace-only diff, or a small one that touches only docs or config, one review instead of the full council (anything but a pass goes on to the full council); code and security-adjacent paths never qualify | `src/verify/triage.ts` |
| `FOREMAN_FAST_VERIFY_MAX_LINES` | `20` | Largest changed-line count that still counts as small | `src/verify/triage.ts` |
| `FOREMAN_CREW_REVIEW` | `escalate` | `always` runs the crew chain on every ticket and its verdict lands; anything else escalates to it only when needed | `src/verify/crewReview.ts` |
| `FOREMAN_GATE` | `human` | `owner` lets the Owner model decide a ticket this process watched park at the gate when neither the ticket (`--gate`), its playbook nor the board's switch says who decides; never under local-only mode or while the Claude CLI is down. See [Crew mode](crews.md#crew-mode) | `src/gate.ts` |
| `FOREMAN_GATE_BATCH` | on | `off` gates tickets one by one instead of in batches | `src/gate.ts` |
| `FOREMAN_ASSIGNEE` | `ai` | `ai` or `human`: who a ticket is assigned to when neither the ticket nor its playbook says. The board's toggle, once flipped, wins over this variable | `src/assign.ts` |
| `FOREMAN_COUNCIL_DEADLINE_SHARE` | `0.4` | Share of the remaining run time the gate council may use (clamped to 0.1-0.9, at least 30 s) | `src/scheduler.ts` |
| `FOREMAN_COUNCIL_MAX_TOKENS` | `350` | Output-token ceiling on a council advisor or chair call | `src/config.ts` |
| `FOREMAN_COUNCIL_NUM_CTX` | `16384` | Context-window ceiling of a council call | `src/verify/council.ts` |
| `FOREMAN_HIGH_PRIORITY` | `5` | Priority at which a ticket gets one rung more review | `src/verify/council.ts` |
| `FOREMAN_LIMIT_BACKOFF_MS` | `900000` (15 min) | How long a provider that reported a usage limit is left alone | `src/providerLimit.ts` |
| `FOREMAN_DAILY_USD_CAP` | `5` | Daily ceiling on model spend in dollars; 0 or less means no cap | `src/budget.ts` |
| `FOREMAN_DAILY_SUBSCRIPTION_USD_CAP` | `200` | Daily ceiling on notional subscription spend, at list price | `src/budget.ts` |
| `FOREMAN_IMPROVE_PRIORITY` | `-10` | Priority of a self-improvement task (below real work) | `src/improve.ts` |
| `FOREMAN_IMPROVE_BUDGET_USD` | `0.5` | Spend allowed to one self-improvement task | `src/improve.ts` |
| `FOREMAN_MODEL_OWNER` | `opus` (a local model on the local plane) | Model alias for the owner tier; set, it wins even in local-only mode | `src/roles.ts` |
| `FOREMAN_MODEL_SENIOR` | `opus` (a local model on the local plane) | Model alias for the senior tier | `src/roles.ts` |
| `FOREMAN_MODEL_WORKER` | `sonnet` (a local model on the local plane) | Model alias for the worker tier | `src/roles.ts` |
| `FOREMAN_MODEL_ROUTER` | `haiku` | Model that classifies an ambiguous request; only Claude aliases count, others fall back to `haiku` | `src/assistant/crewPlan.ts` |
| `FOREMAN_MAX_TURNS_OWNER` | `40` (falls back to `FOREMAN_MAX_TURNS_SENIOR` when set) | Agent-loop turn cap for owner-tier tickets | `src/roles.ts` |
| `FOREMAN_MAX_TURNS_SENIOR` | `40` | Agent-loop turn cap for senior-tier tickets | `src/roles.ts` |
| `FOREMAN_MAX_TURNS_WORKER` | `30` | Agent-loop turn cap for worker-tier tickets | `src/roles.ts` |
| `FOREMAN_MAX_PLAN_TICKETS` | `30` | Most tickets a plan an operator hands in over the wire (edited or written by hand) may hold. The owner's own plan stays capped at 12 | `src/assistant/crewPlan.ts` |
| `FOREMAN_PLAN_TIMEOUT_MS` | `480000` | Time allowed to produce a plan | `src/assistant/crewPlan.ts` |
| `FOREMAN_CLAUDE_BIN` | `claude` | The Claude CLI binary | `src/runners/cliRunners.ts`, `src/models.ts`, `src/assistant/ownerCall.ts` |
| `FOREMAN_CLAUDE_ARGS` | unset | Extra arguments for the Claude CLI, split on whitespace | `src/runners/cliRunners.ts` |
| `FOREMAN_CLAUDE_PERMISSION_MODE` | `acceptEdits` | `--permission-mode` passed to the Claude CLI | `src/runners/cliRunners.ts` |
| `FOREMAN_CLAUDE_CONFIG_DIR` | `$FOREMAN_HOME/claude-config` | Folder all worker config directories live under | `src/runners/claudeIsolation.ts` |
| `FOREMAN_CLAUDE_ENV_ALLOW` | unset | Extra environment variable names (comma or space separated, exact) a `claude-code` or `codex-cli` worker may inherit from the daemon | `src/runners/claudeIsolation.ts` |
| `FOREMAN_CLAUDE_ALLOWED_TOOLS` | the slot wrapper, `npm run`, `npx tsc`, `node --test`, read-only git, plus web tools a playbook grants | `;`-separated replacement for the worker's allowed-tools list; `none` allows nothing extra | `src/runners/cliRunners.ts` |
| `FOREMAN_CLAUDE_DISALLOWED_TOOLS` | `npm test`, `npm t`, `npm run test`, `npm run verify`, and web tools a playbook does not grant | `;`-separated replacement for the worker's denied-tools list; `none` denies nothing | `src/runners/cliRunners.ts` |
| `FOREMAN_CLAUDE_RESUME` | on | `off` stops a repair round resuming the worker's previous Claude session | `src/scheduler.ts` |
| `FOREMAN_CODEX_BIN` | `codex` | The Codex CLI binary | `src/runners/cliRunners.ts` |
| `FOREMAN_CODEX_ARGS` | unset | Extra arguments for the Codex CLI, split on whitespace | `src/runners/cliRunners.ts` |
| `FOREMAN_API_MAX_TURNS` | `12` | Turn cap of the api runner; a crew ticket gets its tier's `FOREMAN_MAX_TURNS_*` instead when that is higher | `src/runners/api.ts` |
| `FOREMAN_API_REPEAT_NUDGE` | `3` | The api runner tells a model it got the same result from the same call this many times in a row; below 2 turns it off | `src/runners/api.ts` |
| `FOREMAN_API_REPEAT_STOP` | `5` | It ends the run at this many; below 2 turns it off | `src/runners/api.ts` |
| `FOREMAN_API_ALLOW_SHELL` | on | `0` disables the api runner's `run_shell` tool | `src/runners/api.ts` |
| `FOREMAN_TOOL_SURFACE` | full | `sparse`: the api runner lists only the role's own tools in full and the rest by name | `src/runners/api.ts` |
| `FOREMAN_TOOL_TIMEOUT_MS` | `120000` | Default timeout of a catalog tool run | `src/tools/run.ts` |
| `FOREMAN_TOOL_QUARANTINE_AFTER` | `3` | Consecutive failures before a tool is quarantined | `src/tools/catalog.ts` |
| `FOREMAN_LOCAL_ONLY` | `auto` | `1`/`true`/`yes`/`on`: nothing leaves the machine. `0`/`false`/`no`/`off`: cloud and local mixed. Otherwise `auto`: mixed while the Claude CLI works, local plane while it does not | `src/localOnly.ts` |
| `FOREMAN_LOCAL_MAX_OUTPUT_TOKENS` | `8192` for drafting roles and writing tickets, else `2048` | Output-token ceiling of a local model call | `src/localOnly.ts` |
| `FOREMAN_LOCAL_NUM_CTX` | `16384` for writing tickets and non-dev roles, else `8192` | Context window of a local model call | `src/localOnly.ts` |
| `FOREMAN_SHADOW_LOCAL` | off | `1`, `true`, `yes` or `on` records a local reviewer's shadow verdict beside the cloud one, for the agreement report | `src/agreement.ts` |
| `FOREMAN_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL | `src/models.ts`, `src/budget.ts`, `src/warm.ts`, `src/memory.ts` |
| `FOREMAN_OLLAMA_CONCURRENCY` | `2` | Concurrent Ollama calls | `src/budget.ts` |
| `FOREMAN_OLLAMA_KEEP_ALIVE` | `30m` | Keep-alive for the roster's models | `src/budget.ts`, `src/warm.ts` |
| `FOREMAN_OLLAMA_KEEP_ALIVE_COLD` | `5m` | Keep-alive for any other local model | `src/budget.ts` |
| `FOREMAN_PREWARM` | on | `off` skips loading the roster's models at start | `src/warm.ts` |
| `FOREMAN_PREWARM_TIMEOUT_MS` | `120000` | Time allowed to load one model | `src/warm.ts` |
| `FOREMAN_GIT_TIMEOUT_MS` | `120000` | Longest any daemon-side git process may run before it is killed with SIGKILL; the call then fails with `git <subcommand> timed out after <n>ms`. An empty, non-numeric or non-positive value keeps the default | `src/gitTimeout.ts` |
| `FOREMAN_DOWNSHIFT` | on | `off` stops a local model stepping down to a smaller one that fits | `src/budget.ts` |
| `FOREMAN_DOWNSHIFT_HOLD_MS` | `600000` (10 min) | How long a model that did not fit is skipped before it is tried again | `src/budget.ts` |
| `FOREMAN_VRAM_GUARD` | on | `off` dispatches without the memory-fit check (single-model installs) | `src/budget.ts` |
| `FOREMAN_PAGING_ALLOWANCE_GB` | `7` | Memory a model may page out and still count as fitting | `src/memory.ts` |
| `FOREMAN_MODEL_TIMEOUT_MS` | `180000` (180 s) | Floor of a model call's idle timeout (local calls asking 4096 or more tokens get at least 600 s). `foreman debrief` sets 600000 when unset | `src/models.ts`, `src/cli.ts` |
| `FOREMAN_GATEWAY_URL` | unset | Base URL of an OpenAI-compatible gateway; unset (or local-only on) registers no gateway alias | `src/models.ts` |
| `FOREMAN_GATEWAY_KEY` | unset | API key sent to the gateway | `src/models.ts` |
| `FOREMAN_GATEWAY_ALIASES` | `gateway-chair` | Comma-separated aliases served by the gateway; each may be pinned to a model with `FOREMAN_MODEL_<ALIAS>` | `src/models.ts` |
| `FOREMAN_GATEWAY_IN_RATE` | `3` | Dollars per million input tokens charged for a gateway call | `src/models.ts` |
| `FOREMAN_GATEWAY_OUT_RATE` | `15` | Dollars per million output tokens charged for a gateway call | `src/models.ts` |
| `FOREMAN_GATEWAY_CONCURRENCY` | `4` | Concurrent gateway calls | `src/budget.ts` |
| `FOREMAN_AGENTS_DIR` | `$FOREMAN_HOME/agents` | Where agent definitions are read | `src/agents.ts` |
| `FOREMAN_PLAYBOOKS_DIR` | `$FOREMAN_HOME/playbooks` | Where playbooks are read | `src/playbooks.ts` |
| `FOREMAN_SKILLS_DIR` | unset | The skills repository; unset turns skills off | `src/config.ts` |
| `FOREMAN_SKILL_BRIEF_BYTES` | `9000` | Byte budget for the skills block of one brief | `src/config.ts` |
| `FOREMAN_TRACE_SINK` | unset | URL each trace event is also posted to | `src/trace.ts` |
| `FOREMAN_TRACE_KEY` | unset | Bearer key sent with posts to the trace sink | `src/trace.ts` |
| `FOREMAN_BACKUP` | on | `off` turns the ledger backup off | `src/backup.ts` |
| `FOREMAN_BACKUP_DIR` | `$FOREMAN_HOME/backups` | Where backups are written | `src/backup.ts` |
| `FOREMAN_BACKUP_COPY_DIR` | unset | A second copy on another disk; unset, `serve` warns | `src/backup.ts` |
| `FOREMAN_DEPS_MODE` | `clone` | How a worktree gets its dependencies: `clone`, `symlink` or `off` | `src/deps.ts` |
| `FOREMAN_IGNORE_TRAINING_LOCK` | unset | `1` keeps the queue running while an adapter trains (otherwise it pauses) | `src/scheduler.ts` |
| `FOREMAN_MIN_FREE_MB` | `2048` | Free megabytes required on the volume holding `FOREMAN_HOME` (and on a task's repo volume) before a new run is dispatched. Below it dispatch pauses with one `dispatch paused: disk` event and resumes when space returns; running work is untouched. Empty, negative or non-numeric falls back to the default | `src/diskSpace.ts` |
| `FOREMAN_SANDBOX` | `tests` | `off`, `tests` or `all`: what runs inside the sandbox; anything else throws. `src/deps.ts` reads it only to warn that `FOREMAN_DEPS_MODE=symlink` leaves a sandboxed command without its dependencies. See [The sandbox](security.md#the-sandbox-foreman_sandbox) | `src/security/sandbox.ts`, `src/deps.ts` |
| `FOREMAN_SANDBOX_RO` | unset | Colon-separated extra read-only paths for a sandboxed command | `src/security/sandbox.ts` |
| `FOREMAN_SANDBOX_DENY_PORTS` | `8000,8001,8002,3010` | Loopback ports a sandboxed command may not connect to, besides the control port (at most 4; a bad list is refused) | `src/security/sandbox.ts` |
| `FOREMAN_SANDBOX_ALLOW` | unset | Allowances a sandboxed command gets only when named (comma or space separated): `fsevents`, file watching, is the only one; an unknown name is refused | `src/security/sandbox.ts` |
| `FOREMAN_FREEZE_SWEEP_GRACE_MS` | `2000` | Shortens the start-up freeze sweep's grace (digits only) | `src/runners/freezeSweep.ts` |
| `FOREMAN_FREEZE_SWEEP_CAP_MS` | grace plus 5 s | Shortens the start-up freeze sweep's cap (digits only; never above grace plus 5 s) | `src/runners/freezeSweep.ts` |
| `FOREMAN_LEFTOVER_SAMPLE_MS` | `3000` | Interval between samples of a command's process tree while it runs, used to find processes it leaves behind; `0` turns sampling off (an empty value also reads as 0) | `src/runners/proctree.ts` |
| `FOREMAN_PYTHON` | `/opt/homebrew/bin/python3` (`python3` for catalog tools) | Python for training, persona serving and catalog tools | `src/align/train.ts`, `src/align/governor.ts`, `src/align/personaAdopt.ts`, `src/align/personaServe.ts`, `src/tools/run.ts` |
| `FOREMAN_ALIGN_DIR` | `$FOREMAN_HOME/align` | Alignment data and local-model lock | `src/align/extract.ts` |
| `FOREMAN_CLAUDE_PROJECTS` | `~/.claude/projects` | Claude Code transcripts read for alignment | `src/align/extract.ts` |
| `FOREMAN_COWORK_SESSIONS` | `~/Library/Application Support/Claude/local-agent-mode-sessions` | Cowork transcripts read for alignment | `src/align/extract.ts` |
| `FOREMAN_ENTROPY_THRESHOLD` | `3.6` | Entropy above which a long token is redacted from alignment data | `src/align/redact.ts` |
| `FOREMAN_LOCAL_LOCK` | `$FOREMAN_ALIGN_DIR/local-model.lock` | Lock file held while an adapter trains | `src/align/localLock.ts` |
| `FOREMAN_TRAIN_MEMORY_SHARE` | `0.4` | Share of RAM the base weights may take before training is refused | `src/align/governor.ts` |
| `FOREMAN_TRAIN_NICE` | `19` | `nice` level of a training run | `src/align/governor.ts` |
| `FOREMAN_SERVE_NICE` | `10` | `nice` level of a persona server | `src/align/personaServe.ts` |
| `FOREMAN_PERSONAS_DIR` | `$FOREMAN_HOME/personas` | Where personas live | `src/align/personas.ts` |
| `FOREMAN_PERSONA_PORT_BASE` | `4200` | First port persona servers use (plus a hash of the persona id, under 200) | `src/align/personas.ts` |
| `FOREMAN_PERSONA_BASE` | `mlx-community/Qwen2.5-7B-Instruct-4bit` | Base model new personas train from | `src/align/personas.ts` |

A daemon stop (`foreman stop`, a launchd restart, an upgrade) is not a verdict on the work in flight: each running
ticket goes back in the queue with its attempt given back, and its worktree is kept; the fourth stop since the ticket
last started fresh sends it to your desk instead (Give to AI puts it back in the queue with the count started over; so
do Retry and a repair round). A cancel ends the run for good — a Retry you issue meanwhile stands. Marking a ticket
done from your own desk lands nothing; if an interrupted run's worktree is still on disk, you are told where it is, so
you can commit and merge that work yourself.

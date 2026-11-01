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
`FOREMAN_REVERT_TESTS=on` (off) — see [The revert check, per test](security.md#the-revert-check-per-test-foreman_revert_tests) ·
`FOREMAN_SANDBOX=off|tests|all` (tests) · `FOREMAN_SANDBOX_RO` · `FOREMAN_SANDBOX_DENY_PORTS` (8000,8001,8002,3010) · `FOREMAN_SANDBOX_ALLOW=fsevents` — see [The sandbox](security.md#the-sandbox-foreman_sandbox) ·
`FOREMAN_CREW_REVIEW=always|escalate` (escalate) · `FOREMAN_REVIEW_REPORT_BYTES` (24000) · `FOREMAN_CITED_SOURCE_BYTES` (64000) · `FOREMAN_GATE_BATCH=off` (on) ·
`FOREMAN_TOOL_SURFACE=sparse` (off; api runner lists only the role's own tools in full, the rest by name — experiment E-M) ·
`FOREMAN_API_REPEAT_NUDGE` / `_STOP` (3 / 5; the api runner tells a model it made the same call with the same result — or was refused, whatever it asked — N times in a row, then ends the run; 0 turns it off).

A daemon stop (`foreman stop`, a launchd restart, an upgrade) is not a verdict on the work in flight: each running
ticket goes back in the queue with its attempt given back, and its worktree is kept; the fourth stop since the ticket
last started fresh sends it to your desk instead (Give to AI puts it back in the queue with the count started over; so
do Retry and a repair round). A cancel ends the run for good — a Retry you issue meanwhile stands. Marking a ticket
done from your own desk lands nothing; if an interrupted run's worktree is still on disk, you are told where it is, so
you can commit and merge that work yourself.


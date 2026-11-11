## The lifecycle

```
queue → admit → isolate → plan/work/test → verify → gate → merge
         │        │                          │        │
      security  worktree                  council  your click
       scan      jail                     + tests
```

1. **admit** — the task (and any agent definition) is scanned. A blocking finding refuses the
   task outright and is **not configurable**. Uses `frisk-scan` when installed (20 s timeout; a
   missing or failing scanner falls back to the rules alone); the built-in ruleset always runs.
   The scan runs off the event loop, so the API and the board keep answering while it does.
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
   aborts cleanly on conflict; your checkout is never left mid-merge. Everything checked before
   the merge (approval, the branch, the reviewed tree before and after the worktree is committed,
   the commit count and the core guard against the commit it lands on) is one step,
   `prepareLandingCommit`, so any other way of landing runs the same checks; the local merge adds
   the clean-checkout check, asked before the worktree is committed. Every landing answers a typed
   `code` beside its `reason` (`MergeResult` in `src/merge.ts`: `merged`, `conflict`,
   `not-reviewed`, `core-refused` and the rest). The gate, the owner gate, the CLI and the board
   decide on the code; the reason is the words you are shown and is never matched.
   Merges in one repo run one at a time (`src/landing/queue.ts`): a second approval in the
   same repo waits until the first one's checks, decision and merge have settled, whether they
   passed, failed or threw. The post-merge check (`src/landing/verify.ts`) runs after that, so
   the next approval in the repo merges while it is tested. A dependent stays `blocked` until a
   passing check covers its parent's merge; it is released at once when no check runs for that
   landing (`FOREMAN_POSTMERGE_CHECK=off`, no repo, nothing merged), and a red or interrupted
   check holds it with the repo. Its epic waits the same way: it closes on the tick after the
   check ends the hold, not at the decision. By default (`FOREMAN_POSTMERGE_MODE=coalesced`) one check runs
   per repo at a time: the next one is for the test command of the oldest landing not yet
   covered (the ticket's `testCmd`, or none, which detects the command at the checked HEAD),
   at the newest HEAD merged with that command, and it covers every landing with that command
   whose merge HEAD is an ancestor of it. So merges that land while a check runs share one
   more check; merges with different commands never cover each other. A red check covering
   several merges marks the repo red at that HEAD with one `MAIN IS RED` event, on the newest
   one's timeline, naming them all, and ends all their holds: the red marker holds the repo's
   work until the scheduler's red re-check passes. The re-check leaves a repo alone while its
   landing checks still run, so a HEAD merged after the red one is not checked twice at once. An interrupted check names every landing it
   covered the same way. `FOREMAN_POSTMERGE_MODE=per-merge` runs one check per landing at the
   HEAD its own merge made, at once, and a red names that merge alone.
   The hold is in memory; its durable twin is a `landings` row, written before the decision and
   deleted once the merge (and its ref update) has settled. A daemon that dies in between leaves
   the row: at the next start the repo shows as `landInterrupted` in `/api/state` with a
   `land-interrupted(<repo>)` warning on the ticket, and every dependent in that repo stays
   `blocked` until you check the checkout and run `foreman land-clear <repo>`.
   An approve answers once its merge has settled, with the merge result and `postMerge: 'pending'`
   (`'none'` when no check runs); the check runs on in the background, and a shutdown still aborts
   it and holds the repo as untested. Its `decisions` row is written once, at the merge, and no
   longer carries the main-check outcome: a red shows as the `MAIN IS RED` event on the ticket's
   timeline and as the red-repo marker in `/api/state`, an interrupted check as its warning event.
   While it waits its ticket stays at `awaiting-approval` and nothing is
   decided: its checks, the decision and the merge all run when its turn comes, so approving the
   same ticket twice lands it once, and an approval whose turn comes after a daemon shutdown began
   is refused (approve again after restart). A queued approval is for the run that was parked when
   it was given: if the ticket has been rejected, retried and parked on another run by its turn,
   the approval is refused with nothing decided. An owner-gate approval is also refused, as a hold
   that leaves no durable marker, if by its turn the review changed, the ticket was handed to a
   person, or it became a hard-human case. Once a principal exists, an approval or a `landed` is
   also refused, with nothing decided, when four-eyes (`docs/security.md`) does not allow its
   approver: asked first, and again when its turn comes. Four-eyes never allows the owner model, so
   with auth on the owner gate (single or batched) only advises: an owner approval is not tried but
   parked for a person, as a human-only path is, with the model's verdict in its `owner-gate: hold`
   line and no decision row. The hold leaves the durable marker: the owner model is asked once per
   park, not again on every sweep. With auth off the owner gate is unchanged. Approvals in different repos land side by side. The queue is keyed by
   the ticket's repo path, so two tickets naming different directories of one checkout are not
   queued together.
   **By merge request.** With `FOREMAN_LANDING=mr`, an approval in a repo whose checkout's top
   level is mapped in `landing.json` ([configuration](configuration.md#merge-request-landing-landingjson))
   does not merge into the checkout (`src/landing/mr.ts`). Inside the repo's merge section it
   fetches the target branch through the forge mirror, runs every `prepareLandingCommit` check
   against that commit (a refusal is the same code and reason as for a local merge, and work changed
   after review is refused before anything is pushed), pushes the checked commit to
   `foreman/<task id>`, finds the open merge request from that branch or opens one, and confirms
   the MR's head is that commit (GitLab takes a push into an MR that was already open in a
   background job, so a reused MR's head is read again every 0.5 s for up to 30 s before the
   approval is refused). The answer is `mr-opened` (`opened !<iid> <url>`). The ticket is
   `done`, but its landing hold and its `landings` row stay: its dependents stay `blocked` and its
   epic stays open until the MR merges. A forge or mirror failure, an unreachable forge, an MR
   head that is not the reviewed commit, or a project whose settings MR landing does not support
   (read on every approval: a merge method other than `merge`, squash required, merged results
   pipelines or merge trains) is `mr-refused`: the ticket goes back to
   `awaiting-approval` with the reason, the hold ends and the row is deleted; approving again
   writes a second decision and reuses the MR still open. Only an open MR from the project's own
   `foreman/<task id>` branch (not a fork's) into the mapped target branch is reused (every page of
   GitLab's list is read, so fork MRs listed first do not hide it), and one set
   to squash is `mr-refused`. Each approval that opens or reuses an MR
   then posts one note on it naming the reviewed tree, the approver of record, the ticket's author
   and the decision id, and the decision keeps the MR's iid ([security](security.md)). The MR's
   description names the task and points to the latest such note, since a reused MR keeps the
   description it was opened with. Its title is `Foreman <task id>: <ticket title>`, on one line and
   cut to GitLab's 255 characters; led by the task id, a ticket title such as `Draft: ...` does not
   make GitLab open a draft MR, which would never merge. Only those steps run in the section, so
   the next approval in the repo opens its own MR without waiting for CI; a slow forge holds the
   section for at most about five forge calls of 15 s each, plus the mirror's git (and those
   30 s when a reused MR's head lags). A change to
   Foreman itself always lands by the local merge. A daemon that stops with an MR open leaves its
   `landings` row, so the next start holds the repo until `foreman land-clear <repo>`, and sends the
   `done` ticket back to `awaiting-approval` (nothing follows the MR after a restart): approving
   again reuses the MR. A row kept because GitLab merged the MR but the checkout could not take it
   (`land-held`) leaves the ticket `done`. A mapped
   ticket is not hand-landed with `foreman landed` (409), except to record its own MR merged on the
   forge at the reviewed tree ([commands](commands.md)); with auth on, no ticket is hand-landed otherwise.

   **Merging the MR.** A tick stage, before the dispatch gate so a full machine still polls, reads
   each open MR at most every `FOREMAN_MR_POLL_MS`, one call at a time per MR; the tick never waits
   for the forge. Each change of state is one event on the ticket.
   - The ticket left `done` (a person reopened, rejected or archived it): the MR is no longer
     followed, the hold ends and the row is deleted. No merge call is made for it (`no merge made
     by Foreman`). The MR gets one note, `No longer approved in Foreman: the ticket is <status>`,
     and is closed on the forge when the ticket is `rejected`, `canceled`, `failed` or deleted; a
     note or close the forge refuses is a `warning`. After a merge call that got no answer (a timeout), the MR is read first: it is
     dropped only if it still reads open; merged, it is settled as below.
   - The MR's head is not the reviewed commit, its target branch is not the mapped one or it is
     set to squash (someone edited it on GitLab), its pipeline for that commit `failed` or was
     `canceled`, a person closed it, or GitLab refuses the merge call itself (401 or 403, or a
     refusal while the status reads something other than a transient word such as `checking`; a
     refusal while it reads `mergeable`, as when another merge into the target just moved it, is
     tried once more at the next poll first; a merge GitLab answers 200 with the MR still open, as
     when a hook refuses the merge commit, is such a refusal, with GitLab's `merge_error` as the message):
     the ticket goes back to `awaiting-approval` with the reason (the pipeline's URL, or GitLab's
     message), the hold ends and the row is deleted. The MR gets one note, `Not merged by Foreman:
     <reason>`, saying it is no longer approved in Foreman (a note the forge refuses is a
     `warning`), and stays open, so approving again reuses it. After a failed or canceled
     pipeline, retry the pipeline in GitLab (or rework the ticket) first: approving again pushes
     the same reviewed commit, which starts no pipeline, so it reads the same failed one and
     returns at once. Foreman makes no call to retry a pipeline.
   - A merge status of `conflict` or `need_rebase` (another merge into the target came first): the
     ticket goes back to the gate at once, as above, with `rework it, then approve again`. Only a new
     commit on the MR clears either, and a head that is not the reviewed commit is never merged.
   - No pipeline yet, one for another commit, one still running (with `requirePipeline`; without
     it no pipeline is needed), or another merge status other than `mergeable`: it waits, and no
     merge call is made. That includes the lasting words as well as the transient ones:
     `not_approved` (required GitLab approvals), `draft_status` and `discussions_not_resolved` wait
     like `checking` or `ci_still_running`, so a person can still fix them on GitLab. Only `FOREMAN_MR_TIMEOUT_MIN` after the MR was opened does waiting give up and send
     the ticket back to the gate, with the last status as the reason. A forge or mirror failure while
     polling is waited out the same way, except that a merge call that got no answer, or a server
     error (5xx), is first read back: the timeout applies only once a read shows the MR still open.
     Each such call the next read shows open counts: the third sends the ticket back to the gate
     with the last error, and so does the first once the timeout has passed.
     A merge call GitLab answers with another 4xx is a definite answer that nothing merged, and the
     timeout applies to it as to any wait. GitLab answers 401 or 403 when the token may not merge
     into the target branch: that is a refusal, and the ticket goes back to the gate at once.
   - Pipeline `success` for the reviewed commit and `mergeable`: four-eyes (`docs/security.md`) is
     asked again for the approve decision's actor, then one merge call at the reviewed sha, which
     GitLab refuses if the head has moved. Merge calls into one target branch are sent one at a
     time (GitLab can refuse two that overlap); the MR (as in the cases above), the ticket, the repo hold (below) and four-eyes are read again in its turn, right before the call, so an MR a person merged, closed or edited while the merge waited is handled as read. A merge call GitLab refuses is read back too: an MR a person merged just before the call is confirmed (below), one closed goes back to the gate. A turn that makes a merge call lasts until that merge is
     confirmed and the checkout synced, or the repo held for it (not until its post-merge check),
     so a merge that cannot be confirmed holds the repo before the next merge call. If four-eyes now refuses (the approver was disabled while
     the pipeline ran, the creator changed, or the rule no longer allows it), no merge call is made,
     and the ticket goes back to `awaiting-approval` with the reason and that note, as above.
   - The repo is held (below, or a crash mid-merge): it waits, with no merge call, until
     `foreman land-clear <repo>`.
   - Merged (by Foreman, or by a person in GitLab): the mirror fetches the target branch and
     confirms the merge commit is on it with the reviewed commit as its second parent. Confirmed
     (`merged !<iid> at <sha>`), the checkout is synced inside the repo's merge section, so two MRs
     of a repo confirmed in one tick sync one after the other: the merge commit is copied in from
     the mirror (no URL is resolved in the task repo) and the checkout is fast-forwarded to it
     (`merge --ff-only` by sha, pinned git, hooks off), but only when it is on the target branch and
     clean. Then the row is deleted (`checkout synced to <sha>`) and the merge commit gets the
     post-merge check, as a local merge's HEAD does: per merge or coalesced
     (`FOREMAN_POSTMERGE_MODE`), red attributed to the ticket the same way. The landing hold ends
     with the check, so a dependent is released on green; with `FOREMAN_POSTMERGE_CHECK=off` it
     ends at the sync.
   - Not confirmed, or a checkout that cannot be synced (`checkout dirty`, `checkout not on
     <branch>`, a fast-forward git refuses): the repo is held as a crash mid-merge holds it. The
     ticket gets a `land-held(<repo>): <reason>` warning, the repo is listed in `GET /api/state`
     (`landInterrupted`), its dependents stay `blocked`, its other MRs are not merged, and the
     ticket's hold and row stay until you sync the checkout by hand and run
     `foreman land-clear <repo>`, which ends the hold and deletes the row.
     A merge made on the forge is settled this way even when the ticket left `done` meanwhile
     (a person reopened it during the merge call), with a warning naming its status; a confirm
     that fails (a mirror failure) is retried at the next poll, with the hold and the row kept.

### A dependent waiting on a canceled ticket

When a person cancels a ticket (`foreman cancel <id>`, no `--cascade`), tickets that depend on it do not fail. Each stays
`blocked` with the note `waiting: dependency <id> was canceled - foreman deps <dependent> --drop <id>, foreman landed <id>,
or foreman retry <id>`, written once and not rewritten on later ticks. The scheduler decides this from the canceled
ticket's own `cancel` row in `decisions`, never from a status or note. Three exits:

1. `foreman deps <dependent> --drop <id>` removes the edge for that one dependent; it is released once its other
   dependencies are done.
2. `foreman landed <id> --commit <sha>` closes the canceled ticket as `done` (work landed by hand); every waiting
   dependent is released.
3. `foreman retry <id>` requeues it; its dependents are released when it lands as `done`.

Not waiting, still failed with `dependency <id> ended as <status>`: dependents of a ticket canceled with `--cascade`, of one
canceled by its parent epic (a `system` row), of one with no `cancel` row since its last `retry` or `reopen`, and of one
that ended `failed` or `rejected`.

### The worker's own suite run (advisory)

What the gate recorded before: only its own test stage, plus timeline lines while the worker's suite waited for a test slot. The worker's in-jail runs through `src/verify/testSlot.ts` were not read back.

At collection (before the gate's own tests touch the jail) the daemon reads `savedOutputs(outputDir, runId)` — the run key matched exactly, so output under `r_1-2` does not count for `r_1` — and writes one `worker-suite` event, a `worker-suite` artifact (its summary is the line, so it shows in `foreman show` and `/api/state`) and a line (on the run's timeline and as that artifact's summary; it is not put in the reviewers' input):

- `worker suite: PASSED|FAILED at <time> (advisory, written by worker-side code)`, read from the `.result` file the wrapper writes beside the output once the suite has ended (a run cut short has none and says `no result line`), with `; changed after the worker's suite` when a file or folder in the jail (not `.git`, not `node_modules`) has a newer mtime than the last saved output (a folder's changes when a file in it is deleted or renamed);
- `the worker never ran the suite` when there is no saved output, or `worker suite: not run (FOREMAN_WORKER_SUITE=targeted)` under that setting, where no run is the policy, not an omission (a run the worker made anyway is reported as above);
- `worker suite: could not read its saved output (<reason>)` when the output folder cannot be read. Collection goes on.

The line is **advisory** and holds nothing: the output is written by worker-side code in a folder the worker can write, and "changed after" is a file-mtime comparison, so an unsandboxed worker can forge either. The gate's own test stage is the result that counts. The daemon looks in its own temp dir (`os.tmpdir()`), which is the worker's only when they share it.

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
home`. Inside a worker run the CLI is refused (see [Commands](commands.md#commands)), so a worker's `foreman` command does not reach the ledger
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
The marker is removed at a clean exit. While a reap has groups frozen, one listener per event (`exit`, SIGHUP, SIGTERM,
SIGINT) in `proctree.ts` continues every frozen group when the process is signalled or exits. A signal that nothing else
in the process listens for is then raised again, so the process still ends by it. The registry's listener runs ahead of
every other listener for the signal, so a host that handles it itself (`process.once` or `process.on`, installed before
or after the freeze began) is counted, is not cut short and decides its own exit. A process
ended by a signal it does not handle (Ctrl-C of `foreman watch`, a SIGTERM, a SIGKILL, or one of those re-raised as
above) has no `exit` event, so it leaves its marker, and the next `foreman serve` sweep removes it with any other dead recorder's
files. The process's identity is its pid and its zone-free start time; if that cannot be read, the recorder is FAILED.
A worker's `testSlot.ts` is not itself sandboxed in this build (the `claude-code` worker is not; see [The sandbox](security.md#the-sandbox-foreman_sandbox)), so it
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

Under `FOREMAN_WORKER_SUITE=targeted` (default `full`, see [configuration](configuration.md)) the worker's brief
instead asks it to run only the tests for what it changed, says the gate runs the full suite and its result is the
one that counts, says this replaces any full-suite step in the role's prompt above it (the software playbook's dev
and qa roles say to run the suite once), and names the wrapper as the only route for a full run if it must make one.
A `codex-cli` worker, which has no wrapper, gets all of that but the wrapper route. The policy is advisory, not enforced: the worker's
`--allowedTools` and `--disallowedTools` are unchanged (`Bash(node --test:*)` and `Bash(npm run:*)` could start a full
run anyway), so the wrapper stays allowed and a full run the worker still makes takes a verify slot. The gate's own
test stage is unchanged.

- **One suite run per ticket at a time.** The worker session carries `FOREMAN_RUN_ID` and its proof
  `FOREMAN_RUN_TOKEN` (see [security](security.md)); the wrapper sends both, and the daemon refuses
  a second request for the same run while the first is open. The second invocation runs nothing, takes no slot and exits **4** with
  `testSlot: a suite run for this ticket is already in progress (started <N> s ago, pid <p>); wait for it — its full output will be at <path>`.
  The claim lasts as long as the first wrapper's connection, so a wrapper that died holds nothing.
  Other tickets, and a wrapper started with no run id or without that run's token (by hand), are
  not held to each other. With
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


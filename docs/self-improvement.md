## Self-improvement

```bash
foreman improve                    # propose, show, queue nothing
foreman improve --yes              # queue it against the foreman repo
foreman schedule add "weekly self-improvement" --spec "weekly sun 09:00" --improve
```

Foreman reads its own ledgers — outcomes by runner, council verdicts, top
errors, rejections with reasons, quarantined tools, and the README's own
limitations list (the same list as [limitations.md](limitations.md)) — and proposes one fix, queued as an ordinary code task with
the full suite as its gate.

**The guardrails are code, not prose.** `PROTECTED_PATHS` (security scanning
and the core guard, the merge logic, the jail, tool registration, the daemon
lock and its process-error guard, the guardrail file itself, the tests that pin
the guard, and the files that hold the rules around it: the gate, the scheduler,
the queue, the HTTP API and the store's schema) are enforced on the change, not
on the request. Admission
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
`/approve` on its own ticket, read the host-admin secret and queue a ticket
carrying `allowCore` (docs/security.md), or write the store's file. What such a call cannot do is land a protected path without
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


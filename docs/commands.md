## Commands

```
serve · stop · add · ls · show · approve · landed · deps · reject · cancel · retry [--note] · reopen [--note] · rm · watch · demo
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

### `foreman landed <taskId> --commit <sha> [--by <ticketId>] [--note <text>]`

Records work a person landed on the base branch by hand, so the ticket closes as `done` instead of being cancelled.
It posts to `POST /api/tasks/:id/landed`; the route sits behind the same Host check (DNS-rebinding defence) and
cross-origin (Origin) check as every other write under `/api`, which run before routing. There is no separate token:
the guard is those two checks. The decision is always recorded with actor `human`.

**Accepts** a ticket that is `awaiting-approval`, `failed` or `blocked`, or `canceled` when the ticket's latest
`cancel` decision is from a person (not `system`).

**Refuses**, changing nothing (the route answers 409 with the Store's reason; the CLI prints it and exits non-zero):
any other state (`queued`, `running`, `verifying`, `done`, `rejected`, ...: a rejection is a ruling on the work, so
retry the ticket, or cancel it and land the work as a new ticket); a `canceled` ticket whose cancel came from its
parent epic; a ticket with no repo, or a repo that is not a git repo; a `--commit` that is not a commit in that repo;
a repo with no branch checked out; and either ancestry check below. A ticket that does not exist answers 404.

**Inputs** are checked at the route before the Store sees them (400, nothing done): `--commit` is hex, 7 to 40
characters; `--by` has the ticket-id shape (`t_` then letters or digits); `--note` is at most 2000 characters.

**Two ancestry checks**, against the branch checked out in the ticket's repo (the base branch):

1. the commit must be an ancestor of the base branch (it really is landed there);
2. the commit must NOT be an ancestor of the latest run's `base_commit` (that would be work that was already there,
   not work from this ticket). **Exception:** a ticket with no run, or a run with no `base_commit`, skips this second
   check, and the decision's note says so ("no run base_commit, so the jail-base ancestor check was skipped").
   If git cannot compare the two (say the repo does not have that base), the landing is refused.

**What it writes**, in one transaction: a `landed` row in `decisions` (note, `landed_tree` = the commit's tree, and in
`extra` the full `commit`, the `by` ticket id when given, and `statusBefore`), the status `done`, and the revival of
dependents. Dependents revive: tickets that failed *because of* this one (error `dependency <id> ended as failed`,
`rejected` or `canceled`) go back to `blocked`, transitively, and the scheduler releases them once every dependency is
done. Afterwards the ticket's jail (worktree and branch) is removed, but only when it is the run's own tree under the work
root; its artifacts stay.

`foreman show <taskId>` prints the row among the ticket's decisions:
`landed by human; commit <sha>; landed_tree <12 chars>; by ticket <id>; → done; note: landed by hand: ...`. The `by`
part appears only when `--by` was given. `GET /api/state` carries the same facts on each ticket as
`landed: { commit, landedTree, by, actor, at }` (null when the ticket was not landed by hand), and
`GET /api/tasks/:id` lists the full row under `decisions`.

### `foreman cancel <taskId> [--note <text>] [--cascade]`

Stops a queued or running ticket (`POST /api/tasks/:id/cancel`, body `{ note?, cascade? }`; a body that cannot be read
never refuses the cancel). It writes a `cancel` row in `decisions` and an epic's tickets under it are canceled too.

**Dependents wait.** A ticket that depends on the canceled one is not failed. It stays `blocked` with the note
`waiting: dependency <id> was canceled - foreman deps <dependent> --drop <id>, foreman landed <id>, or foreman retry <id>`
(its `error` field: `GET /api/state` and `foreman show` carry it). See
[the waiting state](lifecycle.md#a-dependent-waiting-on-a-canceled-ticket) for the three exits. Whether a dependent waits is
read from the `decisions` table: the canceled ticket must have its OWN `cancel` row from a person.

**`--cascade`** keeps the earlier behaviour: the cancel's row is marked `cascade` in `extra`, and every dependent fails
with `dependency <id> ended as canceled` on the next reconcile. A ticket canceled by its parent epic (a `system` row) also
fails its dependents this way, and so does one with no `cancel` row at all. Dependencies that ended `failed` or `rejected`
always fail their dependents.

### `foreman deps <taskId> --drop <depId>`

Drops one dependency edge (`--after`) from a ticket. It posts to `POST /api/tasks/:id/deps-drop` with `{ dep }`, behind
the same Host and Origin checks as `approve` and `landed`. In one transaction it deletes exactly that `task_deps` row and
writes one `deps-drop` row in `decisions` (actor `human`) whose note names the dependency.

**Refuses**, changing nothing (409 with the reason; the CLI prints it and exits non-zero): a ticket that is `running`; an
edge that does not exist; and a terminal ticket (`done`, `failed`, `rejected`, `canceled`), with one exception. A
dependent this edge failed by cascade (status `failed`, error `dependency <depId> ended as failed|rejected|canceled`, and
the edge exists) is accepted: it is revived through the same path as a retry of its dependency, goes to `blocked`, and
the next reconcile queues it once its other dependencies are done (or fails it again if one of them ended). A ticket
that does not exist answers 404; a `dep` that is not a ticket id answers 400.

**There is no `--add`.** `reconcileBlocked` relies on an invariant: only ticket creation writes edges, so an edge on a
reviewer's follow-up is either the real dependency or an order written by the filing rule. Adding an edge later breaks
that, so edges are set when a ticket is created and can only be dropped. A test fails if any code in `src/` other than
task creation inserts into `task_deps`.

**Inside a worker run the CLI refuses.** A worker session carries `FOREMAN_RUN_ID`; with it set, every
`foreman` command except `help` (and `--help`) exits 2 with `foreman: worker ledger guard: …` before it opens, creates or
locks anything (`ls`, `add`, `restore`, `serve`, `approve`, `doctor`, …). The ledger is the daemon's.
`testSlot.ts` is not `cli.ts` and is unaffected. A suite started by a worker does not inherit the marker
(the wrapper drops it; `test/env.ts` clears it too). The guard is not a fence: a worker that unsets or empties
`FOREMAN_RUN_ID` (`env -u FOREMAN_RUN_ID …`) is not refused, and see [A worker's `FOREMAN_HOME`](lifecycle.md#a-workers-foreman_home).

### `foreman rm <taskId>`

Deletes a ticket. **Refuses** (nothing changes) while it is running or verifying, while open child tickets remain, and
while another ticket depends on it. One kind of dependent no longer blocks it: a reviewer's follow-up that is only
ORDERED behind the ticket (an edge written by the filing rule, not the edge to its own parent). Each such edge is
released through the same path as `foreman deps <id> --drop`, so it writes one `deps-drop` decision (actor `human`) on
the sibling, and the next reconcile queues it once its other dependencies are done. A real dependency still refuses
the rm, as does an ordered sibling that is running or already terminal.

`foreman add` flags: `--kind --runner --repo --agent --priority --after --sensitivity --budget
--test-cmd --no-merge --repairs --prompt --role --playbook --assignee --skills --allow-core` (see [Skills](skills.md);
`--allow-core` is not in `foreman help`, see [Self-improvement](self-improvement.md)).


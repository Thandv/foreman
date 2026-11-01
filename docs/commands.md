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


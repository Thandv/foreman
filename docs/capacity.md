# Capacity

Scope: how fast Foreman's ledger, pipeline and landing are, measured by benchmarks, and the first numbers they gave. For a contributor changing the queue, the scheduler or the gate, and for an operator sizing a backlog. How the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

Neither benchmark is part of `npm run verify` (they take minutes); verify typechecks them, and `test/bench.test.ts` runs each at its smallest size. Both run from a clean checkout with no network: each makes its own temp `FOREMAN_HOME`, clears every `FOREMAN_*` variable the shell exported, turns the OS sandbox off (it is a per-command wrapper whose cost depends on the platform), and removes everything it made when it exits, Ctrl-C included. Neither starts or calls a daemon. Pass `--json` for machine-readable output. Two more scripts, [identity](#identity-scriptsbenchidentityts) and [landing](#landing-scriptsbenchlandingts), do start daemons, and are described apart.

## Ledger: `scripts/bench/ledger.ts`

```
node scripts/bench/ledger.ts [--sizes 1000,10000,100000] [--iterations 20]
```

For each size it seeds a temp ledger file through the `Store` API: one running task, 2% blocked waiting on it, 5% queued, 1% parked at the gate, and the rest done with one finished run each. It then times, after one untimed warm-up call each:

- `reconcileBlocked()`: every blocked task is read and none is promoted, so each pass costs the full scan.
- `claimable(8)`: one dispatch tick's claim query.
- the board snapshot: `GET /api/state` from an in-process server on a loopback port (the snapshot function itself is private to `src/server.ts`), payload read in full.
- `record()`: one event row.

## Pipeline: `scripts/bench/pipeline.ts`

```
node scripts/bench/pipeline.ts [--tickets 20] [--workers 4] [--suite-ms 500] [--model-ms 2000] [--worker-suite full|targeted]
```

One epic of `--tickets` tickets, run twice: with `FOREMAN_GATE_BATCH` on, then off. Each ticket is a shell worker that writes its own file in a real temp git repo, so every ticket lands without a conflict. The ticket's test command is the fake suite: it counts itself and sleeps `--suite-ms`; it runs as the ticket's own check and as the post-merge check on main. A fake `claude` (through `FOREMAN_CLAUDE_BIN`) waits `--model-ms` and then passes every review and approves every ticket the owner gate asks about, one at a time or in a batch. The bench's playbook has one reviewer and the owner gate deciding, with `FOREMAN_CREW_REVIEW=always`, because the gate signs off only work with a review verdict. The scheduler runs at its default tick. Each worker follows its brief under `FOREMAN_WORKER_SUITE` (`--worker-suite`, default `full`): under `full` it runs a stand-in suite (it sleeps `--suite-ms` and counts nothing) once through the slot wrapper against the bench's own server, under `targeted` it does not.

It reports, per run, from the ledger:

| Column | Measured from → to |
| --- | --- |
| tickets/h | the first ticket queued → the last post-merge check passing |
| dispatch | queued → its run starting |
| gate | parked at the gate → merged (the owner model's call, the wait for the repo's merge section, the merge; the approve decision row) |
| landing | merged → its post-merge check passing, which releases dependents (the owner gate logs its approval then) |
| suite runs/landed | fake suite runs (own checks, post-merge checks, re-runs) per landed ticket |
| worker leases/landed | verify slots the workers' own wrapper runs were granted, per landed ticket; not in suite runs |
| gate/review calls | owner-gate calls (a batch is one) and reviewer calls the fake model answered |

A ticket counts as landed once the owner gate has logged its approval, the approval's decision row records that it merged, and the ticket's landing has settled. The post-merge check can end the landing hold before the approval's decision row and the gate's verdict are written (both wait on git after the merge), so the bench waits for the verdict rather than for the hold. Tickets get the default two attempts, so a transient failure retries as it would in production. A ticket that does not land is listed under `unlanded` in `--json` output, with its status, the gate's marker and the end of its last events (a failed git command's message ends with git's error).

## Identity: `scripts/bench/identity.ts`

```
node scripts/bench/identity.ts [--base <checkout>] [--branch <checkout>] [--requests 200] [--out <dir>] [--json]
```

What bearer-token auth costs per request, and what four-eyes landing adds. Unlike the two above it starts daemons: `foreman serve` from a checkout (`--branch`, default this one; `--base`, a checkout of the commit before identity existed, optional), each in its own temp `FOREMAN_HOME`, on a free loopback port, with the OS sandbox off and the model server pointed at a dead port. It refuses a home that is the operator's `~/.foreman` or inside it, and the default port 4100. It writes `raw.json`, `summary.md` and `demo-transcript.txt` to `--out` (default `comparisons/identity`) and prints the summary, or the raw results with `--json`.

Two results are kept apart. **A, comparable:** p50 and p95 of `GET /api/state` and `POST /api/tasks` (a ticket for a person's desk, which never runs) on a fresh daemon of the base with no auth, of the branch with no auth, and of the branch with a bearer. **B, a new capability, branch only:** approve to merged through the local fake GitLab (`scripts/forge/fakeGitlab.ts`) with one principal and with four-eyes, from the approving call to Foreman's "merged" event, with the person's wait left out, and a transcript of the four-eyes demo. B has nothing to compare with and is not a speed-up. `comparisons/identity/method.md` says how to read both.

## Landing: `scripts/bench/landing.ts`

```
node scripts/bench/landing.ts [--scenarios burst,steady,mr] [--tickets 20] [--suite-ms 900] [--burst-gap-ms 50] [--steady-gap-ms 864] [--pipeline-ms 1500] [--wait-ms 600000] [--out <dir>] [--json]
```

What landing costs when many approvals reach one repo. Like identity it starts daemons (`foreman serve` of this checkout, each cell in its own temp `FOREMAN_HOME` on a free loopback port, with the OS sandbox off and the model server pointed at a dead port; it refuses `~/.foreman` and port 4100), and drives them over the HTTP API only, with `scripts/bench/landingRun.ts`. That file takes a daemon's URL and a repo and nothing else, so the comparison harness runs the same code against a build that has no bench code. Time is compressed: the 15-minute suite takes `--suite-ms`.

Each cell parks `--tickets` shell tickets at the gate, then approves them through the API. The ticket's test command is a fake suite that waits `--suite-ms` and appends one line to a log (when it ended, which ticket files its checkout held), so the count of suite runs is read from the log. The last ticket's change is bad: it also writes `bad.txt`, which fails the suite only in a post-merge checkout, so the red's attribution can be read. Scenarios:

| Scenario | Approvals |
| --- | --- |
| burst | `--burst-gap-ms` apart ("20 approvals in one minute") |
| steady | `--steady-gap-ms` apart (100 merges a day at the compression) |
| mr | the burst, landed through the local fake GitLab whose pipelines pass after `--pipeline-ms` |

Each runs under `before` (`FOREMAN_WORKER_SUITE=full`, `FOREMAN_POSTMERGE_MODE=per-merge`) and `after` (`targeted`, `coalesced`). It reports, per cell:

| Column | Measured from → to |
| --- | --- |
| suite runs/landed | log lines (own checks, post-merge checks, re-runs) per landed ticket |
| worker leases/landed | verify slots the workers' wrapper runs were granted, per landed ticket; not in suite runs |
| landings/h | landed tickets over the first approval → the last check that covered a merge |
| approve > merged | the approving call sent → the ticket's merge event (`merge: merged …`, or `merged !<iid> at …` for a merge request) |
| merged > verified | the merge event → the first suite run to end after it in a checkout that held the ticket's file |
| red names | whether the red-main event names the bad ticket, and how many tickets it names |

A ticket whose approval did not land it is listed under `not landed` with the merge event that says why. `--out` writes `raw.json`; `comparisons/landing/method.md` says how to read the stored run.

The comparison harness scenario `landing-burst` runs the burst against the commit before the landing work (3a6712a), the branch with `per-merge` and the branch at its defaults, through the same `landingRun.ts`.

## First numbers

Machine class: an 8-core Apple M2 laptop with 16 GB of memory, macOS 14, Node 26, otherwise idle. Defaults as above. With 20 samples a p99 is the slowest sample, so one pause (a WAL checkpoint, a GC) shows there: the 100k `claimable` p99 is one such sample.

Ledger, ms:

| Tasks | Operation | p50 | p99 |
| --- | --- | --- | --- |
| 1,000 | reconcileBlocked | 1.1 | 1.2 |
| 1,000 | claimable | 0.35 | 0.39 |
| 1,000 | snapshot | 13 | 16 |
| 1,000 | record | 0.02 | 0.03 |
| 10,000 | reconcileBlocked | 11 | 69 |
| 10,000 | claimable | 0.34 | 0.37 |
| 10,000 | snapshot | 131 | 155 |
| 10,000 | record | 0.02 | 0.04 |
| 100,000 | reconcileBlocked | 112 | 247 |
| 100,000 | claimable | 0.34 | 104 |
| 100,000 | snapshot | 1,587 | 1,653 |
| 100,000 | record | 0.02 | 0.08 |

Pipeline, 20 tickets, 4 workers, a 500 ms suite and a 2 s model, ms:

| Gate batch | Landed | Gate/review calls | Tickets/h | Dispatch p50/p90 | Gate p50/p90 | Landing p50/p90 | Suite runs/landed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| on | 20/20 | 5/20 | 1,969 | 2,068/4,599 | 14,826/26,173 | 623/625 | 2 |
| off | 20/20 | 20/20 | 1,053 | 2,031/4,241 | 29,824/53,839 | 620/623 | 2 |

The table above was measured before the bench's workers ran the wrapper, which is the same as `--worker-suite targeted` today. One later pair at the same sizes, on a machine that was not idle, both modes landing 20/20 with the same gate/review calls and 2 suite runs per landed ticket:

| Worker suite | Gate batch | Tickets/h | Dispatch p50/p90 | Worker leases/landed |
| --- | --- | --- | --- | --- |
| full | on | 1,850 | 4,335/9,281 | 1 |
| full | off | 1,019 | 4,254/9,145 | 1 |
| targeted | on | 1,950 | 2,080/4,706 | 0 |
| targeted | off | 1,052 | 2,063/4,246 | 0 |

Landing, 20 tickets, a 900 ms suite (the 15-minute suite at 1000x), one bad change last, ms, from the stored run in `comparisons/landing/` ([method](../comparisons/landing/method.md)):

| Scenario | Mode | Landed | Suite runs/landed | Worker leases/landed | Landings/h | Approve > merged p50/p95 | Merged > verified p50/p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| burst | before | 20/20 | 2.05 | 1 | 6,781 | 3,146/5,902 | 2,032/3,382 |
| burst | after | 20/20 | 1.45 | 0 | 8,061 | 3,071/5,798 | 1,434/1,841 |
| steady | before | 20/20 | 2.05 | 1 | 4,025 | 383/387 | 1,016/1,020 |
| steady | after | 20/20 | 1.9 | 0 | 3,874 | 380/390 | 1,534/1,994 |

The same burst through the comparison harness, against the commit before the landing work: 3a6712a landed 15 of 20 (its overlapping approvals conflict: there is no per-repo merge section) at 2.47 suite runs per landed ticket; the branch landed 20 of 20, at 2.05 under `per-merge` and 1.45 under `coalesced`, against the target of 2.3 or fewer. The `mr` scenario lands one merge request and refuses the other 19 at the git tripwire (the first merge request creates `refs/foreman/forge/target`), so it has no suite-run figure worth reading.

What they say:

- `claimable` and `record` do not grow with the ledger. `reconcileBlocked` grows with the number of blocked tasks (one dependency query each) and the snapshot with every task not archived: at 100k tasks a board poll costs about 1.6 s of the daemon's one thread. Archiving closed work is what keeps the snapshot small.
- With one model call per ticket, the owner gate is the pipeline's bottleneck: tickets queue behind each other's calls. Batching cut the gate's calls from 20 to 5 and its p50 wait in half, and nearly doubled throughput. Dispatch and landing do not depend on it.
- Every landed ticket ran the suite twice, its own check and one post-merge check: no re-runs, no coalescing.
- A worker's own run through the wrapper takes one of the verify slots the gate's runs use. Under `full` each worker held one for a suite's length before it finished, and dispatch p50 roughly doubled; under `targeted` the workers took none and the gate's runs per ticket did not change.

## Approval age

`GET /api/metrics` reports two approval ages per repo, and a comparison only ever sets a figure beside the same one:

- `awaitingApprovalAgeP95Ms` (`foreman_awaiting_approval_age_p95_ms`) counts from each parked ticket's last update. Any write resets it: a gate change makes a ticket parked three hours read as zero.
- `awaitingSinceParkP95Ms` (`foreman_awaiting_approval_since_park_p95_ms`) counts from when the ticket entered `awaiting-approval` (`tasks.awaiting_since`), or from its last update for a ticket parked before that was recorded.

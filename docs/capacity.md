# Capacity

Scope: how fast Foreman's ledger and pipeline are, measured by two benchmarks, and the first numbers they gave. For a contributor changing the queue, the scheduler or the gate, and for an operator sizing a backlog. How the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

Neither benchmark is part of `npm run verify` (they take minutes); verify typechecks them, and `test/bench.test.ts` runs each at its smallest size. Both run from a clean checkout with no network: each makes its own temp `FOREMAN_HOME`, clears every `FOREMAN_*` variable the shell exported, turns the OS sandbox off (it is a per-command wrapper whose cost depends on the platform), and removes everything it made when it exits, Ctrl-C included. Neither starts or calls a daemon. Pass `--json` for machine-readable output.

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
node scripts/bench/pipeline.ts [--tickets 20] [--workers 4] [--suite-ms 500] [--model-ms 2000]
```

One epic of `--tickets` tickets, run twice: with `FOREMAN_GATE_BATCH` on, then off. Each ticket is a shell worker that writes its own file in a real temp git repo, so every ticket lands without a conflict. The ticket's test command is the fake suite: it counts itself and sleeps `--suite-ms`; it runs as the ticket's own check and as the post-merge check on main. A fake `claude` (through `FOREMAN_CLAUDE_BIN`) waits `--model-ms` and then passes every review and approves every ticket the owner gate asks about, one at a time or in a batch. The bench's playbook has one reviewer and the owner gate deciding, with `FOREMAN_CREW_REVIEW=always`, because the gate signs off only work with a review verdict. The scheduler runs at its default tick.

It reports, per run, from the ledger:

| Column | Measured from → to |
| --- | --- |
| tickets/h | the first ticket queued → the last post-merge check passing |
| dispatch | queued → its run starting |
| gate | parked at the gate → merged (the owner model's call, the wait for the repo's merge section, the merge; the approve decision row) |
| landing | merged → its post-merge check passing, which releases dependents (the owner gate logs its approval then) |
| suite runs/landed | fake suite runs (own checks, post-merge checks, re-runs) per landed ticket |
| gate/review calls | owner-gate calls (a batch is one) and reviewer calls the fake model answered |

A ticket counts as landed once the owner gate has logged its approval, the approval's decision row records that it merged, and the ticket's landing has settled. The post-merge check can end the landing hold before the approval's decision row and the gate's verdict are written (both wait on git after the merge), so the bench waits for the verdict rather than for the hold. Tickets get the default two attempts, so a transient failure retries as it would in production. A ticket that does not land is listed under `unlanded` in `--json` output, with its status, the gate's marker and the end of its last events (a failed git command's message ends with git's error).

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

What they say:

- `claimable` and `record` do not grow with the ledger. `reconcileBlocked` grows with the number of blocked tasks (one dependency query each) and the snapshot with every task not archived: at 100k tasks a board poll costs about 1.6 s of the daemon's one thread. Archiving closed work is what keeps the snapshot small.
- With one model call per ticket, the owner gate is the pipeline's bottleneck: tickets queue behind each other's calls. Batching cut the gate's calls from 20 to 5 and its p50 wait in half, and nearly doubled throughput. Dispatch and landing do not depend on it.
- Every landed ticket ran the suite twice, its own check and one post-merge check: no re-runs, no coalescing.

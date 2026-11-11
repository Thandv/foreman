# Landing comparison: method

`node scripts/bench/landing.ts --out comparisons/landing` produced the `burst` and `steady` cells of `raw.json` here, at
commit 9b217ab (this branch, clean for `src/` and `scripts/`). The `mr` cells were rerun alone (`--scenarios mr`) at
63c7c94, after the git tripwire stopped flagging Foreman's own `refs/foreman/forge/` refs. How the script works is in
[docs/capacity.md](../../docs/capacity.md). The comparison against the commit before the landing work (3a6712a) is the
harness scenario `landing-burst`, which runs the same `scripts/bench/landingRun.ts` against 3a6712a, the branch with
`FOREMAN_POSTMERGE_MODE=per-merge` and the branch at its defaults; its `result.json` is kept with the comparison harness, not in this repository.

Machine class: an 8-core Apple M2 laptop with 16 GB of memory, macOS 14, Node 26, a few other processes running (load
average 2 to 3 while it ran). Compressed time: the 15-minute suite takes 900 ms.

## What was run

Every cell is a `foreman serve` of the checkout in a temp `FOREMAN_HOME` on a free loopback port, with the OS sandbox off
and the model server pointed at a dead port. Nothing touched `~/.foreman` or the live daemon's port. Each cell has 20 shell
tickets in one repo, parked at the gate, then approved through the API:

- **burst**: approvals 50 ms apart. **steady**: 864 ms apart (100 merges a day at 1000x). **mr**: the burst, through the
  local fake GitLab whose pipelines pass after 1.5 s.
- **before**: `FOREMAN_WORKER_SUITE=full` (each worker runs the suite once through the slot wrapper) and
  `FOREMAN_POSTMERGE_MODE=per-merge`. **after**: `targeted` and `coalesced`.
- The suite is a command that waits 900 ms and logs when it ended and which ticket files its checkout held. Suite runs per
  landed ticket count its log lines (each ticket's own check, post-merge checks, re-runs) over the tickets that landed;
  the workers' wrapper runs are counted apart. The bench leaves out the own checks of tickets that did not land
  (`unlandedOwnChecks`). The `burst` and `steady` cells were run before it did, but every ticket in them landed, so
  their figures are unchanged; their `unlandedOwnChecks` (0) and `culpritLanded` (true) were filled in from that, not
  measured. The harness `result.json` was also written before it and counts them, which changes its 3a6712a cell only
  (2.47 stored, 32 runs over 15 landed = 2.13 without the 5 conflicted tickets' own checks).
- The last ticket's change is bad and turns the suite red in a post-merge checkout only.

## Read these caveats first

1. **The `mr` cells land all 20 merge requests.** The first run of these cells landed one and refused the other 19 at
   the git tripwire ("ref refs/foreman/forge/target was created"): the first merge request's mirror copy created that
   ref in the real repo, and every run that began before it was then not approvable. The tripwire now leaves
   `refs/foreman/forge/` out (Foreman's own refs, never read back), and the rerun lands 20 of 20 under both modes:
   2.05 suite runs per landed ticket under `per-merge` and 1.2 under `coalesced`. Approve to merged (p50 about 6.3 s)
   and merged to verified (p50 8.9 s and 5.9 s) are longer than the plain burst's, because each landing waits for the
   fake pipeline (1.5 s) and the target fetch; under `coalesced` one check covered up to 10 merges, so its red names
   the culprit among 10 tickets. The fake runs merges one at a time and does not recheck other merge requests when the
   target moves, so these cells say nothing about merges that collide on a real GitLab. Foreman now sends merge calls
   into one target one at a time and tries a refusal once more while GitLab reports `mergeable`; the fake's
   `refuseOverlappingMerges` and `recheckAfterMerge` options behave like that, and these cells were not rerun with them.
2. **Coalescing helps in proportion to overlap.** In the burst the checks overlap and the post-merge checks coalesce: 2.05
   to 1.45 suite runs per landed ticket. In the steady run a check ends before the next merge, so there is little to
   share: 2.05 to 1.9, and merged-to-verified is longer under `coalesced` (about 1.5 s against 1.0 s) because a merge that
   arrives while a check runs waits for the next one.
3. **Red attribution.** With one bad change last, both modes' red names the culprit. On 3a6712a the bad last ticket was
   one of the 5 whose merge conflicted, so it never merged and no red could name it: the harness verdict's "does NOT
   name the culprit among 0 task(s)" means the culprit did not land (the bench now reports `culprit not landed`). Under `coalesced` the red can name
   every ticket one check covered (two in the harness run), because bisecting a red batch is not built yet.
4. **Merged-to-verified is read from the suite's own log**: the first run to end after the merge in a checkout that held
   the ticket's file. A ticket's own check holds its file but ends before it merges, so it cannot be mistaken for the
   post-merge check. Event times are the daemon's, the approving call's time is the bench's, on the same machine.
5. One run per cell. Read the difference between rows rather than the size of a single figure.

# Landing comparison: method

`node scripts/bench/landing.ts --out comparisons/landing` produced `raw.json` here, at commit 9b217ab (this branch, clean
for `src/` and `scripts/`). How the script works is in [docs/capacity.md](../../docs/capacity.md). The comparison against
the commit before the landing work (3a6712a) is the harness scenario `landing-burst`, which runs the same
`scripts/bench/landingRun.ts` against 3a6712a, the branch with `FOREMAN_POSTMERGE_MODE=per-merge` and the branch at its
defaults; its `result.json` is kept with the comparison harness, not in this repository.

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
  the workers' wrapper runs are counted apart. The bench now leaves out the own checks of tickets that did not land
  (`unlandedOwnChecks`); `raw.json` and the harness `result.json` were written before that and count them, which only
  changes the cells with tickets not landed: the `mr` cells (21 stored, 2 without them) and the harness's 3a6712a cell
  (2.47 stored, 32 runs over 15 landed = 2.13 without the 5 conflicted tickets' own checks).
- The last ticket's change is bad and turns the suite red in a post-merge checkout only.

## Read these caveats first

1. **The `mr` cells measure a refusal, not a landing.** One merge request lands; the other 19 approvals are refused by
   the git tripwire ("ref refs/foreman/forge/target was created"): the first merge request creates that ref in the real
   repo, and every run that began before it is then not approvable. So the `mr` suite-runs-per-landed figure (21) is 20 own
   checks over one landing and says nothing about coalescing. Merge requests cannot be burst-approved today; this is a
   finding, not something this ticket changes.
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

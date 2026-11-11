# Identity comparison: method

`node scripts/bench/identity.ts --base <checkout of the commit before identity> --branch <this checkout>` produced
`raw.json`, `summary.md` and `demo-transcript.txt` here. How the script works is in
[docs/capacity.md](../../docs/capacity.md).

## What was run

Every daemon was `foreman serve` from a checkout, in a `FOREMAN_HOME` made for it (a temp directory), on a free loopback
port, with the OS sandbox off and the local model server pointed at a dead port. The script asserts that no home is the
operator's `~/.foreman` or inside it and that no port is 4100, the live daemon's. Nothing else was touched.

- **A, comparable.** 200 timed requests (after 5 untimed) of `GET /api/state` and then `POST /api/tasks` (a ticket for a
  person's desk, which never runs), one at a time, on a fresh daemon with an empty ledger for each of: the base without
  auth, the branch without auth, the branch with a bearer token. The only difference between the last two is the token
  lookup. p50 and p95 are of the 200.
- **B, a new capability.** The base has no principals, no four-eyes and no merge-request landing, so there is nothing to
  compare it with, and these numbers are not a speed-up or a slowdown. On the branch, a repo is mapped to a project on the
  local fake GitLab with a passing pipeline, and the merge request is polled every 100 ms. The time is from the approving
  call to Foreman's own "merged" event for the ticket: the person's wait before approving is not in it, and the poll
  interval, the push through the mirror and the fake's merge are. First one principal approves its own ticket, then a
  second is minted and the author's approval is refused before the second person's lands.

## Read these three caveats first

1. **Attribution, not security.** An unsandboxed worker runs as the daemon's user, can read `secrets/host-admin` and is a
   loopback peer, so it can mint a principal for itself and so a second person for four-eyes. That is pinned as a
   documented gap (`test/identity-gap.test.ts`, and "Known gap until the worker sandbox" in
   [docs/security.md](../../docs/security.md)). Until workers run in the macOS sandbox with gateway-only egress, the
   identities in the transcript say who acted; they do not stop a worker.
2. **Single host.** One daemon, one machine, loopback only, the fake GitLab on the same host. Nothing here measures a
   network between a person and the daemon or between the daemon and a real GitLab.
3. **No required approval rules on the demo project.** Foreman records the approver on the merge request and never calls
   GitLab's approve, so a project with required approvals would hold the merge for a GitLab person. The fake has none.

Latencies are loopback and sub-millisecond, from one run on an otherwise idle laptop; read the difference between rows
rather than the size of a single one.

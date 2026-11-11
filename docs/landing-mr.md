# Landing by merge request, for a team

With `FOREMAN_LANDING=mr`, a repo mapped in `landing.json` does not merge an approved ticket into the operator's checkout:
the reviewed commit goes to a merge request on GitLab, and Foreman merges that request once its pipeline passes. This page
is the short version, with a demo you can rerun. The rules are in [lifecycle](lifecycle.md) (merge, "By merge request"),
the setting in [configuration](configuration.md#merge-request-landing-landingjson), the token and mirror in
[security](security.md#the-gitlab-token-foreman_landingmr).

## The invariant

Whatever lands is the tree a person reviewed. The commit pushed to the MR is the one the gate checked; an MR whose head is
anything else is never merged, and the merge call names the reviewed sha, which GitLab refuses (409) if the head has moved.
With sign-in on, the person who approves is not the person who created the ticket (four-eyes), and that is asked again
right before the merge call.

## States of a ticket

| State | Meaning | How it ends |
|---|---|---|
| `done`, MR open | Approved; the MR is polled every `FOREMAN_MR_POLL_MS`; its dependents stay `blocked` | the pipeline passes and the MR merges, or one of the next two |
| back at the gate (`awaiting-approval`) | The pipeline failed, the head is not the reviewed commit, a person closed the MR, GitLab refused the merge, or the MR timed out | approve again |
| merged, checkout synced | The merge commit is confirmed on the target branch and the checkout is fast-forwarded to it | the post-merge check is green and the dependents are released |
| repo held | A merge could not be confirmed or the checkout could not take it | `foreman land-clear <repo>` after you have looked |

A daemon restart while an MR is open also holds the repo: run `foreman land-clear <repo>` after the restart. The MR
itself stays on GitLab.

## The demo

```sh
node scripts/demo/mr-landing.ts [--keep] [--check]
```

It runs from a clean checkout in seconds and touches nothing outside temp dirs. It has a `FOREMAN_HOME` and a port
of its own (never `~/.foreman` or the live daemon), a bare "GitLab" repo with a clone, and the local fake GitLab
(`scripts/forge/fakeGitlab.ts`) with a token, a pipeline left running and a short "checking" window. It writes
`landing.json` and `secrets/gitlab-token`, mints two people (alice, bob), and starts a daemon from this checkout with
`FOREMAN_LANDING=mr`, `FOREMAN_WORKER_SUITE=targeted` and a shell worker. The token never appears in its output. It
prints each step of three passes:

1. The pipeline passes. alice's approval of alice's own ticket is refused (403, four-eyes). bob's approval opens the MR,
   whose head is the reviewed commit. The pipeline succeeds, the MR merges at that sha, the checkout is synced, the main
   check is green and alice's second ticket, which depended on the first, is released.
2. The pipeline fails. The ticket is back at the gate, with the pipeline's URL.
3. The MR's head moves after review and the moved head's pipeline passes, so only the stale sha is left to refuse: the
   demo's own merge call at the reviewed sha is refused (409). The ticket is back at the gate ("MR head moved after
   review"): Foreman reads the moved head and never makes that call.

`--keep` leaves the temp dirs (and prints them) so you can read `landing.json`, the ledger and the repos; remove them
yourself. `--check` answers the pipeline at once and does not pause: the suite runs the demo that way
(`test/demo-mr-landing.test.ts`). The script stops with a non-zero status the moment a step does not happen as above.

## Against a real GitLab

The demo only talks to the fake. To try the real thing, map a throwaway repo and project in `landing.json`, put the token
in `<FOREMAN_HOME>/secrets/gitlab-token` (mode 0600), run `foreman doctor`, and sign two people in
(`foreman token create --host-admin --name <name>`) before approving.

## Manual steps

- Held repo: look at the checkout (`git status`, is it on the target branch and clean), fast-forward it by hand if
  GitLab merged, then `foreman land-clear <repo>`.
- A ticket whose MR was merged on GitLab at the reviewed tree can be recorded with `foreman landed <id> --commit <sha>` ([commands](commands.md)).

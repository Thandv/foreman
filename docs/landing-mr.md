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
| back at the gate (`awaiting-approval`) | The pipeline failed, the head is not the reviewed commit, the MR was retargeted or set to squash, it conflicts with the target (GitLab reports `conflict` or `need_rebase`), a person closed the MR, GitLab refused the merge, or the MR timed out. The MR gets a `Not merged by Foreman` note and stays open | approve again (the MR is reused) |
| merged, checkout synced | The merge commit is confirmed on the target branch and the checkout is fast-forwarded to it | the post-merge check is green and the dependents are released |
| repo held | A merge could not be confirmed or the checkout could not take it | `foreman land-clear <repo>` after you have looked |

A daemon restart while an MR is open also holds the repo, and sends the ticket back to the gate: nothing follows the MR
after a restart. Run `foreman land-clear <repo>`, then approve again (the open MR is reused), or, if GitLab merged it at
the reviewed commit meanwhile, record it with `foreman landed <id> --commit <sha>`. The MR itself stays on GitLab, with
no note.

A ticket that leaves `done` while its MR is open (reopened, rejected, canceled) is no longer followed: its MR gets a
`No longer approved in Foreman` note, and is closed when the ticket is rejected, canceled, failed or deleted.
A repo already held because GitLab merged the MR but the checkout could not take it stays held after a restart, and
its ticket stays done: sync the checkout by hand, then `foreman land-clear <repo>`.

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
   check is green at the merge commit (the ticket's test command records the HEAD each run is at, and the demo finds
   the merge commit there) and alice's second ticket, which depended on the first, is released.
2. The pipeline fails. The ticket is back at the gate, with the pipeline's URL.
3. The MR's head moves after review and the moved head's pipeline passes, so only the stale sha is left to refuse: the
   demo's own merge call at the reviewed sha is refused (409). The ticket is back at the gate ("MR head moved after
   review"): Foreman reads the moved head and never makes that call.

`--keep` leaves the temp dirs (and prints them, a failed run's too) so you can read `landing.json`, the ledger and the repos; remove them
yourself. `--check` answers the pipeline at once and does not pause: the suite runs the demo that way
(`test/demo-mr-landing.test.ts`). The script stops with a non-zero status the moment a step does not happen as above.

## Against a real GitLab

The demo only talks to the fake. None of this has been run against a real GitLab yet.

### What the GitLab side needs

- GitLab 15.6 or later: the adapter reads `detailed_merge_status` and refuses an MR without it.
- A token whose user may create, read, comment on, close and merge MRs (scope `api`; GitLab has no narrower scope for
  merging) and push over https (scope `write_repository`, for an https `pushUrl`). A project access token's bot user
  is the usual choice.
- That user may merge into the target branch (on a protected branch, Maintainer by default) and push and force-push
  `foreman/*`. Without merge rights GitLab answers the merge call with 401, and the ticket goes back to the gate with
  that message.
- Merge method `merge` (not fast-forward or semi-linear), squash not required, and no merged results pipelines or
  merge trains. `foreman doctor` FAILs a project that breaks one of these, and an approval there is refused.
- No required GitLab approval rules: Foreman never approves on GitLab, so such an MR waits for a person to approve it
  on GitLab, or for `FOREMAN_MR_TIMEOUT_MIN`.
- `pushUrl` is the same project as `project`, not a fork.
- No Git LFS in the repo: Foreman's git runs with filters off and pushes objects it copied itself, so it never uploads
  an LFS object. GitLab refuses a push that adds an LFS pointer without its object, and a file meant for LFS is pushed
  as a plain file.
- No push rules that reject unsigned commits or check the committer or author: Foreman's commits are not signed, and
  carry the git identity they were made with, not the token's user. Either refuses the push, and the approval is
  `mr-refused` (`merge request not opened: git push for the forge mirror of <repo> failed: ...`).

To try it, map a throwaway repo and project in `landing.json`, put the token
in `<FOREMAN_HOME>/secrets/gitlab-token` (mode 0600), run `foreman doctor`, and sign two people in
(`foreman token create --host-admin --name <name>`) before approving.

Anyone who may push to `foreman/<task id>` can open an MR from it before the approval. Foreman reuses only an MR into
the mapped target branch that is not set to squash, and reads both again before every merge call, but the branch is
still force-pushed with the reviewed commit. Make `foreman/*` a protected branch pattern on GitLab that only the
token's user may push to, with "Allowed to force push" on: approving a reworked ticket again force-pushes its branch.
Foreman opens each MR with "delete source branch" on, but GitLab does not delete a protected branch when it merges, so
with this pattern the merged `foreman/*` branches stay: delete them on a schedule. Left unprotected, they are deleted
on merge, but any Developer can push there.

## Manual steps

- Held repo: look at the checkout (`git status`, is it on the target branch and clean), fast-forward it by hand if
  GitLab merged, then `foreman land-clear <repo>`.
- A ticket whose MR was merged on GitLab at the reviewed tree can be recorded with `foreman landed <id> --commit <sha>` ([commands](commands.md)).
- An MR Foreman no longer follows but did not close (its ticket went back to the gate, was reopened, or the daemon
  restarted) stays open on GitLab, and anyone with merge rights there can still merge it; Foreman would not check it.
  Close it by hand if the ticket will not be approved again.

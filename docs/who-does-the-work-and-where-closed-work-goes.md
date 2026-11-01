## Who does the work, and where closed work goes

```bash
foreman add "…" --assignee human     # parks at `awaiting-human`; no worker ever claims it
foreman assign <taskId> ai|human     # move an unstarted task either way
```

Every task has an **assignee** — `ai` by default, which is what Foreman is for. `human` is the
other setting: the task never dispatches to a runner at all, it parks in the board's *Yours to
do* lane, and it closes through the same gate an AI task does. Resolution runs task →
playbook role → playbook → `FOREMAN_ASSIGNEE` → `ai`, so a playbook can claim one role for the
operator permanently (`"publisher": { "tier": "owner", "assignee": "human" }`) — which is how a
rule like "no binding ruling is authored by a model" becomes code rather than prose.

```bash
foreman archive                      # closed work, newest first
foreman archive estimate "draft chapter 21" --role author --playbook publishing
```

Closed tasks fold into the **archive** a week after they close, on an hourly sweep, so the
Closed lane stays "what just happened" instead of growing without bound. Archiving is never
deletion: the task row stays (so `trace` still reconstructs it) and a denormalised record —
duration, cost, tokens, repair rounds, points, verdict — is written alongside it. That record
is denormalised on purpose, because `prune` deletes the ledgers it would otherwise point at,
and it is what `estimate` reads: a **median over comparable past work**, zero tokens, reporting
its own sample count and evidence so a real estimate is distinguishable from one built on two
rows.


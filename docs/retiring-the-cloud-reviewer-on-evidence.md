## Retiring the cloud reviewer, on evidence

```bash
export FOREMAN_SHADOW_LOCAL=1   # while a cloud reviewer is still deciding tickets
foreman agreement               # per role: samples, agreement, trend, false passes
```

Every ticket a cloud model reviews also gets a **shadow verdict** from a local reviewer —
recorded, never binding, never seen by the gate. The cloud reviewer is retirable for a role
when, over **≥30 samples**, the local one **agrees ≥90%** of the time with **at most one false
pass in thirty**.

The thresholds live in `src/agreement.ts`, were fixed before the first sample was collected, and
are pinned by a test — because the way a gate gets retired early is by deciding what "good
enough" means while looking at a number that will not clear. The two errors are not symmetric
and are scored separately: a local reviewer that *fails* work the cloud passed is expensive, one
that *passes* work the cloud failed is the error that lands bad work once the cloud is gone.
Scoring is per (playbook, role), because a model ready for copyedit and hopeless at
developmental edit is not "85% agreed".

`foreman drill`'s `gate-retirable` probe reports the same verdict.


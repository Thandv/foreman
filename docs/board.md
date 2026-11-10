## The board

`http://127.0.0.1:4100` — five lanes (Queue · Working · Yours to do · Your call · Closed), a worker-pool gauge
and today's spend. Cards show a live stage rail, progress bar and verdict chip. Click one for the
drawer: **Activity** (live log), **Council** (every advisor's verdict, confidence and critique,
plus the chair's reasoning), **Artifacts** (coloured diff viewer), **Receipts** (per-call tokens,
cost, latency, local-vs-cloud), **Prompt** — and Approve / Reject / Cancel / Retry.

Each task row in `GET /api/state` carries `awaitingSince`: the epoch ms it entered `awaiting-approval`, unchanged by a
re-park or a gate change while it waits, and `null` once it leaves (approve, reject, a repair round, a requeue) or if
it was parked before Foreman recorded this. The owner gate's work list is ordered by it, longest parked first
(`updatedAt` for a ticket parked before it was recorded).


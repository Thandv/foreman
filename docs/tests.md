## Tests

```bash
npm run verify    # typecheck, then the whole suite; the gate to run before a commit
npm test          # the suite alone
npm run typecheck      # the native compiler (tsgo, @typescript/native-preview), the one the gate runs
npm run typecheck:tsc  # tsc 5.9, the reference: run it when the two might disagree
foreman drill     # the live readiness suite — real models, answers checked by code
```

Covered: DAG promotion and dependency-failure propagation, exactly-once claim, crash recovery,
orphaned-process-group reaping on recovery, pid recording over a child's lifetime, the daemon
pidfile lock (live conflict and stale reclaim), pool concurrency, cancel and timeout aborts,
worktree jails and dirty-repo refusal, per-run branch uniqueness, the test gate short-circuiting
the council, council agreement / disagreement→chair / unreachable→split / unparseable→not-pass,
budget cap breach, provider concurrency, receipts on success *and* failure, S2 refusal of cloud
models and hosted runners, admission blocks and their false-positive rate on ordinary prompts,
agent-catalog refusal, api-runner jail escape and destructive-command refusal, merge
only-when-approved, merge refusal on a dirty repo, prune keeping undecided branches and approved work that has not landed, memory
belief revision, schedule parsing and single-fire re-arming, HTTP routes, path-traversal
containment, SSE streaming and slow-client drop policy, claude/codex stream parsing on recorded
fixtures, chunk-split line reassembly, and trace-sink delivery plus sink-failure isolation.

### Verified live (not just unit-tested)

A real `shell` code task on a scratch git repo: worktree cut → change applied → `npm test` passed
→ two local models reviewed the diff → **they disagreed** → the chair (`qwen3.5:9b`) read both and
correctly identified that `llama3.1:8b` had misread the diff → verdict `pass` → approved → branch
merged `--no-ff` → repo clean → `prune` reclaimed all three branches. Four council calls, all
local, $0.00, every one on the receipts ledger.


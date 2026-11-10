## Tests

```bash
npm run verify    # typecheck, then the whole suite; the gate to run before a commit
npm test          # the suite alone
npm run typecheck      # the native compiler (tsgo, @typescript/native-preview), the one the gate runs
npm run typecheck:tsc  # tsc 5.9, the reference: run it when the two might disagree
foreman drill     # the live readiness suite — real models, answers checked by code
```

The typecheck step of `verify` (`tsgo --noEmit`, see `scripts/verify.sh`) uses `tsconfig.json`, which covers
`src/`, `test/` and all of `scripts/` (the `scripts/checks/*.ts` gates too): `strict` and
`noUncheckedIndexedAccess`, plus `noUnusedLocals` (rejects an unused local or import), `noUnusedParameters`
(an unused parameter; prefix with `_` if the signature needs it), `noFallthroughCasesInSwitch` (a non-empty
case that falls through), `noImplicitReturns` (a function that returns a value on only some paths) and
`noImplicitOverride` (an overriding member without `override`). Tickets queued before this landed must rebase
onto it; a new failure on an unused binding after the rebase is expected, not a regression.

`scripts/forge/fakeGitlab.ts` is a local fake GitLab for the merge-request landing tests and the demo: a `node:http`
server (no dependencies, no network) over real bare repos, serving the REST v4 subset Foreman uses (project, merge
requests, merge by `sha`) with GitLab's field names and status codes: 409 on a stale `sha`, 405 while
`detailed_merge_status` is `checking` or the pipeline is not green, 401 without the token. Import `startFakeGitlab`
in a test, or run it with `node scripts/forge/fakeGitlab.ts --project group/app=<bare repo>` (token in
`FAKE_GITLAB_TOKEN`, never printed or logged). `POST /__fake/pipelines/:sha {status}` flips a pipeline.
`test/fake-gitlab.test.ts` pins it.

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
fixtures, chunk-split line reassembly, and trace-sink delivery plus sink-failure isolation, its in-flight cap, drop count and post timeout.

### Verified live (not just unit-tested)

A real `shell` code task on a scratch git repo: worktree cut → change applied → `npm test` passed
→ two local models reviewed the diff → **they disagreed** → the chair (`qwen3.5:9b`) read both and
correctly identified that `llama3.1:8b` had misread the diff → verdict `pass` → approved → branch
merged `--no-ff` → repo clean → `prune` reclaimed all three branches. Four council calls, all
local, $0.00, every one on the receipts ledger.


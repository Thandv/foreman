## Security posture

- The API can queue shell commands. It binds loopback only; anything else needs
  `FOREMAN_ALLOW_REMOTE=1`, and there is still **no authentication** — this is a local tool.
  The approve and `landed` endpoints take no proof of who is calling and record the caller as `human`.
  The one exception is the run a `POST /api/verify-slot` request names: `x-foreman-run` counts only
  with `x-foreman-run-token`, an HMAC-SHA256 of the run id under a key the daemon draws at start
  (32 random bytes, held in memory, never written to disk; no run outlives its daemon). Workers get
  it as `FOREMAN_RUN_TOKEN` beside `FOREMAN_RUN_ID`; the slot wrapper sends it and removes both from
  the suite's environment. A request with a missing or wrong token is treated exactly as one that
  names no run: it is still slotted, never refused, and claims nothing, so another local process
  cannot make a run's lease busy or have a slot wait counted against its deadline. It is never
  answered 403, because the wrapper reads any non-200 answer as "no daemon" and runs unslotted.
- `allowCore` (a ticket that may edit Foreman's own core) is honoured only from a request that
  carries the host-admin secret in `x-foreman-host-secret`. The secret is 32 random bytes in
  `<FOREMAN_HOME>/secrets/host-admin` (mode 0600, created once by the first `foreman add --allow-core`
  or `foreman improve --allow-core --yes`; `src/security/hostSecret.ts` is the only code that touches
  that directory). `POST /api/tasks` and `POST /api/improve` compare it with `timingSafeEqual`; without
  a match the task is still queued, without `allowCore`, and records the warning event
  `allowCore dropped: request lacked the host-admin secret`. The secret is never logged, never in an
  event and never in a worker's environment. This stops a process that can only reach the local API;
  it is **not a boundary against a worker**: while workers run unsandboxed as the daemon's user, a
  worker can read the file.
- Runners work in a worktree or scratch dir, never in your checkout, and only an approval makes
  Foreman land anything in your repo. That keeps a worker's mistake out of your repo, not a hostile
  worker: the `claude-code` and `codex-cli` workers are not sandboxed (see "What it does NOT
  cover" below), a worktree jail shares the real repository's `.git`, and the approve endpoint
  takes no proof of who is calling.
- A CLI worker's environment is an allowlist of the daemon's, not a copy: a shell and toolchain,
  locale, proxy and CA settings, what the slot wrapper reads, the names in
  `FOREMAN_CLAUDE_ENV_ALLOW`, and the CLI's own prefixes — `CLAUDE_*` / `ANTHROPIC_*` for
  `claude-code` (`AWS_*` / `GOOGLE_*` only with Bedrock / Vertex switched on), `CODEX_*` /
  `OPENAI_*` for `codex-cli`. A gateway key, a forge token or the other CLI's sign-in held by the
  daemon never reaches a worker (`src/runners/claudeIsolation.ts`).
- The `api` runner's file tools are contained to the jail (symlinks included) and its
  model-authored shell commands are screened by the same block rules as task admission. That
  screening is a guardrail, **not a sandbox** — the sandbox is `FOREMAN_SANDBOX` (below), which
  confines the command to the jail unless it is `off`.
  With `FOREMAN_API_ALLOW_SHELL=0` every `run_shell` call is refused.
- A test command Foreman runs (the gate, playbook checks, the post-merge check) runs code a worker
  wrote, so it gets the same environment as a model-authored shell command: credential-shaped
  variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, …) are dropped, and `HOME`/`TMPDIR` are throwaway
  directories (`FOREMAN_TEST_REAL_HOME=1` keeps the real home — only with `FOREMAN_SANDBOX=off`;
  with the sandbox on, a run that sets it fails saying so). `FOREMAN_TEST_KEEP_ENV=NAME,…`
  passes named variables through for a suite that needs one.
- The `worker suite:` line (docs/lifecycle.md) is advisory: it reads output saved by worker-side code and
  compares file mtimes, so an unsandboxed worker (it runs as the user) can forge both. Nothing is held on
  it; the gate's own test run is the one that counts. The git tripwire's baseline (next section) is a file
  the worker can write too, and has the same limit.
- Admission BLOCK is non-overridable by config, by design.

## The git tripwire (`src/gitTripwire.ts`)

Until workers are sandboxed, a worker runs as you and can write the real repo's `.git` by path: its
`config`, `hooks/`, `info/`, or a `refs/replace/*` or `refs/notes/*` ref. Git then acts on that the next time
you use the repo. The tripwire **only detects and holds**: it reads, hashes and compares; it never restores
anything and writes nothing in the real `.git`.

- **Hashed:** the bytes of `.git/config` and `.git/config.worktree`; every file under `hooks/` and `info/` (a
  symlink by its target); and the refs as `git for-each-ref` lists them (pinned git, so `packed-refs` counts and
  `git pack-refs` hides nothing). In a linked worktree, the common git directory is the one hashed.
- **Excluded, and why:** `refs/heads`, `refs/remotes`, `refs/tags` and `refs/stash` are your own work (commits,
  branches, tags, stashes). `refs/bisect` and `refs/prefetch` are created by your own `git bisect` and
  `git maintenance` and hold no code that runs. `info/refs` is rewritten by `git gc`. Foreman's own git writes (`worktree add` and
  `prune`, `ORIG_HEAD`/`MERGE_HEAD`, the `foreman-main-*` worktrees, deleting its own branches) fall in
  `worktrees/`, `refs/heads` or top-level files, outside the set. Every other ref is flagged.
- **When:** the baseline is taken when a jail is created (and when a repair round reuses one), and stored at
  `<home>/artifacts/<runId>/git-tripwire.json` (mode 0600, written to a temp file, then renamed): outside the
  jail, and not in the database, so it survives a restart and event pruning. It is compared at collection (a
  change parks the run for a person, with no reviewer called and the tests not run, since a tampered config or
  hook could run in them), when you approve (refused before anything is merged; the ticket stays at the gate),
  and on `foreman landed` (refused).
- **The reason** names each changed file (`.git/hooks/post-commit was added`) or ref (`ref refs/replace/<sha>
  was created`). A snapshot that cannot be taken (an unreadable `hooks/`) holds with that error; it never
  crashes the run. After you have looked, delete the named baseline file to accept the change; a run with no
  baseline passes at landing (it began before the tripwire), but is held at collection. A held run's tests and
  reviewers were skipped, so approving it then lands it unchecked; to have it checked, reject it, then
  `foreman retry` it.
- **Limit:** the baseline file is in `<home>`, which an unsandboxed worker running as you can also write. A worker
  that rewrites both `.git` and the baseline defeats the check (the same is true of the `worker suite:` line's
  mtimes). Detection is for mistakes and unsubtle tampering; the sandbox is what closes this. A run whose
  worker failed is checked too: a change fails the ticket with the reason, and no repair round is queued. A run
  that ends before collection (a provider limit, a guard refusal, a crash) is not checked, and its retry takes a
  fresh baseline.
- Operator changes to `.git/config` during a run are flagged too, including the ones git writes for you (adding a
  remote, `git push -u`, a branch made to track a remote one); look at the reason and accept as above.

## The revert check, per test (`FOREMAN_REVERT_TESTS`)

"This test would fail on the old code" is a claim a reviewer makes without running anything. With
`FOREMAN_REVERT_TESTS=on` (off by default; unset, empty or `off` is off, anything but `on`/`off` refuses to start;
read once when the daemon starts) Foreman runs it, per test, and tells the reviewer what it found. It decides nothing.

- **When**: a `code` ticket in a repo, whose worker finished and whose test step ran and passed, with a diff that
  adds or changes at least one test and also changes something besides tests and docs. Never for other kinds, never
  on red tests, never on a test-only or docs-only diff.
- **Which tests**: read off the source, not run to find out (`src/verify/testNames.ts`). In each changed JS/TS test
  file, the node:test calls (`test`, `it`, `describe`, `suite`, their `.skip`/`.only`/`.todo`, and a subtest's
  `t.test`) whose own lines the diff touches — a new test, an edited one, a renamed one — and every test under a
  `describe` whose own lines (a hook, a shared fixture) changed, and every test a changed loop or case table
  generates. Changed lines in no test (imports, helpers) are counted and named, not attributed to a test.
- **How**: a scratch worktree at the run's base gets the test-side files of the **reviewed tree** (never the live
  worktree), so only the diff's code change is put back. Each changed test file is run once there, with the test
  script's own node flags but its reporters replaced by TAP, `--test-timeout=60000` per test,
  `--test-force-exit`, and a `--test-name-pattern` per changed test (the outermost test around a subtest) when every
  name on the way is known; a filter that misses is retried once unfiltered. Results are matched to the call that
  defines each test by the location node reports, so a test named in a loop gets one row per case. Only a test script
  of the form `node … --test …` can be aimed at one file; any other gives `could not run` for every test.
- **What each test gets**: `fails without the change` (with its first failure line), `passes without the change`
  ("either it does not test the change, or it pins behaviour that must not change — the reviewer decides"), or
  `could not run` (timed out, the file did not load at the base, skipped, never reported, or the check itself failed —
  any failure of the check is `could not run` for every test, never a clean result).
- **Where it goes**: a `FOREMAN REVERT CHECK` note to the crew reviewer (and to a re-review), a section of the owner
  gate's evidence, `<FOREMAN_HOME>/artifacts/<run>.revert-tests.json` with a `revert-tests` artifact row (its summary
  is what `foreman show` prints), and the run's entry in `foreman debrief`. **No repair round, no hold, no failed
  stage comes from it**; the reviewer may still fail the work on what it shows.
- **Cost and bounds**: every command takes a verify slot and runs under the sandbox like the test command. The run's
  deadline is stopped for the whole check (it is Foreman's aid, not the ticket's work; a cancel or a stop still ends
  it). A file's run is killed at 30 s plus 60 s per changed test in it, at most
  300 s; the whole check has 600 s of **run time** (slot waits are not counted). A file that hangs at the base costs
  at most that bound, and its tests are `could not run`.

## The sandbox (`FOREMAN_SANDBOX`)

A jail is a git worktree, not a boundary. A test command is code a worker wrote, and without a
sandbox it runs as you: it can write the real repository's `.git` (move `main`, plant a hook),
your home, Foreman's database, and call the daemon's own API. `FOREMAN_SANDBOX` puts those
commands under macOS `sandbox-exec`.

| Value | What happens |
|---|---|
| `tests` (default) | The repo's test command, playbook checks, `shell` tickets, the `api` runner's `run_shell` and `use_tool` (a catalog tool), the post-merge check and a worker's own suite run (`src/verify/testSlot.ts`) run sandboxed. |
| `all` | Accepted, and reserved for sandboxing the worker too. **In this build it behaves exactly as `tests`**; `serve` says so at start. |
| `off` | No sandbox: everything runs as it did before. This is the rollback — set it and restart. |

Any other value is an error: `serve` refuses to start and a run fails with the reason.

**What a sandboxed command can do.** Read and write its jail, and a private `HOME` and `TMPDIR`
made for that run and removed after it. Read the operating system and the toolchains (`/usr`,
`/bin`, `/System`, `/Library`, `/opt/homebrew`, `/Applications`, `/private/etc`). In a worktree
jail, read the real repository's `.git` — so `git status`, `diff` and `log` work — but not write
it: `git add`, `commit` and `update-ref` there fail (a repository the suite makes for itself,
inside the jail or under `TMPDIR`, takes commits normally). Use loopback networking, unix sockets
inside its own directories, and pseudo-terminals it allocates itself. Read the task of another
process in the same sandbox (how AddressSanitizer names a file and line).
If the node Foreman runs on is installed under your home or a temp dir (nvm, an unpacked
tarball), its install root (`<root>/bin/node`) is readable too, never writable, and does not take
a `FOREMAN_SANDBOX_RO` place. It is opened only when it holds a node install and nothing else, is not inside
Foreman's home, the real repository or the jails' directory, and neither is nor contains your
home, a temp dir root or Foreman's home; otherwise `foreman doctor`
and `serve` print `sandboxed commands may not find node: …` with the fix. A version manager that
puts a shim or symlink directory on `PATH` instead (volta, fnm) needs that directory in `FOREMAN_SANDBOX_RO`.

**What it cannot do.** Write anywhere else. Read, list or stat anything under `/Users`,
`/Volumes`, the shared temp dirs (`/tmp`, `/var/tmp`, `/var/folders`), or Foreman's home (the
database, artifacts, other runs' jails).
Reach the daemon's port (`FOREMAN_PORT`) or the ports in `FOREMAN_SANDBOX_DENY_PORTS`. Reach any
address off this machine, or resolve a name. Signal a process outside the sandbox. Run the
`launchctl` program, or start another `sandbox-exec`. `/Users` and `/Volumes` themselves can be
stat-ed (a program can see that they are directories); nothing in them can. Two things this does
**not** add up to are under "Known limits of the test sandbox" below.

**What a suite can trip over** (each one broke a real gate when this was first run on it):

- **Setuid programs do not start**: `ps`, and anything else with the setuid bit (`top`, `sudo`). macOS starts none inside
  any sandbox, whatever the profile says. A test that shells out to `ps` to read a child's memory
  has to ask the child instead.
- **`/tmp` is not writable.** Only `$TMPDIR` is; a test that hard-codes `/tmp` or `/private/tmp`
  fails with `EPERM`.
- **`$TMPDIR` is not empty after a compile**: `xcrun` (behind `clang`, `clang++`, `swiftc`) keeps
  its lookup cache `xcrun_db` in the user's temp dir, and inside the sandbox that is the run's own
  `TMPDIR`. A test that requires an empty temp dir must not count it.
- **File watching** needs `FOREMAN_SANDBOX_ALLOW=fsevents` (below).
- A tool under your home is not there: `FOREMAN_SANDBOX_RO` (below).

**What it does NOT cover — read this before relying on it.**

- **The `claude-code` and `codex-cli` workers themselves are not sandboxed.** A worker session
  still runs as you, with your files and the daemon's API in reach. Only the commands listed above
  are confined. A worker's own suite run goes through the slot wrapper, which takes its verify
  slot from the daemon *outside* the sandbox and then runs the suite *inside* it.
- Foreman's own git calls in a jail, and dependency provisioning (`npm ci`), are not sandboxed.
- Loopback is every address of this machine: any local service that is not on the closed-port
  list (Ollama, a gateway, a dev server) can be called from a test command. The list is a
  deny-list of at most four ports besides the daemon's.
- Everything in the jail, and in a worktree jail the real repository's whole `.git` (all history,
  every unmerged branch, its config), is readable. No CPU, memory or disk limits.
- macOS only: on Linux or any other system `sandboxAvailable()` answers that it needs macOS
  `sandbox-exec`. With the default (`tests`) the command is not run
  and `foreman serve` refuses to start (its start-up self-test fails) until you set `FOREMAN_SANDBOX=off`,
  which runs test commands with no sandbox at all. No Linux profile exists (`src/security/sandbox/`
  holds only `.sb` files). `sandbox-exec` is deprecated by Apple and still what the platform's own
  tools use.

**Known limits of the test sandbox.** Things a sandboxed command can still do, stated plainly:

- **It can ask launchd to unload or remove one of your jobs.** Refusing the `launchctl` program
  does not prevent the request underneath it: in the adversarial review a small program written
  for the purpose, run inside this sandbox, removed a job of the same user that had just been
  submitted for the test. No profile rule tried closed that on macOS 14.7. So a hostile test
  command could stop one of your LaunchAgents (a watchdog, a bot) until it is loaded again.
  Creating a job that way was refused by launchd in the same review, and a sandboxed command
  cannot write a file under `~/Library/LaunchAgents` (a test covers the write).
- **It can read the initial arguments and environment of its ancestor processes — the Foreman
  daemon included.** The variables Foreman strips from a test command's own environment (keys,
  tokens) are still readable this way if the daemon was *started* with them: the review recovered
  secrets planted on the launching process, and no profile rule tried closed it. Processes that
  are not its ancestors did not show theirs. So **do not start the daemon with a secret in its
  environment**; a secret the daemon needs belongs in a file only you can read (mode 0600) outside
  any jail. A test command has no network beyond loopback, but it can write what it read into
  the jail or its output, where a worker (which does have the network) or a person will see it.
- **Catalog tools are sandboxed from this build on.** The `api` runner's `use_tool` runs a tool
  under the same sandbox as `run_shell`: the ticket's jail, a private `HOME` and `TMPDIR`, the
  toolbox readable and not writable. A tool that reads anything else of yours stops working
  until that tree is named in `FOREMAN_SANDBOX_RO` (the toolbox takes one of its four places
  unless it is listed there itself); one that writes outside the jail stops working under the
  sandbox. If the toolbox itself is somewhere
  the sandbox cannot give back (inside Foreman's home), the call is refused, not run unconfined.

**It fails closed.** With the switch on, if `/usr/bin/sandbox-exec` is missing, is not
executable, or the sandbox does not start, the command is **not run**: the run fails with a line
that names the reason and `FOREMAN_SANDBOX=off`. `serve` runs a self-test at start (a sandboxed
no-op must succeed, a sandboxed write into Foreman's home must fail) and refuses to start if it
does not hold; `foreman doctor` prints the same check. A failed sandboxed test run ends with
`foreman: this ran sandboxed (FOREMAN_SANDBOX=tests): …` so the cause is easy to find. A process
that is already inside a sandbox (Foreman's own suite, run by Foreman's gate) cannot nest one and
runs its commands under the sandbox it is already in.

**`foreman doctor` also runs a worker's suite in a jail.** Its last check line is
`worker suite in a jail: ok` or `worker suite in a jail: FAIL <reason>`. Doctor cuts a scratch
jail of the Foreman checkout it runs from (`createJail` under `<home>/work`, named
`doctor-<pid>`), gives it its dependencies from the repo's or the cache's `node_modules`
(`provisionDeps`, never `npm install`), and starts `node src/verify/testSlot.ts -- node -e 0` in
it with the environment a worker gets, the sandbox on and a 60 s timeout. A repo that is dirty or
refused, a provisioning error, a timeout or a non-zero exit is a `FAIL` with the reason (a relative
`FOREMAN_HOME` that reached a worker shows as `contains Foreman's home`); the other lines still
print, and the jail is removed either way. A jail that could not be removed is never a plain `ok`:
the line is `FAIL … jail left at <path>`. The check sets `FOREMAN_PORT=0`, so the wrapper finds no
daemon to ask and runs `node -e 0` **unslotted** (`testSlot: no Foreman daemon … running … unslotted`);
it does not take a test slot.

**Knobs.**

- `FOREMAN_SANDBOX_RO=/abs/one:/abs/two` — up to four extra **read-only** trees, for a suite that
  needs a tool or toolchain under your home (a prose linter, a virtualenv). Anything listed is
  readable by every test command, so name the one subtree that is needed. A path inside Foreman's
  home is refused, and so is a tree that **is or contains** something the sandbox closes: `/`,
  `/Users`, your home, `/Volumes`, `/private`, `/tmp`, `/var`, `/var/tmp`, `/var/folders` and your
  temp dir, `/var/root`, `/var/db/sudo`, `/opt/homebrew/var`, `/usr/local/var`, `/Library/Keychains`,
  Foreman's home, the directory above the run's jail, and the real repository or the
  directory above it (also in the `/System/Volumes/Data/…` spelling). With such an entry set,
  every sandboxed command is refused with a line naming it, and `serve` does not start (an entry
  that only contains a ticket's real repository is found when that ticket's command runs, not at
  start: `serve` comes up and each such run is refused) — if
  Foreman's home is inside the source checkout (`…/foreman/.foreman`), list `…/foreman/toolbox`,
  not `…/foreman`. Foreman's own gate needs none (a project whose tests use file-system events
  needs `FOREMAN_SANDBOX_ALLOW=fsevents`, and no sandboxed suite may depend on `ps`, on writing
  `/private/tmp`, or on an empty `TMPDIR` after a compile — see "What a suite can trip over"). A
  gate script that calls the forged tools (a writing project's `scripts/gate.sh`) needs the
  toolbox named and readable — a test command's `HOME` is a throwaway, so
  `$HOME/Projects/foreman/toolbox` is not there:
  `FOREMAN_TOOLBOX=/Users/you/Projects/foreman/toolbox FOREMAN_SANDBOX_RO=/Users/you/Projects/foreman/toolbox`.
- `FOREMAN_SANDBOX_DENY_PORTS=8000,8001,8002,3010` — the loopback ports closed besides the
  daemon's (default: common local dashboard and git-forge ports). Setting it **replaces** the list; at
  most four; empty closes only the daemon's port. A suite that itself serves on one of these
  ports cannot connect to it: change the list or the suite's port.
- `FOREMAN_SANDBOX_ALLOW=fsevents` — allowances that are **off unless named**, because each lets
  a little of the outside in; an unknown name is an error. `fsevents` is file watching (node's
  `fs.watch` on a directory, anything built on FSEvents). Without it a watcher fails or never
  fires, and a suite that waits on one hangs until its timeout —
  **a project whose tests use file watching needs it** (a preview live-reload test, say). What it
  costs, measured: a sandboxed command can then also learn the *names* — never the contents — of
  files created and then deleted or renamed away *directly inside* a directory above its jail,
  `TMPDIR` or `HOME` (your home's top level, the shared temp dir). Files that stay, anything
  deeper and every other tree are not reported.
- `FOREMAN_TEST_REAL_HOME=1` is refused while the sandbox is on. `FOREMAN_DEPS_MODE=symlink`
  points a jail's `node_modules` at the real repository, which a sandboxed command cannot read:
  use the default (`clone`).

**Rollback.** `FOREMAN_SANDBOX=off`, restart the daemon. Nothing is stored; tickets already
parked are unaffected either way.


## Crew mode

```bash
foreman crew init                          # install the seed playbooks
foreman playbooks                          # list loaded playbooks + refusals
foreman build "add token auth to the api"  # classify → epic of role-assigned tickets
foreman build "write a novella about ..." --auto
foreman build --from-epic t_abc123        # clone a past epic, zero planning tokens
foreman build "..." --gate owner          # let the owner model approve its own crew's green work
foreman build "..." --revise               # one revision round when the senior critic calls the plan risky
```

A **playbook** makes Foreman run an ask the way the matching real-world
organization would: `software` (dev/senior/qa/architect; code review by a senior and, concurrently, an architect who is served `review-architecture` and `security-review`), `publishing`
(author/dev-editor/copyeditor/beta-reader/critic…, editorial letters), `investment` (analyst,
devil's-advocate senior, independent risk — analysis only, never execution),
`research` (assistant/researcher, internal + peer review). Playbooks are
markdown files with JSON front matter under `$FOREMAN_HOME/playbooks/`,
admission-scanned like agents; roles map to model tiers — owner
(`FOREMAN_MODEL_OWNER`, default `opus`; `fable` is deprecated but still honoured when pinned) plans, chairs escalations; senior
(`opus`) reviews and challenges; worker (`sonnet`) executes.

Each role also sits on a **generative ↔ deterministic slider**: `roles.<name>.mode` is `deterministic`
(code, tests, copyedits, risk numbers), `balanced` (the default: design, review, analysis) or `generative`
(drafting prose, editorial letters, devil's advocacy). Before any reviewer is paid, Foreman runs pure checks on the
worker's diff: a committed credential (a private key, AWS/GitHub/Slack/Anthropic/OpenAI/Google/Stripe/npm/GitLab key
shapes, or a new `.env` file — a line carrying `foreman:allow-secret` is exempt) and a focused test (`.only`; a line
that holds one as test data carries `foreman:allow-only`) are **hard**: still there after the pre-review repair rounds,
the ticket fails. An added skip/todo test, a deleted test file or an edit to an `.env` file the repository already
tracks is **soft**: the worker gets one repair round to fix or explain it, then the reviewer gets it as a note; a
`generative` role is not sent back for the test findings. A playbook's `required` list (`{ "label", "pattern", "roles" }`, a case-insensitive
multiline regex) names content every markdown file those roles change must carry (files up to 256 KB are checked; a larger file is not scanned but reported for a person to check; an empty `roles` list refuses the playbook) — research's limitations section,
investment's disclaimer, bear case and exit criteria — and is checked in every mode. The local `api` runner samples at
temperature 0 / 0.3 / 0.8 by mode (the Claude CLI has no temperature setting). An unknown mode or a malformed
`required` rule refuses the playbook.

A playbook may grant web access with `"web": { "search": true, "domains": ["arxiv.org", "doi.org", …] }` (research
does, with a list of scholarly and public-data hosts). Its claude-code workers then get `WebSearch` (only if `search`
is true) and one `WebFetch(domain:<host>)` allow rule per listed host, only for an S0/S1 ticket (an unset sensitivity
gets none). A rule names one exact host (`arxiv.org` does not cover `export.arxiv.org`); a fetch to any other host
needs an approval no headless worker can get, so it is refused. The CLI's WebFetch also fetches about 90
documentation hosts with no rule at all (docs.python.org, github.com/anthropics, …); each one a playbook does not
list is on the worker's deny list (`CLI_PREAPPROVED_FETCH_HOSTS` in `src/runners/cliRunners.ts`, read from CLI
2.1.287 — re-check it when the CLI is upgraded). A redirect to another host is not followed: the worker is told the
new URL, and fetching it is a new request under the same rules, so a DOI usually resolves to a publisher that is not
on the list. Plain `"web": true` (any host) refuses the playbook, as does a host with a scheme, path, port or
wildcard, or more than 64 hosts. Every claude-code worker not granted them has `WebSearch`/`WebFetch` on its deny
list. A worker cannot widen its own permissions for its next round: before every claude-code round the jail's
`.claude/settings.json` and `.claude/settings.local.json` are put back to the base commit's (a symlink is removed,
never followed), and a diff that changes them or a `.mcp.json` is a hard pre-review finding. Reviewers never get
tools; the `api` and `codex-cli` runners get no web tools; `FOREMAN_CLAUDE_ALLOWED_TOOLS` replaces the whole allow
list and `FOREMAN_CLAUDE_DISALLOWED_TOOLS` the whole deny list, web rules included; a forged playbook may not set
`web` (the forge strips it, approve refuses it). What the host list does NOT do: it limits the `WebFetch` tool, not
the worker. The claude-code worker is not sandboxed (see [The sandbox](security.md#the-sandbox-foreman_sandbox)) and can reach
any host from an `npm run` script, so the list keeps an honest worker on its sources; it is not a network boundary
against one that a page has steered. What it still opens: a search query and a fetch URL carry text out of the
machine to the search service and those hosts (and WebFetch sends each host name to Anthropic for a safety check);
search results and fetched pages are text an outsider wrote — search results from any site, not only the listed
ones — inside that unsandboxed worker. The research roles are told fetched pages are untrusted data, never to follow
instructions in them, and to cite the URL with the line a claim rests on. Turn it off with `"web": false` in your
copy of the playbook.

Each role has a `## role: <name>` prompt section. A role may also have a shorter
`## role-card: <name>` section: a worker gets the card instead of the full prompt
when its role's tier resolves to a local model or the crew is on the local plane
(local-only, or the CLI is down and auto mode fell back; the same rule that serves a
skill's `card.md`), because a long process prompt is harder for a small model to follow. A
role with no card gets its full prompt everywhere, and a crew review always carries the
full prompt. A duplicate card, a card for a role the playbook does not declare, or an
empty card refuses the playbook; cards are admission-scanned like the prompts.

A reviewer entry may carry its own `skills`: `{"role": "lead", "style": "code-review", "skills": ["a", "b"]}`.
Names are checked like a ticket's skills (a valid name, a loaded skill, in that
role's default or allowed loadout, at most two); with `FOREMAN_SKILLS_DIR`
unset only the shape and the name are checked. A bad list never refuses the
playbook: malformed names are dropped, a list that is not an array or has no
valid name gives no skills (never the role's default), a well-formed name the
catalog will not serve is kept on the list (crew review checks it again against
the catalog as it is when it serves, so a skill added later is served without a
restart), and each problem comes
back as a `warnings` entry on the load result naming the playbook, the
reviewer's index and role, and the skill. The daemon logs each distinct warning
once per process when it loads the playbooks; `foreman playbooks` (next to its
refusals) and `foreman build` (before the plan) print them; a name that is not a well-formed skill name is printed quoted, cut to 80 characters, with anything unprintable shown as `?`. Leave the key out and the reviewer is
unchanged: its prompt carries its role's usual skills, byte for byte as before.
With the key, the review prompt carries exactly those skills (full text, bounded by
`FOREMAN_SKILL_BRIEF_BYTES`) and `skills: []` carries none. A listed skill the catalog
refuses or lacks is left out and the rest are served; if none can be served, or the
catalog cannot be read, the prompt has no skills block, and the role's default never
stands in. Either way the review runs, and a `status` event on the ticket,
`crew review skills {…}`, records the reviewer's role, the skills served and each name
left out with its reason (the same JSON as a run's `skills` event, but not that event
type, so the debrief and a resumed round's skills check do not read it). The review
cache key (`crew_review_cache`) covers the reviewer's role, style and skill list as well
as the model and the prompt, so two reviewers on the same model and diff, such as an
architect and a senior on the senior tier, never replay each other's verdict. That key
is new: after a rollout every cached review misses once, which costs one paid re-review
for each ticket in flight.

With `--repo`, the planner and the plan critic get a zero-token repo snapshot
(tracked files, the README, and any file the ask names) — they have no tools,
so without it they plan blind. Planning has its own timeout
(`FOREMAN_PLAN_TIMEOUT_MS`, default 8 min).

The senior's review of a plan is kept, not only printed. Each note that names a
ticket — by its plan label (`t4`, `t4/t5`, `t1-t6`) or its title — is put at the
end of that ticket's brief under `PLAN REVIEW NOTE (from the senior's review of
the plan; the brief and acceptance outrank it; say in your report how you
handled it)`, where the ticket's worker and its reviewers both read it. A note
that names no ticket of the plan is recorded on the epic. Each note is one line
of at most 600 characters (a cut is marked), and `foreman build` prints under
the review where every note went, including one it could not match to a ticket.
With `--revise` the first review goes to the planner and the notes kept are
those of the review of the revised plan.

Only a `code` ticket merges on approval and has the repo's suite as its gate. So
in a repo with a test command of its own, a ticket planned as `writing` whose
deliverable is a file in that repo (a README, `docs/`, an ADR, help text) is
queued as `code`, and the printed plan says so on the ticket: `kind writing →
code (deliverable is a file in a gated repo)`. A manuscript (no test command), a
plan under a playbook whose reviewers do not review code (publishing, research)
or a plan with no repo keeps `writing`. And `foreman approve` on a ticket that does
not merge ends with `NOT MERGED: …`, naming the worktree its work is still in.

Headless `claude-code` workers cannot have a command approved, so they get a
scoped shell allowlist (`npm run`, `npm test`, `npx tsc`, `node --test`, the
ticket's test command, read-only git) and are told so in their brief; other
tools go through an `npm run` script that lands in the reviewed diff.
`FOREMAN_CLAUDE_ALLOWED_TOOLS` (`;`-separated, or `none`) replaces the list.

A `claude-code` worker does not run as your own CLI. It gets its own config
directory (`CLAUDE_CONFIG_DIR`, under `$FOREMAN_HOME/claude-config` or
`FOREMAN_CLAUDE_CONFIG_DIR`) holding a Foreman-written `CLAUDE.md`, only the
project's settings (`--setting-sources project`), no MCP servers
(`--strict-mcp-config` with an empty config), no auto-memory and no `CLAUDE.md`
discovery — so nothing is written under your `~/.claude`, and your global
instructions, knowledge files and MCP servers never reach a ticket. Its
environment is an allowlist of the daemon's, not a copy: a shell and toolchain
(`PATH`, `HOME`, locale, temp dir), proxy and CA settings, what the test-slot
wrapper reads, and every `CLAUDE_*` / `ANTHROPIC_*` variable. `AWS_*` passes
only with `CLAUDE_CODE_USE_BEDROCK` on, `GOOGLE_*` only with
`CLAUDE_CODE_USE_VERTEX`; anything else a project's tests need is named in
`FOREMAN_CLAUDE_ENV_ALLOW` (comma-separated, exact names). A `codex-cli` worker
gets the same allowlist with `CODEX_*` / `OPENAI_*` in place of `CLAUDE_*` /
`ANTHROPIC_*` and no cloud credentials. Each ticket has
its own directory under that root (`tasks/<ticket id>`), so one ticket's session
cannot leave settings or history for another's. Sign-in is left alone: no
`CLAUDE_*` variable is removed, `--bare` is not used, and the worker is told to
read its credentials where your own CLI keeps them
(`CLAUDE_SECURESTORAGE_CONFIG_DIR`: empty for the default keychain item, or the
daemon's own `CLAUDE_CONFIG_DIR`), not in its new config directory. An `Edit` or
`Write` aimed outside the worker's jail stops the run and fails it before review.
The crew reviewer reads code diffs up to `FOREMAN_CREW_CODE_DIFF_CAP_BYTES`
(96 KB) and is told the test stage's outcome. A failing review's blockers go
into the repair round instead of being filed as tickets, and `retry` revives the
dependents a failed ticket took down, carries its final critique, and grants a
fresh repair round.

**Follow-ups a reviewer files.** A follow-up waits for the ticket it was filed on
to land and is then cut from main. It is held for a person when that ticket is
(`gate human` on the ticket is copied to it; a ticket opted in to the owner gate
does not opt its follow-ups in). Two fixed rules, no model, decide what else it
waits for: follow-ups filed on the same ticket run one at a time, in filing
order; and a follow-up waits for any other open ticket in the same repo that
names a file its brief names — in the diff that ticket's latest run recorded,
or, for another follow-up, in its brief (up to 40 open tickets are compared; a
brief that names no file is ordered only by the first rule). Each wait is on the
follow-up's timeline (`waits for t_…: both name src/helper/packages.ts`). These
waits are an order, not a dependency: when a ticket a follow-up is ordered
behind ends canceled, failed or rejected, the follow-up is not failed — the next
in line may start. Only the ticket it was filed on is a real dependency: if that
one ends failed, rejected or canceled, its follow-ups go with it
(`dependency <id> ended as …`; `foreman retry` of it revives them). Follow-ups
are ordered automatically; tickets you queue yourself are not — order those with
`--after`, which is a real dependency as before. A follow-up that asks for work no worker on this host can do — a request
to run, re-run, recapture, reproduce, test or verify something on another OS, another machine, a
phone or a Mac of another architecture (`recapture on Linux`, `test on an Intel Mac`) — is filed
as `(operator) …`, assigned to you (the board's Yours to do) and never sent to a runner; its
timeline says why (`filed for the operator: …`). It waits for the ticket it was filed on like any
follow-up, but the AI's follow-ups of that ticket do not queue behind it. A mere description of an OS (`crashes on Linux`,
`taken on macOS`, `make it work on Windows`) is an ordinary follow-up.

An owner-tier planner decomposes the ask into an epic of tickets (roles,
dependencies, acceptance criteria, points) shown before queuing. In the
verify lane, the playbook's reviewer chain reads the diff — code review,
editorial letter, devil's advocate, or peer review — memoized by prompt
hash; failures feed the repair loop, side-issues file as depth-capped child
tickets, and repeated failure or council disagreement escalates to the
playbook's chair. Epics close when their tickets do, writing a deterministic
retrospective (zero tokens) that future plans reuse as precedent.
Classification is keyword-first (free); the owner model is consulted only on
ambiguity. `FOREMAN_CREW_REVIEW=escalate` (default) skips the Claude chain
when the local council passes unanimously on a small diff; `=always` runs the
chain regardless and therefore skips the local council entirely (its verdict
would be overridden anyway, and it is serialized on the local model slots) —
the council still runs as the fallback when the chain is unavailable. Approval is yours by
default; `foreman build --gate owner` (or `FOREMAN_GATE=owner`, which a playbook
that says `human` still overrides) lets the owner model sign off tickets that
already went green — never an S2, `allowCore`, budget-stopped, failed-test or
failed-review ticket, and never anything it is unsure about, which parks for you
with its reasoning on the task timeline. `FOREMAN_GATE=owner` applies only to
tickets that park while it is set, never to a backlog that was already waiting
when you exported it — retroactive auto-approval needs `--gate owner` or a
playbook that asks for it. Gates run one at a time and stop at the daily cap.
Tickets of the same epic that reach the gate together are decided in one call,
up to five at a time — each still passes every hard-human check on its own, and
each still gets its own decision, event and durable marker; `FOREMAN_GATE_BATCH=off`
goes back to one call per ticket.

### What a reviewer is given, and what holds a pass

**The acceptance map.** A code ticket's worker ends its report with an
`ACCEPTANCE MAP`, one line per numbered acceptance item, and a check with no
model in it reads the map before any reviewer is called. A line has one of
these forms. `<test file> :: <exact test title>`, a test of this change: the
file is in the diff and the title is in a hunk that adds a line. The same
form, a test that was already there: the file is a test file in the work tree
and the title is the title of a test in it — for an item that says something
stays as it was. `(diff) <path>`: the path is in the diff; when the item does
not name that file the line is still accepted for an item the diff itself can
show, so an item that says code stayed the same can point at the file whose
diff shows it. `(operator)` or `(review)`: only for an item the acceptance text
marks that way. A short item that only says the gate passes needs no line. Two
things keep the relaxed forms from carrying a ticket: an item that asks for a
test in so many words (`(test)`, "a test pins…", "fails without the change",
"add a test for…", "a route test shows…", "is unit-tested", "Route tests: …" —
not "the existing tests pass unchanged") takes only a test of this change, and
when the diff changes code at least one item must be mapped to a test of this
change in a test file — `(diff) README.md` on every line is a gap on every
line, and `README.md :: 403` or `src/x.ts :: return` beside them is no test. Anything else is a gap, named (`unmapped`, `test
file not in diff`, `test file not in diff or tree`, `test name not found`,
`file not in diff`, `item asks for a test…`, `no changed test is mapped to any
item…`, `not exempt`), and costs a repair round with no reviewer called. What
the check cannot tell is whether a mapped test or file really proves its item:
that is the reviewer's status per item, below.

**The worker's report.** A worker's whole final message is stored once per run
as a `report` artifact, `$FOREMAN_HOME/artifacts/<run id>.report.md`, beside the
run's diff and log; `foreman show` lists it. (Over 256 KB the middle is cut and
the file says how much. The shell and demo runners write no report.) The run
row and the board still show a 4000-character copy. A crew reviewer is given the report whole up to
`FOREMAN_REVIEW_REPORT_BYTES` (24 KB); a longer one keeps its first lines and
its last lines — the acceptance map is at the end — and the cut, always between
two lines, says how many characters were dropped and names the stored file. With
no diff (a research ticket) the worker's answer is the work under review, and
the reviewers get it from the same stored text. The owner gate's prompt reads
the same stored report, its first and last lines within 6000 characters (it
used to read the first 2000 characters of the run row's copy, which never
reached the acceptance map). A line of the report that starts the way one of
Foreman's own lines does (`FOREMAN CHECK`, `--- added by Foreman…`, `SOURCE THE
DOCUMENT CITES`, …) reaches the reviewer marked `[worker's text]` — also when
it is written with a hidden character (the set a skill file is refused for),
with Cyrillic or Greek letters that print as Latin ones, with another dash, or
after a line break other than LF. It is a mark on look-alikes, not a parser:
the reviewer is told above the report that all of it is the worker's claims.

**The source a document cites.** A reviewer sees the diff, not the repo. When
the diff adds or changes a prose file (`.md`, `.txt`, `.rst`, anything under
`docs/` that is not code or config), the repo files its added lines cite —
`src/x.ts`, `src/x.ts:123`, `test/y.test.ts:10-20`, a backticked file name —
and the files the worker's report cites are read from the work tree and
attached under `SOURCE THE DOCUMENT CITES`: each numbered by its own lines, 40
lines each side of a cited line, 12 each side of a backticked name given on the
same line as the file, else the first 80 lines. The block holds at most
`FOREMAN_CITED_SOURCE_BYTES` (64 KB) and names every file it left out (the
files the document itself cites are given their room before the files only the
report names; when both cite one file and both do not fit, the lines and names
the document cites in it are the ones shown, and the block says so; past the
first 40 cited paths the rest are counted); a cited
path that is not a regular file git lists in that tree — a link, a hard link,
a FIFO, a file over 1 MB, a binary — is named as not read. A code-only diff
gets no such block. The list of tracked files is unchanged.

**"Could not check" is not a pass.** For a ticket with numbered acceptance
items a crew reviewer's reply carries a status per item: `met`, `partial`,
`missing` or `not-verifiable` (it was not shown what it needed). Items marked
`(operator)` are yours and are not asked for, nor is an item that only says
the gate passes once Foreman's own gate run has passed. Foreman reads that
list, not the prose. A reply that says pass with a `partial` or `missing` item
is recorded as a fail and goes to a repair round with a `FOREMAN CHECK` line
naming the item. A reply that says pass with a `not-verifiable` item — or with
an item it gave no status — is recorded as `split`: it parks for you with the
note `the reviewer could not verify acceptance item 3 (…) — a person decides`
(or `gave no status for acceptance items 1, 2` when the reply did not fill the
field in), spends no repair round (a worker cannot fix what the reviewer was
not shown), and is not signed off by the owner model, whatever a chair or a
local-council re-review of the same run says. Two things lift it: a retry (new
work, a new review), and a crew re-review you ask for (`foreman reverify`) in
which the reviewer does verify every item. A status may carry its evidence
(`met (asserted in the new test)`); `met as far as shown` is not a status, and
a `met` whose evidence says what was not checked counts as not-verifiable. A ticket with no numbered acceptance, the
local council, and verdicts recorded before this existed are not affected. On
the board such a card reads `held for you`, not `no verdict`, and does not
offer Re-review first (the same reviewer would give the same reply); in the
shadow-agreement ledger a pair whose cloud verdict is such a `split` is kept
and not scored.

**Pre-existing assertions.** When a run's diff modifies a test file that was
there before the run, a check with no model in it lists what a reader would
want a reason for: an assertion line removed or changed (also a later line of
an assertion written over several lines, such as the expected text on a line
of its own under `assert.equal(`), a value an assertion
checks redefined (`const saved = …` narrowed while `assert.doesNotMatch(saved,
…)` stays), a value only handed to an asserted call redefined (a fixture:
`const root = project({…})` under `assert.deepEqual(declared(root), [])`), a
test declaration removed or changed, a `.skip` / `.only` / `todo` added, a
test file deleted. A line that only moved or was re-indented is not
listed, a renamed test file is compared with what it was, and new tests and
added assertions are never listed. It is not a repair demand. The list goes to
the reviewers as a `FOREMAN CHECK` block (file, line, old and new text), and
onto the run as an `assertions` artifact
(`$FOREMAN_HOME/artifacts/<run id>.assertions.json`, shown by `foreman show`).
The reviewers are given every finding, always. A finding also holds the gate
for a person — `the diff changes pre-existing assertions: 1 in
test/preview.test.ts`, and the owner model does not sign the work off — only
when it is in a test file the ticket does not name. "The ticket" is what was
written before the run: the task's title, prompt and acceptance; never the
worker's report or diff, nor a critique of its work, nor a note given with a
retry, a rejection or any other decision (the ledger's `human` is whoever
called the route, and a pasted note is often a reviewer's). A ticket a model
wrote from what earlier runs produced is not read at all, so nothing on it is
released: a follow-up a reviewer filed (its prompt starts `Filed by …`, and
its parent is a work ticket, not an epic), a ticket a worker queued from
inside its run, and an `improve:` proposal. A file is named by its
repo-relative path, by the end of that path from a directory boundary, by an
absolute path under the ticket's repo, or by its bare file name, as a whole
word (`data.test.ts` does not name `a.test.ts`, and `src/a.test.ts` does not
name `test/a.test.ts`), in the exact case, and a renamed file by the name it
had before the run. A sentence that says to leave something as it is names
nothing — one with `do not`, `don't`, `never`, `must not`, `unchanged`,
`unmodified`, `untouched`, `must pass` or `without changing` in it, and the
list under such a line that ends in a colon: `Do not change: test/a.test.ts`
and `the tests in test/a.test.ts pass unchanged` hold that file's findings.
It is a test of words, so `in test/a.test.ts, don't pre-create b.txt` holds
them too; say what to change in a sentence of its own. Nothing the diff does
releases a hold: adding tests to
the file does not. On the ledger this holds 196 runs of 97 tickets, where
holding for every finding held 252 runs of 122. The hold is decided when the
findings are recorded and kept with them (each finding's `hold` in the JSON file; the block says it per
finding); in doubt — no task to read, 200 findings or more — it holds. A
redefined fixture alone is listed for the reviewers and is never such a hold.

`foreman crew report` reads tasks, verdicts and receipts (zero tokens) for the
per-role scoreboard: tickets delivered, first-review pass rate, average repair
rounds and cost per ticket, plus advisory tier suggestions — a worker role that
keeps failing its first review, a senior role that never does. It never edits a
playbook; the tier is yours to change.

## Model roster

```bash
foreman doctor --bench             # score every local model, re-point the roster
```

Twelve probes (4 reasoning, 4 code review, 4 instruction fidelity), each scored
by **code, not by another model**, measuring score, tokens/s and cold start.
Probes require bare answers, so a hedge like "no idea" is not a correct "no".

Switching is deterministic and logged in the receipts:

- **Ladder** — priority and repair history set the starting rung; a `split`
  verdict escalates one rung (`council@r0` → `council@r1` in the ledger). S2
  never escalates off the machine.
- **Roster** — rungs follow the measurements, not the alias names.
- **VRAM guard** — dispatching a non-resident model while a different one is
  mid-call would evict and reload it, so those calls serialise instead.
  Resident models still run in parallel; an unreadable runtime never blocks.

The first real bench here: `qwen3.5:9b` and `qwen2.5-coder:14b` scored 1.00;
`llama3.1:8b` scored **0.25 on reasoning** — independently confirming a live run
in which it misread a diff twice.

### Which model sits where

| Seat | Model | Why |
|---|---|---|
| Council advisors (code) | 9B + coder-14B at every rung; the 2B sits on no council | the 2B failed a correct one-file change for a nonsense reason; two *different* models, never one model counted twice. A seat stepped down for memory can still land on it, and that verdict is provisional |
| Council advisors (prose) | 9B + coder-14B at every rung | the 2B returned nothing on a 6,000-token chapter; llama benched 0.25 |
| Council chair | the strongest reasoner not already seated; **opus at the top rung** when the cloud is allowed and the task is not S2 | the chair decides every disagreement — it used to be llama or the 2B |
| Chair already argued a side | nobody — the vote is a `split`, which escalates or parks | one model re-reading its own vote is not a decision |
| A seat answered nothing usable and the rest passed | nobody — the round is a `split`; it climbs only to a rung with *different* advisors (never under memory pressure), and keeps its earlier verdict if that rung hears from fewer advisors (a lone FAIL there still stands); otherwise it parks for you | the survivor's PASS is not the council's; a lone FAIL still stands (fail-closed). A crew chain of two or more reviewers applies the same rule (no crew verdict, so the council's stands; a `review:incomplete` receipt marks it either way) |
| Playbook classifier (ambiguous asks) | `haiku` (`FOREMAN_MODEL_ROUTER`) | a one-word pick; it used to consult fable |
| Owner / senior / worker | opus / opus / sonnet (fable deprecated 2026-10-05) — or the local roster under local-only or the Claude fallback | `FOREMAN_MODEL_OWNER` / `_SENIOR` / `_WORKER` override |
| `api` runner, no routed model | coder-14B for code, 9B otherwise | llama is never a fallback worker |

`llama3.1:8b` sits in no review seat in any mode. On a 17 GB machine the coder-14B
(~10 GB resident) only fits when the desktop is quiet — `doctor` warns when the
machine is swapping, and a local call that stalls says so instead of reporting a bare
timeout.

### Smaller models when memory is short, re-checked when it frees up

On a 17 GB machine the strong local models only fit when the desktop is quiet, so
every local alias has a **step-down chain** of cheaper models already pulled:

| Asked for | Steps down to |
|---|---|
| `local-code` (coder-14B, ~9 GB) | `local-code-small` (coder-7B, ~4.7 GB) → `local-fast` (2B) |
| `local-reason` (9B) / `local-general` | `local-fast` (2B) |

Before each local call the broker checks whether the model fits: its size plus a rough
KV cache for the window, against reclaimable memory, plus idle models Ollama would evict,
plus a paging allowance (`FOREMAN_PAGING_ALLOWANCE_GB`, default 7). The allowance is
calibrated on this machine, where the 9B loaded at 0.8 GB reclaimable and the 14B could not.
If the model doesn't fit, the first one down the chain that fits runs instead. A local call
that stalls before its first token is also retried one step down instead of failing the task.
Adopted personas and cloud models never step down. `FOREMAN_DOWNSHIFT=off` disables it.

Nothing about a step-down is silent. The receipt records `downshifted_from`. A council
review that used any stepped-down model is a **provisional** verdict: the card gets a
*provisional* chip and the owner model never auto-approves it. Its opinions are not cached,
so a later check cannot replay them. Once a minute, when no work and no review is running,
the scheduler finds the oldest provisional task at the gate whose **full** council fits now
and re-reviews it with `reverify`, keeping the work. A re-check that comes back provisional
again backs off for 15 minutes. `FOREMAN_RECHECK_MS` sets the interval, and a negative value
turns it off. The re-check only ever reviews a ticket whose provisional verdict is on its
latest run, and never a run that parked for a person with no reviewer called (a gate that timed
out twice, a red gate on a jail behind main, a run that changed nothing): those wait for you,
whatever an earlier run's verdict was. `foreman reverify <id>` still re-reviews one when you ask.

## Training a persona on the work, not on reports about it

```bash
foreman persona ingest publishing.author --manuscript <chapters-dir> --style STYLE_SHEET.md
foreman persona train publishing.author
foreman persona adopt publishing.author --judge opus
```

`persona build` mines Claude Code session history, which is right for a coding
persona and wrong for an authoring one. Measured: `publishing.author` trained on
108 history samples failed its gate against an Opus judge **0W 0L 8T** — every
metric identical to the base. The adapter was fine; the corpus was summaries of
drafting sessions (*"Chapter 7 is drafted at …, 3,872 words"*, median 215
characters). It had been taught to write status reports and was then judged on
prose it had never seen.

`persona ingest` builds from the manuscript instead: continuation pairs split at
paragraph boundaries, headings and author-query blocks stripped. 20 chapters →
659 pairs of the actual target voice. Passages rather than whole chapters
because a chapter is ~5,500 tokens against a 1,024 window — and because
"continue this scene in this voice" is the drafting job stated exactly.

`--judge` picks who runs the blind A/B. While a subscription lasts, use a cloud
model: it is the third arm the gate needs, and a local judge's verdict on local
work is the thing `foreman agreement` exists to validate.

**Dispatch pauses while a trainer holds the local-model lock.** A trainer or an
adoption gate owns the machine's inference for hours, and starting new work
under it is how a 17 GB machine ends up 33 GB into swap — a collision that
happened once for real. Running work finishes; only new dispatch waits.
`FOREMAN_IGNORE_TRAINING_LOCK=1` opts out.


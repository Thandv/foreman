## Skills

A **skill** is a short text procedure a crew role carries into a ticket (how to write a failing test
first, how to review for silent failures). Skills live in a separate repository; point
`FOREMAN_SKILLS_DIR` at it. Until that is set the feature is off: no skill is loaded and every brief
and review prompt is byte-for-byte what it is without skills. Skills are text Foreman reads and puts
in a prompt. It never runs anything from that directory and never writes to it.

```
<dir>/skills/<name>/skill.json   name (= the directory), description, roles ["software.dev"], status
<dir>/skills/<name>/full.md      at most 4,000 bytes — Claude workers and the crew reviewers
<dir>/skills/<name>/card.md      at most 1,200 bytes — a local-model worker
<dir>/loadouts.json              {"roles": {"software.dev": {"default": ["a"], "allowed": ["a", "b"]}}}
```

Every skill is checked at load, and one that fails is refused — listed with its reason, never
served: a name that is not `[a-z0-9-]{1,64}` or does not match its directory; a file over its cap;
a status of `retired` (or none of `draft`, `measured`, `adopted`); a skill directory or file that is
a symlink (links are not followed, so nothing outside the directory is read) or not a regular file;
bytes that are not UTF-8; zero-width, bidi, control or other invisible characters (variation
selectors and filler characters included); a line that opens like one of Foreman's own brief sections
(a `---` rule, `ACCEPTANCE CRITERIA`, `TEST GATE`, `## role:` and the like); an injection phrase
("ignore previous instructions", "system prompt", "you are now"); or a blocking finding from the same
admission scan agents and playbooks pass. The phrase list catches the stock wording only: a skill is
still text you put in front of a model, so read what you install.

Foreman picks the skills, by rule; the worker never chooses. In order: the ticket's own list, else the
names its playbook lists for the role — an optional `"skills": {"dev": ["a", "b"]}` key in the
playbook's front matter — else the role's loadout `default`. Each name must be in that role's loadout
(`allowed` or `default`) and the skill's own `roles` must list `<playbook>.<role>`. At most two are
served; a name that is left out is named, with the reason, in the block (when nothing at all is
served the brief carries no block, and `foreman skills show` prints the reasons). The block follows the role prompt, hard constraints and tools in
the worker's brief, under a header that says the ticket's brief, acceptance and operator demands
outrank it, and is bounded by `FOREMAN_SKILL_BRIEF_BYTES` (9,000) with any cut marked. A crew
reviewer gets its own `## role:` prompt from the playbook (bounded at 4,000 bytes, under a line saying it reviews
with no tools, must say what it could not check, and reports in the reply contract's shape, a critical finding being a
"blocker") and then its role's skills (full text), between its review style and the reply contract.
A worker gets `card.md` when its role's tier resolves to a local model (or the crew is on the local
plane); everything else gets `full.md`. The choice is made from the role's tier, not the ticket: a
ticket routed to a local model by an adopted persona still gets `full.md`.

```bash
foreman skills                          # loaded skills, refused ones with reasons, loadouts
foreman skills show software dev        # exactly the block that role's brief carries
```

Both read `FOREMAN_SKILLS_DIR` from the shell they run in, as does the `skills:` line of
`foreman doctor` — the daemon uses the value it was started with.

**A ticket's own skills.** A ticket may name up to two skills that replace its role's default — a bug
with an unknown cause is better served by a debugging procedure than by "write the test first". The
list is stored on the ticket (`tasks.skills`; empty means the role's default) and is checked when it is
set, by one rule for every way in: each name must be a loaded skill, on the role's loadout, that lists
the role; two at most; the ticket must be an agent-less playbook role; skills must be on. A request
that fails is refused whole, naming the skill and what the role may carry — nothing is trimmed quietly.
(Spaces around a name are ignored and a repeated name counts once; a list of more than 16 entries is
refused without being read.)

- **The planner.** With skills on, the planning prompt lists, for each role of the playbook that has a
  choice, its default and what it may carry instead, with each skill's `when` line. A skill the playbook
  names only on a reviewer entry for a role, and that is not in that role's ticket default, is left off
  that role's menu (a role with nothing else to choose is not listed). This filters the menu only:
  `checkTicketSkills` still accepts such a skill when an operator names it on a ticket, because
  `loadouts.json` decides what a role may carry. The section is held to 2,048 bytes and a `when` line is
  never cut: the defaults' `when` lines go first, then whole entries from the end (one line, `(N more
  not shown)`, counts them), then roles from the end of the playbook's list — and once an entry or a
  role has gone the plan check says so (`skills-prompt-trimmed`). A ticket in the plan may then carry
  `"skills": ["name"]`. A name that fails the check is dropped from that ticket and shown as a
  `skill-dropped` warning in the plan check — the plan still stands — and `foreman build` prints each
  ticket's skills. `--from-epic` keeps each cloned ticket's list. A follow-up a reviewer files carries
  its parent's list (none stays none); a name its own role may not carry is left off and named in a
  warning on its timeline, never costing the follow-up. One a worker files starts on its role's default.
- **Self-epic warning.** When a plan's repo is the Foreman checkout itself, the plan check warns
  (`core-file-refused`, never blocking) on each ticket whose title, prompt or acceptance names a
  core-guarded path (`PROTECTED_PATHS`): `likely refused at admission: consider hand work`, with the
  ticket ref and the path. A mention after `do not touch`, `do not edit`, `excludes`, `must not edit`,
  `never edit` or `e.g.` in the same sentence is not counted. Other repos never get it.
- **`foreman show <id>`** prints the ticket's list, or `role default: …` as the shell's skills dir has it.
- **`foreman add … --playbook <p> --role <r> --skills a,b`** and **`foreman retry <id> --skills a,b`**
  (`--skills default` clears the list). The daemon checks the list; a refused one queues nothing and
  requeues nothing, and the ticket is as it was. A retry without `--skills` keeps the ticket's list.
  The CLI reads the answer back: a daemon still running a build from before this (it would drop the
  list unseen) is caught there, and the ticket is canceled rather than run on the wrong skills.

The list is checked again each time a brief is built, against the skills as they are then. A name
that has stopped passing (retired, refused, taken off the role's list) is left out and the brief says
so; if none of the ticket's names is left, the role's usual skills are carried and the brief says that
too. A repair round carries the same skills as the first; a resumed round, which sends the critique
alone, is sent the block again only when the skills are no longer the ones its session began with.
Each run starts with a `skills` event on the run — JSON with the role, whose list was used (`ticket`,
`playbook` or `default`), the text given (`full` or `card`), the skills in the brief and every name
left out with its reason; the same line is in the run's log. A crew reviewer carries its role's
default, or the `skills` list of its playbook entry (see above).


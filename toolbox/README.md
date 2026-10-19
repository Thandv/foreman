# toolbox

The forged-tool catalog. This is a **git-tracked** part of the Foreman repo so
that Foreman can both *use* its tools and *improve* them the same way it changes
any other source — through a jail, the council, and the human gate.

## Layout

One directory per tool, named `[a-z][a-z0-9-]{1,39}`:

```
toolbox/
  <tool-name>/
    manifest.json     # name, description, JSON-schema input/output, entry, runtime,
                      #   version, provenance, admission findings — STATIC only
    tool.js|tool.py   # the entry: reads one JSON object on stdin, writes one on stdout
    test/             # tests that spawn the tool end to end and assert its behaviour
    README.md         # what the tool does and how to call it
```

## What is NOT here

Runtime state — usage counts, failure counts, quarantine flags, last-used
timestamps — is deliberately kept **out** of the toolbox, in
`~/.foreman/tool-state.json`. Running or quarantining a tool never rewrites a
file here, so the toolbox stays clean for version control. Override the catalog
location with `FOREMAN_TOOLBOX`.

## How a tool gets in

Nothing is hand-added. Every tool enters through the **forge gate**:

1. a `build_tool` request queues a separate, gated `tool` task;
2. the worker must produce the full layout above;
3. every source file it ships is **admission-scanned** — a blocking finding
   refuses registration outright;
4. the tool must pass **its own tests**;
5. the verification **council** reviews the contract and the source;
6. **you** approve it at the gate.

Only then is it copied in and registered. Editing a tool follows the same path:
it is ordinary repo source, so `improve`/`forge` tasks may change `toolbox/`
while `src/security/`, the gate and merge logic, and the guardrail file itself
stay fenced behind `--allow-core`.

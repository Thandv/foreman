## Tool forge

```bash
foreman tools ls | show <name> | rm <name> | quarantine <name> | release <name>
```

The `api` runner can `find_tool`, `use_tool`, and `build_tool`. A build is not
inline: it queues a separate `tool` task that must produce the full layout
(manifest with a JSON-schema contract, entry, tests, README), pass **its own
tests**, survive an admission scan of every source file, and be approved by you
— only then is it registered. Tools run with an allowlisted environment, speak
JSON on stdin/stdout, and are quarantined after three consecutive failures. A `claude-code` crew worker has no catalog access, so its brief names the role's tools and tells it to do that work by hand, show the working and never claim a tool's result; Foreman's own deterministic checks run after it.

Registered tools live in a git-tracked **`toolbox/`** subfolder of the repo (see
`toolbox/README.md`), so Foreman can both use and improve its own tools. Only
tool *source* is stored there — usage stats and quarantine state are kept in
`$FOREMAN_HOME/tool-state.json`, out of version control, so the toolbox stays clean
for git. Set `FOREMAN_TOOLBOX` to point the catalog elsewhere. A pre-existing
`$FOREMAN_HOME/tools` catalog is migrated into `toolbox/` once, on first start.


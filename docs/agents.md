## Agents

Drop `.json` or `.md` (front-matter) definitions in `$FOREMAN_HOME/agents` — or point
`FOREMAN_AGENTS_DIR` at another catalog's build output. Each is admission-scanned at load; a
blocked definition is dropped from the catalog entirely rather than left selectable. Select with
`--agent <id>`; the `api` runner uses its system prompt and preferred model.


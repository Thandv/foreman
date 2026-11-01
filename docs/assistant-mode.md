## Assistant mode

```bash
foreman ask "Summarise last week's commits and draft the release note"      # plan it
foreman ask "..." --yes                                                      # queue the plan
foreman schedule add "morning triage" --spec "daily 07:30" --ask "triage my inbox"
```

A planner turns a request into a task DAG — kinds, runners, dependencies, and
any tool that must be built first — and shows it. Nothing is queued until you
confirm. An unreachable planner degrades to a single task rather than an error.

Memory grows with use: every run leaves an episode, every gate decision leaves a
preference ("rejected: you touched unrelated files again"), and recall is
relevance-ranked with preferences outranking episodes. `foreman memory
consolidate` compacts episodes into durable facts — and refuses to retire what
it could not compact.


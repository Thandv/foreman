## Runners

| Runner | What it does | Verified |
|---|---|---|
| `echo` | walks the stage rail without a model; a prompt containing "fail" fails on purpose | yes — used throughout the suite |
| `shell` | runs the prompt verbatim as a shell command in the jail | yes — end-to-end on a real repo |
| `api` | tool loop (`list_dir`/`read_file`/`write_file`/`run_shell`/`done`) against the model plane | yes — including jail-escape and destructive-command refusal |
| `claude-code` | drives `claude -p` headless, parsing `stream-json` into stages, logs and tokens | yes — runs live every day; parsing is also fixture-tested against recorded transcripts |
| `codex-cli` | same shape for `codex exec --json` | CLI present and preflights; parsing is fixture-tested against recorded transcripts, **not yet against a live run** |

## Local-only mode

```bash
export FOREMAN_LOCAL_ONLY=1
foreman drill                    # readiness: probes scored by code, not by a model
foreman doctor                   # mode, resolved tiers, and whether every persona is served
```

**Unset, the flag means `auto`.** Foreman asks the Claude CLI whether it is signed in at
boot, in `doctor` and `drill`, and every five minutes; a real call failing on authentication
counts too. While the CLI is down, only what depended on it falls back: default tiers route
to the local roster, crew tickets use the `api` runner, owner/router calls are skipped (each
already degrades), every gate is yours, and queued `claude-code` tickets **wait** — held, not
failed, attempts untouched. Codex and gateway models are unaffected. Recovery needs one real
call to succeed; `auth status` alone cannot prove it (it reports `loggedIn:true` for invalid
credentials). The board shows a **Claude offline** chip. `FOREMAN_LOCAL_ONLY=0` turns the
fallback off; `=1` is the strict mode below.

`FOREMAN_LOCAL_ONLY=1` is the mode for when there is no cloud. Tiers collapse onto the local roster, cloud aliases are
never registered (not merely refused later), `claude-code`/`codex-cli` are refused **at
admission**, crew tickets run on the `api` runner, owner gating is abolished so every gate is
human, and `llama3.1:8b` is pinned out of every review seat. It loosens capability and never
safety: admission BLOCK, the jail, `PROTECTED_PATHS`, merge-only-on-approval,
split-never-passes and redaction are untouched.

Running local-only, `drill` found three real defects. The load-bearing one: a **non-streaming**
request sends no response headers until generation completes, and undici gives up waiting
after 300s — so on a machine that sustains ~8 tok/s, every generation past ~2,500 tokens
died. Both model paths stream now, and the call ceiling is an *idle* timeout (reset by every
chunk) rather than a total duration guessed from an assumed token rate.


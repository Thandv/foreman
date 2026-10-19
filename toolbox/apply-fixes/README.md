# apply-fixes

Ported from the author's earlier tools.

Applies a batch of exact-string edits to files under the working directory.
Each fix replaces `old` with `new` only when `old` occurs **exactly once** in
the file — the never-guess guard. Zero occurrences is `NOTFOUND` (or
`ALREADY` if `new` is already present, treating the fix as idempotently
applied); more than one occurrence is `AMBIGUOUS×N` and is skipped rather
than picking one.

Every path is relative to the working directory. Absolute paths and any path
that resolves (after following symlinks) outside the working directory are
refused before any file is touched, and every file is read before any is
written, so a bad or missing path in the middle of a batch never leaves
earlier files half-edited.

## Calling it

```
$ echo '{"files":[{"path":"chapter-1.md","fixes":[{"old":"teh","new":"the"}]}]}' | node tool.js
```

```json
{
  "applied": 1,
  "skipped": 0,
  "report": [{ "path": "chapter-1.md", "old": "teh", "status": "APPLIED" }]
}
```

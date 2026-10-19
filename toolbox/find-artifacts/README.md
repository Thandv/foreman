# find-artifacts

Ported from the author's earlier tools.

Scans manuscript text for damage typically left behind when two draft passes
get merged by hand: exact-duplicate paragraphs, near-duplicate paragraphs
(a variant of the same passage pasted in from another draft), truncated
false-start paragraphs, and lines with an unbalanced markdown-italic
asterisk. It only ever returns **candidates** — short repeated lines spread
far apart in the manuscript are frequently an intentional refrain, and this
tool spares those rather than flagging them. A human or model still has to
judge every candidate; nothing is edited.

Near-duplicate scoring uses a bigram Dice coefficient at the same 0.82
threshold the original Python used with `difflib.SequenceMatcher` — see the
header comment in `tool.js` for why, and how the two measures differ.

## Calling it

```
$ echo '{"text": "Line one of the book.\nLine one of the book.\n"}' | node tool.js
```

```json
{
  "paragraphs": 2,
  "candidates": [
    {
      "kind": "exact-duplicate",
      "index": 0,
      "line": 1,
      "snippet": "Line one of the book.",
      "detail": { "lines": [1, 2], "min_distance": 1, "words": 5, "tag": "likely-artifact" }
    }
  ]
}
```

An optional `"window"` integer (default 10) sets the sliding-window size, in
paragraphs, used for near-duplicate scanning.

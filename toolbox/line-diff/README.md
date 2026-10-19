# line-diff

Presentation-only line diff. Ported from
the author's earlier tools (already zero-dependency; unchanged in
`lib.js` here, `tool.js` is just the stdin/stdout wrapper).

Uses a classic O(n*m) LCS for small inputs. For large inputs (more than
4000 total lines, or an LCS matrix over 250,000 cells) it falls back to a
linear prefix/suffix diff instead of allocating an unbounded matrix — the
`after` text stays authoritative either way, this is a *display* diff, not
a patch/merge tool. Output over 4000 rendered lines is capped with a `note`
line in the middle.

## Input

```json
{ "before": "alpha\nbeta\ngamma", "after": "alpha\nnew\ngamma" }
```

## Output

```json
{
  "lines": [
    { "kind": "same", "text": "alpha" },
    { "kind": "remove", "text": "beta" },
    { "kind": "add", "text": "new" },
    { "kind": "same", "text": "gamma" }
  ]
}
```

## Example

```
echo '{"before":"alpha\nbeta\ngamma","after":"alpha\nnew\ngamma"}' | node tool.js
```

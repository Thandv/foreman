# yaml-lite

Offline parser for a deliberate SUBSET of YAML. Inspired by
[js-yaml](https://github.com/nodeca/js-yaml) (MIT); reimplemented from the
YAML spec — no vendored code. **Full YAML is out of scope on purpose**: it
is a large, genuinely ambiguous spec, and this tool covers the common 90%
rather than pretending to cover all of it.

## Supported

- Nested block maps and lists by indentation
- A list at the same indentation as its parent key (the common
  `key:\n- a\n- b` form, as well as the more-indented `key:\n  - a` form)
- Inline flow collections: `[a, b, c]` and `{k: v, n: 5}`
- Scalars: strings, integers/floats, `true`/`false`, `null`/`~`
- Quoted strings: double-quoted with backslash escapes (`\n \t \" \\ \uXXXX`
  etc.), single-quoted with `''` as the only escape (backslash is literal)
- Comments (`# ...`, quote-aware so `#` inside a string isn't stripped)
- Multi-line block scalars: `|` (literal) and `>` (folded), with `-`
  (strip) / `+` (keep) chomping indicators and an optional explicit indent
  digit (`|2`)

## Refused, on purpose

Anchors/aliases (`&name` / `*name`), tags (`!!type` / `!custom`),
multi-document streams (`---` / `...`), and merge keys (`<<`) are refused
with a clear error rather than silently mis-parsed or approximated.
**Refusing is safer than guessing**: because there is no code path that
ever expands one node into another (no alias resolution at all), the
"billion laughs" exponential-expansion attack — which depends entirely on
nested alias expansion — is structurally impossible here, not just
mitigated.

Tabs used for INDENTATION are also a hard error (YAML forbids them there,
and silently guessing a tab-width would risk misreading structure); tabs
inside a value or a block-scalar's content are fine.

A line that doesn't fit the structure above it — an over-indented line
under a key that already has an inline value, or the continuation line of
a multi-line plain scalar (unsupported; use a quoted string or a `|`/`>`
block scalar) — is also an error naming the line, never silently dropped.

## Nesting limit

Both block-level indentation nesting and inline flow-collection nesting
(`[[[...]]]`, `{{{...}}}`) are capped at 500 levels (mirroring
html-extract's `MAX_DEPTH` pattern). A document nested deeper than that gets
a clean "nesting too deep" error instead of overflowing the call stack.

## Input

```json
{ "text": "name: demo\nvalues:\n  - a\n  - b\n" }
```

## Output

```json
{ "data": { "name": "demo", "values": ["a", "b"] }, "warnings": [] }
```

`warnings` currently reports non-fatal issues such as a duplicate mapping
key (the later value wins, but it's worth flagging).

## Example

```
echo '{"text":"a: [1, 2]\nb:\n  c: 3\n"}' | node tool.js
```

# json-query

Offline JMESPath-subset query engine for extracting and reshaping JSON.
Inspired by [jmespath.js](https://github.com/jmespath/jmespath.js)
(Apache-2.0); reimplemented from the published JMESPath grammar/spec — no
vendored code.

## Supported syntax

- Dot access: `a.b.c`, quoted-identifier fields: `a."weird key"`
- Index access: `a[0]`, negative indices: `a[-1]`
- Wildcard projection: `a[*]`, `a.*` (object values)
- Flatten projection: `a[]` (flattens one level, then projects)
- Filter projection: `items[?price > \`10\` && ok]`
  (`== != < <= > >=`, `&&`, `||`, `!`, parentheses)
- Pipes: `a | b` — evaluates `a`, then evaluates `b` fresh against that
  result. A pipe is the only thing that resets projection scope.
- Multiselect hash: `{a: x, b: y.z}`
- Functions: `length(@)`, `keys(@)`, `values(@)`, `sort_by(@, &field)`,
  `max_by(@, &field)`, `min_by(@, &field)`, `contains(@, needle)`,
  `starts_with(@, prefix)`, `join(sep, @)`, `to_number(@)`
- Literals: `` `123` ``, `` `"a string"` ``, `` `true` `` (backtick, parsed
  as JSON) and `'raw string'` (single-quoted, used directly as a string)

**Not supported** (a deliberate subset, not a bug): array slices
(`a[0:2]`), full multiselect-list `[a, b]`, `expression-type` values outside
`&field` function arguments, and the remaining ~20 built-in functions
(`map`, `reduce`, `merge`, `type`, etc.). Unsupported syntax is a parse
error naming the offending token and its character position, not a silent
wrong answer.

## Truthiness (JMESPath rules, not JS rules)

`false`, `null`, `""`, `[]`, `{}` are falsy. Everything else — including the
number `0` — is truthy. This matters for `&&`/`||`/`!` and filters.

## Input

```json
{ "data": { "items": [{"name": "a", "price": 5}, {"name": "b", "price": 15}] }, "query": "items[?price > `10`].name | sort_by(@, &@)" }
```

## Output

```json
{ "result": ["b"], "truncated": false }
```

### Output bounds

- **Result size cap**: the serialized `result` is capped at 700,000
  characters. If `result` is an array and would exceed that, it is
  truncated to the largest leading prefix that still fits, with a trailing
  `{ "truncated": true, "originalLength": N, "returned": M }` marker object
  appended, and the top-level `truncated` field is `true`. A non-array
  result that is still oversized (e.g. one huge string) is replaced by a
  `{ "truncated": true, "note": "..." }` marker instead. Ordinary results
  are unaffected and `truncated` is `false`.
- **Expression nesting cap**: parenthesised sub-expressions, function-call
  arguments, filter conditions, multiselect-hash values, and chained
  projections (e.g. `a[?x][?y][?z]...`) are capped at 200 levels of
  nesting. Deeper queries are refused with a clean `query nesting too deep`
  error naming the position, instead of overflowing the call stack. An
  ordinary flat chain like `a.b.c.d...` (no nesting, just length) is not
  affected by this cap.

## Example

```
echo '{"data":{"items":[{"name":"a","price":25},{"name":"b","price":5}]},"query":"sort_by(items, &price)[0].name"}' | node tool.js
```

## Errors

Both parse errors (bad syntax) and evaluation errors (wrong argument type
to a function) are written to stderr with a non-zero exit code, and name
the character position in the query where the problem was found, e.g.:

```
query syntax error: unexpected token ']' at position 7
```

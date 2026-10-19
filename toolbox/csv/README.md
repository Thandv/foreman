# csv

RFC 4180 CSV parsing and stringifying, dependency-free. Handles quoted
fields, escaped `""` quotes, CRLF or bare LF line endings, embedded newlines
inside quoted fields, and ragged rows or an unterminated quoted field
(reported in `warnings` instead of throwing). A leading UTF-8 byte-order mark
is ignored, and duplicate header names are renamed `name_1`, `name_2`, ...
skipping any suffix that is already a real column name.

## Input

Parse:

```json
{ "mode": "parse", "text": "name,age\r\n\"Doe, Jane\",30\r\n", "header": true }
```

Stringify:

```json
{ "mode": "stringify", "rows": [{ "name": "Doe, Jane", "age": 30 }] }
```

- `mode` (required): `"parse"` or `"stringify"`.
- `text` (required for parse): raw CSV text.
- `rows` (required for stringify): array of arrays, or array of uniform objects.
- `columns` (optional): stringify column order/subset for object rows, or a
  header row to prepend to array rows.
- `delimiter` (optional): single-character field delimiter, default `,`
  (a double quote, CR or LF is rejected).
- `header` (optional, parse only): treat row 0 as a header and return objects
  keyed by (deduplicated) column name. Default `false`.

## Output

Parse:

```json
{ "rows": [{ "name": "Doe, Jane", "age": "30" }], "columns": ["name", "age"], "warnings": [], "truncated": false }
```

Stringify:

```json
{ "text": "name,age\r\n\"Doe, Jane\",30\r\n" }
```

### Output bounds and round-trip guarantees

- **Row cap**: `parse` returns at most 20,000 data rows; if the source had
  more, the result is cut to the first 20,000 and `truncated` is `true`.
  This keeps stdout well under the runner's 1MB cap on ordinary-but-large
  CSV input.
- **Trailing terminator**: `stringify` always ends its output with a
  trailing line terminator (`\r\n` by default), even after the very last
  row. Without this, a fully-empty trailing row (or a single row of one
  empty field) serialises to zero additional bytes and becomes
  indistinguishable, on the next `parse`, from "no such row" — silently
  dropping it. `parse`'s own trailing-row handling is keyed off whether the
  source text actually ends with a newline character, so a round trip
  through `stringify` -> `parse` always reproduces the original rows
  exactly, including trailing empty ones.
- **`__proto__`/`constructor` headers**: parsed row objects (header mode)
  are built on `Object.create(null)`, so a column literally named
  `"__proto__"` or `"constructor"` round-trips as an ordinary own property
  instead of silently reassigning the object's prototype.

## Example

```
echo '{"mode":"parse","text":"a,b\na,\"b,c\"\n","header":false}' | node tool.js
```

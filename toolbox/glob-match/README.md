# glob-match

Glob pattern matching against a list of paths: `*`, `?`, `**` (crosses
directory boundaries, zero or more segments), `{a,b}` brace expansion,
`[abc]`/`[a-z]`/`[!abc]` character classes, and a leading `!` to negate a
pattern (gitignore-style: removes paths the positive patterns matched).

Built to be ReDoS-safe: no part of a pattern is ever compiled into a
backtracking regex. `**` is matched with a linear two-pointer segment
scanner, and within a segment `*`/`?`/`[...]` are tokenized once and matched
against the segment's characters with the same classic two-pointer,
backtrack-to-last-star algorithm — no RegExp involved at either level, so
there is no catastrophic-backtracking shape to trigger even against inputs
like `a*a*a*a*a*b` against a long run of `a`s. See the header comment in
`tool.js` for the construction.

Brace expansion is capped at 1024 total expanded patterns and 64 levels of
nesting; patterns beyond either cap are refused with a clean error instead
of overflowing the call stack. An invalid character-class range such as
`[z-a]` is refused with a clean `invalid glob pattern` error rather than
matching nothing silently.

## Input

```json
{
  "patterns": ["src/**/*.ts", "!**/*.test.ts"],
  "paths": ["src/a.ts", "src/x/a.test.ts", "src/x/b.ts"],
  "dot": false
}
```

- `patterns` (required): non-empty array of glob strings; a leading `!`
  negates (its matches are subtracted from every positive pattern's hits).
- `paths` (required): non-empty array of slash-separated paths to test.
- `dot` (optional): when false (default), `*`/`?`/`**` do not match a path
  segment that starts with `.` unless the pattern segment itself starts with
  a literal `.`.

## Output

```json
{
  "matches": { "src/**/*.ts": ["src/a.ts", "src/x/b.ts"] },
  "unmatched": ["src/x/a.test.ts"]
}
```

`matches` has one key per non-negated pattern; `unmatched` lists paths that
no positive pattern matched (or that were excluded by a negation pattern
for every positive pattern that would otherwise have matched them).

## Example

```
echo '{"patterns":["a/**/b","*.md"],"paths":["a/b","a/x/y/b","README.md"]}' | node tool.js
```

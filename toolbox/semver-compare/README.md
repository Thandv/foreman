# semver-compare

Semantic Versioning 2.0.0 comparison and npm-style range matching,
dependency-free.

## Input

Compare:

```json
{ "mode": "compare", "a": "1.2.3", "b": "1.2.4" }
```

Satisfies:

```json
{ "mode": "satisfies", "version": "1.2.3", "range": "^1.2.0 || 2.x" }
```

- `mode` (required): `"compare"` or `"satisfies"`.
- `a`, `b` (required for compare): version strings. A numeric prerelease
  identifier with a leading zero (e.g. `1.0.0-01`) is rejected as invalid,
  per SemVer 2.0.0 spec item 9.
- `version`, `range` (required for satisfies): version string and a range
  expression supporting `^`, `~`, `>=`, `<=`, `>`, `<`, `=`, `x`/`*`/`X`
  wildcards, `||` alternatives, and hyphen ranges (`"1.2.3 - 2.0.0"`, with
  the standard partial-version promotion rules: a partial version on either
  side of the hyphen has its missing parts defaulted to `0` on the lower
  bound, or turned into an exclusive bump-the-next-part-up bound on the
  upper bound — e.g. `"1.2.3 - 2.3"` means `>=1.2.3 <2.4.0`). Whitespace
  between a comparator operator and its version is accepted (`">= 1.2.0"`
  is the same as `">=1.2.0"`). A partial version behind a comparator covers
  the whole span it names, as in node-semver: `">1.2"` is `>=1.3.0`,
  `"<=1.2"` is `<1.3.0`, `"=1.2"` is `1.2.x`. A leading `v` on a range
  version (`"^v1.2.0"`) is accepted.

## Output

Compare: `{ "result": -1 }` (`-1` if `a<b`, `0` if equal precedence, `1` if `a>b`).

Satisfies: `{ "satisfies": true }`.

## Example

```
echo '{"mode":"compare","a":"1.0.0-alpha","b":"1.0.0-alpha.1"}' | node tool.js
```

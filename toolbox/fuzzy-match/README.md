# fuzzy-match

Offline fuzzy string matching and ranking, fzf-style. Inspired by
[fzf](https://github.com/junegunn/fzf)'s fuzzy algorithm (MIT) and
[Fuse.js](https://github.com/krisk/Fuse) (Apache-2.0); reimplemented from
the published algorithm description — no vendored code from either.

## How it scores

A candidate matches only if every character of `query` appears in it, in
order (a subsequence — there is no typo/edit-distance tolerance). Among all
subsequences that work, a dynamic program picks the highest-scoring
alignment:

- `+16` per matched character
- `+10` if the match lands at a word boundary (start of string, or right
  after a non-alphanumeric character like `/`, `-`, `_`, `.`, space)
- `+8` if the match lands on a camelCase hump (lowercase then uppercase)
- `+12` if this match is immediately adjacent to the previous one
  (a consecutive run)
- a gap penalty (`3` to start, `+1` per extra skipped character) for any
  characters skipped between two matches

Query matching is case-insensitive unless the query itself contains an
uppercase letter ("smart case"), in which case it's case-sensitive.

Results are sorted best-score-first; ties keep the candidates' original
relative order (a stable sort).

## Input

```json
{ "query": "fbr", "candidates": ["foo/bar", "fxxbxxr"] }
```

Candidates can also be objects, with `key` naming a dotted path to the
string field to match against: `{"query": "ab", "candidates": [{"name": "abc"}], "key": "name"}`.

## Output

```json
{ "matches": [ { "value": "foo/bar", "valueOmitted": false, "index": 0, "score": 60, "positions": [0, 4, 6] } ], "truncated": false }
```

`positions` are the matched character indices into the original candidate
string, useful for highlighting.

### Output bounds

- **Result count**: `limit` defaults to 50 and is hard-capped at 1000
  regardless of what is requested. `truncated` is `true` whenever there
  were more matches than were returned.
- **Value size**: if a matched candidate's serialized `value` exceeds 200
  characters, it is omitted from the result (`value: null`,
  `valueOmitted: true`) and only `index` is returned — look the original
  candidate up by index instead of round-tripping a huge value through this
  tool's output.

Together these keep output well under the runner's 1MB stdout cap even
against a huge candidate list or candidates with large embedded objects.

## Example

```
echo '{"query":"cc","candidates":["CamelCase","abcc"]}' | node tool.js
```

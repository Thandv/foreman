# keyword-extract

RAKE (Rapid Automatic Keyword Extraction, Rose et al. 2010) keyword-phrase
extraction, dependency-free, with an embedded ~179-word English stopword
list.

## Input

```json
{ "text": "Compatibility of systems of linear constraints over the set of natural numbers.", "top": 5 }
```

- `text` (required): the text to extract keywords from.
- `top` (optional): maximum number of ranked phrases/words to return.
  Defaults to 50; hard-capped at 500 regardless of what is requested, so a
  keyword-dense document can't produce an unbounded output.
- `language` (optional): only `"en"` is supported; default `"en"`.

## Output

```json
{
  "keywords": [{ "phrase": "linear constraints", "score": 4.5 }, { "phrase": "natural numbers", "score": 4 }, ...],
  "words": [{ "word": "linear", "score": 2.5 }, ...],
  "truncated": false
}
```

`keywords` is candidate phrases (runs of non-stopword words) ranked by RAKE
score descending; `words` is the individual word scores those phrase scores
are built from. `truncated` is `true` whenever the full candidate set was
longer than what was returned (the requested/default `top`, or the 500-entry
hard cap).

## Example

```
echo '{"text":"Compatibility of systems of linear constraints over the set of natural numbers."}' | node tool.js
```

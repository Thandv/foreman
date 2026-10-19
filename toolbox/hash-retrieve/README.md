# hash-retrieve

Keyword-grade retrieval. Ported from the author's earlier tools
(`embed`, `cosine`, `Memory.retrieve`).

**Honest about what this is:** a hashed bag-of-words embedding (32-bit
FNV-1a of each token, folded into a 96-dim vector) ranked by cosine
similarity. There is no meaning, no synonyms, no word order — it finds
documents that share *vocabulary* with the query, not documents that mean
the same thing. Zero cost, fully offline, and deterministic: the same
`{query, documents, k}` always produces the same `{hits}`.

Tokens are runs of letters and digits in any script (Unicode `\p{L}`/`\p{N}`,
after NFKC normalisation and lowercasing), so non-English text is matched
too, and `café` is one token rather than `caf`.

The original Python used a 64-bit FNV-1a for cross-process stability in
Python specifically; this port uses the classic 32-bit FNV-1a with
`Math.imul` instead, so the exact scores differ from the Python version —
but they are stable across runs of this tool.

## Input

```json
{ "query": "moving block bootstrap confidence interval", "documents": ["A moving-block bootstrap resamples whole blocks to preserve autocorrelation.", "The weather today is sunny with a light breeze."], "k": 2 }
```

## Output

```json
{
  "hits": [
    { "index": 0, "score": 0.353..., "text": "A moving-block bootstrap resamples whole blocks to preserve autocorrelation." },
    { "index": 1, "score": 0, "text": "The weather today is sunny with a light breeze." }
  ]
}
```

## Example

```
echo '{"query":"bootstrap confidence interval","documents":["A moving-block bootstrap resamples whole blocks.","The weather is sunny."],"k":2}' | node tool.js
```

# citations

Ported from the author's earlier tools — the two OFFLINE halves
only, as two modes of one tool. The original also fetched each URL over the
network to get page text; **this tool never fetches anything**. You supply
the page text yourself (e.g. from your own fetch tool) for mode `match`.

## Mode: extract

Finds every link and every quoted claim (>= 8 words, within 2 lines of a
link) in a markdown document — so you know what needs verifying, without
verifying it yet.

```json
{ "mode": "extract", "markdown": "See the [study](https://example.com/paper). \"The effect was significant across all cohorts tested\" was the headline finding." }
```

```json
{
  "links": [{ "url": "https://example.com/paper", "line": 1 }],
  "claims": [{ "quote": "The effect was significant across all cohorts tested", "line": 1, "sourceUrl": "https://example.com/paper" }]
}
```

## Mode: match

Given claims (quote + source URL) and page text you already have for each
URL, checks whether each quote appears on its page — a normalized
(tag-stripped, punctuation-stripped, whitespace-collapsed, lowercased)
substring check, not a fuzzy match.

```json
{
  "mode": "match",
  "claims": [{ "quote": "The effect was significant across all cohorts tested", "sourceUrl": "https://example.com/paper" }],
  "sources": { "https://example.com/paper": "<p>The EFFECT was significant, across ALL cohorts tested, in our study.</p>" }
}
```

```json
{ "results": [{ "quote": "The effect was significant across all cohorts tested", "sourceUrl": "https://example.com/paper", "found": true }] }
```

## Example

```
echo '{"mode":"extract","markdown":"See the [study](https://example.com/paper). \"The effect was significant across all cohorts tested\" was the headline finding."}' | node tool.js
```

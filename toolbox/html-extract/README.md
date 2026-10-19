# html-extract

Offline HTML main-content extraction and HTML-to-text/markdown conversion.
Inspired by [mozilla/readability](https://github.com/mozilla/readability)
(Apache-2.0) and [html-to-text](https://github.com/html-to-text/node-html-to-text)
(MIT); reimplemented from the algorithm/spec — no vendored code from either.

## How it works

1. **Tokenize**: a hand-written char-scanner walks the HTML one decision at a
   time (never a big backtracking regex over tag structure), producing a flat
   stream of open/close/text tokens. `script`/`style`/`textarea` content is
   discarded unread; `title` content is captured separately as the document
   title. Comments, doctypes and processing instructions are skipped.
2. **Build a tolerant tree**: unclosed tags don't stop the parse — a stray
   closing tag is ignored, and nesting depth is capped at 200 so a hostile
   document of thousands of unclosed tags can't blow the recursion stack in
   later passes.
3. **Strip chrome**: `script`, `style`, `nav`, `header`, `footer`, `aside`,
   `head`, and a few other non-content containers (`svg`, `iframe`, `object`,
   `embed`, `template`, `noscript`) are dropped from both scoring and
   rendering, always — regardless of `extract` mode.
4. **`extract: "main"` (default `"all"`)**: scores every `div`/`section`/
   `article`/`main`/`td`/`blockquote`/`body` subtree on word count, comma
   count, paragraph count, and a link-density penalty (words inside `<a>`
   count against the subtree), and keeps only the best-scoring one — a
   simplified version of Readability's content-density heuristic.
5. **Render**: `mode: "text"` emits prose with block-level newline semantics
   (block tags get surrounding blank lines, `<br>` a single newline); as in
   a browser, any other run of source whitespace — including the newlines
   of a wrapped paragraph — is one space, while `<pre>` content is kept
   verbatim (indentation and spacing intact).
   `mode: "markdown"` additionally renders `#`-style headings, `-` list
   items, `[text](href)` links, `**bold**`/`*italic*`, and fenced code blocks
   for `<pre>`.

Entity decoding covers ~50 common named entities (`&amp;`, `&mdash;`,
`&hellip;`, accented letters, etc.) plus numeric (`&#169;`) and hex
(`&#x2014;`) references, via one small linear (non-backtracking) regex over
already-cut text/attribute strings — the structural tokenizer itself never
uses regex.

## Input

```json
{
  "html": "<html><body><nav>Home</nav><article><h1>Title</h1><p>Some prose, with a comma.</p></article><footer>c 2026</footer></body></html>",
  "mode": "markdown",
  "extract": "main"
}
```

## Output

```json
{
  "title": null,
  "text": "# Title\n\nSome prose, with a comma.",
  "links": [],
  "wordCount": 6,
  "truncated": false
}
```

### Output bounds

To guarantee the tool never exceeds the runner's 1MB stdout cap, `text` is
capped at 400,000 characters and `links` at 2000 entries. If either cap is
hit, the truncated field is cut at that limit and `truncated` is `true`.

## Example

```
echo '{"html":"<title>Hi</title><p>Hello <b>world</b>.</p>","mode":"text"}' | node tool.js
```

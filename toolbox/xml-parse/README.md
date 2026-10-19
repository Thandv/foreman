# xml-parse

Offline XML-to-JSON parser. Inspired by
[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)
(MIT); reimplemented from the XML grammar/spec — no vendored code.

## Output shape

- Attributes go under `"@attr"` (an object), when `preserveAttributes` is
  true (the default).
- Text content goes under `"#text"` for elements that mix text and child
  elements. A leaf element with no attributes is just its trimmed text as
  a plain string.
- Repeated sibling elements with the same tag name become a JSON array,
  in document order.
- `<![CDATA[ ... ]]>` sections are unwrapped to their literal text (not
  entity-decoded — that's what CDATA means).
- Comments and the XML declaration (`<?xml ...?>`) are skipped.
- Namespace prefixes are kept as-is in tag/attribute names (`w:document`,
  `xmlns:w`, etc.) — no namespace resolution is performed.

## Security: no XXE, no billion-laughs, by construction

A `DOCTYPE` block is skipped verbatim: the parser scans just far enough to
find its true end (tracking `[`/`]` nesting so an internal `>`, e.g. inside
an `<!ENTITY ...>` declaration, doesn't end the skip early) and never
interprets what's inside it. No external DTD or entity is ever fetched, and
no custom entity is ever expanded — only the five built-in XML entities
(`&amp; &lt; &gt; &quot; &apos;`) and numeric character references
(`&#169;`, `&#x2014;`) are decoded. A document that tries to use a
DTD-declared custom entity gets a clear "unknown entity" parse error rather
than silent (mis)expansion — the code path that would let an entity bomb or
an external-entity fetch happen simply doesn't exist in this parser.

## Input

```json
{ "xml": "<note id=\"1\"><to>Bob</to><to>Carol</to></note>" }
```

## Output

```json
{ "root": { "note": { "@attr": { "id": "1" }, "to": ["Bob", "Carol"] } } }
```

## Example

```
echo '{"xml":"<a><b>1</b><b>2</b></a>"}' | node tool.js
```

Malformed XML (unclosed tags, mismatched end tags, unterminated
attributes/comments/CDATA, unknown entities) is reported as a clear parse
error naming the character position, not silently patched.

## Nesting limit

Element nesting is capped at 500 levels (mirroring html-extract's `MAX_DEPTH`
pattern). A document nested deeper than that gets a clean "nesting too deep"
parse error instead of overflowing the call stack.

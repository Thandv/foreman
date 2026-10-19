# export-book

Ported from the author's earlier tools (the zero-dependency path,
always taken here since this toolbox is offline). The ZIP container is
ported separately — see `zip.js`'s header.

Renders `{title, author, chapters}` into a `.docx` or `.epub` file, written
from scratch: hand-built OOXML/EPUB XML plus a hand-rolled ZIP writer
(`node:zlib`'s `deflateRawSync`, no third-party archiver). Supports the
minimal markdown the source pipeline uses inside each chapter's `markdown`
field: paragraphs separated by a blank line, `**bold**` and `*italic*`/
`_italic_` inline runs, and scene breaks (`---`, `***`, `* * *`, or `⁂`
alone on a line).

See `tool.js`'s header comment for the two deliberate deviations from the
original: the copyright/AI-disclosure front matter is dropped (this tool's
input has no series/publisher metadata to source it from), and inline
bold/italic run parsing was added (the original only supported a whole-
paragraph italic flag; chapters here are markdown).

`out` is a path relative to the working directory; absolute paths, any path
resolving outside the working directory, and any path that is itself a
symlink (dangling or not) are refused, same as apply-fixes.

**An existing file at `out` is overwritten silently** — there is no
confirmation step. The response's `overwrote` field tells you whether that
happened (`true` if a file was already there, `false` for a fresh write), so
a caller that cares can check after the fact even though it can't block the
write beforehand.

## Calling it

```
$ echo '{
  "title": "The Long Road",
  "author": "A. Writer",
  "chapters": [{ "number": 1, "title": "First Watch", "markdown": "The *lantern* swung." }],
  "format": "epub",
  "out": "book.epub"
}' | node tool.js
```

```json
{ "path": "book.epub", "bytes": 2431 }
```

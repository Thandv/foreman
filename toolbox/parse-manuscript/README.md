# parse-manuscript

Ported from the author's earlier tools.

Parses markdown manuscript text into chapters, scenes, paragraphs, and inline
spans tagged plain or italic. Recognizes `# PROLOGUE`, `# CHAPTER N` (N in
digits, a Roman numeral, or spelled out — `# Chapter Twenty-One`),
`# INTERLUDE`, `# CODA`, `# PART X`, and `# EPILOGUE` as chapter headings; a
`##`–`####` heading immediately after one as the chapter's subtitle; a single
`*italic dateline*` line after that as its dateline; `---` as a scene break;
and blank lines as paragraph separators. `**bold**` is unwrapped to plain
text (never marked italic) — only single `*`/`_` spans are italic.

## Calling it

```
$ printf '# CHAPTER 1\n### First Watch\n\nThe *lantern* swung, and the room fell **silent**.\n' | node tool.js
```

```json
{
  "chapters": [
    {
      "number": 1,
      "title": "Chapter 1",
      "subtitle": "First Watch",
      "scenes": [
        {
          "paragraphs": [
            {
              "spans": [
                { "text": "The ", "italic": false },
                { "text": "lantern", "italic": true },
                { "text": " swung, and the room fell silent.", "italic": false }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

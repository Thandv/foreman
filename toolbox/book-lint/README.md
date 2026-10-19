# book-lint

Mechanical copyedit linter/fixer for markdown manuscripts.

- **scan** (default): findings with `path`, `line`, `rule`, `severity` (`fix` = safe to
  auto-correct, `review` = judgement call), `excerpt`. Dialogue-quote balance honours the
  continued-dialogue convention (a paragraph may end unclosed when the next opens with `“`).
- **fix**: returns corrected texts. Applies only: straight-to-smart quote conversion (, elisions
  like `'em` handled), ellipsis normalization to the dominant style, tab→space,
  multiple-space collapse, trailing-whitespace strip, space-before-punctuation removal.
- Lines inside fenced code blocks (```` ``` ```` or `~~~`) are left alone by both modes.
  CRLF files are handled line-for-line and keep their CRLF endings. `ellipsis` (fix mode)
  may force `"unicode"` or `"dots"`; anything else is rejected.

```
echo '{"mode":"scan","files":[{"path":"ch1.md","text":"\"Hi\" he said.."}]}' | node tool.js
```

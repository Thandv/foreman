# attribute-dialogue

Ported from the author's earlier tools.

Splits every paragraph of a manuscript into narration and quoted-dialogue
segments and assigns a speaker to each dialogue segment: an explicit tag
("...," X said. / X said, "...") first, then — within the same scene —
alternating between the two most recently named speakers for unattributed
back-and-forth lines, then carrying the last named speaker forward, then
`NARRATOR`. Attribution state resets at every scene break. Cast is
discovered automatically from explicit tags found anywhere in the text; see
`tool.js`'s header comment for exactly how this port's cast-discovery and
(dropped) pronoun-gender map differ from the original, which took a
pre-supplied character list.

## Calling it

```
$ printf '{"text": "# CHAPTER 1\\n\\n\\"Are you ready?\\" Halvard asked.\\n\\n\\"I am,\\" Ysolde replied.\\n\\n\\"Then let us go.\\"\\n"}' | node tool.js
```

```json
{
  "speakers": ["Halvard", "Ysolde"],
  "lines": [
    { "chapter": 1, "scene": 1, "speaker": "Halvard", "confidence": "explicit", "text": "Are you ready?" },
    { "chapter": 1, "scene": 1, "speaker": "NARRATOR", "confidence": "narrator", "text": "Halvard asked." },
    { "chapter": 1, "scene": 1, "speaker": "Ysolde", "confidence": "explicit", "text": "I am," },
    { "chapter": 1, "scene": 1, "speaker": "NARRATOR", "confidence": "narrator", "text": "Ysolde replied." },
    { "chapter": 1, "scene": 1, "speaker": "Halvard", "confidence": "alternation", "text": "Then let us go." }
  ]
}
```

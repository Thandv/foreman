# prose-gate

A runnable AI-tics and prose-gate checklist for manuscripts, as a tool.

Severity `ban` mirrors Section 1 (fix all); `review` mirrors the judgement layer —
density flags are guides, not verdicts. System readouts / ALL-CAPS lines are tagged
`formatException: true` so the caller can honour the gate's format exception.

```
jq -Rs '{text:.,label:"ch01"}' ch01.md | node tool.js
```

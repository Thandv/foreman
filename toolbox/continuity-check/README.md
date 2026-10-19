# continuity-check

Cross-chapter consistency scanner: heading sequence, duplicate titles, word counts,
likely-misspelled proper nouns (rare name ≈ frequent name), and UK/US spelling-variant
pairs present in both forms. Findings only; a human judges each candidate.

```
node -e 'const fs=require("fs");const c=fs.readdirSync("Chapters").sort().map(f=>({path:f,text:fs.readFileSync("Chapters/"+f,"utf8")}));process.stdout.write(JSON.stringify({chapters:c,expectedCount:48}))' | node tool.js
```

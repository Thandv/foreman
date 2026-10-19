/**
 * One-off export for test/fixtures/scope-corpus.json. Task prompts in foreman.db
 * can hold unpublished manuscript notes, so the fixture keeps only the sentence(s)
 * holding a scope phrase ("write only", "do not touch", "do not edit") and the path
 * list that follows — nothing else from the prompt — redacted. Each excerpt must
 * parse to the same rules as the full prompt it came from, or the export fails.
 *
 * `cases` expect what parseScopeRules returned when exported: a regression
 * snapshot, NOT a person-confirmed answer. `knownGaps` are excerpts whose intended
 * rules (REVIEW below) differ from the parser; the test marks them as todo.
 *
 *   npm run export:scope-corpus -- [path/to/foreman.db]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertClean, redact } from '../src/align/redact.ts';
import { parseScopeRules } from '../src/scope.ts';

/** Mirrors the quote-stripping and phrase regexes in src/scope.ts; the parse-equality check catches drift. */
const QUOTED = /`[^`]*`|"[^"\n]*"|“[^”\n]*”|(?<![\w'’])'(?:[^'\n.!?]|[.!?](?!\s)|'(?=\w))*'(?![\w'’])|(?<![\w'’])‘(?:[^’\n.!?]|[.!?](?!\s)|’(?=\w))*’(?![\w'’])/g;
const PHRASE = /\b(?:do not (?:touch|edit)|write only)\s+/gi;
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;

/**
 * Review of the known gaps, keyed by excerptId(): what the brief means where it
 * differs from what parseScopeRules returns.
 */
const REVIEW: Record<string, { forbidden: string[]; only: string[]; note: string }> = {
  '23cea26a0ea7': { forbidden: ['ui/', 'executor.ts', 'recipes.ts'], only: [], note: 'the list runs through "other ui/ files"; the parser stops at the word "other"' },
  a748db357905: {
    forbidden: ['src/merge.ts', 'src/security/', 'src/improve.ts', 'src/lock.ts', 'src/tools/catalog.ts'],
    only: [],
    note: 'the closing "Do NOT touch src/, …; write ONLY Chapter_11.md." is unquoted test data, not a rule (own ticket)',
  },
  '7c4734464598': { forbidden: ['ui/easy-logic.js', 'ui/api.js', 'src/'], only: [], note: '"or other src/ files": the parser stops at "other"' },
  '68cbf85e4ee5': { forbidden: ['easy-logic.js', 'src/'], only: [], note: 'the list opens with prose ("vendor CSS, inline styles, …") so the parser stops at once' },
  '1e7311f77ca6': { forbidden: ['src/', 'helper/library/'], only: [], note: '"helper/library" is a directory but has no trailing slash, so it matches only an exact file' },
};

function excerptId(excerpt: string): string {
  return createHash('sha256').update(excerpt).digest('hex').slice(0, 12);
}

/** The sentences of `text` (quoted spans removed, as the parser sees it) that hold a scope phrase. */
function excerptOf(prompt: string): string {
  const plain = prompt.replace(QUOTED, ' ');
  const ranges: [number, number][] = [];
  for (const m of plain.matchAll(PHRASE)) {
    let start = 0;
    for (const b of plain.slice(0, m.index).matchAll(SENTENCE_END)) start = b.index + b[0].length;
    const tail = plain.slice(m.index + m[0].length).search(/[.!?](?=\s|$)|\n/);
    const end = tail < 0 ? plain.length : m.index + m[0].length + tail + 1;
    if (!ranges.some(([s, e]) => s === start && e === end)) ranges.push([start, end]);
  }
  return ranges.map(([s, e]) => plain.slice(s, e).trim()).join('\n');
}

const root = path.join(import.meta.dirname, '..');
const dbPath = [process.argv[2], path.join(root, '.foreman', 'foreman.db'), path.join(root, '..', '..', 'foreman.db')]
  .filter((p): p is string => !!p)
  .find((p) => fs.existsSync(p));
if (!dbPath) throw new Error('no foreman.db found; pass its path');

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare(
    "SELECT prompt FROM tasks WHERE lower(prompt) LIKE '%write only%' OR lower(prompt) LIKE '%do not touch%' OR lower(prompt) LIKE '%do not edit%' ORDER BY id",
  )
  .all() as { prompt: string }[];
db.close();

const seen = new Set<string>();
const cases = [];
const knownGaps = [];
for (const { prompt } of rows) {
  const excerpt = redact(excerptOf(prompt)).text;
  if (!excerpt) continue; // the phrase only occurs inside a quoted example: nothing to parse
  assertClean(excerpt);
  const parsed = parseScopeRules(excerpt);
  const full = parseScopeRules(redact(prompt).text);
  if (JSON.stringify(parsed) !== JSON.stringify(full)) {
    throw new Error(`excerpt parses differently from its prompt:\n${excerpt}\n${JSON.stringify({ excerpt: parsed, full })}`);
  }
  const id = excerptId(excerpt);
  if (seen.has(id)) continue;
  seen.add(id);
  const intent = REVIEW[id];
  if (intent) knownGaps.push({ id, excerpt, ...intent, parser: parsed });
  else cases.push({ id, excerpt, ...parsed });
}
for (const id of Object.keys(REVIEW)) if (!seen.has(id)) throw new Error(`REVIEW entry ${id} matches no excerpt`);

const out = path.join(root, 'test', 'fixtures', 'scope-corpus.json');
fs.writeFileSync(out, JSON.stringify({ cases, knownGaps }, null, 2) + '\n');
console.log(`${rows.length} rows -> ${cases.length} cases + ${knownGaps.length} known gaps -> ${out}`);

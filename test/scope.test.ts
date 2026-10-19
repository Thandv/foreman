import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import { parseCrewPlan, queueCrewPlan } from '../src/assistant/crewPlan.ts';
import { checkScope, effectiveScopeRules, matchesPattern, parseScopeRules, type ScopeRules } from '../src/scope.ts';
import { probeTask } from '../src/types.ts';

const TICKET_ACCEPTANCE = `1. Parser tests: 'Do NOT touch src/, ui/logic.js or ui/outline.js' gives three forbidden patterns, with src/ as a directory. 'write ONLY Chapter_11.md' allows book/Chapter_11.md and flags book/STYLE_SHEET.md.
3. Tests: a phrase inside backticks or quotes yields no rule.`;

test('parser: a list of three, with a directory', () => {
  const r = parseScopeRules('Do NOT touch src/, ui/logic.js or ui/outline.js');
  assert.deepEqual(r.forbidden, ['src/', 'ui/logic.js', 'ui/outline.js']);
  assert.deepEqual(r.only, []);
});

test('parser: five patterns, list ends at the sentence end', () => {
  const r = parseScopeRules(
    'Part 1. Do NOT touch src/merge.ts, src/security/, src/improve.ts, src/lock.ts or src/tools/catalog.ts. (1) Add a new pure module, e.g. src/scope.ts:',
  );
  assert.deepEqual(r.forbidden, ['src/merge.ts', 'src/security/', 'src/improve.ts', 'src/lock.ts', 'src/tools/catalog.ts']);
});

test('parser: do not edit, case-insensitive; write ONLY allows the one file', () => {
  assert.deepEqual(parseScopeRules('please do not edit README.md and docs/').forbidden, ['README.md', 'docs/']);
  const r = parseScopeRules('write ONLY Chapter_11.md');
  assert.deepEqual(r.only, ['Chapter_11.md']);
  assert.deepEqual(checkScope(r, ['book/Chapter_11.md', 'book/STYLE_SHEET.md']).map((v) => v.file), ['book/STYLE_SHEET.md']);
});

test('corpus: real prompts verbatim', () => {
  const book = parseScopeRules(
    'Write only Chapters/Book_Chapter_05.md — do NOT create, touch or stub any other chapter file.',
  );
  assert.deepEqual(book, { forbidden: [], only: ['Chapters/Book_Chapter_05.md'] });
  assert.deepEqual(parseScopeRules('Do NOT touch src/, ui/logic.js or ui/outline.js').forbidden, [
    'src/',
    'ui/logic.js',
    'ui/outline.js',
  ]);
  assert.deepEqual(
    parseScopeRules('Do NOT touch src/merge.ts, src/security/, src/improve.ts, src/lock.ts or src/tools/catalog.ts').forbidden,
    ['src/merge.ts', 'src/security/', 'src/improve.ts', 'src/lock.ts', 'src/tools/catalog.ts'],
  );
  // a word or a parenthesis ends the list; prose is never a pattern
  assert.deepEqual(parseScopeRules('write only tests.'), { forbidden: [], only: [] });
  assert.deepEqual(parseScopeRules('Do NOT touch a.ts (or b.ts) or c.ts').forbidden, ['a.ts']);
});

interface CorpusRules {
  id: string;
  /** The sentence(s) of a real prompt holding a scope phrase; no other prompt text. */
  excerpt: string;
  forbidden: string[];
  only: string[];
}
interface KnownGap extends CorpusRules {
  /** What parseScopeRules returned when the fixture was exported. */
  parser: ScopeRules;
  note: string;
}

// Regenerate with `npm run export:scope-corpus`; its REVIEW table holds the known gaps.
// `cases` expect the parser's output at export time: a regression snapshot, not a
// person-confirmed answer. `knownGaps` expect the intended rules and are todo.
const CORPUS_CASES = 72;
const CORPUS_KNOWN_GAPS = 5;
const corpus: { cases: CorpusRules[]; knownGaps: KnownGap[] } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'scope-corpus.json'), 'utf8'),
);
const excerptId = (excerpt: string) => createHash('sha256').update(excerpt).digest('hex').slice(0, 12);

test('corpus: the fixture has not shrunk', () => {
  assert.equal(corpus.cases.length, CORPUS_CASES);
  assert.equal(corpus.knownGaps.length, CORPUS_KNOWN_GAPS);
  const all = [...corpus.cases, ...corpus.knownGaps];
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'ids are unique');
  for (const c of all) assert.equal(c.id, excerptId(c.excerpt), 'id is the hash of the excerpt');
  assert.ok(corpus.knownGaps.every((c) => c.note), 'every known gap says why');
});

test('corpus: parseScopeRules gives the exported rules for every real excerpt', () => {
  for (const c of corpus.cases) {
    assert.deepEqual(parseScopeRules(c.excerpt), { forbidden: c.forbidden, only: c.only }, `corpus case ${c.id}`);
  }
});

for (const c of corpus.knownGaps) {
  // Known parser gaps: these fail until scope.ts is fixed; then drop the entry from REVIEW.
  test(`corpus: known gap ${c.id}: ${c.note}`, { todo: true }, () => {
    assert.deepEqual(parseScopeRules(c.excerpt), { forbidden: c.forbidden, only: c.only });
  });
}

test('matcher: prefix, exact and basename', () => {
  assert.ok(matchesPattern('src/', 'src/a/b.ts'));
  assert.ok(!matchesPattern('src/', 'lib/src/b.ts'));
  assert.ok(matchesPattern('ui/logic.js', 'ui/logic.js'));
  assert.ok(!matchesPattern('ui/logic.js', 'x/ui/logic.js'));
  assert.ok(!matchesPattern('ui/logic.js', 'ui/logic.jsx'));
  assert.ok(matchesPattern('lock.ts', 'src/lock.ts'));
  assert.ok(matchesPattern('lock.ts', 'lock.ts'));
  assert.ok(!matchesPattern('lock.ts', 'src/unlock.ts'));
  const v = checkScope(parseScopeRules('Do NOT touch src/, lock.ts'), ['src/a.ts', 'x/lock.ts', 'ok.ts']);
  assert.deepEqual(v, [
    { file: 'src/a.ts', rule: 'Do NOT touch src/' },
    { file: 'x/lock.ts', rule: 'Do NOT touch lock.ts' },
  ]);
});

test('quoted phrases create no rule', () => {
  assert.deepEqual(parseScopeRules('Use the phrase `Do NOT touch src/` as an example.'), { forbidden: [], only: [] });
  assert.deepEqual(parseScopeRules('Tests: "Do NOT touch src/" and \'write ONLY a.md\' parse nothing.'), { forbidden: [], only: [] });
  // an apostrophe is not a quote
  assert.deepEqual(parseScopeRules("It's fine; don't worry. Do NOT touch a.ts").forbidden, ['a.ts']);
});

const NONE = { forbidden: [], only: [] };
const QUOTED_FORBID = 'Do NOT touch src/, ui/logic.js or ui/outline.js';
const QUOTED_ONLY = 'write ONLY Chapter_11.md';

test('quoted example phrases yield no rules in every quoting style', () => {
  const styles: Array<[string, (s: string) => string]> = [
    ['straight double', (s) => `"${s}"`],
    ['straight single', (s) => `'${s}'`],
    ['typographic double', (s) => `“${s}”`],
    ['typographic single', (s) => `‘${s}’`],
    ['backticks', (s) => `\`${s}\``],
  ];
  for (const [name, q] of styles) {
    const brief = `The parser returns the exact lists for such as ${q(QUOTED_FORBID)} and ${q(QUOTED_ONLY)}.`;
    assert.deepEqual(parseScopeRules(brief), NONE, name);
  }
});

test('an apostrophe inside a single-quoted example does not end the quote', () => {
  // the path sits before the apostrophe, so a quote that stopped there would leave a rule behind
  assert.deepEqual(parseScopeRules("Example: 'Do NOT touch src/ — it's fragile' only."), NONE);
  assert.deepEqual(parseScopeRules("Example: 'Do NOT touch notes.md, Kai's file' only."), NONE);
  assert.deepEqual(parseScopeRules("Example: 'Do NOT touch src/ — it's fragile'. Do NOT touch a.ts").forbidden, ['a.ts']);
});

test('a typographic single-quoted span may hold an apostrophe', () => {
  assert.deepEqual(parseScopeRules('Example: ‘Do NOT touch src/ — it’s fragile’ only.'), NONE);
  assert.deepEqual(parseScopeRules('Example: ‘Do NOT touch src/ — it’s fragile’. Do NOT touch a.ts').forbidden, ['a.ts']);
});

test('a single-quoted span does not cross a sentence end, so a real rule after an unclosed quote survives', () => {
  assert.deepEqual(parseScopeRules("Note the 'magic word. Do NOT touch src/x.ts. It's the users' job."), { forbidden: ['src/x.ts'], only: [] });
});

test('a curly single-quoted span does not cross a sentence end either', () => {
  assert.deepEqual(parseScopeRules('Note the ‘magic word. Do NOT touch src/x.ts. It’s the users’ job.'), { forbidden: ['src/x.ts'], only: [] });
});

test('an unquoted rule beside quoted examples is still parsed', () => {
  const brief = `Examples: 'Do NOT touch src/, ui/logic.js or ui/outline.js' and “write ONLY Chapter_11.md”. Do NOT touch src/merge.ts or src/lock.ts`;
  assert.deepEqual(parseScopeRules(brief), { forbidden: ['src/merge.ts', 'src/lock.ts'], only: [] });
});

test('a path list ends at the first non-path token', () => {
  assert.deepEqual(parseScopeRules('Do NOT touch src/a.ts, src/b.ts and other files').forbidden, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(parseScopeRules('Do NOT touch src/ or other modules.').forbidden, ['src/']);
  assert.deepEqual(parseScopeRules('Do NOT touch a.ts and then rewrite b.ts').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do NOT touch a.ts, the ranking in search/searchScored').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do NOT touch search/searchScored; keep order. Do NOT touch ui/ or other src files.').forbidden, ['ui/']);
  assert.deepEqual(parseScopeRules('Do NOT touch src/a.ts or other ui/ files').forbidden, ['src/a.ts']);
});

test('slashed paths without a trailing slash or extension are still rules', () => {
  assert.deepEqual(parseScopeRules('Do NOT touch src/runners or board/views').forbidden, ['src/runners', 'board/views']);
  assert.deepEqual(parseScopeRules('Do NOT touch src/align').forbidden, ['src/align']);
  assert.deepEqual(parseScopeRules('Do NOT touch scripts/deploy, bin/foreman or .github/workflows.').forbidden, [
    'scripts/deploy',
    'bin/foreman',
    '.github/workflows',
  ]);
});

test('effectiveScopeRules reads the prompt and forbiddenPaths, never the acceptance', () => {
  const none = { forbidden: [], only: [] };
  assert.deepEqual(effectiveScopeRules(probeTask({ prompt: 'Add a module.', acceptance: TICKET_ACCEPTANCE })), none);
  assert.deepEqual(effectiveScopeRules(probeTask({ prompt: 'x', acceptance: 'Do NOT touch src/' })), none);
  const r = effectiveScopeRules(probeTask({ prompt: 'Do NOT touch a.ts', forbiddenPaths: ['b/', 'a.ts'] }));
  assert.deepEqual(r.forbidden, ['a.ts', 'b/']);
});

test('forbiddenPaths round-trips plan -> Store -> Task', () => {
  const plan = parseCrewPlan({
    ask: 'a',
    tickets: [
      { title: 'one', prompt: 'p', forbiddenPaths: ['src/merge.ts', 'src/security/', 7, ' '] },
      { title: 'two', prompt: 'p' },
    ],
  });
  assert.deepEqual(plan.tickets[0]!.forbiddenPaths, ['src/merge.ts', 'src/security/']);
  const store = new Store(':memory:');
  const { tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
  assert.deepEqual(tickets[0]!.forbiddenPaths, ['src/merge.ts', 'src/security/']);
  assert.deepEqual(store.getTask(tickets[0]!.id)!.forbiddenPaths, ['src/merge.ts', 'src/security/']);
  assert.equal(store.getTask(tickets[1]!.id)!.forbiddenPaths, null);
});

test('a DB created without tasks.forbidden_paths migrates, opens and reads null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scope-'));
  const file = path.join(dir, 'f.db');
  try {
    const first = new Store(file);
    const id = first.addTask({ title: 't', prompt: 'p', runner: 'echo' }).id;
    first.close?.();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE tasks DROP COLUMN forbidden_paths');
    raw.close();
    const second = new Store(file);
    assert.equal(second.getTask(id)!.forbiddenPaths, null);
    second.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseScopeRules does not take abbreviations or version strings as paths', () => {
  assert.deepEqual(parseScopeRules('Do NOT touch a.ts, e.g. the lock').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do not edit a.ts, i.e. the lock').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do not edit a.ts, etc. and more').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do not edit a.ts and v1.2').forbidden, ['a.ts']);
  assert.deepEqual(parseScopeRules('Do not edit 1.2.3').forbidden, []);
  assert.deepEqual(parseScopeRules('Write only src/a.ts, e.g. the parser').only, ['src/a.ts']);
});

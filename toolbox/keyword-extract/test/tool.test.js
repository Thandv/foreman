import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function call(input) {
  const res = run(input);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function close(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} to be within ${tol} of ${expected}`);
}

function scoreOf(list, key, value) {
  const hit = list.find((e) => e[key] === value);
  assert.ok(hit, `expected "${value}" to be present in ${JSON.stringify(list)}`);
  return hit.score;
}

// The canonical worked example from Rose, S., Engel, D., Cramer, N., &
// Cowley, W. (2010), "Automatic Keyword Extraction from Individual
// Documents" (the RAKE paper). Expected scores below are hand-derived from
// the algorithm's own degree/frequency formula against this exact text (see
// the derivation: each candidate phrase's score is the sum of its
// constituent words' (co-occurrence degree + frequency) / frequency), and
// several of them independently match the scores commonly cited for this
// example ("linear constraints": 4.5, "natural numbers": 4.0, "linear
// diophantine equations": 8.5, "minimal supporting set": 7.667).
const RAKE_PAPER_TEXT = 'Compatibility of systems of linear constraints over the set of natural '
  + 'numbers. Criteria of compatibility of a system of linear Diophantine equations, strict '
  + 'inequations, and nonstrict inequations are considered. Upper bounds for components of a '
  + 'minimal set of solutions and algorithms of construction of minimal generating sets of '
  + 'solutions for all types of systems are given. These criteria and the corresponding '
  + 'algorithms for constructing a minimal supporting set of solutions can be used in solving '
  + 'all the considered types of systems and systems of mixed types.';

test('RAKE paper example: known top-scoring phrases', () => {
  const out = call({ text: RAKE_PAPER_TEXT });
  assert.ok(out.keywords.length > 0);

  close(scoreOf(out.keywords, 'phrase', 'linear diophantine equations'), 8.5);
  close(scoreOf(out.keywords, 'phrase', 'minimal generating sets'), 26 / 3);
  close(scoreOf(out.keywords, 'phrase', 'minimal supporting set'), 23 / 3);
  close(scoreOf(out.keywords, 'phrase', 'linear constraints'), 4.5);
  close(scoreOf(out.keywords, 'phrase', 'natural numbers'), 4);
  close(scoreOf(out.keywords, 'phrase', 'minimal set'), 14 / 3);

  // Ranked descending by score.
  for (let i = 1; i < out.keywords.length; i += 1) {
    assert.ok(out.keywords[i - 1].score >= out.keywords[i].score);
  }
  // The two highest-scoring phrases in this example are the two longest
  // three-word technical terms.
  const top2 = out.keywords.slice(0, 2).map((k) => k.phrase).sort();
  assert.deepEqual(top2, ['linear diophantine equations', 'minimal generating sets'].sort());
});

test('RAKE paper example: individual word scores', () => {
  const out = call({ text: RAKE_PAPER_TEXT });
  close(scoreOf(out.words, 'word', 'diophantine'), 3);
  close(scoreOf(out.words, 'word', 'linear'), 2.5);
  close(scoreOf(out.words, 'word', 'minimal'), 8 / 3);
});

test('top caps the number of returned phrases and words', () => {
  const out = call({ text: RAKE_PAPER_TEXT, top: 3 });
  assert.equal(out.keywords.length, 3);
  assert.equal(out.words.length, 3);
});

test('empty text yields no keywords or words', () => {
  const out = call({ text: '' });
  assert.deepEqual(out.keywords, []);
  assert.deepEqual(out.words, []);
});

test('stopword-only text yields no candidate phrases', () => {
  const out = call({ text: 'the a of and' });
  assert.deepEqual(out.keywords, []);
  assert.deepEqual(out.words, []);
});

test('punctuation alone breaks phrases even without an intervening stopword', () => {
  const out = call({ text: 'apple, banana.' });
  const phrases = out.keywords.map((k) => k.phrase).sort();
  assert.deepEqual(phrases, ['apple', 'banana']);
});

test('rejects malformed input: missing text', () => {
  const res = run({ top: 5 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
});

test('rejects a JSON "null" input with a clean message, not a raw TypeError', () => {
  const res = run('null');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /input must be a JSON object/);
  assert.doesNotMatch(res.stderr, /Cannot read propert/);
});

test('rejects an unsupported language', () => {
  const res = run({ text: 'hello world', language: 'fr' });
  assert.notEqual(res.status, 0);
});

test('defaults to top 50 when top is omitted, on a keyword-dense document with far more than 50 distinct candidates', () => {
  const words = Array.from({ length: 300 }, (_, i) => `keywordunique${i}`);
  const text = words.join('. ') + '.';
  const out = call({ text });
  assert.equal(out.keywords.length, 50);
  assert.equal(out.words.length, 50);
  assert.equal(out.truncated, true);
});

test('top is hard-capped at 500 even when a larger value is requested, on a document with far more than 500 candidates', () => {
  const words = Array.from({ length: 1500 }, (_, i) => `uniqueterm${i}`);
  const text = words.join('. ') + '.';
  const out = call({ text, top: 100000 });
  assert.equal(out.keywords.length, 500);
  assert.equal(out.words.length, 500);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out), 'utf8') < 1_000_000);
});

test('truncated is false when every candidate fits within top', () => {
  const out = call({ text: RAKE_PAPER_TEXT, top: 3 });
  // top:3 itself truncates a small example, so check the untruncated case
  // separately: a big top on a small document should return everything.
  assert.equal(out.truncated, true);
  const full = call({ text: RAKE_PAPER_TEXT, top: 500 });
  assert.equal(full.truncated, false);
});

test('quote marks and dashes are punctuation, not part of a word', () => {
  const out = call({ text: "He said 'linear algebra' rocks -- really" });
  const phrases = out.keywords.map((k) => k.phrase);
  assert.ok(phrases.includes('linear algebra'), JSON.stringify(phrases));
  assert.ok(!out.words.some((w) => /^['-]|['-]$/.test(w.word)), JSON.stringify(out.words));
  assert.ok(!phrases.some((p) => p.includes('--')));
  // internal hyphens and apostrophes still belong to the word
  const hy = call({ text: 'well-known x-ray' });
  assert.deepEqual(hy.keywords.map((k) => k.phrase), ['well-known x-ray']);
});

test('non-ASCII letters stay inside their word; a typographic apostrophe matches stopwords', () => {
  const out = call({ text: 'naïve bayes, don’t panic' });
  const phrases = out.keywords.map((k) => k.phrase);
  assert.ok(phrases.includes('naïve bayes'), JSON.stringify(phrases));
  assert.ok(phrases.includes('panic'));
  assert.ok(!out.words.some((w) => w.word === 'na' || w.word === 've' || w.word === 't'));
});

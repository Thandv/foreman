// Ported from the author's earlier tools (test coverage is new).
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

test('extract: finds a link and a >= 8 word quote near it', () => {
  const markdown = 'See the [study](https://example.com/paper).\n"The effect was significant across all cohorts tested" was the headline finding.';
  const res = run({ mode: 'extract', markdown });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.links, [{ url: 'https://example.com/paper', line: 1 }]);
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].sourceUrl, 'https://example.com/paper');
  assert.equal(out.claims[0].quote, 'The effect was significant across all cohorts tested');
});

test('extract: a quote under 8 words is not treated as a claim', () => {
  const markdown = 'See [it](https://example.com). "Too short a quote" here.';
  const res = run({ mode: 'extract', markdown });
  const out = JSON.parse(res.stdout);
  assert.equal(out.claims.length, 0);
});

test('extract: a quote more than 2 lines from any link is not attributed', () => {
  const markdown = [
    '[link](https://example.com)',
    'line two',
    'line three',
    '"This quote sits four lines away from the only link in this document"',
  ].join('\n');
  const res = run({ mode: 'extract', markdown });
  const out = JSON.parse(res.stdout);
  assert.equal(out.claims.length, 0);
});

test('extract: bare URLs are also found and deduplicated', () => {
  const markdown = 'Raw link: https://example.com/a and again https://example.com/a and new https://example.com/b';
  const res = run({ mode: 'extract', markdown });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.links.map((l) => l.url), ['https://example.com/a', 'https://example.com/b']);
});

test('match: quote present in the supplied page text is found (case/punctuation-insensitive)', () => {
  const res = run({
    mode: 'match',
    claims: [{ quote: 'The effect was significant across all cohorts tested', sourceUrl: 'https://example.com/paper' }],
    sources: { 'https://example.com/paper': '<p>The EFFECT was significant, across ALL cohorts tested, in our study.</p>' },
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results[0].found, true);
});

test('match: quote absent from the supplied page text is not found', () => {
  const res = run({
    mode: 'match',
    claims: [{ quote: 'A completely different claim never made on this page', sourceUrl: 'https://example.com/paper' }],
    sources: { 'https://example.com/paper': 'This page talks about something else entirely.' },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.results[0].found, false);
});

test('match: a claim whose sourceUrl has no matching entry in sources is not found', () => {
  const res = run({
    mode: 'match',
    claims: [{ quote: 'Some quote here', sourceUrl: 'https://example.com/missing' }],
    sources: {},
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.results[0].found, false);
});

test('rejects malformed input: missing mode', () => {
  const res = run({ markdown: 'hi' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: extract mode without markdown', () => {
  const res = run({ mode: 'extract' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('nope nope');
  assert.notEqual(res.status, 0);
});

function ok(input) {
  const res = run(input);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('extract: a markdown link URL keeps balanced parentheses (Wikipedia-style)', () => {
  const out = ok({ mode: 'extract', markdown: 'See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and [x](https://a.example/c).' });
  assert.deepEqual(out.links.map((l) => l.url), ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://a.example/c']);
});

test('match: HTML entities in page text are decoded before comparing', () => {
  const out = ok({
    mode: 'match',
    claims: [{ quote: 'we don’t know what happens next at all', sourceUrl: 'u' }],
    sources: { u: '<p>We don&#8217;t know what happens next at&nbsp;all.</p>' },
  });
  assert.equal(out.results[0].found, true);
});

test('match: quotes in non-Latin scripts are compared, not normalised away to nothing', () => {
  const out = ok({
    mode: 'match',
    claims: [{ quote: '英語のテキスト', sourceUrl: 'u' }, { quote: '日本', sourceUrl: 'u' }],
    sources: { u: '<p>英語のテキスト</p>' },
  });
  assert.deepEqual(out.results.map((r) => r.found), [true, false]);
});

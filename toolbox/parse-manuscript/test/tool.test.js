import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tool.js');

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('happy path: chapters, subtitle, scene break and italics are all parsed', () => {
  const text = [
    '# The Long Road',
    '',
    '# CHAPTER 1',
    '### First Watch',
    '',
    'The lantern swung in the dark.',
    '',
    '---',
    '',
    'A second scene begins here.',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.title, 'The Long Road');
  assert.equal(out.chapters.length, 1);
  const ch = out.chapters[0];
  assert.equal(ch.number, 1);
  assert.equal(ch.title, 'Chapter 1');
  assert.equal(ch.subtitle, 'First Watch');
  assert.equal(ch.scenes.length, 2);
  assert.equal(ch.scenes[0].paragraphs[0].spans[0].text, 'The lantern swung in the dark.');
  assert.equal(ch.scenes[1].paragraphs[0].spans[0].text, 'A second scene begins here.');
});

test('malformed input is rejected rather than guessed at', () => {
  const notJson = run('not json');
  assert.notEqual(notJson.status, 0);

  const noText = run({ nope: true });
  assert.notEqual(noText.status, 0);
  assert.match(noText.stderr, /text/);
});

test('bold text is unwrapped to plain, not marked italic', () => {
  const text = ['# CHAPTER 1', '', 'The room fell **silent** at once.'].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const spans = out.chapters[0].scenes[0].paragraphs[0].spans;
  const joined = spans.map((s) => s.text).join('');
  assert.equal(joined, 'The room fell silent at once.');
  assert.ok(spans.every((s) => s.italic === false), 'bold must never be marked italic');
});

test('single-asterisk spans are italic and independent of bold markers', () => {
  const text = ['# CHAPTER 1', '', 'She *never* looked back, not **once**.'].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const spans = out.chapters[0].scenes[0].paragraphs[0].spans;
  const italicSpans = spans.filter((s) => s.italic);
  assert.equal(italicSpans.length, 1);
  assert.equal(italicSpans[0].text, 'never');
  const plain = spans.filter((s) => !s.italic).map((s) => s.text).join('');
  assert.equal(plain, 'She  looked back, not once.');
});

test('scene breaks split scenes and PART/EPILOGUE-style heads are recognized', () => {
  const text = ['# PROLOGUE', '', 'Before it all began.', '', '# EPILOGUE', '', 'After it all ended.'].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.chapters.length, 2);
  assert.equal(out.chapters[0].title, 'Prologue');
  assert.equal(out.chapters[1].title, 'Epilogue');
});

test('chapter headings may spell out the number or use a Roman numeral', () => {
  const titles = (head) => JSON.parse(run({ text: `${head}\n\nBody text.` }).stdout).chapters.map((c) => c.title);
  assert.deepEqual(titles('# Chapter One'), ['Chapter One']);
  assert.deepEqual(titles('# Chapter Twenty-One'), ['Chapter Twenty-One']);
  assert.deepEqual(titles('# Chapter IV'), ['Chapter IV']);
  assert.deepEqual(titles('# CHAPTER xii'), ['Chapter XII']);
  // a word that merely looks Roman, or starts like a number word, is not a chapter
  assert.deepEqual(titles('# Chapter Mix'), []);
  assert.deepEqual(titles('# Chapter Onerous'), []);
});

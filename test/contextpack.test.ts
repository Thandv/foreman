import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContextPack, chapterFromTitle, outlineBeatFor, previousTail } from '../src/prose/contextPack.ts';

/**
 * An 8B cannot hold seven hundred days of timeline and two hundred proper nouns
 * across fifty-four chapters, and no LoRA fixes that: it is a weakness of
 * MEMORY, not of style. Training supplies the voice; this supplies the facts.
 *
 * `bible.ts` has carried `selectRelevant` / `orderForPrompt` / `formatEntries`
 * — a complete pick-and-format pipeline, whose own docstring calls it the token
 * saver that "keeps the prompt small instead of dumping the whole bible every
 * call" — and none of the three was ever called outside a test. The parts
 * existed; the wire did not.
 */

function withBook(files: Record<string, string>, fn: (repo: string) => void): void {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-book-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(repo, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    fn(repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const BIBLE = [
  '## Captain Pellam',
  '- always: false',
  'Commands Gannet Keep. Named Pellam in Chapter 11; never Wilmot.',
  '',
  '## Oswin',
  '- always: true',
  'POV character. Close third throughout.',
  '',
  '## Thornmere',
  '- always: false',
  'A holding of nine households on the old bed.',
].join('\n');

test('only the canon this scene touches is packed, plus what is always on', () => {
  withBook({ 'Reference/Example_Series_Bible.md': BIBLE }, (repo) => {
    const pack = buildContextPack({ repo, brief: 'Draft a scene where Captain Pellam inspects the wall.' });
    assert.match(pack.text, /Captain Pellam/);
    assert.match(pack.text, /Oswin/, 'an always-on entry rides along');
    assert.ok(!pack.text.includes('Thornmere'), 'an unmentioned entry must not be dumped into the prompt');
    assert.equal(pack.included.entries, 2);
  });
});

test('the outline beat for THIS chapter is selected, and never a neighbour’s', () => {
  const outline = [
    '## Chapter 20', 'The fort holds. Fenwick arrives.',
    '', '## Chapter 21', 'The vote is called. Keswick loses the amendment.',
    '', '## Chapter 22', 'The march begins.',
  ].join('\n');
  const beat = outlineBeatFor(outline, 21);
  assert.match(beat!, /The vote is called/);
  assert.ok(!beat!.includes('The march begins'), 'the next chapter leaked in');
  assert.ok(!beat!.includes('The fort holds'), 'the previous chapter leaked in');
  // A drafter handed the WRONG beats writes the wrong chapter, which costs far
  // more than being handed none.
  assert.equal(outlineBeatFor(outline, 99), null);
});

test('the previous chapter’s tail is handed over, with the instruction not to re-establish it', () => {
  // The standing rule: a head that back-fills means the neighbour's tail was
  // never read.
  withBook({
    'Chapters/Book_Chapter_20.md': `${'earlier text '.repeat(400)}THE FINAL LINE OF TWENTY.`,
    'Reference/Book_Outline.md': '## Chapter 21\nThe vote is called.',
  }, (repo) => {
    const tail = previousTail(repo, 21, 200);
    assert.match(tail!.text, /THE FINAL LINE OF TWENTY/);
    assert.ok(tail!.text.length <= 200);

    const pack = buildContextPack({ repo, brief: 'Draft Chapter 21', chapter: 21 });
    assert.match(pack.text, /THE FINAL LINE OF TWENTY/);
    assert.match(pack.text, /must ANSWER this, not re-establish it/);
    assert.equal(pack.included.tailFrom, 'Book_Chapter_20.md');
    assert.equal(pack.included.outlineBeat, true);
  });
});

test('every pack ends with the rule that an unsourced fact is a query, not an invention', () => {
  withBook({ 'Reference/Example_Series_Bible.md': BIBLE }, (repo) => {
    const pack = buildContextPack({ repo, brief: 'Oswin counts the wagons.' });
    assert.match(pack.text, /marked author query rather than invented/);
    assert.match(pack.text, /a confident guess/);
  });
});

test('a workspace with no canon yields an empty pack rather than an error', () => {
  // A repo without a bible is a normal repo; a drafting ticket in one must not
  // fail for want of canon it never had.
  withBook({ 'README.md': 'not a book' }, (repo) => {
    const pack = buildContextPack({ repo, brief: 'do something' });
    assert.equal(pack.text, '');
    assert.equal(pack.bytes, 0);
    assert.equal(pack.included.entries, 0);
  });
});

test('the pack reports what went into it', () => {
  // A pack nobody can audit is a liability: when a draft invents a name, the
  // first question is whether it was ever told the right one.
  withBook({ 'STYLE_SHEET.md': BIBLE }, (repo) => {
    const pack = buildContextPack({ repo, brief: 'Captain Pellam walks the wall.' });
    assert.equal(pack.included.styleSheet, true);
    assert.ok(pack.bytes > 0);
  });
});

test('chapter numbers are read off the usual ticket titles', () => {
  assert.equal(chapterFromTitle('Draft Chapter 21'), 21);
  assert.equal(chapterFromTitle('Read-through fixes: Chapter 07'), 7);
  assert.equal(chapterFromTitle('Ch21 numeral sweep'), 21);
  assert.equal(chapterFromTitle('Write the canon pack'), null, 'no number is null, never a guess');
});

// ------------------------------------------------- retrieval, the other way round

test('a common name does not outrank a selective one', async () => {
  // The first cut scored raw hits and returned the Book Two and Book Four
  // summaries for a later-book scene — long sections that say "Oswin" a lot —
  // while the canon that governed the scene ranked below them. A protagonist
  // named in almost every section carries nearly no information; a name in
  // three sections is a pointer.
  const { selectByMentionedNames } = await import('../src/prose/contextPack.ts');
  const entries = [
    // Says the common name many times, says nothing about Keswick.
    { name: 'Book Two summary', aliases: [], category: 'b', body: `${'Oswin '.repeat(200)}`, always: false },
    { name: 'Book Three summary', aliases: [], category: 'b', body: `${'Oswin '.repeat(200)}`, always: false },
    { name: 'Book Four summary', aliases: [], category: 'b', body: `${'Oswin '.repeat(200)}`, always: false },
    // Short, and the only thing that knows who Keswick is.
    { name: 'Sergeant Odette Keswick', aliases: [], category: 'b', body: 'Keswick commands the reserve. Oswin trusts her.', always: false },
  ];
  const picked = selectByMentionedNames(entries, 'Oswin and Keswick at the vote', 2);
  assert.equal(picked[0]!.name, 'Sergeant Odette Keswick', 'the selective name must lead');
});

test('the pack is bounded by bytes, not only by entry count', async () => {
  // Twelve entries of a real series bible came to 12,681 tokens, which is not a
  // context pack — it is the whole bible again.
  const { selectByMentionedNames } = await import('../src/prose/contextPack.ts');
  const entries = Array.from({ length: 30 }, (_, i) => ({
    name: `Section ${i}`, aliases: [], category: 'b',
    body: `Keswick appears here. ${'filler '.repeat(500)}`, always: false,
  }));
  const picked = selectByMentionedNames(entries, 'Keswick', 24, 6000);
  const bytes = picked.reduce((n, e) => n + e.name.length + e.body.length, 0);
  assert.ok(bytes <= 6000, `byte cap must bind, got ${bytes}`);
  assert.ok(picked.length < 24, 'the byte cap bit before the count cap');
});

test('a brief with no proper nouns retrieves nothing rather than everything', async () => {
  const { selectByMentionedNames } = await import('../src/prose/contextPack.ts');
  const entries = [{ name: 'x', aliases: [], category: 'b', body: 'Keswick is here', always: false }];
  assert.deepEqual(selectByMentionedNames(entries, 'write the next bit of it', 5), []);
});

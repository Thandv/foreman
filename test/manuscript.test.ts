import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFromManuscript, proseOf, splitPassages } from '../src/align/manuscript.ts';

/**
 * The failure this module was written for, kept in front of the tests:
 * `publishing.author` was trained on 108 session summaries — completions like
 * "Chapter 7 is drafted at Chapters/…, 3,872 words" — and then failed a prose
 * A/B 0W 0L 8T against an Opus judge. It had never been shown a sentence of the
 * book. So every case here is about one question: does a sample teach the model
 * to WRITE THE PROSE, or something adjacent to it?
 */

function withChapters(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ms-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const para = (n: number, word = 'word'): string => Array.from({ length: n }, () => word).join(' ');

test('passages break at paragraph boundaries, never mid-paragraph', () => {
  // A sample that starts halfway through a sentence teaches the model to start
  // halfway through a sentence.
  const text = [para(120), para(120), para(120)].join('\n\n');
  const passages = splitPassages(text, 60);
  assert.ok(passages.length > 1, 'this should have split');
  for (const p of passages) {
    for (const chunk of p.split('\n\n')) {
      assert.equal(chunk.trim(), para(120), 'a paragraph was cut in half');
    }
  }
});

test('a single oversized paragraph becomes its own passage rather than being split', () => {
  const passages = splitPassages(para(2000), 60);
  assert.equal(passages.length, 1, 'better one long sample than two broken ones');
});

test('nothing is lost across the split', () => {
  const paragraphs = [para(40, 'alpha'), para(40, 'beta'), para(40, 'gamma')];
  const joined = splitPassages(paragraphs.join('\n\n'), 30).join('\n\n');
  for (const p of paragraphs) assert.ok(joined.includes(p));
});

test('scaffolding is stripped: front matter, headings, author queries', () => {
  const raw = [
    '---',
    'title: Chapter 7',
    '---',
    '# Chapter Seven',
    '',
    'Oswin counted the wagons.',
    '',
    '## Scene 2',
    '',
    '[[AUTHOR QUERY: is the keep named Redstone or Gannet?]]',
    '',
    'The clerk kept writing.',
  ].join('\n');
  const prose = proseOf(raw);
  assert.ok(prose.includes('Oswin counted the wagons.'));
  assert.ok(prose.includes('The clerk kept writing.'));
  // A heading left in teaches the model to emit headings mid-scene; a query
  // left in teaches it to stop and ask questions mid-chapter.
  assert.ok(!prose.includes('#'), 'headings survived');
  assert.ok(!/AUTHOR QUERY/i.test(prose), 'an author query survived');
  assert.ok(!prose.includes('title:'), 'front matter survived');
});

test('every sample teaches writing prose, not reporting on it', () => {
  // The regression that matters. If a completion ever becomes a summary again,
  // this is what should fail.
  withChapters({
    'ch01.md': `# One\n\n${para(150, 'alpha')}\n\n${para(150, 'beta')}\n\n${para(150, 'gamma')}`,
  }, (dir) => {
    const { rows } = buildFromManuscript({ dir, passageTokens: 50 });
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      // A completion is book text, so it is made of the words the chapter is
      // made of — never a path, a word count, or a description of an edit.
      assert.ok(/alpha|beta|gamma/.test(row.completion), `completion was not prose: ${row.completion.slice(0, 80)}`);
      assert.ok(!/\.md\b/.test(row.completion), 'a completion named a file');
      assert.ok(!/\bwords\b/i.test(row.completion), 'a completion reported a word count');
    }
  });
});

test('the first sample of a chapter teaches how to OPEN one', () => {
  // Only as many openings as chapters, and a continuation pair never
  // demonstrates one — but starting a chapter is the hardest part of the job.
  withChapters({
    'ch01.md': `${para(150, 'alpha')}\n\n${para(150, 'beta')}`,
  }, (dir) => {
    const { rows } = buildFromManuscript({ dir, passageTokens: 50 });
    assert.match(rows[0]!.prompt, /opening/i);
    assert.ok(!rows[0]!.prompt.includes('alpha'), 'an opening prompt must not contain the text it asks for');
    assert.ok(rows[0]!.completion.includes('alpha'));
  });
});

test('a continuation prompt carries the preceding passage and asks for the next', () => {
  withChapters({
    'ch01.md': `${para(150, 'alpha')}\n\n${para(150, 'beta')}`,
  }, (dir) => {
    const { rows } = buildFromManuscript({ dir, passageTokens: 50 });
    const cont = rows[1]!;
    assert.match(cont.prompt, /continue/i);
    assert.ok(cont.prompt.includes('alpha'), 'the preceding passage is the context');
    assert.ok(cont.completion.includes('beta'));
    assert.ok(!cont.completion.includes('alpha'), 'the model must not be taught to repeat its context');
  });
});

test('the style note rides on every prompt and never on a completion', () => {
  withChapters({
    'ch01.md': `${para(150, 'alpha')}\n\n${para(150, 'beta')}`,
  }, (dir) => {
    const { rows } = buildFromManuscript({ dir, passageTokens: 50, styleNote: 'STYLE: close third, no head-hopping.' });
    for (const row of rows) {
      assert.ok(row.prompt.includes('STYLE: close third'));
      assert.ok(!row.completion.includes('STYLE:'), 'the style note leaked into a training target');
    }
  });
});

test('a chapter with nothing to learn from is skipped and named', () => {
  withChapters({
    'empty.md': '# Only a heading\n',
    'ch01.md': `${para(150, 'alpha')}\n\n${para(150, 'beta')}`,
  }, (dir) => {
    const report = buildFromManuscript({ dir, passageTokens: 50 });
    assert.deepEqual(report.skipped, ['empty.md']);
    assert.equal(report.filesRead, 2);
    assert.ok(report.rows.length > 0, 'the good chapter still produced samples');
  });
});

test('chapters are read in order, so a corpus is reproducible', () => {
  withChapters({
    'ch02.md': `${para(150, 'beta')}\n\n${para(150, 'beta2')}`,
    'ch01.md': `${para(150, 'alpha')}\n\n${para(150, 'alpha2')}`,
  }, (dir) => {
    const a = buildFromManuscript({ dir, passageTokens: 50 });
    const b = buildFromManuscript({ dir, passageTokens: 50 });
    assert.deepEqual(a.rows, b.rows);
    assert.ok(a.rows[0]!.completion.includes('alpha'), 'ch01 should come first');
  });
});

test('a missing directory reports empty rather than throwing', () => {
  const report = buildFromManuscript({ dir: path.join(os.tmpdir(), 'fm-does-not-exist-ever') });
  assert.deepEqual(report.rows, []);
  assert.equal(report.filesRead, 0);
});

// ------------------------------------------------------ the tic gate as a filter

/** A stand-in scanner: flags the word "began to" as a pattern tic. */
const stubScan = (t: string): Array<{ kind: string }> =>
  (t.includes('began to') ? [{ kind: 'pattern' }] : [])
    .concat(t.includes('LONGWINDED') ? [{ kind: 'density' }] : []);

test('a passage carrying a hard tic is never shown to the model', async () => {
  // mlx-lm here has no DPO, so a bad habit cannot be trained against — the
  // only way to unlearn one is never to show it. The tic gate already knows,
  // deterministically and free, what the machine tells in this prose are.
  const { passageIsClean } = await import('../src/align/manuscript.ts');
  assert.equal(passageIsClean('he began to walk', stubScan), false);
  assert.equal(passageIsClean('he walked', stubScan), true);
});

test('density findings do not disqualify a passage', async () => {
  // Cadence evenness, em-dashes per thousand words and "because" chains are
  // measured over a CHAPTER. Over a 700-character passage they fire on 49% of
  // the corpus against 8% for the per-instance tells — excluding them would
  // drop half the training data for statistical noise rather than any defect.
  const { passageIsClean } = await import('../src/align/manuscript.ts');
  assert.equal(passageIsClean('LONGWINDED but otherwise fine', stubScan), true);
});

test('the filter judges the completion, never the context it continues from', () => {
  // A tic in the text a model is asked to continue FROM is a fact about the
  // book. A tic in the text it is asked to PRODUCE is the thing being taught.
  const dirty = `${para(150, 'began')} began to ${para(20, 'x')}`;
  const cleanText = para(150, 'clean');
  withChapters({ 'ch01.md': `${dirty}\n\n${cleanText}` }, (dir) => {
    const report = buildFromManuscript({ dir, passageTokens: 400, ticScan: stubScan });
    // The opening passage is dirty and withheld; the second is clean and kept,
    // even though its PROMPT quotes the dirty passage as context.
    assert.equal(report.ticDropped, 1);
    assert.equal(report.rows.length, 1);
    assert.ok(report.rows[0]!.completion.includes('clean'));
    assert.ok(report.rows[0]!.prompt.includes('began to'), 'the dirty text is still legitimate context');
  });
});

test('without a scanner nothing is withheld — the filter is opt-out, not implicit', () => {
  withChapters({ 'ch01.md': `${para(150, 'a')} began to walk\n\n${para(150, 'b')}` }, (dir) => {
    const report = buildFromManuscript({ dir, passageTokens: 400 });
    assert.equal(report.ticDropped, 0);
  });
});

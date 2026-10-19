import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');
const call = (input) => {
  const res = spawnSync(process.execPath, [TOOL], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

const mk = (n, title, body) => ({ path: `ch${n}.md`, text: `# Chapter ${n}\n\n## ${title}\n\n${body}` });

test('sequential chapters with unique titles pass', () => {
  const out = call({ chapters: [mk(1, 'A', 'Oswin walked. Then Oswin ran.'), mk(2, 'B', 'Oswin slept.')], expectedCount: 2 });
  assert.equal(out.sequenceIssues.length, 0);
  assert.equal(out.titleIssues.length, 0);
});

test('spelled ordinal headings parse; gaps and duplicate titles are flagged', () => {
  const out = call({ chapters: [
    { path: 'a.md', text: '# Chapter One\n\n## Same\n\nx' },
    { path: 'b.md', text: '# Chapter Twenty-Three\n\n## Same\n\nx' },
  ] });
  assert.ok(out.sequenceIssues.some((i) => /chapter 23, position says 2/.test(i.issue)));
  assert.ok(out.titleIssues.some((i) => /duplicate title/.test(i.issue)));
});

test('a rare near-miss of a frequent name is flagged as a variant', () => {
  const body1 = Array(8).fill('Then Pendry gave the order.').join(' ');
  const out = call({ chapters: [mk(1, 'A', body1), mk(2, 'B', 'At dawn Pendrey gave the order again.')], minNameFreq: 5 });
  assert.ok(out.nameVariants.some((v) => v.rare === 'Pendrey' && v.similarTo === 'Pendry'));
});

test('spelling variant pairs present in both forms are tallied', () => {
  const out = call({ chapters: [mk(1, 'A', 'The grey wall stood toward the sea.'), mk(2, 'B', 'A gray wall leaned towards the road.')] });
  assert.ok(out.spellingVariants.some((v) => v.variantA === 'grey' && v.countA === 1 && v.countB === 1));
  assert.ok(out.spellingVariants.some((v) => v.variantA === 'toward'));
});

test('a chapter that opens a Part is numbered by its own heading, not the Part title', () => {
  // The locked outline puts Part III at Chapter 15, so that file legitimately
  // begins "# Part III — Power Under Review" and only then "# Chapter 15".
  // Reading the first heading reported a correct chapter as unnumbered.
  const out = call({
    chapters: [
      { path: 'ch01.md', text: '# Chapter 1\n\n## Lower Ash\n\nThe trestle held.' },
      {
        path: 'ch02.md',
        text: '# Part III — Power Under Review\n\n*Forty. The third campaign spring.*\n\n# Chapter 2\n\n## The Theater Line\n\nEleven feet of turf.',
      },
    ],
  });
  assert.deepEqual(out.sequenceIssues, []);
  assert.deepEqual(out.titleIssues, []);
});

test('chapter numbers parse from Roman numerals, sixty-plus number words, and a word followed by a title', () => {
  const heads = ['# Chapter I', '# Chapter II', '# Chapter Three The Ford', '# Chapter iv', '# Chapter V: Ash'];
  const out = call({ chapters: heads.map((h, i) => ({ path: `c${i}.md`, text: `${h}\n## Title ${i}\nbody` })) });
  assert.deepEqual(out.sequenceIssues, []);
  const late = call({ chapters: [{ path: 'x.md', text: '# Chapter Sixty-Two\n## T\nbody' }] });
  assert.match(late.sequenceIssues[0].issue, /heading says chapter 62/);
  const mixed = call({ chapters: [{ path: 'x.md', text: '# Chapter Mix\n## T\nbody' }] });
  assert.match(mixed.sequenceIssues[0].issue, /no parseable chapter number/);
});

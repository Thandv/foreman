import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tool.js');
const call = (input) => {
  const res = spawnSync(process.execPath, [TOOL], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

test('it finds the numeral a chapter leans on', () => {
  const out = call({
    chapters: [{
      path: 'ch13.md',
      text: 'Eleven crates on the dock at eleven coins apiece, eleven blocks to the station, '
        + 'and eleven days of rain in the forecast. Four trucks went the other way.',
    }],
  });
  const top = out.perChapter[0].top[0];
  assert.equal(top.numeral, 'eleven');
  assert.equal(top.count, 4);
  assert.ok(top.per1000 > 0);
  assert.equal(out.worstChapters[0].path, 'ch13.md');
});

test('a compound is its own number, not its parts', () => {
  // "forty-one" is what a reader hears; counting it as a forty beside a one
  // would both invent a forty and inflate the units.
  const out = call({ chapters: [{ path: 'a.md', text: 'Forty-one households, and forty-one again.' }] });
  const counts = Object.fromEntries(out.perChapter[0].top.map((t) => [t.numeral, t.count]));
  assert.equal(counts['forty-one'], 2);
  assert.equal(counts.forty, undefined);
  assert.equal(counts.four, undefined);
});

test('"one" is not counted, because it is usually a pronoun', () => {
  const out = call({
    chapters: [{ path: 'a.md', text: 'One of them spoke. The one with the dog. No one moved.' }],
  });
  assert.deepEqual(out.perChapter[0].top, [], 'grammar is not arithmetic');
});

test('the rate is per thousand words, so length alone is not a finding', () => {
  const filler = 'the queue moved and the clerk wrote it down again '.repeat(200); // ~1,800 words
  const out = call({
    chapters: [
      { path: 'short.md', text: 'Eleven wagons and eleven teams.' },
      { path: 'long.md', text: `${filler} eleven wagons and eleven teams.` },
    ],
  });
  const short = out.perChapter[0].top[0];
  const long = out.perChapter[1].top[0];
  assert.equal(short.count, long.count, 'the same two uses');
  assert.ok(short.per1000 > long.per1000, 'but the short chapter leans on it far harder');
  assert.equal(out.worstChapters.length, 1, 'and only the short one is worth sweeping');
  assert.equal(out.worstChapters[0].path, 'short.md');
});

test('it totals across the book, and reports each chapter separately', () => {
  const out = call({
    chapters: [
      { path: 'a.md', text: 'Eleven wagons. Nineteen men.' },
      { path: 'b.md', text: 'Eleven barrels. Thirty-one carts.' },
    ],
  });
  assert.equal(out.chapters, 2);
  const overall = Object.fromEntries(out.overall.map((o) => [o.numeral, o.count]));
  assert.equal(overall.eleven, 2, 'summed across chapters');
  assert.equal(overall.nineteen, 1);
  assert.equal(overall['thirty-one'], 1);
  assert.equal(out.perChapter.length, 2);
});

test('malformed input is refused, not guessed at', () => {
  for (const bad of ['not json', JSON.stringify({}), JSON.stringify({ chapters: 'nope' })]) {
    const res = spawnSync(process.execPath, [TOOL], { input: bad, encoding: 'utf8' });
    assert.equal(res.status, 2, `should have refused: ${bad}`);
  }
});

test('a book with no spelled numbers reports nothing rather than failing', () => {
  const out = call({ chapters: [{ path: 'a.md', text: 'The bar came down at dawn.' }] });
  assert.deepEqual(out.perChapter[0].top, []);
  assert.deepEqual(out.worstChapters, []);
  assert.deepEqual(out.overall, []);
});

test('scale words are not the tic: "hundred" is how a number is spelled, not one that was picked', () => {
  // On a real manuscript "hundred" topped every chapter — "four hundred",
  // "eleven hundred" — and buried the number the writer was actually reaching
  // for. It stays in the overall tally and out of the leaning ranking.
  const out = call({
    chapters: [{
      path: 'a.md',
      text: 'Four hundred wagons, eleven hundred bushels, and nine hundred paces. Eleven men held it.',
    }],
  });
  const top = out.perChapter[0].top.map((t) => t.numeral);
  assert.ok(!top.includes('hundred'), 'the multiplier is not a finding');
  assert.equal(top[0], 'eleven', 'the number actually leaned on surfaces');

  const overall = Object.fromEntries(out.overall.map((o) => [o.numeral, o.count]));
  assert.equal(overall.hundred, 3, 'but the overall tally stays honest about it');
});

test('concentration says how much of the counting one number does', () => {
  const oneWell = call({
    chapters: [{ path: 'a.md', text: 'Eleven, eleven, eleven, and eleven again. Four.' }],
  });
  const spread = call({
    chapters: [{ path: 'b.md', text: 'Two carts, three men, seven miles, twelve days, forty barrels.' }],
  });
  assert.ok(oneWell.perChapter[0].concentration > 0.7, 'nearly every figure from one well');
  assert.ok(spread.perChapter[0].concentration < 0.4, 'a chapter that counts things separately');
});

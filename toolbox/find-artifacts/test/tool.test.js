import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tool.js');

function run(input) {
  const res = spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return res;
}

test('happy path: flags a nearby exact duplicate and an unbalanced-asterisk line', () => {
  const text = [
    'The lantern swung wildly in the wind that night.',
    'The lantern swung wildly in the wind that night.',
    'She *never went back inside the house again',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.paragraphs, 3);
  const kinds = out.candidates.map((c) => c.kind);
  assert.ok(kinds.includes('exact-duplicate'));
  assert.ok(kinds.includes('truncation-or-unbalanced'));
  const dup = out.candidates.find((c) => c.kind === 'exact-duplicate');
  assert.equal(dup.detail.tag, 'likely-artifact');
  assert.deepEqual(dup.detail.lines, [1, 2]);
});

test('malformed input is rejected rather than guessed at', () => {
  const notJson = run('not json at all');
  assert.notEqual(notJson.status, 0);
  assert.match(notJson.stderr, /JSON/);

  const missingText = run({ oops: true });
  assert.notEqual(missingText.status, 0);
  assert.match(missingText.stderr, /text/);
});

test('a short refrain repeated far apart is spared, not flagged', () => {
  const filler = Array.from({ length: 6 }, (_, i) => `Unrelated filler sentence number ${i} goes here today.`);
  const lines = ['Bells rang across the valley.', ...filler, 'Bells rang across the valley.'];
  const res = run({ text: lines.join('\n') });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const flaggedRefrain = out.candidates.some(
    (c) => c.kind === 'exact-duplicate' && c.snippet.startsWith('Bells rang'),
  );
  assert.equal(flaggedRefrain, false, 'a short far-apart refrain must not be reported as a candidate');
});

test('near-duplicate detection catches a variant draft passage pasted back in', () => {
  const a = 'The old bridge creaked under the weight of every careful footstep they took.';
  const b = 'The old bridge groaned under the weight of every careful footstep they took.';
  const res = run({ text: `${a}\n${b}\n` });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const near = out.candidates.find((c) => c.kind === 'near-duplicate');
  assert.ok(near, 'expected a near-duplicate candidate');
  assert.ok(near.detail.similarity >= 0.82);
});

test('paragraphs in non-Latin scripts are checked, and curly vs straight apostrophes count as the same text', () => {
  const ru = 'Он вошёл в комнату и сел у окна, глядя на дождь.';
  const text = [ru, '', ru, '', 'She didn’t look back at the house on the hill.', "She didn't look back at the house on the hill.", ''].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.paragraphs, 4);
  const dups = out.candidates.filter((c) => c.kind === 'exact-duplicate').map((c) => c.detail.lines);
  assert.deepEqual(dups.sort((a, b) => a[0] - b[0]), [[1, 3], [5, 6]]);
});

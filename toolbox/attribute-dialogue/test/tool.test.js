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

test('happy path: explicit tags attribute both speakers and populate the cast', () => {
  const text = [
    '# CHAPTER 1',
    '',
    '"Are you ready?" Halvard asked.',
    '',
    '"I am," Ysolde replied.',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.speakers, ['Halvard', 'Ysolde']);
  const dialogue = out.lines.filter((l) => l.confidence === 'explicit');
  assert.equal(dialogue.length, 2);
  assert.equal(dialogue[0].speaker, 'Halvard');
  assert.equal(dialogue[0].text, 'Are you ready?');
  assert.equal(dialogue[1].speaker, 'Ysolde');
  const narration = out.lines.filter((l) => l.confidence === 'narrator');
  assert.ok(narration.every((l) => l.speaker === 'NARRATOR'));
});

test('malformed input is rejected rather than guessed at', () => {
  const notJson = run('nope');
  assert.notEqual(notJson.status, 0);

  const noText = run({ nope: true });
  assert.notEqual(noText.status, 0);
  assert.match(noText.stderr, /text/);
});

test('alternation window: unattributed back-and-forth lines alternate between the two known speakers', () => {
  const text = [
    '# CHAPTER 1',
    '',
    '"Are you ready?" Halvard asked.',
    '',
    '"I am," Ysolde replied.',
    '',
    '"Then let us go."',
    '',
    '"Right behind you."',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const dialogueLines = out.lines.filter((l) => l.text.length && l.speaker !== 'NARRATOR');
  const byText = Object.fromEntries(dialogueLines.map((l) => [l.text, l]));
  assert.equal(byText['Then let us go.'].speaker, 'Halvard');
  assert.equal(byText['Then let us go.'].confidence, 'alternation');
  assert.equal(byText['Right behind you.'].speaker, 'Ysolde');
  assert.equal(byText['Right behind you.'].confidence, 'alternation');
});

test('a scene break resets alternation state', () => {
  const text = [
    '# CHAPTER 1',
    '',
    '"Are you ready?" Halvard asked.',
    '',
    '"I am," Ysolde replied.',
    '',
    '---',
    '',
    '"Where did everyone go?"',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const afterBreak = out.lines.find((l) => l.text === 'Where did everyone go?');
  // No named speaker yet in the new scene: falls through to NARRATOR, not
  // an alternation guess carried over from the previous scene.
  assert.equal(afterBreak.speaker, 'NARRATOR');
  assert.equal(afterBreak.confidence, 'narrator');
  assert.equal(afterBreak.scene, 2);
});

test('carry-forward: a mixed narration+dialogue line with no tag keeps the last named speaker', () => {
  // Alternation only fires for a paragraph that is PURE dialogue (see
  // tool.js). A paragraph that mixes narration and an untagged quote in the
  // same paragraph instead falls through to carrying the last speaker
  // forward — this is the case that exercises the "carry" confidence level.
  const text = [
    '# CHAPTER 1',
    '',
    '"I found it," Halvard said.',
    '',
    'He held it up to the light. "It was under the floorboards the whole time."',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const carried = out.lines.find((l) => l.text === 'It was under the floorboards the whole time.');
  assert.equal(carried.speaker, 'Halvard');
  assert.equal(carried.confidence, 'carry');
});

test('one known speaker: an untagged pure-dialogue reply alternates to the unnamed counterpart', () => {
  // With exactly one named speaker in the scene, the alternation partner is
  // not yet known by name — the original ported algorithm marks it with the
  // literal placeholder speaker "_OTHER" rather than guessing a name.
  const text = [
    '# CHAPTER 1',
    '',
    '"I found it," Halvard said.',
    '',
    'He held it up to the light.',
    '',
    '"It was under the floorboards the whole time."',
  ].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const line = out.lines.find((l) => l.text === 'It was under the floorboards the whole time.');
  assert.equal(line.speaker, '_OTHER');
  assert.equal(line.confidence, 'alternation');
});

test('spelled-out and Roman-numeral chapter headings are recognised (in step with parse-manuscript)', () => {
  const text = ['# Chapter One', '', '"Hello," Tom said.', '', '# Chapter IV', '', '"Again," Tom said.', '', '# Chapter Mix', '', '"Lost," Tom said.'].join('\n');
  const res = run({ text });
  assert.equal(res.status, 0, res.stderr);
  const { lines } = JSON.parse(res.stdout);
  const dialogue = lines.filter((l) => l.speaker === 'Tom').map((l) => [l.chapter, l.text]);
  // "# Chapter Mix" is not a chapter heading, so its line folds into chapter 2
  assert.deepEqual(dialogue, [[1, 'Hello,'], [2, 'Again,'], [2, 'Lost,']]);
});

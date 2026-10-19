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

test('hard bans are severity ban', () => {
  const out = call({ text: 'It was not just a door, but a promise. No light. No sound. No mercy.' });
  const bans = out.findings.filter((f) => f.severity === 'ban').map((f) => f.rule);
  assert.ok(bans.includes('contrast-formula'));
  assert.ok(bans.includes('negation-catalogue'));
});

test('the contrast formula is banned in its spelled-out forms too', () => {
  // "it was not X; it was Y" is the same tic as "it wasn't X, it was Y" — the
  // gate used to catch only the contraction, so a chapter could pass here and
  // still fail Foreman's own prose audit, which never made that distinction.
  for (const text of [
    'It was not a delay; it was the pause before the gate opened.',
    "It wasn't a warning, it was an invoice.",
    'It is not a rule, it is a habit with a seal on it.',
  ]) {
    const bans = call({ text }).findings.filter((f) => f.severity === 'ban').map((f) => f.rule);
    assert.ok(bans.includes('contrast-formula'), text);
  }
});

test('crutches and stock reactions are severity review', () => {
  const out = call({ text: 'She paused as if listening. His jaw clenched. For a moment nothing moved.' });
  const rules = out.findings.map((f) => `${f.severity}:${f.rule}`);
  assert.ok(rules.includes('review:as-if-though'));
  assert.ok(rules.includes('review:stock-reaction'));
  assert.ok(rules.includes('review:for-a-moment'));
});

test('System readout lines carry formatException', () => {
  const out = call({ text: '**CANDIDATE STATUS: No path. No mantle. No mercy.**' });
  assert.ok(out.findings.length > 0);
  assert.ok(out.findings.every((f) => f.formatException === true));
});

test('clean prose produces no ban findings and sane cadence', () => {
  const out = call({ text: 'Rain fell on the road. Oswin counted wagons until the count stopped mattering, then he walked down to the ford and put his hands in the cold water.' });
  assert.equal(out.findings.filter((f) => f.severity === 'ban').length, 0);
  assert.ok(out.cadence.sentences >= 2);
  assert.ok(out.density.words > 20);
});

test('coordination chain flagged only on long and-heavy sentences', () => {
  const out = call({ text: 'He took the rope and the lamp and the bread and the last of the wire down the long stair to the flooded cellar door.' });
  assert.ok(out.findings.some((f) => f.rule === 'coordination-chain'));
});

test('typographic (curly) apostrophes trip the same rules as straight ones', () => {
  for (const apos of ["'", '’']) {
    const rules = call({ text: `It wasn${apos}t a war, it was a ledger. She let out a breath she didn${apos}t know she held. Here${apos}s the thing.` })
      .findings.map((f) => f.rule);
    assert.ok(rules.includes('contrast-formula'), `${apos}: ${rules}`);
    assert.ok(rules.includes('stock-reaction'), `${apos}: ${rules}`);
    assert.ok(rules.includes('false-suspense'), `${apos}: ${rules}`);
  }
});

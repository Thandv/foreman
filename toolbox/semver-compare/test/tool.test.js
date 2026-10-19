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

function cmp(a, b) {
  const res = run({ mode: 'compare', a, b });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).result;
}

function sat(version, range) {
  const res = run({ mode: 'satisfies', version, range });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).satisfies;
}

test('basic core comparison', () => {
  assert.equal(cmp('1.2.3', '1.2.4'), -1);
  assert.equal(cmp('2.0.0', '1.9.9'), 1);
  assert.equal(cmp('1.2.3', '1.2.3'), 0);
});

test('prerelease ordering chain: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0', () => {
  assert.equal(cmp('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(cmp('1.0.0-alpha.1', '1.0.0-beta'), -1);
  assert.equal(cmp('1.0.0-beta', '1.0.0'), -1);
  // and the reverse direction
  assert.equal(cmp('1.0.0', '1.0.0-beta'), 1);
});

test('numeric prerelease identifiers compare numerically, not lexically', () => {
  assert.equal(cmp('1.0.0-alpha.2', '1.0.0-alpha.10'), -1); // not "10" < "2" lexically
});

test('build metadata is ignored for precedence', () => {
  assert.equal(cmp('1.2.3+build1', '1.2.3+build2'), 0);
});

test('satisfies: caret range on a 1.x version', () => {
  assert.equal(sat('1.2.3', '^1.2.0'), true);
  assert.equal(sat('2.0.0', '^1.2.0'), false);
  assert.equal(sat('1.1.9', '^1.2.0'), false);
});

test('satisfies: ^0.x behaves like a tighter tilde (minor pinned)', () => {
  assert.equal(sat('0.2.3', '^0.2.0'), true);
  assert.equal(sat('0.3.0', '^0.2.0'), false); // minor bump breaks ^0.x
  assert.equal(sat('0.2.9', '^0.2.3'), true);
  assert.equal(sat('0.0.4', '^0.0.3'), false); // ^0.0.x pins the patch too
  assert.equal(sat('0.0.3', '^0.0.3'), true);
});

test('satisfies: tilde range pins minor', () => {
  assert.equal(sat('1.2.9', '~1.2.3'), true);
  assert.equal(sat('1.3.0', '~1.2.3'), false);
});

test('satisfies: x-wildcards', () => {
  assert.equal(sat('1.2.3', '1.2.x'), true);
  assert.equal(sat('1.3.0', '1.2.x'), false);
  assert.equal(sat('5.9.9', '5.x'), true);
});

test('satisfies: range with || alternatives', () => {
  assert.equal(sat('1.5.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(sat('2.5.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(sat('3.0.0', '^1.0.0 || ^2.0.0'), false);
});

test('satisfies: comparator range with an AND of >= and <', () => {
  assert.equal(sat('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(sat('2.0.0', '>=1.0.0 <2.0.0'), false);
});

test('satisfies: a prerelease version only matches a range that names its own prerelease', () => {
  assert.equal(sat('1.0.0-alpha', '>=1.0.0'), false);
  assert.equal(sat('1.0.0-alpha', '>=1.0.0-alpha <1.0.0'), true);
});

test('rejects malformed input: bad mode', () => {
  const res = run({ mode: 'nope' });
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

test('rejects an invalid version string', () => {
  const res = run({ mode: 'compare', a: 'not-a-version', b: '1.0.0' });
  assert.notEqual(res.status, 0);
});

// --- fix: whitespace after a range operator -------------------------------

test('satisfies: whitespace after a comparator operator is accepted, same as no whitespace', () => {
  assert.equal(sat('1.2.3', '>= 1.2.0'), true);
  assert.equal(sat('1.1.9', '>= 1.2.0'), false);
  assert.equal(sat('1.5.0', '>=  1.0.0   <2.0.0'), true); // multiple spaces, both operators
  assert.equal(sat('2.0.0', '>= 1.0.0 < 2.0.0'), false);
});

// --- fix: hyphen ranges ------------------------------------------------

test('satisfies: a full hyphen range is inclusive on both ends', () => {
  assert.equal(sat('1.2.3', '1.2.3 - 2.0.0'), true);
  assert.equal(sat('2.0.0', '1.2.3 - 2.0.0'), true); // inclusive upper bound
  assert.equal(sat('1.2.2', '1.2.3 - 2.0.0'), false);
  assert.equal(sat('2.0.1', '1.2.3 - 2.0.0'), false);
});

test('satisfies: a hyphen range with a partial right side promotes to an exclusive upper bound', () => {
  // "1.2.3 - 2.3" means >=1.2.3 <2.4.0 (partial right -> bump the next part up, exclusive)
  assert.equal(sat('2.3.9', '1.2.3 - 2.3'), true);
  assert.equal(sat('2.4.0', '1.2.3 - 2.3'), false);
  // "1.2.3 - 2" means >=1.2.3 <3.0.0
  assert.equal(sat('2.9.9', '1.2.3 - 2'), true);
  assert.equal(sat('3.0.0', '1.2.3 - 2'), false);
});

test('satisfies: a hyphen range with a partial left side defaults missing parts to 0', () => {
  // "1.2 - 2.3.4" means >=1.2.0 <=2.3.4
  assert.equal(sat('1.2.0', '1.2 - 2.3.4'), true);
  assert.equal(sat('1.1.9', '1.2 - 2.3.4'), false);
  assert.equal(sat('2.3.4', '1.2 - 2.3.4'), true);
});

test('a prerelease hyphen (attached directly, no surrounding spaces) is NOT mistaken for a hyphen range', () => {
  assert.equal(sat('1.0.0-alpha', '>=1.0.0-alpha <2.0.0'), true);
  assert.equal(sat('1.0.0-alpha', '1.0.0-alpha'), true);
});

// --- fix: leading-zero numeric prerelease identifiers are invalid ---------

test('rejects a leading-zero numeric prerelease identifier ("1.0.0-01")', () => {
  const res = run({ mode: 'compare', a: '1.0.0-01', b: '1.0.0-1' });
  assert.notEqual(res.status, 0);
});

test('accepts a bare "0" prerelease identifier and non-numeric identifiers with leading digits+zero shape', () => {
  assert.equal(cmp('1.0.0-0', '1.0.0-1'), -1); // "0" alone is a valid numeric identifier
  assert.equal(cmp('1.0.0-0alpha', '1.0.0-0beta'), -1); // not purely numeric, leading zero rule doesn't apply
});

// node-semver's x-range rules for a partial version behind a comparator.
test('satisfies: a comparator on a partial version covers the whole span it names', () => {
  assert.equal(sat('1.2.5', '>1.2'), false); // >1.2   => >=1.3.0
  assert.equal(sat('1.3.0', '>1.2'), true);
  assert.equal(sat('1.2.5', '<=1.2'), true); // <=1.2  => <1.3.0
  assert.equal(sat('1.3.0', '<=1.2'), false);
  assert.equal(sat('1.9.9', '>1'), false); // >1     => >=2.0.0
  assert.equal(sat('2.0.0', '>1'), true);
  assert.equal(sat('1.9.9', '<=1'), true); // <=1    => <2.0.0
  assert.equal(sat('1.2.5', '=1.2'), true); // =1.2   => 1.2.x
  assert.equal(sat('1.3.0', '=1.2'), false);
  assert.equal(sat('1.1.9', '>=1.2'), false); // >=1.2 => >=1.2.0
  assert.equal(sat('1.1.9', '<1.2'), true); // <1.2   => <1.2.0
  assert.equal(sat('1.2.0', '<1.2'), false);
});

test('satisfies: ^X.Y.x keeps its minor floor (^1.3.x is >=1.3.0 <2.0.0)', () => {
  assert.equal(sat('1.2.5', '^1.3.x'), false);
  assert.equal(sat('1.3.0', '^1.3.x'), true);
  assert.equal(sat('1.9.0', '^1.3.x'), true);
  assert.equal(sat('2.0.0', '^1.3.x'), false);
});

test('satisfies: a leading "v" is accepted on range versions, as on plain versions', () => {
  assert.equal(sat('1.2.5', '^v1.2.0'), true);
  assert.equal(sat('1.2.5', '>=v1.3.0'), false);
});

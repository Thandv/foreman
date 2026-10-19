import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { allLines, changedLinesOf, changedTests, findTests, namePatternFor } from '../src/verify/testNames.ts';

/**
 * Which tests a diff adds or changes, read off the source (src/verify/testNames.ts): the calls found, what is not a
 * call, and which changed lines make which test changed.
 */

const lines = (...n: number[]) => ({ lines: new Set(n), deletedAfter: [] as number[] });
const names = (src: string): Array<string | null> => findTests(src).map((c) => c.name);

test('findTests: test, it, describe, suite, their modifiers and a subtest; nothing in strings, comments, regexes or templates', () => {
  const src = [
    "import test, { describe, it, suite } from 'node:test';",
    "const RE = /x it('in a regex', 1) \"/;",
    "// test('in a comment', () => {});",
    "/* it('in a block comment') */",
    "const s = \"test('in a string', () => {})\";",
    "const tpl = `${test('in an interpolation', () => {})}`;",
    "if (RE.test('literal only')) {}",
    "class A { test(a, b) { return a; } }",
    "function test2() {}",
    "test('plain', () => {});",
    "test.skip('skipped', () => {});",
    "it.only('only', () => {});",
    "describe('group', () => {",
    "  it('inside', () => {});",
    "  suite.todo('later', () => {});",
    "});",
    "test('parent', async (t) => {",
    "  await t.test('sub', () => {});",
    "  t.test(`sub ${1}`, () => {});",
    "});",
    "x.y.test('deep member, not a subtest', () => {});",
  ].join('\n');
  const calls = findTests(src);
  assert.deepEqual(calls.map((c) => [c.callee, c.name, c.kind]), [
    ['test', 'plain', 'test'],
    ['test.skip', 'skipped', 'test'],
    ['it.only', 'only', 'test'],
    ['describe', 'group', 'suite'],
    ['it', 'inside', 'test'],
    ['suite.todo', 'later', 'suite'],
    ['test', 'parent', 'test'],
    ['t.test', 'sub', 'test'],
    ['t.test', null, 'test'],
  ]);
  const byName = (n: string) => calls.findIndex((c) => c.name === n);
  assert.equal(calls[byName('inside')]!.parent, byName('group'));
  assert.equal(calls[byName('sub')]!.parent, byName('parent'));
  assert.equal(calls[byName('plain')]!.parent, null);
  assert.equal(calls[8]!.namePattern, 'sub .*', 'a template with an interpolation is a pattern');
  assert.deepEqual([calls[byName('plain')]!.line, calls[byName('plain')]!.endLine, calls[byName('sub')]!.cols], [10, 10, [9, 11]]);
});

test('findTests: escapes in a name are read, and a name from a variable is unknown', () => {
  assert.deepEqual(names("test('it\\'s \\u0041 \\n', () => {});\ntest(NAME, () => {});\ntest('a' + b, () => {});"), ["it's A \n", null, null]);
  const calls = findTests("test(NAME, () => {});");
  assert.equal(calls[0]!.namePattern, null);
  assert.equal(namePatternFor(calls, 0), null, 'no filter can be built for it');
});

test('namePatternFor: anchored, describes joined with a space, a subtest runs through its outermost test, regex characters escaped', () => {
  const src = "describe('a (b)', () => {\n  test('c.d', async (t) => {\n    await t.test('e', () => {});\n  });\n});\n";
  const calls = findTests(src);
  assert.equal(namePatternFor(calls, 1), '^a \\(b\\) c\\.d$');
  assert.equal(namePatternFor(calls, 2), '^a \\(b\\) c\\.d$');
});

test('changedLinesOf: hunks of a -U0 diff, and a deletion with nothing in its place', () => {
  const diff = '@@ -3 +3 @@\n-a\n+b\n@@ -10,2 +11,3 @@\n@@ -20,4 +22,0 @@\n';
  const c = changedLinesOf(diff);
  assert.deepEqual([...c.lines].sort((a, b) => a - b), [3, 11, 12, 13]);
  assert.deepEqual(c.deletedAfter, [22]);
  assert.deepEqual([...allLines('a\nb\n').lines], [1, 2]);
  assert.deepEqual([...allLines('').lines], []);
});

const BEFORE = [
  "import test, { describe } from 'node:test';", // 1
  'const helper = () => 1;', // 2
  "test('one', () => {", // 3
  '  helper();', // 4
  '});', // 5
  "test('two', () => {", // 6
  '  helper();', // 7
  '});', // 8
  "describe('group', () => {", // 9
  '  const shared = 1;', // 10
  "  test('three', () => {});", // 11
  "  test('four', () => {});", // 12
  '});', // 13
  'for (const n of [1, 2]) {', // 14
  '  test(`case ${n}`, () => {});', // 15
  '}', // 16
  '', // 17
].join('\n');

test('changedTests: a line in a test changes that test only; a line in no test is counted, not attributed', () => {
  const r = changedTests(BEFORE, BEFORE, lines(4, 2));
  assert.deepEqual(r.tests.map((t) => [t.call.name, t.change]), [['one', 'changed']]);
  assert.equal(r.unattributed, 1);
});

test('changedTests: a describe\'s own line changes every test under it; a changed case table changes the cases', () => {
  assert.deepEqual(changedTests(BEFORE, BEFORE, lines(10)).tests.map((t) => t.call.name), ['three', 'four']);
  assert.deepEqual(changedTests(BEFORE, BEFORE, lines(11)).tests.map((t) => t.call.name), ['three'], 'a test inside it: that test');
  assert.deepEqual(changedTests(BEFORE, BEFORE, lines(14)).tests.map((t) => t.call.namePattern), ['case .*']);
  assert.equal(changedTests(BEFORE, BEFORE, lines(14)).unattributed, 0, 'the table is the cases\' change');
});

test('changedTests: a deletion inside a test changes it; one between two tests changes neither', () => {
  assert.deepEqual(changedTests(BEFORE, BEFORE, { lines: new Set(), deletedAfter: [3] }).tests.map((t) => t.call.name), ['one']);
  assert.deepEqual(changedTests(BEFORE, BEFORE, { lines: new Set(), deletedAfter: [5] }).tests, []);
});

test('changedTests: added, changed and renamed are told apart; a new file is all added', () => {
  const after = BEFORE.replace("test('one'", "test('uno'").replace("test('two', () => {\n  helper();", "test('two', () => {\n  helper(); helper();");
  const r = changedTests(BEFORE, after, lines(3, 7));
  assert.deepEqual(r.tests.map((t) => [t.call.name, t.change]), [['uno', 'renamed'], ['two', 'changed']]);
  const fresh = changedTests(null, BEFORE, allLines(BEFORE));
  assert.deepEqual(fresh.tests.map((t) => t.change), ['added', 'added', 'added', 'added', 'added']);
  assert.equal(fresh.tests.length, 5, 'one, two, three, four and the case call; the describe is not a test');
});

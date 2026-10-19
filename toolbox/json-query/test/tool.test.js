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

function query(data, q) {
  const res = run({ data, query: q });
  assert.equal(res.status, 0, `query ${JSON.stringify(q)} failed: ${res.stderr}`);
  return JSON.parse(res.stdout).result;
}

test('nested projection + filter: items[?price > `10`].name', () => {
  const data = { items: [{ name: 'a', price: 5 }, { name: 'b', price: 15 }, { name: 'c', price: 25 }] };
  assert.deepEqual(query(data, 'items[?price > `10`].name'), ['b', 'c']);
});

test('filter with && and a boolean field', () => {
  const data = { items: [{ n: 'a', p: 5, ok: true }, { n: 'b', p: 9, ok: false }, { n: 'c', p: 12, ok: true }] };
  assert.deepEqual(query(data, 'items[?ok && p > `1`].n'), ['a', 'c']);
});

test('pipe chain: filter then pipe into sort_by, resetting projection scope', () => {
  const data = { items: [{ name: 'b', price: 15 }, { name: 'a', price: 25 }, { name: 'c', price: 5 }] };
  assert.deepEqual(
    query(data, 'items[?price > `1`] | sort_by(@, &price)').map((x) => x.name),
    ['c', 'b', 'a'],
  );
});

test('sort_by is stable for equal keys', () => {
  const data = [{ k: 1, tag: 'first' }, { k: 1, tag: 'second' }, { k: 0, tag: 'zeroth' }];
  assert.deepEqual(query(data, 'sort_by(@, &k)').map((x) => x.tag), ['zeroth', 'first', 'second']);
});

test('max_by and min_by', () => {
  const data = { items: [{ n: 3 }, { n: 9 }, { n: 1 }] };
  assert.deepEqual(query(data, 'max_by(items, &n)'), { n: 9 });
  assert.deepEqual(query(data, 'min_by(items, &n)'), { n: 1 });
});

test('multiselect hash reshapes an object', () => {
  assert.deepEqual(query({ a: 1, b: 2, c: 3 }, '{x: a, y: b}'), { x: 1, y: 2 });
});

test('wildcard projection and flatten', () => {
  assert.deepEqual(query({ a: { x: 1, y: 2, z: 3 } }, 'a.*'), [1, 2, 3]);
  assert.deepEqual(query({ a: [[1, 2], [3], [4, 5]] }, 'a[]'), [1, 2, 3, 4, 5]);
});

test('negative index and out-of-range index returns null', () => {
  assert.equal(query([10, 20, 30], '[-1]'), 30);
  assert.equal(query([10, 20, 30], '[99]'), null);
});

test('functions: length, keys, values, contains, starts_with, join, to_number', () => {
  assert.equal(query({ tags: ['x', 'y', 'z'] }, 'length(tags)'), 3);
  assert.deepEqual(query({ a: 1, b: 2 }, 'keys(@)'), ['a', 'b']);
  assert.deepEqual(query({ a: 1, b: 2 }, 'values(@)'), [1, 2]);
  assert.equal(query({ tags: ['x', 'y'] }, "contains(tags, 'y')"), true);
  assert.equal(query({ s: 'hello world' }, "starts_with(s, 'hello')"), true);
  assert.equal(query({ tags: ['x', 'y', 'z'] }, 'join(`","`, tags)'), 'x,y,z');
  assert.equal(query({ n: '42' }, 'to_number(n)'), 42);
  assert.equal(query({ n: 'nope' }, 'to_number(n)'), null);
});

test('missing field access returns null, not an error', () => {
  assert.equal(query({ a: 1 }, 'b.c.d'), null);
});

test('deeply nested projection: items[*].tags[*] flattened per element via pipe', () => {
  const data = { items: [{ tags: ['a', 'b'] }, { tags: ['c'] }] };
  assert.deepEqual(query(data, 'items[*].tags'), [['a', 'b'], ['c']]);
});

test('error on bad syntax names the position', () => {
  const res = run({ data: {}, query: 'items[?].name' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /position 7/);
});

test('error on an unknown function names it', () => {
  const res = run({ data: {}, query: 'nope(@)' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown function/);
});

test('error on trailing garbage after a valid expression', () => {
  const res = run({ data: {}, query: 'a.b )' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /position/);
});

test('rejects malformed input: missing query', () => {
  const res = run({ data: {} });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: missing data key entirely', () => {
  const res = run({ query: '@' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('definitely not json');
  assert.notEqual(res.status, 0);
});

test('handles null data with identity query', () => {
  assert.equal(query(null, '@'), null);
});

// --- fix: max_by/min_by key-type validation (symmetric with sort_by) -------

test('max_by/min_by reject a key expression that evaluates to a non-number/string, same as sort_by', () => {
  const data = { items: [{ tag: { x: 1 } }, { tag: { x: 2 } }] };
  const res = run({ data, query: 'max_by(items, &tag)' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /key expression must evaluate to a number or string/);

  const res2 = run({ data, query: 'min_by(items, &tag)' });
  assert.notEqual(res2.status, 0);
  assert.match(res2.stderr, /key expression must evaluate to a number or string/);
});

test('max_by/min_by still work normally with number/string keys', () => {
  const data = { items: [{ n: 3, s: 'b' }, { n: 9, s: 'a' }, { n: 1, s: 'c' }] };
  assert.equal(query(data, 'max_by(items, &s).s'), 'c');
  assert.equal(query(data, 'min_by(items, &s).s'), 'a');
});

// --- fix: parser recursion depth cap ---------------------------------------

test('deeply nested parentheses are refused with a clean "nesting too deep" error, not a stack overflow', () => {
  const query = '('.repeat(50000) + '@' + ')'.repeat(50000);
  const res = run({ data: 1, query });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nesting too deep/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
});

test('a long chain of filter projections is refused with a clean "nesting too deep" error, not a stack overflow', () => {
  const query = 'a' + '[?b]'.repeat(50000);
  const res = run({ data: { a: [] }, query });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nesting too deep/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
});

test('an ordinary long flat dot chain (no nesting) is NOT rejected by the depth cap', () => {
  const parts = Array.from({ length: 500 }, (_, i) => `f${i}`);
  // Build data matching a query with 500 chained field accesses.
  let nested = { leaf: 'value' };
  for (let i = parts.length - 1; i >= 0; i -= 1) nested = { [parts[i]]: nested };
  const q = parts.join('.') + '.leaf';
  assert.equal(query(nested, q), 'value');
});

// --- fix: unbounded output (result size cap) --------------------------------

test('an oversized array result is truncated to fit under 700,000 characters with a trailing marker and truncated:true', () => {
  const data = Array.from({ length: 100000 }, (_, i) => ({ i, s: 'x'.repeat(20) }));
  const res = run({ data, query: '@' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') < 1_000_000, `stdout was ${res.stdout.length} bytes, expected < 1MB`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, true);
  assert.ok(Array.isArray(out.result));
  const marker = out.result[out.result.length - 1];
  assert.equal(marker.truncated, true);
  assert.equal(marker.originalLength, 100000);
  assert.ok(marker.returned < 100000);
});

test('an ordinary small array result is not marked truncated', () => {
  const res = run({ data: [1, 2, 3], query: '@' });
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.result, [1, 2, 3]);
});

// JMESPath spec / jmespath.js: flatten binds looser than any other
// projection, so a trailing [] flattens the whole projected list.
test('a [] after a projection flattens the whole projected result', () => {
  const data = { reservations: [{ instances: [{ id: 1 }, { id: 2 }] }, { instances: [{ id: 3 }] }] };
  assert.deepEqual(query(data, 'reservations[].instances[].id'), [1, 2, 3]);
  assert.deepEqual(query(data, 'reservations[*].instances[].id'), [1, 2, 3]);
  assert.deepEqual(query(data, 'reservations[*].instances[*].id'), [[1, 2], [3]]);
  assert.deepEqual(query(data, 'reservations[].instances[0].id'), [1, 3]);
  assert.equal(query(data, 'length(reservations[].instances[])'), 3);
  assert.equal(query(data, 'reservations[].instances[] | [0].id'), 1);
});

test('! binds tighter than a comparator: !a == b is (!a) == b', () => {
  assert.equal(query({ x: 1 }, '!x == `2`'), false);
  assert.equal(query({ x: 1 }, '!x == `false`'), true);
  assert.equal(query({ x: 1 }, '!(x == `2`)'), true);
});

test("raw strings only unescape \\' and \\\\, keeping other backslashes", () => {
  assert.equal(query({}, "'a\\b'"), 'a\\b');
  assert.equal(query({}, "'it\\'s'"), "it's");
  assert.equal(query({}, "'a\\\\b'"), 'a\\b');
});

test('a multiselect-hash key named __proto__ is kept as an ordinary key', () => {
  assert.deepEqual(Object.keys(query({ x: 1 }, '{__proto__: x}')), ['__proto__']);
});

test('sort_by/max_by refuse a mix of number and string keys', () => {
  const data = [{ k: 1 }, { k: 'b' }, { k: 0 }];
  for (const q of ['sort_by(@, &k)', 'max_by(@, &k)', 'min_by(@, &k)']) {
    const res = run({ data, query: q });
    assert.notEqual(res.status, 0, q);
    assert.match(res.stderr, /not a mix/);
  }
});

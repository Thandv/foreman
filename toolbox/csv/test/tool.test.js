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

test('parse: simple header CSV', () => {
  const res = run({ mode: 'parse', text: 'a,b\n1,2\n3,4\n', header: true });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.columns, ['a', 'b']);
  assert.deepEqual(out.rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  assert.deepEqual(out.warnings, []);
});

test('parse: quote-in-quote (escaped double quote)', () => {
  const res = run({ mode: 'parse', text: '"He said ""hi""",ok\n' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rows, [['He said "hi"', 'ok']]);
});

test('parse: trailing newline does not produce a phantom empty row', () => {
  const res = run({ mode: 'parse', text: 'a,b\n1,2\n' });
  const out = JSON.parse(res.stdout);
  assert.equal(out.rows.length, 2);
});

test('parse: delimiter inside quotes is not treated as a separator', () => {
  const res = run({ mode: 'parse', text: '"a,b",c\n' });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rows, [['a,b', 'c']]);
});

test('parse: embedded newline inside a quoted field', () => {
  const res = run({ mode: 'parse', text: '"line1\nline2",x\n' });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rows, [['line1\nline2', 'x']]);
});

test('parse: CRLF line endings', () => {
  const res = run({ mode: 'parse', text: 'a,b\r\n1,2\r\n' });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.rows, [['a', 'b'], ['1', '2']]);
});

test('parse: ragged rows are reported in warnings, not thrown', () => {
  const res = run({ mode: 'parse', text: 'a,b,c\n1,2\n' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /expected 3.*got 2/);
});

test('parse: header dedup renames duplicate column names', () => {
  const res = run({ mode: 'parse', text: 'a,a,a\n1,2,3\n', header: true });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.columns, ['a', 'a_1', 'a_2']);
  assert.deepEqual(out.rows, [{ a: '1', a_1: '2', a_2: '3' }]);
  assert.equal(out.warnings.length, 2);
});

test('stringify: quotes only fields that need it', () => {
  const res = run({ mode: 'stringify', rows: [['plain', 'has,comma', 'has"quote', 'ok']] });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.text, 'plain,"has,comma","has""quote",ok\r\n');
});

test('stringify: object rows produce a header row from key order', () => {
  const res = run({ mode: 'stringify', rows: [{ name: 'Doe, Jane', age: 30 }] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.text, 'name,age\r\n"Doe, Jane",30\r\n');
});

test('stringify -> parse round trip preserves data', () => {
  const rows = [['a', 'b,c', 'd"e', 'line1\nline2']];
  const stringified = JSON.parse(run({ mode: 'stringify', rows }).stdout);
  const reparsed = JSON.parse(run({ mode: 'parse', text: stringified.text }).stdout);
  assert.deepEqual(reparsed.rows, rows);
});

test('rejects malformed input: missing mode', () => {
  const res = run({ text: 'a,b\n' });
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

test('rejects stringify with non-array rows', () => {
  const res = run({ mode: 'stringify', rows: 'not-an-array' });
  assert.notEqual(res.status, 0);
});

// --- fix: trailing all-empty-row loss on round trip ------------------------

test('stringify -> parse round trip preserves a trailing fully-empty row', () => {
  const rows = [['a'], [''], ['']];
  const stringified = JSON.parse(run({ mode: 'stringify', rows }).stdout);
  const reparsed = JSON.parse(run({ mode: 'parse', text: stringified.text }).stdout);
  assert.deepEqual(reparsed.rows, rows);
});

test('stringify -> parse round trip preserves a single fully-empty row', () => {
  const rows = [['']];
  const stringified = JSON.parse(run({ mode: 'stringify', rows }).stdout);
  const reparsed = JSON.parse(run({ mode: 'parse', text: stringified.text }).stdout);
  assert.deepEqual(reparsed.rows, rows);
});

// Deterministic PRNG (mulberry32) so this fuzz run is reproducible.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomField(rand) {
  const choices = ['', 'a', 'plain', 'has,comma', 'has"quote', 'has\nnewline', '  spaced  ', '0', String(rand())];
  return choices[Math.floor(rand() * choices.length)];
}

function randomRows(rand) {
  const width = 1 + Math.floor(rand() * 3);
  const height = Math.floor(rand() * 4); // includes 0 rows
  const rows = [];
  for (let r = 0; r < height; r += 1) {
    const row = [];
    for (let c = 0; c < width; c += 1) row.push(randomField(rand));
    rows.push(row);
  }
  return rows;
}

test('fuzz: 200 random stringify -> parse round trips preserve the original rows exactly', () => {
  const rand = mulberry32(20260821);
  for (let i = 0; i < 200; i += 1) {
    const rows = randomRows(rand);
    const stringified = JSON.parse(run({ mode: 'stringify', rows }).stdout);
    const reparsed = JSON.parse(run({ mode: 'parse', text: stringified.text }).stdout);
    assert.deepEqual(reparsed.rows, rows, `round trip #${i} failed for rows=${JSON.stringify(rows)}, text=${JSON.stringify(stringified.text)}`);
  }
});

// --- fix: __proto__ as a header/column name -------------------------------

test('a "__proto__" header column round-trips as a normal own property, not a prototype swap', () => {
  const res = run({ mode: 'parse', text: '__proto__,name\nevil,Jane\n', header: true });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.columns, ['__proto__', 'name']);
  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  // The value must be reachable as an own property (JSON.stringify would
  // silently drop it if `obj['__proto__'] = 'evil'` had instead reset the
  // object's actual prototype).
  assert.equal(Object.prototype.hasOwnProperty.call(row, '__proto__'), true);
  assert.equal(row.__proto__, 'evil');
  assert.equal(row.name, 'Jane');
  // Sanity: the row object must still behave like an ordinary object for
  // the rest of the pipeline (JSON.stringify round trip agrees). Compared
  // via property access, not an object-literal RHS — `{ __proto__: 'evil' }`
  // as literal *source syntax* is itself special-cased by JS (it would try
  // to set the prototype, not create an own property), which would make an
  // object-literal comparison here a false negative for the very thing this
  // test is checking.
  const roundTripped = JSON.parse(JSON.stringify(row));
  assert.equal(Object.prototype.hasOwnProperty.call(roundTripped, '__proto__'), true);
  assert.equal(roundTripped.__proto__, 'evil');
  assert.equal(roundTripped.name, 'Jane');
});

test('a "constructor" header column also round-trips as a normal own property', () => {
  const res = run({ mode: 'parse', text: 'constructor,name\nx,Jane\n', header: true });
  const out = JSON.parse(res.stdout);
  assert.equal(out.rows[0].constructor, 'x');
  assert.equal(typeof out.rows[0].constructor, 'string');
});

// --- fix: stringify mixed row shapes (object-first branch symmetry) -------

test('stringify rejects a non-object row when rows[0] is an object (symmetric with the array-first check)', () => {
  const res = run({ mode: 'stringify', rows: [{ a: 1 }, ['not', 'an', 'object']] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /each row must be an object/);
});

test('stringify rejects a non-array row when rows[0] is an array', () => {
  const res = run({ mode: 'stringify', rows: [['a', 'b'], { a: 1, b: 2 }] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /each row must be an array/);
});

// --- fix: unbounded output (row cap) ---------------------------------------

test('parse caps rows at 20,000 with truncated:true, and the output stays well under 1MB', () => {
  const lines = [];
  for (let i = 0; i < 25000; i += 1) lines.push(`${i},value${i}`);
  const text = lines.join('\n') + '\n';
  const res = run({ mode: 'parse', text, header: false });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') < 1_000_000, `stdout was ${res.stdout.length} bytes, expected < 1MB`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rows.length, 20000);
  assert.equal(out.truncated, true);
});

test('parse does not mark ordinary small input as truncated', () => {
  const res = run({ mode: 'parse', text: 'a,b\n1,2\n', header: false });
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, false);
});

function ok(input) {
  const res = run(input);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('parse: a deduplicated header name never collides with a real column of that name', () => {
  const out = ok({ mode: 'parse', text: 'a,a,a_1\n1,2,3\n', header: true });
  assert.equal(new Set(out.columns).size, 3);
  assert.deepEqual(out.columns, ['a', 'a_2', 'a_1']);
  assert.deepEqual({ ...out.rows[0] }, { a: '1', a_2: '2', a_1: '3' });
});

test('parse: an unterminated quoted field keeps its data and is reported, even before a trailing newline', () => {
  const out = ok({ mode: 'parse', text: 'a,"b\n' });
  assert.deepEqual(out.rows, [['a', 'b\n']]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /row 0: unterminated quoted field/);
});

test('parse: a leading UTF-8 BOM is stripped from the first field', () => {
  const out = ok({ mode: 'parse', text: '﻿name,age\nx,1\n', header: true });
  assert.deepEqual(out.columns, ['name', 'age']);
});

test('rejects a delimiter that already has meaning in CSV (quote, CR, LF)', () => {
  for (const delimiter of ['"', '\r', '\n']) {
    assert.notEqual(run({ mode: 'parse', text: 'a', delimiter }).status, 0, JSON.stringify(delimiter));
  }
});

test('stringify: a column a row lacks is empty, never an inherited Object.prototype member', () => {
  const out = ok({ mode: 'stringify', rows: [{ a: 1 }], columns: ['a', 'toString'] });
  assert.equal(out.text, 'a,toString\r\n1,\r\n');
});

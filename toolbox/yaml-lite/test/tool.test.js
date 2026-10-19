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

function parse(text) {
  const res = run({ text });
  assert.equal(res.status, 0, `parse failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('nested map/list mix, including a list at the same indent as its key', () => {
  const yaml = [
    'name: demo',
    'values:',
    '  - a',
    '  - b',
    'nested:',
    '  x: 1',
    '  y:',
    '    z: 2',
    'list:',
    '- item1',
    '- item2',
    '',
  ].join('\n');
  const { data, warnings } = parse(yaml);
  assert.deepEqual(data, {
    name: 'demo',
    values: ['a', 'b'],
    nested: { x: 1, y: { z: 2 } },
    list: ['item1', 'item2'],
  });
  assert.deepEqual(warnings, []);
});

test('a list of maps ("- key: value" then more indented keys)', () => {
  const yaml = 'items:\n  - name: a\n    price: 5\n  - name: b\n    price: 9\n';
  const { data } = parse(yaml);
  assert.deepEqual(data, { items: [{ name: 'a', price: 5 }, { name: 'b', price: 9 }] });
});

test('inline flow styles: [a, b] and {k: v}', () => {
  const { data } = parse('a: [1, 2, 3]\nb: {k: v, n: 5}\nc: ["x", true, null]\n');
  assert.deepEqual(data, { a: [1, 2, 3], b: { k: 'v', n: 5 }, c: ['x', true, null] });
});

test('literal block scalar (|) preserves line breaks', () => {
  const { data } = parse('desc: |\n  line one\n  line two\n');
  assert.equal(data.desc, 'line one\nline two\n');
});

test('folded block scalar (>) joins lines with spaces', () => {
  const { data } = parse('desc: >\n  line one\n  line two\n');
  assert.equal(data.desc, 'line one line two\n');
});

test('block scalar chomping: strip (-) removes the trailing newline', () => {
  const { data } = parse('desc: |-\n  hello\n');
  assert.equal(data.desc, 'hello');
});

test('scalars: numbers, booleans, null, and quoted strings with escapes', () => {
  const { data } = parse('n: 42\nf: 3.14\nt: true\nfa: false\nnu: null\ntilde: ~\ns: "line1\\nline2"\nsq: \'it\'\'s\'\n');
  assert.deepEqual(data, { n: 42, f: 3.14, t: true, fa: false, nu: null, tilde: null, s: 'line1\nline2', sq: "it's" });
});

test('comments are stripped, including trailing comments after a value', () => {
  const { data } = parse('# a top comment\na: 1 # trailing comment\nb: 2\n');
  assert.deepEqual(data, { a: 1, b: 2 });
});

test('duplicate keys produce a warning and the later value wins', () => {
  const { data, warnings } = parse('a: 1\na: 2\n');
  assert.equal(data.a, 2);
  assert.ok(warnings.some((w) => w.includes('duplicate key')));
});

test('refuses anchors and aliases', () => {
  const res = run({ text: 'a: &x 1\nb: *x\n' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /anchors\/aliases/);
});

test('refuses tags', () => {
  const res = run({ text: 'a: !!str 1\n' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /tags/);
});

test('refuses multi-document markers', () => {
  const res = run({ text: '---\na: 1\n' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /multi-document/);
});

test('refuses merge keys', () => {
  const res = run({ text: 'a:\n  <<: b\n' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /merge keys/);
});

test('tab-indentation is a clear error, not a guess', () => {
  const res = run({ text: 'a:\n\tb: 1\n' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /tab/i);
});

test('rejects malformed input: missing text field', () => {
  const res = run({});
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
});

test('empty document parses to null with no warnings', () => {
  const { data, warnings } = parse('');
  assert.equal(data, null);
  assert.deepEqual(warnings, []);
});

// --- CPU-time budget --------------------------------------------------------
//
// A wall-clock budget here flaked under full-suite load on a swapping machine:
// the run spends most of its time waiting on the scheduler and on page-ins, not
// computing. CPU_PROBE is preloaded into the tool's own process (via --import;
// the tool itself is untouched) and reports, in CPU time, a fixed calibration
// loop run before the tool starts (calibMs: how fast this machine/process is
// right now) and everything the tool does after that until exit (workMs). The
// budget is workMs relative to calibMs, never an absolute number, and a run
// gets up to three attempts so one descheduled run can't decide it — a real
// blow-up fails every attempt. Same scheme as fuzzy-match's perf guard.
const CPU_PROBE = `
const cpuMs = (u) => (u.user + u.system) / 1000;
const c0 = process.cpuUsage();
let acc = 0;
const buf = new Float64Array(4096);
const s = 'abcdefghijklmnopqrstuvwxyz0123456789';
for (let r = 0; r < 2000; r += 1) {
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = buf[i] * 0.5 + (s[i % 36] === s[r % 36] ? r : i);
    acc += buf[i];
  }
}
const calibMs = cpuMs(process.cpuUsage(c0));
globalThis.__calibSink = acc;
const t0 = process.cpuUsage();
process.on('exit', () => {
  process.stderr.write('\\nCPU_PROBE ' + JSON.stringify({ calibMs, workMs: cpuMs(process.cpuUsage(t0)) }));
});
`;
const CPU_PROBE_URL = `data:text/javascript,${encodeURIComponent(CPU_PROBE)}`;

/** Run the tool under CPU_PROBE until workMs/calibMs < maxRatio (up to 3 tries). */
function runWithinCpuBudget(input, maxRatio) {
  const ratios = [];
  let res;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    res = spawnSync(process.execPath, ['--import', CPU_PROBE_URL, TOOL], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = res.stderr.split('\n').find((l) => l.startsWith('CPU_PROBE '));
    assert.ok(line, `CPU probe reported nothing; stderr was: ${res.stderr.slice(-2000)}`);
    res.stderr = res.stderr.slice(0, res.stderr.lastIndexOf('\nCPU_PROBE '));
    const { calibMs, workMs } = JSON.parse(line.slice('CPU_PROBE '.length));
    ratios.push(`${workMs.toFixed(1)}ms CPU vs ${calibMs.toFixed(1)}ms calibration = ${(workMs / calibMs).toFixed(2)}x`);
    if (workMs / calibMs < maxRatio) return { res, ok: true, ratios };
  }
  return { res, ok: false, ratios };
}

test('deeply indented block nesting (10,000 levels) gets a clean "nesting too deep" error, not a stack overflow', () => {
  const depth = 10000;
  const lines = [];
  for (let i = 0; i < depth; i += 1) lines.push(`${'  '.repeat(i)}k${i}:`);
  lines.push(`${'  '.repeat(depth)}leaf: 1`);
  const text = lines.join('\n');
  // The fixture is ~100MB (the indentation alone), so even idle this is ~1s of
  // CPU — ~14x the calibration loop — which is why a 2s wall-clock budget
  // flaked under load. 40x still fails on anything super-linear in depth.
  const { res, ok, ratios } = runWithinCpuBudget({ text }, 40);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nesting too deep/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
  assert.ok(ok, `over budget (expected < 40x) on every attempt: ${ratios.join('; ')}`);
});

test('deeply nested flow collections ("[[[...]]]") get a clean "nesting too deep" error, not a stack overflow', () => {
  const depth = 10000;
  const text = `x: ${'['.repeat(depth)}1${']'.repeat(depth)}`;
  const res = run({ text });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nesting too deep/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
});

test('block nesting right at a generous depth still parses successfully', () => {
  const depth = 200;
  const lines = [];
  for (let i = 0; i < depth; i += 1) lines.push(`${'  '.repeat(i)}k:`);
  lines.push(`${'  '.repeat(depth)}leaf: 1`);
  const out = parse(lines.join('\n'));
  assert.equal(out.warnings.length, 0);
  // Walk down to confirm the deepest leaf survived intact.
  let node = out.data;
  for (let i = 0; i < depth; i += 1) node = node.k;
  assert.equal(node.leaf, 1);
});

test('a document that is only a comment parses to null', () => {
  const { data } = parse('# just a comment\n');
  assert.equal(data, null);
});

test('a line that fits nowhere in the structure is an error, never silently dropped', () => {
  for (const text of ['a: 1\n  b: 2', 'desc: this is\n  continued\nz: 1', '- a\nb: 1', 'x:\n  a: 1\n    b: 2\n  c: 3']) {
    const res = run({ text });
    assert.notEqual(res.status, 0, `expected an error for ${JSON.stringify(text)}, got ${res.stdout}`);
    assert.match(res.stderr, /unexpected content at line \d+/);
  }
});

test('an apostrophe inside a plain scalar or key is not a quote', () => {
  assert.deepEqual(parse("k: it's here # comment").data, { k: "it's here" });
  assert.deepEqual(parse("don't: 1").data, { "don't": 1 });
});

test('comment stripping honours escaped quotes and doubled single quotes', () => {
  assert.deepEqual(parse('k: "say \\"hi\\" # kept" # dropped').data, { k: 'say "hi" # kept' });
  assert.deepEqual(parse("k: 'it''s # kept' # dropped").data, { k: "it's # kept" });
  assert.deepEqual(parse("k: {a: \"x # y\", b: [1, '#']} # c").data, { k: { a: 'x # y', b: [1, '#'] } });
});

test('a "__proto__" key is kept as an ordinary key (block and flow mappings)', () => {
  const block = parse('__proto__: 1\nb: 2').data;
  assert.deepEqual(Object.keys(block), ['__proto__', 'b']);
  assert.equal(block['__proto__'], 1);
  const flow = parse('k: {__proto__: 1}').data;
  assert.deepEqual(Object.keys(flow.k), ['__proto__']);
});

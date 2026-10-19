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

function parse(xml, extra) {
  const res = run({ xml, ...extra });
  assert.equal(res.status, 0, `parse failed: ${res.stderr}`);
  return JSON.parse(res.stdout).root;
}

test('attributes land under @attr', () => {
  const root = parse('<note id="1" lang="en"><to>Bob</to></note>');
  assert.deepEqual(root, { note: { '@attr': { id: '1', lang: 'en' }, to: 'Bob' } });
});

test('preserveAttributes: false drops attributes entirely', () => {
  const root = parse('<note id="1"><to>Bob</to></note>', { preserveAttributes: false });
  assert.deepEqual(root, { note: { to: 'Bob' } });
});

test('repeated sibling elements become an array, in order', () => {
  const root = parse('<list><item>a</item><item>b</item><item>c</item></list>');
  assert.deepEqual(root, { list: { item: ['a', 'b', 'c'] } });
});

test('CDATA is unwrapped literally, not entity-decoded', () => {
  const root = parse('<x><![CDATA[if (a < b) { go(); }]]></x>');
  assert.deepEqual(root, { x: 'if (a < b) { go(); }' });
});

test('mixed content places text under #text alongside child elements', () => {
  const root = parse('<p>Hello <b>world</b>!</p>');
  assert.deepEqual(root, { p: { '#text': 'Hello !', b: 'world' } });
});

test('comments and the XML declaration are skipped', () => {
  const root = parse('<?xml version="1.0"?><!-- top comment --><a><!-- inner --><b>1</b></a>');
  assert.deepEqual(root, { a: { b: '1' } });
});

test('numeric and built-in entities decode correctly', () => {
  const root = parse('<x>Tom &amp; Jerry &#169; &#x2014;</x>');
  assert.deepEqual(root, { x: 'Tom & Jerry © —' });
});

test('a docx document.xml-shaped fixture parses with namespace prefixes intact', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body>'
    + '</w:document>';
  const root = parse(xml);
  assert.deepEqual(root, {
    'w:document': {
      '@attr': { 'xmlns:w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' },
      'w:body': { 'w:p': { 'w:r': { 'w:t': 'Hello world' } } },
    },
  });
});

test('a DOCTYPE with a custom entity is skipped, not resolved (no XXE)', () => {
  const res = run({ xml: '<!DOCTYPE foo [ <!ENTITY bar "baz"> ]><foo>plain text</foo>' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).root, { foo: 'plain text' });
});

test('using an undeclared/DTD-only entity is a clear parse error, proving it was never resolved', () => {
  const res = run({ xml: '<!DOCTYPE foo [ <!ENTITY bar "baz"> ]><foo>&bar;</foo>' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown entity/);
});

test('malformed input: mismatched closing tag is a clear error', () => {
  const res = run({ xml: '<a><b></a>' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /mismatched closing tag/);
});

test('malformed input: unclosed tag is a clear error', () => {
  const res = run({ xml: '<a><b>text' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /never closed/);
});

test('malformed input: no root element at all', () => {
  const res = run({ xml: '   ' });
  assert.notEqual(res.status, 0);
});

test('self-closing empty elements parse as an empty string', () => {
  const root = parse('<a><br/><x id="1"/></a>');
  assert.deepEqual(root, { a: { br: '', x: { '@attr': { id: '1' } } } });
});

test('rejects malformed input: missing xml field', () => {
  const res = run({});
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
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

test('deeply nested elements (10,000 levels) get a clean "nesting too deep" error, not a stack overflow', () => {
  const depth = 10000;
  const xml = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth);
  // Idle: ~0.35x the calibration loop; 4x still fails on anything
  // super-linear in depth.
  const { res, ok, ratios } = runWithinCpuBudget({ xml }, 4);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /nesting too deep/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
  assert.ok(ok, `over budget (expected < 4x) on every attempt: ${ratios.join('; ')}`);
});

test('nesting right at the 500-level cap still parses successfully', () => {
  const depth = 500;
  const xml = '<a>'.repeat(depth) + 'leaf' + '</a>'.repeat(depth);
  const res = run({ xml });
  assert.equal(res.status, 0, res.stderr);
});

test('rejects malformed input: preserveAttributes not a boolean', () => {
  const res = run({ xml: '<a/>', preserveAttributes: 'yes' });
  assert.notEqual(res.status, 0);
});

function parseOk(xml) {
  const res = run({ xml });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).root;
}

test('an element or attribute named "__proto__" is kept as an ordinary key', () => {
  const root = parseOk('<r __proto__="1"><__proto__>x</__proto__><b>1</b></r>');
  assert.deepEqual(Object.keys(root.r), ['@attr', '__proto__', 'b']);
  assert.equal(root.r['__proto__'], 'x');
  assert.equal(root.r['@attr']['__proto__'], '1');
});

test('element and attribute names may use non-ASCII letters', () => {
  assert.deepEqual(parseOk('<café prénom="Zoë">1</café>'), { café: { '@attr': { prénom: 'Zoë' }, '#text': '1' } });
  assert.deepEqual(parseOk('<名前>x</名前>'), { 名前: 'x' });
});

test('a numeric character reference with trailing junk is rejected, not truncated', () => {
  for (const xml of ['<r>&#12abc;</r>', '<r>&#x4G;</r>', '<r>&#;</r>', '<r>&#x;</r>']) {
    const res = run({ xml });
    assert.notEqual(res.status, 0, xml);
    assert.match(res.stderr, /invalid numeric character reference/);
  }
  assert.deepEqual(parseOk('<r>&#x41;&#66;</r>'), { r: 'AB' });
});

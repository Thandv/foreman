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
    maxBuffer: 32 * 1024 * 1024,
  });
}

test('extract:"main" picks the article over nav/footer chrome and a link-heavy sidebar', () => {
  const html = `
    <html><head><title>Quarterly Report</title></head>
    <body>
      <nav><a href="/a">Home</a><a href="/b">About</a><a href="/c">Contact</a></nav>
      <header>Site Header</header>
      <article>
        <h1>Quarterly Report</h1>
        <p>Revenue grew this quarter, driven by three factors: pricing, retention, and expansion.</p>
        <p>Costs were flat, despite inflation, supply pressure, and one-time charges.</p>
        <p>We expect this trend, cautiously, to continue into next quarter.</p>
      </article>
      <div class="sidebar">
        <a href="/x">Link X</a><a href="/y">Link Y</a><a href="/z">Link Z</a><a href="/w">Link W</a>
      </div>
      <footer>Copyright 2026</footer>
    </body></html>
  `;
  const res = run({ html, mode: 'text', extract: 'main' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.title, 'Quarterly Report');
  assert.ok(out.text.includes('Revenue grew this quarter'));
  assert.ok(!out.text.includes('Site Header'));
  assert.ok(!out.text.includes('Copyright'));
  assert.ok(!out.text.includes('Link X'));
  assert.ok(out.links.every((l) => !l.href.startsWith('/x') && !l.href.startsWith('/a')));
});

test('extract:"all" (the default) includes the sidebar text that "main" excludes', () => {
  const html = `
    <body>
      <article><p>Revenue grew this quarter, driven by pricing, retention, and expansion strategy work.</p></article>
      <div class="sidebar"><a href="/x">Link X</a></div>
    </body>
  `;
  const res = run({ html, mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.ok(out.text.includes('Link X'));
});

test('decodes named, decimal and hex entities', () => {
  const html = '<p>Tom &amp; Jerry &mdash; caf&#233; &#x2014; na&iuml;ve? &copy;2026</p>';
  const res = run({ html, mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.ok(out.text.includes('Tom & Jerry'));
  assert.ok(out.text.includes('—'));
  assert.ok(out.text.includes('café'));
  assert.ok(out.text.includes('©2026'));
});

test('tolerates malformed/unclosed nesting without crashing', () => {
  const html = '<div><p>Open paragraph never closed<div><span>nested<b>bold text here</div></article></p>Trailing text';
  const res = run({ html, mode: 'text' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.text.includes('Open paragraph never closed'));
  assert.ok(out.text.includes('Trailing text'));
});

test('extracts links with href and inner text', () => {
  const html = '<p>See <a href="https://example.com/report">the full report</a> and <a href="/local">a local page</a>.</p>';
  const res = run({ html, mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.links, [
    { href: 'https://example.com/report', text: 'the full report' },
    { href: '/local', text: 'a local page' },
  ]);
});

test('markdown mode renders headings, links, bold/italic, lists and code blocks', () => {
  const html = `
    <h2>Section</h2>
    <p>This has <b>bold</b> and <i>italic</i> text, and a <a href="https://x.test">link</a>.</p>
    <ul><li>first item</li><li>second item</li></ul>
    <pre><code>const x = 1;</code></pre>
  `;
  const res = run({ html, mode: 'markdown' });
  const out = JSON.parse(res.stdout);
  assert.ok(out.text.includes('## Section'));
  assert.ok(out.text.includes('**bold**'));
  assert.ok(out.text.includes('*italic*'));
  assert.ok(out.text.includes('[link](https://x.test)'));
  assert.ok(out.text.includes('- first item'));
  assert.ok(out.text.includes('- second item'));
  assert.ok(out.text.includes('```'));
  assert.ok(out.text.includes('const x = 1;'));
});

test('never surfaces script or style content', () => {
  const html = '<style>.x{color:red}</style><script>alert("hi")</script><p>Visible text only.</p>';
  const res = run({ html, mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.equal(out.text, 'Visible text only.');
});

test('wordCount matches the rendered text and title is null when absent', () => {
  const res = run({ html: '<p>One two three four five</p>', mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.equal(out.title, null);
  assert.equal(out.wordCount, 5);
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

// Idle: ~4x the calibration loop. 12x still fails on a ~3x slowdown and on
// anything super-linear in the nesting depth.
test('handles a 1MB adversarial document (deeply nested unclosed tags + repeated text) within a calibrated CPU budget', () => {
  const hostile = '<div><span><b>'.repeat(25000) + 'word '.repeat(200000);
  assert.ok(Buffer.byteLength(hostile, 'utf8') > 1024 * 1024, 'fixture should be > 1MB');
  const { res, ok, ratios } = runWithinCpuBudget({ html: hostile, mode: 'text' }, 12);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(ok, `over budget (expected < 12x) on every attempt: ${ratios.join('; ')}`);
});

test('rejects malformed input: missing html', () => {
  const res = run({ mode: 'text' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: bad mode', () => {
  const res = run({ html: '<p>hi</p>', mode: 'pdf' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json at all');
  assert.notEqual(res.status, 0);
});

test('null/empty stdin is rejected cleanly, not a crash', () => {
  const res = run('');
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.length > 0);
});

test('a previously-overflowing document (huge body text) is capped at 400k chars with truncated:true, output well under 1MB', () => {
  // Plain prose, no markup tricks — just an ordinary document that happens
  // to be big. Before the cap, this would render >1MB of text alone and
  // blow the runner's 1MB stdout ceiling (self-quarantining the tool after
  // 3 such runs).
  const html = `<article><p>${'lorem ipsum dolor sit amet '.repeat(100000)}</p></article>`;
  const res = run({ html, mode: 'text' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') < 1_000_000, `stdout was ${res.stdout.length} bytes, expected < 1MB`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 400_000, `text.length was ${out.text.length}, expected <= 400000`);
});

test('a previously-overflowing document (huge link count) is capped at 2000 links with truncated:true', () => {
  const html = Array.from({ length: 5000 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('');
  const res = run({ html, mode: 'text' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, true);
  assert.equal(out.links.length, 2000);
});

test('ordinary small documents are not marked truncated', () => {
  const res = run({ html: '<p>Small doc.</p>', mode: 'text' });
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, false);
});

function extract(html, mode = 'text') {
  const res = run({ html, mode });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).text;
}

test('source newlines inside a paragraph are whitespace, not line breaks', () => {
  assert.equal(extract('<p>Hello\n   world, this is\n  wrapped.</p><p>a<br>b</p>'), 'Hello world, this is wrapped.\n\na\nb');
});

test('<pre> content keeps its indentation and internal spacing', () => {
  const md = extract('<p>x</p><pre>\n  def f():\n    return  1\n</pre>', 'markdown');
  assert.equal(md, 'x\n\n```\n  def f():\n    return  1\n```');
  assert.equal(extract('<pre><code>x = 1\n  y</code></pre>'), 'x = 1\n  y');
});

test('a document cannot forge the internal <pre> placeholder', () => {
  const out = extract('<p>0 tail</p><pre>code</pre>');
  assert.equal(out, '0 tail\n\ncode');
});

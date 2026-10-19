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

test("'fbr' ranks 'foo/bar' (word-boundary hits) above 'fxxbxxr' (no boundaries)", () => {
  const res = run({ query: 'fbr', candidates: ['foo/bar', 'fxxbxxr'] });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 2);
  assert.equal(out.matches[0].value, 'foo/bar');
  assert.ok(out.matches[0].score > out.matches[1].score);
});

test("'cc' hits the two capital C's in 'CamelCase' (boundary + camelCase bonus)", () => {
  const res = run({ query: 'cc', candidates: ['CamelCase'] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 1);
  const { positions } = out.matches[0];
  assert.equal(positions.length, 2);
  assert.equal('CamelCase'[positions[0]].toLowerCase(), 'c');
  assert.equal('CamelCase'[positions[1]].toLowerCase(), 'c');
  assert.notEqual(positions[0], positions[1]);
  // both matched characters should in fact be the uppercase C's (index 0 and 5)
  assert.deepEqual(positions, [0, 5]);
});

test('non-subsequence queries produce no match', () => {
  const res = run({ query: 'xyz', candidates: ['abc', 'zyx'] });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.matches, []);
});

test('candidates as objects with a dotted key path', () => {
  const res = run({
    query: 'ab',
    candidates: [{ meta: { name: 'abc' } }, { meta: { name: 'zzz' } }],
    key: 'meta.name',
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 1);
  assert.deepEqual(out.matches[0].value, { meta: { name: 'abc' } });
});

test('stable ordering: equal-scoring candidates keep their original relative order', () => {
  // 'a' as a lone char at position 0 scores identically for both single-letter strings.
  const res = run({ query: 'a', candidates: ['a', 'a', 'a'] });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.matches.map((m) => m.index), [0, 1, 2]);
});

test('limit caps the number of results, keeping the best-scoring ones', () => {
  const res = run({ query: 'a', candidates: ['xa', 'a', 'xxa'], limit: 1 });
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].value, 'a'); // boundary bonus wins over the others
});

test('smart case: lowercase query matches any case, uppercase query is case-sensitive', () => {
  const insensitive = JSON.parse(run({ query: 'abc', candidates: ['ABC'] }).stdout);
  assert.equal(insensitive.matches.length, 1);
  const sensitive = JSON.parse(run({ query: 'ABC', candidates: ['abc'] }).stdout);
  assert.equal(sensitive.matches.length, 0);
});

// --- performance guard ----------------------------------------------------
//
// An absolute wall-clock budget ("10k candidates in under 200ms") flakes
// under full-suite load: on a loaded, swapping machine the same run takes
// 330-3400ms, nearly all of it spent waiting on the scheduler and on page-ins
// rather than computing. So instead of wall-clock, PROBE is preloaded into the
// tool's own process (via --import; tool.js itself is untouched) and measures
// two things there in CPU time, which excludes that waiting:
//   - calibMs: a fixed calibration loop, run before the tool starts — a
//     yardstick for how fast this machine and process are right now;
//   - workMs:  CPU the tool spends from then until exit (parse, score, sort,
//     serialize).
// The tests assert workMs relative to calibMs (and relative to a smaller run),
// never an absolute number. Each size is measured several times, interleaved,
// and the minimum kept, so one descheduled run can't decide the result.
const PROBE = `
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
const PROBE_URL = `data:text/javascript,${encodeURIComponent(PROBE)}`;

function perfCandidates(n) {
  const words = ['foo', 'bar', 'baz', 'quux', 'corge', 'grault', 'garply', 'waldo', 'fred', 'plugh'];
  const candidates = [];
  for (let i = 0; i < n; i += 1) {
    candidates.push(`${words[i % words.length]}/${words[(i * 3) % words.length]}-${i}.txt`);
  }
  return candidates;
}

function probedRun(input) {
  const res = spawnSync(process.execPath, ['--import', PROBE_URL, TOOL], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stderr.split('\n').find((l) => l.startsWith('CPU_PROBE '));
  assert.ok(line, `CPU probe reported nothing; stderr was: ${res.stderr}`);
  return JSON.parse(line.slice('CPU_PROBE '.length));
}

/** Min-of-ROUNDS CPU measurements for each candidate count, interleaved. */
function measure(sizes, rounds = 3) {
  const inputs = sizes.map((n) => ({ query: 'foobar', candidates: perfCandidates(n) }));
  const best = sizes.map(() => ({ calibMs: Infinity, workMs: Infinity }));
  for (let r = 0; r < rounds; r += 1) {
    inputs.forEach((input, k) => {
      const m = probedRun(input);
      best[k].calibMs = Math.min(best[k].calibMs, m.calibMs);
      best[k].workMs = Math.min(best[k].workMs, m.workMs);
    });
  }
  return best;
}

const perf = measure([0, 1000, 10000]);

// Idle on an M-series Mac: ~115ms CPU for 10k against a ~31ms calibration
// loop, i.e. ~3.7x. Under heavy load the ratio drops (~2.5x — the calibration
// loop suffers more from contention than the tool does), so load only moves it
// away from the bound. 10x leaves headroom for slower machines while still
// failing on a ~3x slowdown of the tool itself.
test('10,000 candidates score and sort in under 10x a calibrated CPU baseline', () => {
  const [, , big] = perf;
  const ratio = big.workMs / big.calibMs;
  assert.ok(
    ratio < 10,
    `10k candidates took ${big.workMs.toFixed(1)}ms CPU vs a ${big.calibMs.toFixed(1)}ms calibration loop (${ratio.toFixed(2)}x, expected < 10x)`,
  );
});

// Linear in the candidate count: 10x the candidates must cost well under
// 25x the work (fixed startup cost, measured with no candidates, subtracted).
// Observed ~6-8x; a quadratic regression would be ~100x.
test('scoring scales linearly: 10x the candidates costs under 25x the CPU', () => {
  const [empty, small, big] = perf;
  const smallWork = Math.max(small.workMs - empty.workMs, 1);
  const bigWork = big.workMs - empty.workMs;
  const ratio = bigWork / smallWork;
  assert.ok(
    ratio < 25,
    `1k -> 10k candidates went ${smallWork.toFixed(1)}ms -> ${bigWork.toFixed(1)}ms CPU (${ratio.toFixed(2)}x, expected < 25x)`,
  );
});

test('rejects malformed input: missing query', () => {
  const res = run({ candidates: ['a'] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: candidates not an array', () => {
  const res = run({ query: 'a', candidates: 'not-an-array' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: object candidates without a key', () => {
  const res = run({ query: 'a', candidates: [{ name: 'abc' }] });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json');
  assert.notEqual(res.status, 0);
});

test('empty query matches everything with score 0 and no positions', () => {
  const res = run({ query: '', candidates: ['a', 'b'] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 2);
  assert.ok(out.matches.every((m) => m.score === 0 && m.positions.length === 0));
});

test('empty candidates array yields no matches, not an error', () => {
  const res = run({ query: 'a', candidates: [] });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.matches, []);
});

// --- fix: unbounded output (default/hard-capped limit, value size cap) ----

test('defaults to 50 results when limit is omitted, on a candidate list with far more than 50 matches', () => {
  const candidates = Array.from({ length: 500 }, (_, i) => `abc-${i}`);
  const res = run({ query: 'abc', candidates });
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 50);
  assert.equal(out.truncated, true);
});

test('limit is hard-capped at 1000 even when a larger value is requested', () => {
  const candidates = Array.from({ length: 5000 }, (_, i) => `abc-${i}`);
  const res = run({ query: 'abc', candidates, limit: 100000 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.matches.length, 1000);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') < 1_000_000);
});

test('truncated is false when every match fits within the limit', () => {
  const res = run({ query: 'a', candidates: ['a', 'b', 'ab'] });
  const out = JSON.parse(res.stdout);
  assert.equal(out.truncated, false);
});

test('a candidate whose serialized value exceeds 200 characters is echoed index-only (value:null, valueOmitted:true)', () => {
  const bigString = 'ab' + 'x'.repeat(300);
  const res = run({ query: 'ab', candidates: ['ab', bigString] });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const big = out.matches.find((m) => m.index === 1);
  assert.ok(big, 'expected the big candidate to still match');
  assert.equal(big.value, null);
  assert.equal(big.valueOmitted, true);
  assert.equal(typeof big.index, 'number');

  const small = out.matches.find((m) => m.index === 0);
  assert.equal(small.value, 'ab');
  assert.equal(small.valueOmitted, false);
});

test('a huge candidate list with huge values stays well under 1MB stdout', () => {
  const candidates = Array.from({ length: 2000 }, (_, i) => `abc-${i}-` + 'y'.repeat(500));
  const res = run({ query: 'abc', candidates, limit: 1000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') < 1_000_000, `stdout was ${res.stdout.length} bytes, expected < 1MB`);
  const out = JSON.parse(res.stdout);
  assert.ok(out.matches.every((m) => m.valueOmitted === true && m.value === null));
});

test('positions stay aligned when lowercasing a character would change the string length', () => {
  // "İ".toLowerCase() is two UTF-16 units ("i" + combining dot); a whole-string
  // toLowerCase shifted every later index by one per "İ".
  const res = run({ query: 'stan', candidates: ['İİstanbul'] });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.matches[0].positions, [2, 3, 4, 5]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function call(input) {
  const res = run(input);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('* does not cross a directory boundary, ** does', () => {
  const out = call({ patterns: ['a/*.js', 'b/**/*.js'], paths: ['a/x.js', 'a/y/x.js', 'b/x.js', 'b/y/z/x.js'] });
  assert.deepEqual(out.matches['a/*.js'], ['a/x.js']);
  assert.deepEqual(out.matches['b/**/*.js'].sort(), ['b/x.js', 'b/y/z/x.js']);
});

test('brace expansion matches any alternative', () => {
  const out = call({ patterns: ['src/*.{js,ts}'], paths: ['src/a.js', 'src/a.ts', 'src/a.md'] });
  assert.deepEqual(out.matches['src/*.{js,ts}'].sort(), ['src/a.js', 'src/a.ts']);
  assert.deepEqual(out.unmatched, ['src/a.md']);
});

test('negation removes paths a positive pattern matched', () => {
  const out = call({ patterns: ['**/*.ts', '!**/*.test.ts'], paths: ['a.ts', 'a.test.ts', 'x/b.ts'] });
  assert.deepEqual(out.matches['**/*.ts'].sort(), ['a.ts', 'x/b.ts']);
  assert.ok(out.unmatched.includes('a.test.ts'));
});

test('dotfile default-exclusion: * and ** skip dotfiles unless dot:true', () => {
  const withoutDot = call({ patterns: ['*.js', '**/*.js'], paths: ['.hidden.js', 'shown.js'] });
  assert.equal(withoutDot.matches['*.js'].includes('.hidden.js'), false);
  assert.equal(withoutDot.matches['*.js'].includes('shown.js'), true);

  const withDot = call({ patterns: ['*.js'], paths: ['.hidden.js'], dot: true });
  assert.deepEqual(withDot.matches['*.js'], ['.hidden.js']);
});

test('character range [a-c] and negated class [!a-c]', () => {
  const out = call({ patterns: ['file[a-c].txt'], paths: ['filea.txt', 'fileb.txt', 'filed.txt'] });
  assert.deepEqual(out.matches['file[a-c].txt'].sort(), ['filea.txt', 'fileb.txt']);

  const neg = call({ patterns: ['file[!a-c].txt'], paths: ['filea.txt', 'filed.txt'] });
  assert.deepEqual(neg.matches['file[!a-c].txt'], ['filed.txt']);
});

test('? matches exactly one character within a segment', () => {
  const out = call({ patterns: ['a?.txt'], paths: ['ab.txt', 'a.txt', 'abc.txt'] });
  assert.deepEqual(out.matches['a?.txt'], ['ab.txt']);
});

test('** alone matches everything including nested paths, ** with trailing segment requires a match', () => {
  const out = call({ patterns: ['**'], paths: ['a', 'a/b', 'a/b/c'] });
  assert.deepEqual(out.matches['**'].sort(), ['a', 'a/b', 'a/b/c']);
});

test('trailing /** matches the directory itself and everything inside it', () => {
  const out = call({ patterns: ['foo/**'], paths: ['foo', 'foo/bar', 'foo/bar/baz', 'other'] });
  assert.deepEqual(out.matches['foo/**'].sort(), ['foo', 'foo/bar', 'foo/bar/baz']);
});

test('rejects malformed input: empty patterns array', () => {
  const res = run({ patterns: [], paths: ['a'] });
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

// --- CPU-time budget --------------------------------------------------------
//
// Wall-clock budgets here flaked under full-suite load on a swapping machine,
// where elapsed time is mostly waiting on the scheduler and on page-ins. These
// guards measure CPU time instead (process.cpuUsage) and compare it with a
// fixed calibration loop run right beside it in the same process — a yardstick
// for how fast the machine is right now — never an absolute number. Up to
// three attempts, so one descheduled run can't decide it; a real blow-up
// (exponential backtracking, an unbounded matrix) fails every attempt.
function cpuMs(fn) {
  const c0 = process.cpuUsage();
  const value = fn();
  const u = process.cpuUsage(c0);
  return { value, ms: (u.user + u.system) / 1000 };
}

function calibrationLoop() {
  let acc = 0;
  const buf = new Float64Array(4096);
  const s = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let r = 0; r < 2000; r += 1) {
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = buf[i] * 0.5 + (s[i % 36] === s[r % 36] ? r : i);
      acc += buf[i];
    }
  }
  return acc;
}

/** Run fn until its CPU time is under maxRatio x the calibration loop's (up to 3 tries). */
function withinCpuBudget(fn, maxRatio) {
  const ratios = [];
  let value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const calib = cpuMs(calibrationLoop).ms;
    const work = cpuMs(fn);
    value = work.value;
    ratios.push(`${work.ms.toFixed(1)}ms CPU vs ${calib.toFixed(1)}ms calibration = ${(work.ms / calib).toFixed(2)}x`);
    if (work.ms / calib < maxRatio) return { value, ok: true, ratios };
  }
  return { value, ok: false, ratios };
}

// The subprocess variant: CPU_PROBE is preloaded into the tool's own process
// (via --import; the tool is untouched) and reports the calibration loop and
// the tool's work, both in that child's CPU time.
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

// Idle: well under 0.1x the calibration loop; exponential backtracking is
// orders of magnitude past the 1x line.
test('a pathological pattern against a long path completes well under budget (ReDoS-conscious)', async () => {
  // Import the compiled matcher directly, in-process, so the timing budget
  // reflects the matching algorithm itself rather than node's own startup
  // cost (which a subprocess round trip would fold in).
  const mod = await import(pathToFileURL(TOOL).href);
  const evilPattern = `${'*a'.repeat(30)}!`; // many sequential [^/]* tokens, none of which can match
  const evilPath = `${'b'.repeat(5000)}!`;
  const { value: matched, ok, ratios } = withinCpuBudget(() => mod.matchOne(evilPattern, evilPath, false), 1);
  assert.equal(matched, false);
  assert.ok(ok, `matching over budget (expected < 1x calibration): ${ratios.join('; ')}`);
});

test('the classic a*a*a*a*a*b ReDoS shape against 1000 a\'s stays within a calibrated CPU budget, in-process and via the subprocess', async () => {
  const mod = await import(pathToFileURL(TOOL).href);
  const evilPattern = 'a*a*a*a*a*b'; // sequential [^/]* tokens; catastrophic for a naive regex compile
  const evilPath = 'a'.repeat(1000); // never ends in 'b', forces maximal backtracking
  const { value: matched, ok, ratios } = withinCpuBudget(() => mod.matchOne(evilPattern, evilPath, false), 1);
  assert.equal(matched, false);
  assert.ok(ok, `matching over budget (expected < 1x calibration): ${ratios.join('; ')}`);

  // Also exercise the real subprocess path end-to-end, with a tighter wall
  // clock than the tool's own 30s+ pre-fix hang would allow.
  // whole-process CPU time (startup included) against a calibration loop run
  // inside that same child; the tool's pre-fix 30s+ hang would be ~1000x.
  const { res, ok: subOk, ratios: subRatios } = runWithinCpuBudget({ patterns: [evilPattern], paths: [evilPath] }, 10);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).matches[evilPattern], []);
  assert.ok(subOk, `subprocess match over budget (expected < 10x): ${subRatios.join('; ')}`);
});

test('brace expansion beyond 1024 total patterns is refused cleanly, not a stack overflow', () => {
  const bomb = '{a,b}'.repeat(18); // 2^18 = 262144 combinations
  const res = run({ patterns: [bomb], paths: ['a'] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /brace expansion produced more than 1024 patterns/);
  assert.doesNotMatch(res.stderr, /Maximum call stack/);
});

test('an invalid character-class range like [z-a] is refused with a clean error', () => {
  const res = run({ patterns: ['file[z-a].txt'], paths: ['filea.txt'] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /invalid glob pattern/);
});

test('a literal brace pair with no comma does not stop a later real group from expanding', () => {
  const out = call({ patterns: ['{abc}{x,y}', 'a{b}c/{d,e}', '{x{a,b}}'], paths: ['{abc}x', '{abc}y', 'a{b}c/e', '{xb}', 'abc/d'] });
  assert.deepEqual(out.matches['{abc}{x,y}'], ['{abc}x', '{abc}y']);
  assert.deepEqual(out.matches['a{b}c/{d,e}'], ['a{b}c/e']);
  assert.deepEqual(out.matches['{x{a,b}}'], ['{xb}']);
  assert.deepEqual(out.unmatched, ['abc/d']);
});

test('character class: a "]" first in the class is a literal member (POSIX)', () => {
  const out = call({ patterns: ['[]a]', '[!]a]x'], paths: [']', 'a', 'b', 'bx', ']x'] });
  assert.deepEqual(out.matches['[]a]'], [']', 'a']);
  assert.deepEqual(out.matches['[!]a]x'], ['bx']);
});

test('a pattern named "__proto__" is reported under its own key', () => {
  const out = call({ patterns: ['__proto__'], paths: ['__proto__', 'x'] });
  assert.deepEqual(Object.keys(out.matches), ['__proto__']);
  assert.deepEqual(out.matches['__proto__'], ['__proto__']);
});

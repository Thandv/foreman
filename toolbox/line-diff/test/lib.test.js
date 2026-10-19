// Ported from the author's earlier tools.
import assert from 'node:assert/strict';
import test from 'node:test';
import { unifiedDiff } from '../lib.js';

test('proposal diff preserves ordinary additions and removals', () => {
  const lines = unifiedDiff('alpha\nbeta\ngamma', 'alpha\nnew\ngamma');
  assert.deepEqual(lines, [
    { kind: 'same', text: 'alpha' },
    { kind: 'remove', text: 'beta' },
    { kind: 'add', text: 'new' },
    { kind: 'same', text: 'gamma' },
  ]);
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

// Idle: the bounded fallback costs ~0.1x the calibration loop; the full
// 8,000 x 8,000 matrix it replaces would be many times the loop. 3x is the line.
test('line-dense proposals cannot allocate an unbounded matrix or DOM', () => {
  const before = Array.from({ length: 8_000 }, (_, index) => `before-${index}`).join('\n');
  const after = Array.from({ length: 8_000 }, (_, index) => `after-${index}`).join('\n');
  const { value: lines, ok, ratios } = withinCpuBudget(() => unifiedDiff(before, after), 3);
  assert.ok(ok, `large diff should take the bounded fallback (expected < 3x calibration): ${ratios.join('; ')}`);
  assert.ok(lines.length <= 4_000);
  assert.ok(lines.some((line) => line.kind === 'note' && /omitted/.test(line.text)));
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bestCheckpoint, parseValCurve, promoteBestCheckpoint } from '../src/align/governor.ts';

/**
 * mlx-lm writes `{iter}_adapters.safetensors` as it goes and leaves the final
 * state in `adapters.safetensors`. Reading only the LAST reported val loss and
 * shipping only the FINAL adapter means that once validation bottoms out and
 * drifts back up — the normal shape of a run, and observed on this corpus at
 * iteration 200 of 1200 — every later iteration makes the shipped adapter
 * worse while the number reported about it gets worse too. The good adapter
 * was on disk the whole time and was passed over.
 */

const LOG = [
  '  Iter 1: Val loss 4.045, Val took 110.787s',
  '  Iter 100: Train loss 3.4',
  '  Iter 200: Val loss 3.066, Val took 136.814s',
  '  Iter 300: Train loss 2.9',
  '  Iter 400: Val loss 3.086, Val took 149.186s',
  '  Iter 600: Val loss 3.240, Val took 150.0s',
].join('\n');

/**
 * `live` is what `adapters.safetensors` holds. It matters which checkpoint that
 * is: mlx-lm saves on its own interval, so a run interrupted between two
 * validations leaves the live adapter holding a state nothing ever measured.
 * Defaults to the last checkpoint, which is what a run that finished normally
 * leaves behind.
 */
function withAdapters(iters: number[], fn: (dir: string) => void, live?: number): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ckpt-'));
  try {
    for (const i of iters) {
      fs.writeFileSync(path.join(dir, `${String(i).padStart(7, '0')}_adapters.safetensors`), `ckpt-${i}`);
    }
    const liveIter = live ?? iters[iters.length - 1]!;
    fs.writeFileSync(path.join(dir, 'adapters.safetensors'), `ckpt-${liveIter}`);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the whole validation curve is read, not just its last point', () => {
  assert.deepEqual(parseValCurve(LOG), [
    { iter: 1, valid: 4.045 },
    { iter: 200, valid: 3.066 },
    { iter: 400, valid: 3.086 },
    { iter: 600, valid: 3.24 },
  ]);
});

test('the best checkpoint is found even when training ran long past it', () => {
  withAdapters([100, 200, 300, 400, 600], (dir) => {
    const best = bestCheckpoint(LOG, dir);
    assert.equal(best?.iter, 200);
    assert.equal(best?.valid, 3.066);
    assert.equal(best?.finalValid, 3.24, 'and it knows what it is beating');
  });
});

test('promotion keeps the final state rather than destroying it', () => {
  withAdapters([100, 200, 300, 400, 600], (dir) => {
    const r = promoteBestCheckpoint(LOG, dir);
    assert.equal(r.promoted, true);
    assert.equal(fs.readFileSync(path.join(dir, 'adapters.safetensors'), 'utf8'), 'ckpt-200');
    assert.equal(
      fs.readFileSync(path.join(dir, 'final_adapters.safetensors'), 'utf8'), 'ckpt-600',
      'the state training ended in must survive: this should not be irreversible on a hunch about two numbers',
    );
    assert.match(r.note, /iteration-200/);
  });
});

test('a run whose last checkpoint IS the best changes nothing', () => {
  const improving = [
    '  Iter 200: Val loss 3.5, Val took 1s',
    '  Iter 400: Val loss 3.0, Val took 1s',
  ].join('\n');
  withAdapters([200, 400], (dir) => {
    assert.equal(bestCheckpoint(improving, dir), null);
    const r = promoteBestCheckpoint(improving, dir);
    assert.equal(r.promoted, false);
    assert.equal(fs.readFileSync(path.join(dir, 'adapters.safetensors'), 'utf8'), 'ckpt-400');
    assert.equal(fs.existsSync(path.join(dir, 'final_adapters.safetensors')), false, 'no stray copy on the happy path');
  });
});

test('a best checkpoint that was never written to disk is not promoted', () => {
  // The save interval and the eval interval are configured separately and need
  // not line up, so the best-validating iteration may have no file at all.
  withAdapters([400, 600], (dir) => {
    assert.equal(bestCheckpoint(LOG, dir), null, 'iteration 200 has no checkpoint here');
    assert.equal(promoteBestCheckpoint(LOG, dir).promoted, false);
  });
});

test('a run with too few validations to have a curve is left alone', () => {
  withAdapters([100], (dir) => {
    assert.equal(bestCheckpoint('  Iter 1: Val loss 4.0, Val took 1s', dir), null);
    assert.equal(bestCheckpoint('', dir), null);
  });
});

test('a run interrupted between validations does not ship the unvalidated state', () => {
  // Observed for real: validations at 1/200/400/600, best at 600, and training
  // killed at 720 — so `adapters.safetensors` held iteration 700, which nothing
  // ever measured. Comparing only the validation curve said "the final IS the
  // best" and shipped the unvalidated one.
  const log = [
    '  Iter 1: Val loss 4.232, Val took 1s',
    '  Iter 200: Val loss 3.482, Val took 1s',
    '  Iter 400: Val loss 3.498, Val took 1s',
    '  Iter 600: Val loss 3.448, Val took 1s',
  ].join('\n');
  withAdapters([200, 400, 600, 700], (dir) => {
    const r = promoteBestCheckpoint(log, dir);
    assert.equal(r.promoted, true, r.note);
    assert.equal(
      fs.readFileSync(path.join(dir, 'adapters.safetensors'), 'utf8'), 'ckpt-600',
      'the last VALIDATED checkpoint must be what ships',
    );
  }, 700);
});

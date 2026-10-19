import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import {
  agreementReport, MAX_FALSE_PASS_RATE, MIN_AGREEMENT, MIN_AUTHORITATIVE_FAILS, MIN_SAMPLES,
  scorePairs, shadowEnabled, type ShadowPair,
} from '../src/agreement.ts';

const store = (): Store => new Store(':memory:');

const pair = (over: Partial<ShadowPair> = {}): ShadowPair => ({
  taskId: 't', playbook: 'publishing', role: 'author',
  authoritative: 'pass', shadow: 'pass', at: 0, ...over,
});

/** n pairs where the two reviewers agreed on a PASS. */
const agreeing = (n: number, from = 0): ShadowPair[] =>
  Array.from({ length: n }, (_, i) => pair({ taskId: `t${from + i}`, at: from + i }));

/**
 * n pairs where both reviewers said FAIL.
 *
 * Every ready-making sample needs some of these. Agreement measured only on
 * approvals says nothing about whether the local reviewer can say no, and a
 * reviewer that never says no is the one this gate exists to keep out.
 */
const agreeingOnFail = (n: number, from = 500): ShadowPair[] =>
  Array.from({ length: n }, (_, i) => pair({
    taskId: `f${from + i}`, at: from + i, authoritative: 'fail', shadow: 'fail',
  }));

test('a perfect record still is not ready below the sample floor', () => {
  // The failure this guards: retiring a gate on eight samples. Eight samples
  // cannot distinguish a 90% reviewer from a 70% one.
  const s = scorePairs(agreeing(MIN_SAMPLES - 1), 'publishing', 'author');
  assert.equal(s.agreementRate, 1);
  assert.equal(s.ready, false);
  assert.match(s.blockers.join(' '), /samples/);
});

test('enough samples at full agreement is ready', () => {
  const s = scorePairs([...agreeing(MIN_SAMPLES), ...agreeingOnFail(MIN_AUTHORITATIVE_FAILS)], 'publishing', 'author');
  assert.equal(s.ready, true, s.blockers.join('; '));
  assert.deepEqual(s.blockers, []);
});

test('a reviewer that never says no is refused, however well it agrees', () => {
  // The hole this closes: 30 samples the cloud also passed gives 100%
  // agreement and zero false passes, so the criterion was satisfiable by a
  // reviewer that says pass to everything — precisely the one it exists to
  // keep out. The false-pass rate cannot be measured on a sample that contains
  // nothing to fail.
  const yesman = scorePairs(agreeing(MIN_SAMPLES + 5), 'publishing', 'author');
  assert.equal(yesman.agreementRate, 1);
  assert.equal(yesman.falsePasses, 0);
  assert.equal(yesman.ready, false);
  assert.match(yesman.blockers.join(' '), /never says no|cloud FAILED/);

  // ...and one that does say no, correctly, is ready.
  const real = scorePairs([...agreeing(MIN_SAMPLES), ...agreeingOnFail(MIN_AUTHORITATIVE_FAILS)], 'publishing', 'author');
  assert.equal(real.authoritativeFails, MIN_AUTHORITATIVE_FAILS);
  assert.equal(real.ready, true);
});

test('a single false pass blocks a record that clears every other bar', () => {
  // The asymmetry the whole module turns on. This sample agrees far more often
  // than the threshold — and is still not ready, because the one disagreement
  // is the direction that lands bad work after the cutover.
  // 30 agreements + 2 false passes: 93% agreement (past the 90% bar) but a
  // false-pass rate of 1-in-16, which is twice what the criterion allows.
  const pairs = [
    ...agreeing(MIN_SAMPLES),
    ...Array.from({ length: 2 }, (_, i) => pair({ taskId: `fp${i}`, shadow: 'pass', authoritative: 'fail', at: 1000 + i })),
  ];
  const s = scorePairs(pairs, 'publishing', 'author');
  assert.ok(s.agreementRate > MIN_AGREEMENT, 'overall agreement is comfortably past the bar');
  assert.ok(s.falsePassRate > MAX_FALSE_PASS_RATE);
  assert.equal(s.ready, false);
  assert.match(s.blockers.join(' '), /false pass/);
});

test('a false FAIL is counted but does not block — it is expensive, not dangerous', () => {
  // Local said fail, cloud said pass: buys a repair round nobody needed. The
  // human gate still sees the work, so it cannot land anything bad.
  const pairs = [
    ...agreeing(MIN_SAMPLES * 3),
    ...agreeingOnFail(MIN_AUTHORITATIVE_FAILS),
    pair({ taskId: 'ff', shadow: 'fail', authoritative: 'pass', at: 9999 }),
  ];
  const s = scorePairs(pairs, 'publishing', 'author');
  assert.equal(s.falseFails, 1);
  assert.equal(s.falsePasses, 0);
  assert.equal(s.ready, true, 'a cautious local reviewer is not a reason to keep the cloud gate');
});

test('a local reviewer that cannot form an opinion is a non-agreement, not a free pass', () => {
  const pairs = [
    ...agreeing(20),
    ...Array.from({ length: 20 }, (_, i) => pair({ taskId: `sp${i}`, shadow: 'split', at: 100 + i })),
  ];
  const s = scorePairs(pairs, 'publishing', 'author');
  assert.equal(s.shadowSplits, 20);
  assert.equal(s.agreementRate, 0.5);
  assert.equal(s.ready, false);
});

test('the trend is what says whether the local models are improving', () => {
  // Older half disagrees, recent half agrees: exactly the shape the operator
  // is watching for between now and the cutover.
  const older: ShadowPair[] = Array.from({ length: 10 }, (_, i) =>
    pair({ taskId: `o${i}`, shadow: 'fail', authoritative: 'pass', at: i }));
  const recent = agreeing(10, 100);
  const s = scorePairs([...older, ...recent], 'publishing', 'author');
  assert.equal(s.recentAgreementRate, 1);
  assert.ok(s.trend !== null && s.trend > 0.9, `expected a strong positive trend, got ${s.trend}`);

  // And the reverse must read as a regression, not as noise.
  const worsening = scorePairs([...agreeing(10), ...older.map((p, i) => ({ ...p, at: 100 + i }))], 'publishing', 'author');
  assert.ok(worsening.trend !== null && worsening.trend < 0);
});

test('a trend needs two halves; one sample reports null rather than a made-up number', () => {
  const s = scorePairs([pair()], 'publishing', 'author');
  assert.equal(s.trend, null);
});

test('roles are scored separately — a global average hides the decision', () => {
  const s = store();
  // One role the local reviewer matches, one it does not. Averaged together
  // they look mediocre; separately, one is ready and one is nowhere near.
  for (let i = 0; i < MIN_SAMPLES; i++) {
    // The copyeditor sample carries real rejections, so its agreement means
    // something; the dev-editor's are all false passes.
    const rejects = i < MIN_AUTHORITATIVE_FAILS;
    s.addShadowVerdict({
      taskId: `c${i}`, runId: 'r', playbook: 'publishing', role: 'copyeditor',
      authoritative: rejects ? 'fail' : 'pass', shadow: rejects ? 'fail' : 'pass',
    });
    s.addShadowVerdict({
      taskId: `d${i}`, runId: 'r', playbook: 'publishing', role: 'dev-editor',
      authoritative: 'fail', shadow: 'pass',
    });
  }
  const rows = agreementReport(s);
  const copy = rows.find((r) => r.role === 'copyeditor')!;
  const dev = rows.find((r) => r.role === 'dev-editor')!;
  assert.equal(copy.ready, true);
  assert.equal(dev.ready, false);
  assert.equal(dev.falsePasses, MIN_SAMPLES, 'every dev-editor disagreement is the dangerous direction');

  // The overall row exists for orientation and must not read as ready when a
  // constituent role is not.
  const all = rows.find((r) => r.role === 'ALL')!;
  assert.equal(all.ready, false);
  s.close();
});

test('shadow verdicts survive the deletion of the task they describe', () => {
  // Same argument as the archive's actuals: the comparison has to outlive the
  // rows it was derived from, or the evidence evaporates on the first prune.
  const s = store();
  const t = s.addTask({ title: 'chapter', prompt: 'x', playbook: 'publishing', role: 'author' });
  s.addShadowVerdict({
    taskId: t.id, runId: 'r1', playbook: 'publishing', role: 'author',
    authoritative: 'pass', shadow: 'pass',
  });
  s.deleteTask(t.id);
  assert.equal(s.shadowCount(), 1);
  assert.equal(s.shadowPairs().length, 1);
  s.close();
});

test('pairs come back oldest-first, so a trend is readable off them', () => {
  const s = store();
  for (const n of [3, 1, 2]) {
    s.addShadowVerdict({
      taskId: `t${n}`, runId: 'r', playbook: 'p', role: 'r',
      authoritative: 'pass', shadow: 'pass',
    });
    // Force distinct, out-of-insertion-order timestamps.
    s.db.prepare('UPDATE shadow_verdicts SET created_at = ? WHERE task_id = ?').run(n, `t${n}`);
  }
  assert.deepEqual(s.shadowPairs().map((p) => p.at), [1, 2, 3]);
  s.close();
});

test('recording is off by default, and its absence is distinguishable from no data', () => {
  assert.equal(shadowEnabled(), false);
  for (const v of ['1', 'true', 'yes', 'on']) {
    process.env['FOREMAN_SHADOW_LOCAL'] = v;
    assert.equal(shadowEnabled(), true, v);
  }
  delete process.env['FOREMAN_SHADOW_LOCAL'];
  assert.equal(shadowEnabled(), false);
});

test('an empty ledger reports no rows at all rather than a ready zero', () => {
  const s = store();
  assert.deepEqual(agreementReport(s), []);
  s.close();
});

test('the promotion criterion is what it says it is', () => {
  // Pinned deliberately. These thresholds were written before the first shadow
  // verdict was recorded; loosening one should be a visible, argued diff rather
  // than a quiet edit made while staring at a number that will not clear.
  assert.equal(MIN_SAMPLES, 30);
  assert.equal(MIN_AGREEMENT, 0.9);
  assert.ok(MAX_FALSE_PASS_RATE <= 1 / 30);
  assert.ok(MIN_AUTHORITATIVE_FAILS >= 5, 'agreement on approvals alone proves nothing');
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import {
  goldenProbesFor, judgeAbAnswers, JudgeUnavailable, scoreGolden, type AbAnswer, type ArmRunner,
} from '../src/align/adopt.ts';
import { isProseRole, PROSE_PROBES } from '../src/align/proseProbes.ts';
import { PROBES } from '../src/bench.ts';

/**
 * The adoption gate returned `0W 0L 8T` for publishing.author and that was read
 * for hours as "the adapter is indistinguishable from its base". It was not a
 * verdict at all: the judge call was pinned S2, every call to the named cloud
 * judge was refused, each refusal was caught, and each was counted as a tie.
 * The receipts were the only place that said so — `align-judge:error` x8.
 *
 * These are the two properties that make that impossible to repeat, plus the
 * separate defect it was hiding: an authoring adapter scored on code probes.
 */

const answers = (n: number): AbAnswer[] =>
  Array.from({ length: n }, (_, i) => ({ prompt: `p${i}`, candidateText: 'a', baseText: 'b' }));

/** A broker whose every model call fails, like an unreachable judge's. */
function brokenBroker(store: Store): Broker {
  const broker = new Broker(store);
  (broker as unknown as { call: unknown }).call = async () => {
    throw new Error('S2 task refused: alias runs on claude-cli (non-local)');
  };
  return broker;
}

test('a judge that answers nothing raises, and never reports a clean sweep of ties', async () => {
  const store = new Store(':memory:');
  await assert.rejects(
    judgeAbAnswers(brokenBroker(store), 'opus', answers(8)),
    (err: Error) => err instanceof JudgeUnavailable && /answered none of the 8/.test(err.message),
  );
  store.close();
});

test('even one failed judge call invalidates the result', async () => {
  // A partial failure is still not a verdict: the ties it contributes are
  // indistinguishable from real ones once they are counted.
  const store = new Store(':memory:');
  let n = 0;
  const broker = new Broker(store);
  (broker as unknown as { call: unknown }).call = async () => {
    if (++n === 3) throw new Error('judge fell over');
    return { text: '{"winner":"A"}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1 };
  };
  await assert.rejects(
    judgeAbAnswers(broker, 'opus', answers(6)),
    (err: Error) => err instanceof JudgeUnavailable && /failed on 1 of 6/.test(err.message),
  );
  store.close();
});

test('a working judge still returns a verdict, with the arms alternated', async () => {
  const store = new Store(':memory:');
  const broker = new Broker(store);
  // Always picks A. Because the candidate is A on even indices only, a judge
  // with a fixed position preference must come out even — that is what the
  // alternation is for.
  (broker as unknown as { call: unknown }).call = async () => ({
    text: '{"winner":"A"}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1,
  });
  const res = await judgeAbAnswers(broker, 'local-reason', answers(8));
  assert.equal(res.wins, 4);
  assert.equal(res.losses, 4);
  assert.equal(res.ties, 0);
  store.close();
});

test('an authoring persona is judged on prose probes, not on code-review diffs', () => {
  // The defect the ties were hiding: PROBES are syllogisms, diffs and JSON
  // fidelity. An adapter trained on novel prose cannot move them, so it scores
  // exactly its base — which is what 0.75 vs 0.75 was.
  assert.equal(goldenProbesFor('author'), PROSE_PROBES);
  assert.equal(goldenProbesFor('line-editor'), PROSE_PROBES);
  assert.equal(goldenProbesFor('dev'), PROBES);
  assert.equal(goldenProbesFor(null), PROBES);
  assert.ok(isProseRole('copyeditor'));
  assert.ok(!isProseRole('senior'));
});

/** An arm that always replies with `text`, so a probe set can be scored. */
const arm = (text: string): ArmRunner => ({ alias: 'stub', ask: async () => text });

test('the prose golden set separates a status report from actual prose', async () => {
  // Exactly the output the first corpus taught. The property that matters is
  // the SEPARATION, not an absolute floor: a single stub reply is scored
  // against all eight probes including two whose prompt it does not answer, so
  // it collects a couple of passes it has not earned. What must never happen is
  // a report scoring anywhere near prose.
  const report = 'Chapter 7 is drafted at Chapters/Book_Chapter_07.md — 3,872 words, close third.';
  const prose =
    'The clerk did not look up. Rain moved across the yard in sheets, and the smith had let his fire go ' +
    'grey an hour since. "Note it," Oswin said, and set his hand flat on the ledger so the page would ' +
    'not lift. He counted the wagons twice and made the number come out the same both times, which told ' +
    'him nothing he had not already known and everything about the man who had written it down. Outside, ' +
    'someone dropped a chain and swore, and the yard went back to its business without him.';
  const reportScore = await scoreGolden(arm(report), 'author');
  const proseScore = await scoreGolden(arm(prose), 'author');
  assert.ok(
    proseScore - reportScore >= 0.3,
    `prose (${proseScore}) must clear a status report (${reportScore}) by a wide margin`,
  );

  // And the old gate could not see the difference at all: the code probes score
  // both the same, which is how a persona trained on summaries passed them.
  const oldReport = await scoreGolden(arm(report), 'dev');
  const oldProse = await scoreGolden(arm(prose), 'dev');
  assert.equal(oldReport, oldProse, 'the code-review probes are blind to this distinction');
});

test('the prose golden set passes actual prose', async () => {
  const prose =
    'The clerk did not look up. Rain moved across the yard in sheets, and the smith had let his fire go ' +
    'grey an hour since. "Note it," Oswin said, and set his hand flat on the ledger so the page would ' +
    'not lift. He counted the wagons twice and made the number come out the same both times, which told ' +
    'him nothing he had not already known and everything about the man who had written it down. Outside, ' +
    'someone dropped a chain and swore, and the yard went back to its business without him.';
  const score = await scoreGolden(arm(prose), 'author');
  assert.ok(score >= 0.85, `prose should score well, got ${score}`);
});

test('the prose golden set catches the specific defects the old corpus taught', async () => {
  // Each of these is a real failure shape, and each must cost a point.
  const cases: Array<[string, string]> = [
    ['heading mid-scene', '# Scene Two\n\nHe walked to the gate and said nothing more about it.'],
    ['bullet list', '- He walked to the gate\n- He said nothing'],
    ['first person drift', 'I counted the wagons again and made the number come out the same for me.'],
    ['meta commentary', 'Here is the continuation. Let me know if you would like a different tone.'],
  ];
  for (const [label, text] of cases) {
    const score = await scoreGolden(arm(text), 'author');
    assert.ok(score < 1, `${label} should have cost a point, scored ${score}`);
  }
});

test('every prose probe is scored by code, never by a model', () => {
  // The rule bench.ts set, and the reason these numbers can be trusted.
  for (const probe of PROSE_PROBES) {
    assert.equal(typeof probe.score, 'function', probe.id);
    assert.equal(typeof probe.score(''), 'number', probe.id);
  }
});

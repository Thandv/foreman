import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { ModelUnavailable, TruncatedReply, reloadSpecs, resolveSpec } from '../src/models.ts';
import { chairRuled, runCouncil } from '../src/verify/council.ts';
import { triageDiff } from '../src/verify/triage.ts';
import { hardHumanReason } from '../src/gate.ts';
import { probeTask, type Run, type Verdict } from '../src/types.ts';

// A seat that answered nothing usable is a review the council did not give.
// Counting the survivor's PASS as the council's PASS is renormalising over the
// seats that happened to answer (the MoE failure mode: drop an expert, rescale
// the rest, and a lone — often the smallest — model decides alone). Such a
// round is a split: it climbs only to DIFFERENT advisors and never under memory
// pressure (runCouncil), otherwise it parks for a person.

const PASS = JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: ['naming nit in the helper'] });
const FAIL = JSON.stringify({ verdict: 'fail', confidence: 0.8, issues: ['off-by-one in the loop bound'] });
const EVIDENCE = { body: 'diff', bodyLabel: 'diff' as const, testsPassed: true };

/** A fixed reply, or one chosen by how many times this alias has been asked (1-based). */
type Reply = string | Error | ((n: number) => string | Error);

function setup(store: Store, kind: 'code' | 'writing' = 'code'): void {
  store.db.prepare(`INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','${kind}','api','S1','verifying',2,0,0)`).run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
}

/** Every alias answers PASS unless `replies` says otherwise; records which aliases were asked, in order. */
function broker(store: Store, replies: Record<string, Reply> = {}): { b: Broker; asked: string[] } {
  const asked: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async () => true,
    chatFn: async (o) => {
      asked.push(o.alias);
      const reply = replies[o.alias] ?? PASS;
      const out = typeof reply === 'function' ? reply(asked.filter((a) => a === o.alias).length) : reply;
      if (out instanceof Error) throw out;
      return { text: out, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  return { b, asked };
}

async function review(
  replies: Record<string, Reply>,
  opts: { localOnly?: boolean; kind?: 'code' | 'writing'; body?: string } = {},
): Promise<{ v: Verdict; asked: string[]; run: Run | null; notes: string[]; newest: Verdict | undefined }> {
  // The alias registry is cached: without a reload, a test run after an
  // auto-mode one still seats the cloud aliases even under local-only.
  if (opts.localOnly) process.env['FOREMAN_LOCAL_ONLY'] = '1';
  reloadSpecs();
  const store = new Store(':memory:');
  try {
    setup(store, opts.kind);
    const { b, asked } = broker(store, replies);
    const notes: string[] = [];
    const v = await runCouncil({
      store, broker: b, task: probeTask({ id: 't1', kind: opts.kind ?? 'code' }), runId: 'r1',
      evidence: { ...EVIDENCE, body: opts.body ?? EVIDENCE.body }, onNote: (l) => notes.push(l),
    });
    // As the scheduler does before parking at the gate (scheduler.ts, the gate block).
    store.endRun('r1', 'succeeded', { exitCode: 0, summary: 'done' });
    return { v, asked, run: store.getRun('r1'), notes, newest: store.verdictsForTask('t1')[0] };
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
    reloadSpecs();
    store.close();
  }
}

const usable = (v: Verdict): number => v.council.filter((o) => !o.error).length;

test('a lone PASS after an unparseable 2B at rung 0 is not a pass — it climbs to rung 1\'s different advisors, who decide', async () => {
  // Rung 0 seats local-fast + local-code; rung 1 seats local-code + local-reason.
  const { v, asked, newest, notes } = await review({ 'local-fast': 'Looks great to me, ship it!' });
  assert.ok(asked.includes('local-reason'), `climbed to rung 1: ${asked.join(',')}`);
  assert.equal(v.verdict, 'pass');
  assert.equal(usable(v), 2, 'the pass that stands was given by two advisors, not one');
  assert.equal(newest?.verdict, 'pass', "the run's newest verdict row is the decision");
  assert.ok(notes.some((n) => /asking rung 1's advisors/.test(n)), notes.join(' | '));
});

test('a lost-seat split records the survivor, names the lost seat, and is no disagreement', async () => {
  // Every rung loses the same seat: the climb hears no more advisors than rung 0 did.
  const { v } = await review({ 'local-fast': 'not json', 'local-reason': 'not json either' });
  assert.equal(v.verdict, 'split');
  assert.equal(v.disagreement, false, 'nobody disagreed and nobody ruled');
  assert.equal(v.provisional, false, 'a parse failure is not a memory problem');
  assert.match(v.chairSummary ?? '', /unparseable/);
  assert.match(v.chairSummary ?? '', /not a council decision/);
  assert.match(v.critique ?? '', /naming nit in the helper/, "the survivor's critique still reaches the gate");
  assert.equal(usable(v), 1);
});

test('prose: rung 1 seats the same two models (only the chair differs) — the lost seat parks, no replay', async () => {
  const { v, asked } = await review({ 'local-code': 'not json at all' }, { kind: 'writing' });
  assert.equal(v.verdict, 'split');
  assert.deepEqual([...asked].sort(), ['local-code', 'local-reason'], `two calls, no replay: ${asked.join(',')}`);
});

test('a seat lost to memory parks for the re-check even where a higher rung seats different advisors', async () => {
  // Not local-only: rung 1 (coder + 9B) differs from rung 0 (2B + coder), so only the memory rule stops the climb.
  const { v, asked } = await review({ 'local-fast': new ModelUnavailable('http://x/api/chat sent nothing for 180000ms') });
  assert.equal(v.verdict, 'split');
  assert.equal(v.provisional, true);
  assert.ok(!asked.includes('local-reason'), `did not climb under memory pressure: ${asked.join(',')}`);
});

test('a climb that hears from fewer advisors keeps the earlier verdict — as the run\'s newest row', async () => {
  // Rung 0: 2B off-contract, coder PASS. Rung 1: coder and 9B both unreachable.
  const down = (): Error => new Error('connect ECONNREFUSED 127.0.0.1:11434');
  const { v, newest } = await review({
    'local-fast': 'not json', 'local-code': (n) => (n === 1 ? PASS : down()), 'local-reason': down(),
  });
  assert.equal(v.verdict, 'split');
  assert.match(v.chairSummary ?? '', /a seat answered nothing usable/);
  assert.equal(usable(v), 1, 'the one reviewer who read it is not dropped');
  assert.equal(newest?.id, v.id, 'the gate, the board and the re-check read this same row');
  assert.equal(usable(newest!), 1);
  assert.match(newest!.critique ?? '', /naming nit/, "the survivor's critique comes back with it");
  assert.equal(newest!.disagreement, false);
});

test('an ordinary split whose climb loses a seat keeps the rung-0 FAIL in front of the operator', async () => {
  // Rung 0: 2B FAIL vs coder PASS, chair (9B) unreachable -> split, climbs.
  // Rung 1: the coder unreachable, the 9B PASS -> a lone PASS that must not bury the FAIL.
  const { v } = await review({
    'local-fast': FAIL,
    'local-code': (n) => (n === 1 ? PASS : new Error('connect ECONNREFUSED')),
    'local-reason': (n) => (n === 1 ? new Error('connect ECONNREFUSED') : PASS),
  });
  assert.equal(v.verdict, 'split');
  assert.equal(usable(v), 2);
  assert.ok(v.council.some((o) => o.verdict === 'fail' && /off-by-one/.test(o.critique)), JSON.stringify(v.council));
  assert.equal(v.disagreement, true, 'still the split the advisors had');
  assert.match(v.critique ?? '', /off-by-one/, 'the debate the gate shows comes back with it');
});

test("a higher rung's lone FAIL stands — it is not swapped for the earlier split", async () => {
  // Rung 0: 2B FAIL vs coder PASS, chair (9B) unreachable -> split, climbs.
  // Rung 1: the coder unreachable, the 9B FAIL -> fewer advisors, but a lone
  // FAIL stands wherever it is heard: the work goes to repair.
  const { v, newest } = await review({
    'local-fast': FAIL,
    'local-code': (n) => (n === 1 ? PASS : new Error('connect ECONNREFUSED')),
    'local-reason': (n) => (n === 1 ? new Error('connect ECONNREFUSED') : FAIL),
  });
  assert.equal(v.verdict, 'fail');
  assert.equal(newest?.id, v.id);
});

test("the store's verdict event says whether a chair ruled on a split, not just that there was one", () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'ollama', local: true, verdict, confidence: 0.9, critique: verdict, costUsd: 0, latencyMs: 1 });
    store.addVerdict({ runId: 'r1', taskId: 't1', verdict: 'split', disagreement: true, council: [op('pass'), op('fail')], chairSummary: 'no independent chair at this rung: handing up' });
    store.addVerdict({ runId: 'r1', taskId: 't1', verdict: 'pass', disagreement: true, council: [op('pass'), op('fail')], chairSummary: 'the second reviewer misread the anchor' });
    const lines = store.eventsForTask('t1').filter((e) => e.type === 'verdict').map((e) => e.message);
    assert.deepEqual(lines, ['council: split (split, no ruling)', 'council: pass (split, chair ruled)']);
  } finally {
    store.close();
  }
});

test('a reinstated verdict keeps its provisional mark, so the re-check sweep still finds it', async () => {
  // Rung 0: 2B FAIL vs coder PASS; the chair (9B) stalls for memory and its
  // step-down (the 2B) is unreachable -> a provisional split, which climbs.
  // Rung 1: the coder unreachable, the 9B's seat answered by its step-down ->
  // fewer advisors, so the rung-0 split is written again — still provisional,
  // or the sweep that re-asks memory-hit reviews never sees it.
  const { v, newest, notes } = await review({
    'local-fast': (n) => (n === 1 ? FAIL : n === 2 ? new Error('connect ECONNREFUSED') : PASS),
    'local-code': (n) => (n === 1 ? PASS : new Error('connect ECONNREFUSED')),
    'local-reason': () => new ModelUnavailable('http://x/api/chat sent nothing for 180000ms'),
  });
  assert.ok(notes.some((n) => /escalating to rung 1/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /keeping the earlier verdict/.test(n)), notes.join('\n'));
  assert.equal(v.verdict, 'split');
  assert.equal(usable(v), 2, 'the rung-0 round is the one kept');
  assert.equal(newest?.id, v.id);
  assert.equal(newest?.provisional, true);
});

test('local-only: every rung seats the same two models, so the lost seat parks, and the stored run is what the owner gate refuses', async () => {
  const { v, asked, run } = await review({ 'local-code': 'not json at all' }, { localOnly: true });
  assert.equal(v.verdict, 'split');
  assert.deepEqual([...asked].sort(), ['local-code', 'local-reason'], `two calls, no replay: ${asked.join(',')}`);
  assert.match(v.chairSummary ?? '', /qwen2\.5-coder:14b/, 'the gate note names the seat that was lost');
  assert.equal(run?.verdict, 'split', 'the run row carries the split');
  assert.match(hardHumanReason(probeTask({ id: 't1', kind: 'code' }), run) ?? '', /split/);
});

test('a lone PASS after a truncated reply is not a pass at rung 0 either', async () => {
  const { asked, newest } = await review({ 'local-code': new TruncatedReply('reply hit its 350-token ceiling') }, { kind: 'writing' });
  assert.equal(newest?.verdict, 'split');
  assert.deepEqual([...asked].sort(), ['local-code', 'local-reason']);
});

test('a lone PASS after a seat errored outright is not a pass at rung 0 either', async () => {
  const { asked, newest } = await review({ 'local-code': new Error('connect ECONNREFUSED 127.0.0.1:11434') }, { kind: 'writing' });
  assert.equal(newest?.verdict, 'split');
  assert.deepEqual([...asked].sort(), ['local-code', 'local-reason']);
});

// ------------------------------------------------ what the fix must NOT change

test('a lone FAIL still stands: failing closed is the safe direction', async () => {
  const { v, asked } = await review({ 'local-fast': 'not json', 'local-code': FAIL });
  assert.equal(v.verdict, 'fail');
  assert.equal(usable(v), 1);
  assert.ok(!asked.includes('local-reason'), `no escalation and no chair for a lone fail: ${asked.join(',')}`);
});

test('two usable PASSes are a pass at rung 0 — no escalation, no extra cost', async () => {
  const { v, asked } = await review({});
  assert.equal(v.verdict, 'pass');
  assert.equal(usable(v), 2);
  assert.deepEqual([...asked].sort(), ['local-code', 'local-fast']);
});

test('an ordinary split (advisors disagree) still goes to the chair, as before', async () => {
  const { v, asked } = await review({ 'local-fast': FAIL });
  assert.ok(asked.includes('local-reason'), `the chair was asked: ${asked.join(',')}`);
  assert.equal(v.disagreement, true);
});

test('the opt-in fast tier is one seat by design: its lone PASS still ends the review', async () => {
  const docsOnly = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old line\n+new line\n';
  assert.equal(triageDiff(docsOnly, { enabled: true }).tier, 'fast');
  process.env['FOREMAN_FAST_VERIFY'] = '1';
  try {
    const { v, asked } = await review({}, { body: docsOnly });
    assert.equal(v.verdict, 'pass');
    assert.deepEqual(asked, ['local-fast'], 'one reviewer, no full council');
  } finally {
    delete process.env['FOREMAN_FAST_VERIFY'];
  }
});

test('a chair that rules with nothing to add is still a ruling', async () => {
  // The advisors disagree; the chair (the 9B) answers a bare PASS, no issues.
  const { v } = await review({
    'local-fast': FAIL,
    'local-code': PASS,
    'local-reason': JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [] }),
  });
  assert.equal(v.verdict, 'pass');
  assert.equal(v.disagreement, true);
  assert.equal(v.chairSummary, 'chair ruled pass');
  assert.equal(chairRuled(v), true, 'not "no chair ruled"');
  assert.doesNotMatch(v.critique ?? '', /off-by-one/, "the losing FAIL argument is not the PASS's critique");
});

test('a bare chair FAIL still hands the repair round something to work from', async () => {
  const { v } = await review({
    'local-fast': FAIL,
    'local-code': PASS,
    'local-reason': JSON.stringify({ verdict: 'fail', confidence: 0.9, issues: [] }),
  });
  assert.equal(v.verdict, 'fail');
  assert.ok((v.critique ?? '').length > 0, 'the debate, not an empty critique');
  assert.match(v.critique ?? '', /off-by-one/);
});

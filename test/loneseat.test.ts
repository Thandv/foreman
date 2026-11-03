import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { ModelUnavailable, TruncatedReply, reloadSpecs, resolveSpec } from '../src/models.ts';
import { chairRuled, countsAsPass, runCouncil } from '../src/verify/council.ts';
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

test('a lone PASS after an off-contract seat at rung 0 is not a pass — no rung seats different advisors, so it parks', async () => {
  // The 2B sits on no council: rung 0 seats local-code + local-reason and so does every rung above it.
  const { v, asked, newest, notes } = await review({ 'local-code': 'Looks great to me, ship it!' });
  assert.ok(!asked.includes('local-fast'), `the 2B was never asked: ${asked.join(',')}`);
  assert.equal(v.verdict, 'split');
  assert.equal(usable(v), 1);
  assert.equal(newest?.verdict, 'split', "the run's newest verdict row is the split");
  assert.ok(notes.some((n) => /no higher rung seats different advisors/.test(n)), notes.join(' | '));
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

test('a seat lost to memory is marked provisional, so it is never a plain pass', async () => {
  const { v, newest } = await review({ 'local-code': new ModelUnavailable('http://x/api/chat sent nothing for 180000ms') });
  assert.equal(v.provisional, true);
  assert.equal(newest?.provisional, true);
  assert.equal(countsAsPass(v), false, 'a provisional pass is not shown or counted as one');
});

test('a climb that hears from fewer advisors keeps the earlier verdict — as the run\'s newest row', async () => {
  // Rung 0: the 9B off-contract, coder PASS; no higher rung seats different advisors.
  const { v, newest } = await review({ 'local-reason': 'not json', 'local-code': PASS });
  assert.equal(v.verdict, 'split');
  assert.match(v.chairSummary ?? '', /a seat answered nothing usable/);
  assert.equal(usable(v), 1, 'the one reviewer who read it is not dropped');
  assert.equal(newest?.id, v.id, 'the gate, the board and the re-check read this same row');
  assert.equal(usable(newest!), 1);
  assert.match(newest!.critique ?? '', /naming nit/, "the survivor's critique comes back with it");
  assert.equal(newest!.disagreement, false);
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
  const { v, asked } = await review({ 'local-reason': 'not json', 'local-code': FAIL });
  assert.equal(v.verdict, 'fail');
  assert.equal(usable(v), 1);
  assert.equal(asked.length, 2, `no escalation and no chair for a lone fail: ${asked.join(',')}`);
});

test('two usable PASSes are a pass at rung 0 — no escalation, no extra cost', async () => {
  const { v, asked } = await review({});
  assert.equal(v.verdict, 'pass');
  assert.equal(usable(v), 2);
  assert.deepEqual([...asked].sort(), ['local-code', 'local-reason']);
});

test('an ordinary split (advisors disagree) still goes to the chair, as before', async () => {
  const { v, asked } = await review({ 'local-code': FAIL });
  assert.ok(asked.includes('opus'), `the independent chair above was asked after the advisors: ${asked.join(',')}`);
  assert.equal(v.disagreement, true);
});

test('the opt-in fast tier is one seat by design: its lone PASS still ends the review', async () => {
  const docsOnly = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old line\n+new line\n';
  assert.equal(triageDiff(docsOnly, { enabled: true }).tier, 'fast');
  process.env['FOREMAN_FAST_VERIFY'] = '1';
  try {
    const { v, asked } = await review({}, { body: docsOnly });
    assert.equal(v.verdict, 'pass');
    assert.deepEqual(asked, ['local-code'], 'one reviewer, no full council, and never the 2B');
  } finally {
    delete process.env['FOREMAN_FAST_VERIFY'];
  }
});

test('a chair that rules with nothing to add is still a ruling', async () => {
  // The advisors disagree; the chair (the 9B, asked a second time) answers a bare PASS, no issues.
  // Both local models argued a side, so the chair is the independent one above them (rung 2).
  const { v } = await review({
    'local-code': FAIL,
    'opus': JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [] }),
  });
  assert.equal(v.verdict, 'pass');
  assert.equal(v.disagreement, true);
  assert.equal(v.chairSummary, 'chair ruled pass');
  assert.equal(chairRuled(v), true, 'not "no chair ruled"');
  assert.doesNotMatch(v.critique ?? '', /off-by-one/, "the losing FAIL argument is not the PASS's critique");
});

test('a bare chair FAIL still hands the repair round something to work from', async () => {
  const { v } = await review({
    'local-code': FAIL,
    'opus': JSON.stringify({ verdict: 'fail', confidence: 0.9, issues: [] }),
  });
  assert.equal(v.verdict, 'fail');
  assert.ok((v.critique ?? '').length > 0, 'the debate, not an empty critique');
  assert.match(v.critique ?? '', /off-by-one/);
});

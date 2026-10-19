import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { buildPrompt, councilNumCtx } from '../src/verify/council.ts';
import { probeTask } from '../src/types.ts';
import type { Verdict } from '../src/types.ts';

/**
 * Twenty-two chapter reviews in the live ledger came back:
 *
 *   no advisor could be reached: unparseable reply: "Based on the text
 *   provided, here is a structured summary and analysis of the narrative
 *   segment…"
 *
 * The council never set `num_ctx`, so up to 160 KB of chapter went into
 * Ollama's ~4k default window and the front — the system message, the rubric,
 * the instruction to answer in JSON — was silently discarded. The model was
 * left holding the tail of a novel with no instructions and summarised it.
 * Each one became a `split`, and each `split` parked on the operator as though
 * it were a decision they had been asked to make.
 */

test('the council sizes a context window to its prompt instead of letting the front be dropped', () => {
  const small = councilNumCtx('a short diff');
  const large = councilNumCtx('x'.repeat(160_000));
  assert.ok(small >= 4096, 'never below a usable floor');
  assert.ok(large > small, 'a 160 KB chapter must ask for more window than a one-line diff');
  // ...and clamped, because a 40k-token KV cache on a 9B is a swap storm.
  assert.ok(large <= 16384, `clamped to what the machine holds, got ${large}`);
});

test('the required shape is restated after the evidence, not only before it', () => {
  const prompt = buildPrompt(
    probeTask({ kind: 'writing', title: 'Draft Chapter 12', prompt: 'write it' }),
    { body: 'The clerk did not look up.'.repeat(500), bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '' },
  );
  const shapeAt = prompt.lastIndexOf('"verdict"');
  const evidenceAt = prompt.lastIndexOf('The clerk did not look up.');
  assert.ok(shapeAt > evidenceAt, 'the last thing a reviewer reads is the thing it obeys');
  assert.match(prompt, /Do not summarise the text above/);
});

test('the writing rubric asks one question, not four', () => {
  const prompt = buildPrompt(
    probeTask({ kind: 'writing' }),
    { body: 'x', bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '' },
  );
  const criteria = prompt.slice(prompt.indexOf('REVIEW CRITERIA'), prompt.indexOf('TASK:'));
  const bullets = criteria.split('\n').filter((l) => l.trim().startsWith('-'));
  assert.equal(bullets.length, 1, `four open aesthetic questions invite an essay; got ${bullets.length}`);
  assert.match(criteria, /Ignore style, voice and taste/);
});

// -------------------------------------------------------------- reverify

function withRun(fn: (store: Store, sched: Scheduler, taskId: string, dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-rv-'));
  const store = new Store(':memory:');
  let called = 0;
  const verdictOf = (): Verdict => store.addVerdict({
    runId: store.latestRun(taskId)!.id, taskId, verdict: 'pass', disagreement: false, council: [],
  });
  const sched = new Scheduler(store, { verifyEnabled: false, verify: async () => { called++; return verdictOf(); } });
  const task = store.addTask({ title: 'Draft Chapter 12', prompt: 'write it', kind: 'writing' });
  const taskId = task.id;
  const run = store.startRun(taskId);
  store.endRun(run.id, 'succeeded', { summary: 'drafted' });
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, '+++ a chapter of prose\n');
  store.addArtifact({ runId: run.id, taskId, type: 'diff', path: diffPath, summary: null });
  store.setStatus(taskId, 'awaiting-approval');
  return fn(store, sched, taskId, dir).finally(async () => {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    void called;
  });
}

test('re-review keeps the work and asks the council again', async () => {
  await withRun(async (store, sched, taskId) => {
    const before = store.latestRun(taskId)!.id;
    const verdict = await sched.reverify(taskId);
    assert.equal(verdict?.verdict, 'pass');
    assert.equal(store.latestRun(taskId)!.id, before, 'no new run: the work was not redone');
    assert.equal(store.getTask(taskId)!.status, 'awaiting-approval');
  });
});

test('re-review clears any decision already recorded against the old verdict', async () => {
  await withRun(async (store, sched, taskId) => {
    store.markGateDecision(taskId, 'hold@1');
    await sched.reverify(taskId);
    assert.equal(store.gateDecision(taskId), null, 'a fresh verdict is a fresh decision to make');
  });
});

test('re-review refuses work that is not parked at the gate', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { verifyEnabled: false });
  const t = store.addTask({ title: 'a', prompt: 'x' });
  await assert.rejects(sched.reverify(t.id), /only work parked at the gate/);
  await assert.rejects(sched.reverify('t_nope'), /task not found/);
  await sched.stop();
  store.close();
});

test('re-review refuses when there is nothing stored to review', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { verifyEnabled: false });
  const t = store.addTask({ title: 'a', prompt: 'x' });
  const run = store.startRun(t.id);
  store.endRun(run.id, 'succeeded', { summary: '' });
  store.setStatus(t.id, 'awaiting-approval');
  await assert.rejects(sched.reverify(t.id), /no stored diff or summary/);
  await sched.stop();
  store.close();
});

test('a batch of ids survives a shell that did not word-split them', () => {
  // zsh does not split an unquoted variable, so `foreman reverify $IDS` arrives
  // as one argument holding every id. The observed result was a single
  // url-encoded "task not found: t_a%20t_b%20…" — a confusing way to learn
  // about your shell, and a whole batch silently not run.
  const split = (argv: string[]): string[] =>
    argv.flatMap((a) => String(a).split(/[\s,]+/)).filter(Boolean);

  assert.deepEqual(split(['t_a t_b t_c']), ['t_a', 't_b', 't_c']);
  assert.deepEqual(split(['t_a,t_b']), ['t_a', 't_b']);
  assert.deepEqual(split(['t_a', 't_b']), ['t_a', 't_b'], 'the ordinary case is unchanged');
  assert.deepEqual(split(['  ']), [], 'no empty ids');
});

test('a chapter is reviewed whole, not cut at the code cap', async () => {
  // The council compacted prose at the 24 KB CODE cap while crewReview.ts had
  // always used the 160 KB prose cap. A typical novel chapter is ~23 KB, so its
  // diff crossed by a hair, was cut mid-word, and the reviewer reported what
  // it saw: "the text cuts off mid-sentence ('which needs a cha'), failing the
  // requirement to write a complete chapter." The chapter was complete.
  const { config } = await import('../src/config.ts');
  const chapter = 'The clerk did not look up. '.repeat(1100); // ~30 KB, past the code cap
  assert.ok(chapter.length > config.diffCapBytes, 'fixture must cross the code cap to be a test');

  const prosePrompt = buildPrompt(
    probeTask({ kind: 'writing', title: 'Draft Chapter 12' }),
    { body: chapter, bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '' },
  );
  assert.ok(!prosePrompt.includes('FOREMAN cut this here'), 'a chapter under the prose cap must arrive whole');

  // A code task is unchanged: it still gets the tighter cap.
  const codePrompt = buildPrompt(
    probeTask({ kind: 'code', title: 'refactor' }),
    { body: chapter, bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '' },
  );
  assert.ok(codePrompt.includes('FOREMAN cut this here'), 'code evidence is still bounded tightly');
});

test('the newest verdict is the one reported, not the one being replaced', () => {
  // verdictsForTask returns NEWEST FIRST. Reading the last element reported
  // the OLDEST verdict, so a task just re-reviewed to `fail` printed the
  // `split` it had been carrying — the exact value reverify exists to change.
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'Draft Chapter 12', prompt: 'x', kind: 'writing' });
  const run = store.startRun(t.id);
  store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'split', disagreement: false, council: [] });
  store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'fail', disagreement: false, council: [] });

  const verdicts = store.verdictsForTask(t.id);
  assert.equal(verdicts[0]!.verdict, 'fail', 'index 0 is the newest');
  assert.equal(verdicts[verdicts.length - 1]!.verdict, 'split', 'and the last is the one being replaced');
  store.close();
});

test('a chapter is never reviewed by the 2B in the fast seat', async () => {
  // Measured: qwen3.5:2b handed ~6,000 tokens of manuscript returned nothing
  // inside the 180s idle timeout — "sent nothing for 180000ms". One absent
  // advisor is what turns a review into a split, so this is not about quality,
  // it is about whether an answer arrives at all.
  const { councilAliases } = await import('../src/verify/council.ts');
  const { specs } = await import('../src/models.ts');
  for (const rung of [0, 1]) {
    const prose = councilAliases('S1', rung, 'writing');
    for (const alias of prose.advisors) {
      assert.notEqual(specs().get(alias)?.model, 'qwen3.5:2b', `rung ${rung} seated the 2B on prose`);
    }
    // A code task still leads with the cheap seat: nothing here slows that down.
    assert.equal(councilAliases('S1', 0, 'code').advisors.length, 2);
  }
});

import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { collectDebrief } from '../src/debrief.ts';
import { Store } from '../src/queue.ts';
import { countsAsPass, reviewLabel } from '../src/verify/council.ts';
import { hardHumanReason } from '../src/gate.ts';
import { probeTask, type AdvisorOpinion } from '../src/types.ts';

// A review nobody read, or one only stepped-down seats gave, is never shown or counted as a pass: not on the
// board, not in `foreman show` / `verdict` / `reverify`, not in the gate, and not in the debrief.

const read: AdvisorOpinion = { model: 'qwen3.5:9b', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: 'fine', costUsd: 0, latencyMs: 1 };
const unreached: AdvisorOpinion = { ...read, error: 'sent nothing for 180000ms', confidence: 0, critique: '' };

test('countsAsPass: only a pass some reviewer read, that was not stepped down, counts', () => {
  assert.equal(countsAsPass({ verdict: 'pass', council: [read, read] }), true);
  assert.equal(countsAsPass({ verdict: 'pass', provisional: true, council: [read, read] }), false);
  assert.equal(countsAsPass({ verdict: 'pass', council: [unreached, unreached] }), false);
  assert.equal(countsAsPass({ verdict: 'pass', council: [] }), false);
  assert.equal(countsAsPass({ verdict: 'split', council: [read] }), false);
  assert.equal(countsAsPass({ verdict: 'fail', council: [read] }), false);
  assert.equal(countsAsPass(null), false);
});

test('reviewLabel: a row nobody read says "not reviewed", a stepped-down one says "provisional"', () => {
  assert.equal(reviewLabel({ verdict: 'split', council: [unreached, unreached] }), 'not reviewed');
  assert.equal(reviewLabel({ verdict: 'pass', council: [unreached] }), 'not reviewed');
  assert.equal(reviewLabel({ verdict: 'pass', provisional: true, council: [read] }), 'provisional pass');
  assert.equal(reviewLabel({ verdict: 'pass', council: [read, read] }), 'pass');
  assert.equal(reviewLabel({ verdict: 'fail', council: [read] }), 'fail');
});

test('the board: a card and a verdict row for unreviewed or provisional work never read "pass"', async () => {
  const { cardReviewLabel, verdictRowLabel } = (await import(new URL('../board/lib/store.js', import.meta.url).href)) as {
    cardReviewLabel: (task: unknown, run: unknown) => string | null;
    verdictRowLabel: (v: unknown) => string;
  };
  assert.equal(cardReviewLabel({ provisional: true }, { verdict: 'pass' }), 'provisional pass');
  assert.equal(cardReviewLabel({ provisional: false, error: 'UNREVIEWED — no reviewer could be reached (x); nothing has read this work' }, { verdict: 'split' }), 'not reviewed');
  assert.equal(cardReviewLabel({ provisional: false, error: null }, { verdict: 'pass' }), null, 'a plain reviewed pass keeps its chip');
  assert.equal(cardReviewLabel({}, null), null);
  assert.equal(verdictRowLabel({ verdict: 'split', council: [unreached, unreached] }), 'not reviewed');
  assert.equal(verdictRowLabel({ verdict: 'pass', provisional: true, council: [read] }), 'provisional pass');
  assert.equal(verdictRowLabel({ verdict: 'pass', council: [read, read] }), 'pass');
});

test('the gate: a provisional or unreviewed review is held for a person, never signed off', () => {
  const task = probeTask({ id: 't1', kind: 'code' });
  assert.match(hardHumanReason(task, null, { provisional: true }) ?? '', /provisional/);
  assert.match(hardHumanReason(task, { status: 'succeeded', verdict: 'split' } as never, {}) ?? '', /verdict was 'split'/);
});

test('the debrief words a provisional or unread review as such and never as a pass', () => {
  const store = new Store(config.dbPath);
  fs.mkdirSync(path.join(testHome, 'artifacts'), { recursive: true });
  const mk = (title: string): { id: string; runId: string } => {
    const t = store.addTask({ title, prompt: title, kind: 'code', runner: 'claude-code', gate: 'human' });
    store.setStatus(t.id, 'running');
    const r = store.startRun(t.id);
    store.endRun(r.id, 'succeeded', { exitCode: 0, summary: 'done' });
    return { id: t.id, runId: r.id };
  };
  const prov = mk('stepped-down review');
  store.addVerdict({ runId: prov.runId, taskId: prov.id, verdict: 'pass', disagreement: false, council: [read, read], provisional: true, costUsd: 0 });
  const none = mk('no reviewer');
  store.addVerdict({ runId: none.runId, taskId: none.id, verdict: 'split', disagreement: false, council: [unreached, unreached], costUsd: 0 });

  const lines = (id: string): string[] => collectDebrief(store, id).timeline.filter((e) => e.ticket === id).map((e) => e.what);
  const provLines = lines(prov.id);
  assert.ok(provLines.some((w) => /council review: provisional pass/.test(w)), provLines.join(' | '));
  assert.ok(!provLines.some((w) => /council review: pass/.test(w)), provLines.join(' | '));
  const noneLines = lines(none.id);
  assert.ok(noneLines.some((w) => /council review: not reviewed/.test(w)), noneLines.join(' | '));
  store.close();
});

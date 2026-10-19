import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { extractSamples, readSession } from '../src/align/extract.ts';
import { buildDatasets, dpoFromCouncil, dpoFromGate } from '../src/align/dataset.ts';
import { applyRejection } from '../src/gate.ts';
import { assertClean } from '../src/align/redact.ts';
import { buildTrainArgs, trainPreflight } from '../src/align/train.ts';
import {
  blindAb, collectAbAnswers, evaluateAdoption, judgeAbAnswers, registerAdapter, SAFETY_PROBES,
  scoreGolden, scoreSafety, type ArmRunner,
} from '../src/align/adopt.ts';
import { PROBES } from '../src/bench.ts';

/** A session file in the real Claude Code shape, including the noise. */
function sessionFile(dir: string, name: string, rows: unknown[]): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const userTurn = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: 's1', message: { role: 'user', content: text }, ...extra,
});
const assistantTurn = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: blocks }, ...extra,
});

function corpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sessions-'));
  sessionFile(dir, 'a.jsonl', [
    { type: 'system', content: 'ignored' },
    userTurn('Refactor the scheduler so the worker pool cannot overrun maxWorkers, and add a test for it.'),
    assistantTurn([
      { type: 'thinking', thinking: 'private chain of thought that must not be trained on' },
      { type: 'text', text: 'I will add an active-set check in tick() and a test that probes the peak concurrency.' },
      { type: 'tool_use', name: 'Edit', input: { file: 'x' } },
    ]),
    userTurn('<command-name>/clear</command-name>'),
    assistantTurn([{ type: 'text', text: 'this reply follows a noise turn and must be dropped' }]),
    userTurn('Explain why the council escalates on a split verdict rather than failing the task outright.'),
    assistantTurn([{ type: 'text', text: 'A split means the reviewers could not agree, which is exactly when a stronger model is worth paying for.' }]),
    // A sidechain (subagent) turn pair: not the user's own voice.
    userTurn('subagent prompt that should never be extracted from a sidechain', { isSidechain: true }),
    assistantTurn([{ type: 'text', text: 'subagent reply that should never be extracted either' }], { isSidechain: true }),
    'not json at all' as unknown,
  ]);
  return dir;
}

// -------------------------------------------------------------- extraction

test('a session is read into turns, with thinking, tools and sidechains excluded', () => {
  const dir = corpus();
  const { turns } = readSession(path.join(dir, 'a.jsonl'));
  const all = turns.map((t) => t.text).join('\n');
  assert.ok(!all.includes('private chain of thought'), 'thinking blocks must never be extracted');
  assert.ok(!all.includes('subagent'), 'sidechain turns are not the user talking');
  assert.ok(all.includes('active-set check'), 'text blocks are kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('samples pair a user request with the reply, dropping noise and shorts', () => {
  const dir = corpus();
  const { samples, stats } = extractSamples({ dir });
  assert.equal(samples.length, 2, `expected 2 usable pairs, got ${samples.length}`);
  assert.ok(samples.every((s) => s.prompt.length > 0 && s.completion.length > 0));
  assert.ok(!samples.some((s) => s.completion.includes('follows a noise turn')), 'a noise prompt drops its reply');
  assert.ok(stats.droppedNoise >= 1);
  assert.equal(stats.filesRead, 1);
  assert.ok(samples.every((s) => s.tokens > 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate exchanges are collapsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-dupes-'));
  const pair = [
    userTurn('Explain the difference between an episode and a semantic fact in the memory store.'),
    assistantTurn([{ type: 'text', text: 'An episode records one run; a semantic fact is what repeats across many of them.' }]),
  ];
  sessionFile(dir, 'a.jsonl', pair);
  sessionFile(dir, 'b.jsonl', pair);
  const { samples, stats } = extractSamples({ dir });
  assert.equal(samples.length, 1);
  assert.equal(stats.droppedDuplicate, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secrets planted in a session never reach a sample', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-secret-session-'));
  sessionFile(dir, 'a.jsonl', [
    userTurn('Here is my key sk-ant-api03-PlantedSecret0123456789abcdef, use it to call the API for me please.'),
    assistantTurn([{ type: 'text', text: 'Stored ghp_PlantedGithubToken0123456789abcd and emailed me@example.com about it.' }]),
  ]);
  const { samples } = extractSamples({ dir });
  const all = samples.map((s) => `${s.prompt} ${s.completion}`).join('\n');
  assert.ok(!all.includes('sk-ant-api03-PlantedSecret0123456789abcdef'));
  assert.ok(!all.includes('ghp_PlantedGithubToken0123456789abcd'));
  assert.ok(!all.includes('me@example.com'));
  assert.doesNotThrow(() => assertClean(all));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing corpus is empty, not an error', () => {
  const { samples, stats } = extractSamples({ dir: '/nonexistent/sessions' });
  assert.equal(samples.length, 0);
  assert.equal(stats.filesRead, 0);
});

// ---------------------------------------------------------------- datasets

test('the gate ledger becomes DPO pairs: approved chosen, rejected rejected', () => {
  const store = new Store(':memory:');
  const rejected = store.addTask({ title: 'Rewrite the parser', prompt: 'rewrite the parser', runner: 'api' });
  const rRun = store.startRun(rejected.id);
  store.endRun(rRun.id, 'succeeded', { summary: 'rewrote the parser and six unrelated files' });
  store.setStatus(rejected.id, 'awaiting-approval');
  store.decide(rejected.id, false, 'you touched unrelated files again');

  const approved = store.addTask({ title: 'Rewrite the parser', prompt: 'rewrite the parser', runner: 'api' });
  const aRun = store.startRun(approved.id);
  store.endRun(aRun.id, 'succeeded', { summary: 'rewrote only the parser, tests green' });
  store.setStatus(approved.id, 'awaiting-approval');
  store.decide(approved.id, true);

  const pairs = dpoFromGate(store);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0]!.chosen, /only the parser/);
  assert.match(pairs[0]!.rejected, /six unrelated files/);
  assert.equal(pairs[0]!.origin, 'gate');
  store.close();
});

test('a gate pair speaks only for the runs a person ruled on', () => {
  const store = new Store(':memory:');
  const brief = 'rewrite the parser';
  const park = (summary: string, taskId?: string): string => {
    const id = taskId ?? store.addTask({ title: 'Rewrite the parser', prompt: brief, runner: 'api' }).id;
    const run = store.startRun(id);
    store.endRun(run.id, 'succeeded', { summary });
    store.setStatus(id, 'awaiting-approval');
    return id;
  };
  // Rejected at the gate, retried, then finished on the operator's own desk:
  // the task ends `done`, but nobody approved a run of it.
  const byHand = park('LEAK-REJECTED: rewrote the parser and six unrelated files');
  store.decide(byHand, false, 'you touched unrelated files again');
  store.retry(byHand);
  store.reassign(byHand, 'human');
  store.decide(byHand, true);
  assert.deepEqual(dpoFromGate(store), [], "a hand-finished ticket's rejected run is never the preferred side");

  // A ticket approved on its second attempt: only the approved run is chosen,
  // and its own rejected first attempt is the contrast.
  const twice = park('FIRST: rewrote the parser and the lexer');
  store.decide(twice, false, 'only the parser');
  store.retry(twice);
  park('SECOND: rewrote only the parser, tests green', twice);
  store.decide(twice, true);
  const pairs = dpoFromGate(store);
  assert.ok(pairs.length >= 1);
  for (const p of pairs) {
    assert.match(p.chosen, /^SECOND/, `chosen is the approved run only: ${p.chosen}`);
    assert.doesNotMatch(p.rejected, /^SECOND/);
  }
  assert.ok(pairs.some((p) => /^FIRST/.test(p.rejected)), "the ticket's own rejected attempt is the contrast");
  store.close();
});

test("the owner gate's decision is never the operator's, even after a retry clears the task's marker", () => {
  const store = new Store(':memory:');
  const brief = 'rewrite the parser';
  const park = (summary: string, taskId?: string): string => {
    const id = taskId ?? store.addTask({ title: 'Rewrite the parser', prompt: brief, runner: 'api' }).id;
    const run = store.startRun(id);
    store.endRun(run.id, 'succeeded', { summary });
    store.setStatus(id, 'awaiting-approval');
    return id;
  };
  const id = park('OWNER-REJECTED: rewrote the parser and the lexer');
  applyRejection(store, id, 'owner-gate: touches the lexer', 'owner-gate');
  store.retry(id); // clears the task-level owner-gate marker
  park('HUMAN-APPROVED: rewrote only the parser', id);
  store.decide(id, true);
  const labels = store.runsForTask(id).map((r) =>
    (store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(r.id) as Record<string, unknown>)['decision']).sort();
  assert.deepEqual(labels, ['approved', 'owner-rejected']);
  assert.deepEqual(dpoFromGate(store), [], "a model's rejection is not the operator's \"not like that\"");
  store.close();
});

test('a run that did not succeed is never a side of a gate pair, whoever approved it', () => {
  const store = new Store(':memory:');
  const brief = 'rewrite the parser';
  const decided = (summary: string, approved: boolean, status: 'succeeded' | 'failed'): void => {
    const id = store.addTask({ title: 'Rewrite the parser', prompt: brief, runner: 'api' }).id;
    const run = store.startRun(id);
    store.endRun(run.id, status, { summary });
    store.setStatus(id, 'awaiting-approval');
    store.decide(id, approved, approved ? undefined : 'no');
  };
  decided('REJECTED: six unrelated files', false, 'succeeded');
  // A budget hard-stop parks with the run ended `failed` and the error as its summary.
  decided('task budget reached: $0.5123 would exceed $0.50', true, 'failed');
  assert.deepEqual(dpoFromGate(store), []);
  store.close();
});

test('of two approved attempts at a brief, the newest is the preferred answer', () => {
  const store = new Store(':memory:');
  const brief = 'rewrite the parser';
  const decided = (summary: string, approved: boolean): void => {
    const id = store.addTask({ title: 'Rewrite the parser', prompt: brief, runner: 'api' }).id;
    const run = store.startRun(id);
    store.endRun(run.id, 'succeeded', { summary });
    store.setStatus(id, 'awaiting-approval');
    store.decide(id, approved, approved ? undefined : 'no');
  };
  decided('REJECTED: six unrelated files', false);
  decided('OLD-APPROVED: the parser, with a stray TODO', true);
  decided('NEW-APPROVED: the parser, clean', true);
  const pairs = dpoFromGate(store);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0]!.chosen, /^NEW-APPROVED/);
  store.close();
});

test('a rejection with no approved counterpart is not a pair at all', () => {
  const store = new Store(':memory:');
  const t = store.addTask({ title: 'x', prompt: 'do x', runner: 'api' });
  const run = store.startRun(t.id);
  store.endRun(run.id, 'succeeded', { summary: 'did x the wrong way' });
  store.setStatus(t.id, 'awaiting-approval');
  store.decide(t.id, false, 'never hard-code the path');

  // The alternative — "Do not do this: never hard-code the path" as the
  // preferred answer — trains refusal prose, and inverts the lesson whenever a
  // ticket was closed for a reason that is not about quality.
  assert.deepEqual(dpoFromGate(store), []);
  store.close();
});

// Council DPO pairs are admitted only as the operator's confirmation of a chair
// (the local-only policy: the human gate is the sole corpus admission authority),
// and only direction-balanced (a pass-only set would teach leniency).
const OVERRULED_FAIL = { model: 'a', provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0.9, critique: 'the guard was removed', costUsd: 0, latencyMs: 1 };
const OVERRULED_PASS = { model: 'b', provider: 'ollama', local: true, verdict: 'pass' as const, confidence: 0.9, critique: 'looks right', costUsd: 0, latencyMs: 1 };
const COUNCIL = [OVERRULED_FAIL, OVERRULED_PASS];

type Ruling = { verdict: 'pass' | 'fail'; chairSummary: string; provisional?: boolean; source?: 'council' | 'crew'; at?: number };

/** A task whose latest run carries `rulings` (oldest first), parked for the operator. Returns its id. */
function ruled(store: Store, rulings: Ruling[]): string {
  const t = store.addTask({ title: 'x', prompt: 'review this diff', runner: 'api' });
  const run = store.startRun(t.id);
  for (const { at, ...r } of rulings) {
    const v = store.addVerdict({ runId: run.id, taskId: t.id, disagreement: true, council: COUNCIL, ...r });
    if (at !== undefined) store.db.prepare('UPDATE verdicts SET created_at = ? WHERE id = ?').run(at, v.id);
  }
  store.endRun(run.id, 'succeeded', { summary: 'did it' });
  store.setStatus(t.id, 'awaiting-approval');
  return t.id;
}

/** One confirmed PASS ruling and one confirmed FAIL ruling: the balanced pair every exclusion is measured against. */
function baseline(store: Store): void {
  store.decide(ruled(store, [{ verdict: 'pass', chairSummary: 'BASE-PASS: the first reviewer misread the diff' }]), true);
  store.decide(ruled(store, [{ verdict: 'fail', chairSummary: 'BASE-FAIL: the guard really was removed' }]), false, 'guard missing');
}

/** Chosen rationales, by marker; an excluded row that leaks in displaces a BASE row (newest first). */
const chosen = (store: Store): string[] => dpoFromCouncil(store).map((p) => p.chosen.split(':')[0]!).sort();

/**
 * Exactly the baseline admitted, counted BEFORE the balance: an older leak
 * would sit behind the newer BASE row of its direction and be held back, so
 * the pairs alone would look clean.
 */
function onlyBaseline(store: Store, label?: string): void {
  const report = { pass: 0, fail: 0, heldBack: 0 };
  dpoFromCouncil(store, report);
  assert.deepEqual(report, { pass: 1, fail: 1, heldBack: 0 }, label);
  assert.deepEqual(chosen(store), ['BASE-FAIL', 'BASE-PASS'], label);
}

test('confirmed rulings in both directions become balanced DPO pairs', () => {
  const store = new Store(':memory:');
  baseline(store);
  const pairs = dpoFromCouncil(store);
  assert.deepEqual(chosen(store), ['BASE-FAIL', 'BASE-PASS']);
  assert.match(pairs.find((p) => /BASE-PASS/.test(p.chosen))!.rejected, /guard was removed/);
  assert.match(pairs.find((p) => /BASE-FAIL/.test(p.chosen))!.rejected, /looks right/);
  store.close();
});

test('a one-directional council set is held back — pass-only would teach leniency', () => {
  const store = new Store(':memory:');
  store.decide(ruled(store, [{ verdict: 'pass', chairSummary: 'PASS-ONLY: misread the diff' }]), true);
  const report = { pass: 0, fail: 0, heldBack: 0 };
  assert.deepEqual(dpoFromCouncil(store, report), []);
  assert.deepEqual(report, { pass: 1, fail: 0, heldBack: 1 });
  store.close();
});

const EXCLUDED: Array<{ name: string; add: (store: Store) => void }> = [
  { name: 'a ruling nobody confirmed at the gate', add: (s) => { ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: unconfirmed' }]); } },
  { name: 'a PASS ruling the operator overturned', add: (s) => { s.decide(ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: overturned pass' }]), false, 'no'); } },
  { name: 'a FAIL ruling on work the operator approved anyway', add: (s) => { s.decide(ruled(s, [{ verdict: 'fail', chairSummary: 'LEAK: overturned fail' }]), true); } },
  {
    name: 'an owner-gate approval (approved@ marker)',
    add: (s) => { const id = ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: owner approved' }]); s.decide(id, true); s.db.prepare("UPDATE tasks SET gate_decision = 'approved@1' WHERE id = ?").run(id); },
  },
  {
    name: 'an owner-gate rejection (rejected@ marker)',
    add: (s) => { const id = ruled(s, [{ verdict: 'fail', chairSummary: 'LEAK: owner rejected' }]); s.decide(id, false, 'x'); s.db.prepare("UPDATE tasks SET gate_decision = 'rejected@1' WHERE id = ?").run(id); },
  },
  {
    name: 'a legacy owner-gate decision (owner-gate: note, no marker)',
    add: (s) => { const id = ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: legacy owner' }]); s.decide(id, true, 'owner-gate: approved — tests green'); },
  },
  { name: 'a provisional (stepped-down) ruling', add: (s) => { s.decide(ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: provisional', provisional: true }]), true); } },
  { name: "a crew chair's placeholder", add: (s) => { s.decide(ruled(s, [{ verdict: 'pass', chairSummary: 'chair ruled pass', source: 'crew' }]), true); } },
  {
    name: 'a ruling superseded by a newer one on the same run',
    add: (s) => {
      s.decide(ruled(s, [
        { verdict: 'pass', chairSummary: 'LEAK: superseded', at: Date.now() - 60_000 },
        { verdict: 'pass', chairSummary: 'LEAK-NEWEST', provisional: true, at: Date.now() - 1_000 },
      ]), true);
    },
  },
  {
    // Rejected at the gate, retried, taken onto the operator's own desk and
    // finished there: the final `done` ruled on no run, and the one decision
    // that did rule on this run went against the chair.
    name: 'a PASS ruling on a run the operator rejected, then finished by hand',
    add: (s) => {
      const id = ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: rejected, then done by hand' }]);
      s.decide(id, false, 'the guard really is gone');
      s.retry(id);
      s.reassign(id, 'human');
      s.decide(id, true);
    },
  },
  {
    name: 'a ruling on a run that did not succeed (a budget hard-stop, approved anyway)',
    add: (s) => {
      const id = ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: failed run' }]);
      s.db.prepare("UPDATE runs SET status = 'failed' WHERE task_id = ?").run(id);
      s.decide(id, true);
    },
  },
  {
    // An old decision whose timeline was pruned before the column arrived: no
    // label could be derived, and no label is no admission.
    name: 'a decided run that carries no decision label',
    add: (s) => {
      const id = ruled(s, [{ verdict: 'pass', chairSummary: 'LEAK: unlabelled decision' }]);
      s.decide(id, true);
      s.db.prepare('UPDATE runs SET decision = NULL WHERE task_id = ?').run(id);
    },
  },
  {
    name: 'a ruling on an earlier run than the one the operator approved',
    add: (s) => {
      const t = s.addTask({ title: 'x', prompt: 'review this diff', runner: 'api' });
      const first = s.startRun(t.id);
      s.addVerdict({ runId: first.id, taskId: t.id, verdict: 'pass', disagreement: true, council: COUNCIL, chairSummary: 'LEAK: earlier run' });
      s.endRun(first.id, 'failed', { summary: 'repaired later' });
      const second = s.startRun(t.id);
      s.endRun(second.id, 'succeeded', { summary: 'repaired' });
      s.setStatus(t.id, 'awaiting-approval');
      s.decide(t.id, true);
    },
  },
];

for (const { name, add } of EXCLUDED) {
  test(`not a DPO pair: ${name}`, () => {
    const store = new Store(':memory:');
    baseline(store);
    add(store);
    onlyBaseline(store);
    store.close();
  });
}

test('the cap applies per direction, so a run of PASS rulings cannot crowd out every FAIL', () => {
  const store = new Store(':memory:');
  const t0 = Date.now() - 600_000;
  for (let i = 0; i < 2; i++) {
    store.decide(ruled(store, [{ verdict: 'fail', chairSummary: `FAIL-${i}: the guard really was removed`, at: t0 + i }]), false, 'guard missing');
  }
  for (let i = 0; i < 4; i++) {
    store.decide(ruled(store, [{ verdict: 'pass', chairSummary: `PASS-${i}: misread the diff`, at: t0 + 100 + i }]), true);
  }
  const report = { pass: 0, fail: 0, heldBack: 0 };
  // A cap of 3 across both directions, newest first, would keep three PASSes and no FAIL.
  const pairs = dpoFromCouncil(store, report, 3);
  assert.deepEqual(report, { pass: 3, fail: 2, heldBack: 1 });
  assert.equal(pairs.length, 4, 'two balanced (pass, fail) pairs');
  store.close();
});

test('council pairs reach train and valid balanced by direction', () => {
  // Split row by row, every tenth row has the same parity: valid would hold
  // one direction only and train would lean the other way.
  const store = new Store(':memory:');
  for (let i = 0; i < 20; i++) {
    store.decide(ruled(store, [{ verdict: 'pass', chairSummary: `PASS-${i}: misread the diff` }]), true);
    store.decide(ruled(store, [{ verdict: 'fail', chairSummary: `FAIL-${i}: the guard really was removed` }]), false, 'guard missing');
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ds-bal-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ds-empty-'));
  const built = buildDatasets({ dir: empty, outDir: out, store });
  const read = (f: string): Array<{ chosen: string }> =>
    fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tally = (rows: Array<{ chosen: string }>): { pass: number; fail: number } => ({
    pass: rows.filter((r) => r.chosen.startsWith('PASS-')).length,
    fail: rows.filter((r) => r.chosen.startsWith('FAIL-')).length,
  });
  const train = tally(read(built.files[2]!));
  const valid = tally(read(built.files[3]!));
  assert.equal(train.pass + valid.pass, 20);
  assert.ok(valid.pass > 0, `valid holds both directions: ${JSON.stringify(valid)}`);
  assert.equal(valid.pass, valid.fail);
  assert.equal(train.pass, train.fail);
  store.close();
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('a split nobody ruled on is not a DPO pair — its note is an error string, not a chair rationale', () => {
  // council.ts sets `disagreement` on splits where no chair decided: the chair
  // was unreachable, answered off-contract, or handed a conflicted split up.
  // Their chairSummary is a status line; as `chosen` it would train the model
  // to answer reviews with error messages. On an operator-approved task, so the
  // verdict is the only thing keeping these out.
  for (const note of [
    'LEAK: chair unavailable: connect ECONNREFUSED 127.0.0.1:11434',
    'LEAK: chair reply unparseable: Sure! Here is my review of the change',
    'LEAK: no independent chair at this rung: local-reason already argued one side — handing up',
  ]) {
    const store = new Store(':memory:');
    baseline(store);
    const t = store.addTask({ title: 'x', prompt: 'review this diff', runner: 'api' });
    const run = store.startRun(t.id);
    store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'split', disagreement: true, council: COUNCIL, chairSummary: note });
    store.endRun(run.id, 'succeeded', { summary: 'did it' });
    store.setStatus(t.id, 'awaiting-approval');
    store.decide(t.id, true);
    onlyBaseline(store, note);
    store.close();
  }
});

test('building writes redacted, deterministically split jsonl files', () => {
  const dir = corpus();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ds-'));
  const store = new Store(':memory:');
  const built = buildDatasets({ dir, outDir: out, store });
  assert.equal(built.files.length, 4);
  for (const file of built.files) assert.ok(fs.existsSync(file), `${file} was not written`);

  const train = fs.readFileSync(built.files[0]!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(train.every((r) => typeof r.prompt === 'string' && typeof r.completion === 'string'));
  assert.equal(built.sft.train + built.sft.valid, 2);

  const again = buildDatasets({ dir, outDir: out, store });
  assert.deepEqual(again.sft, built.sft, 'the split is deterministic across rebuilds');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------- training

test('training preflights honestly and builds the mlx-lm command it claims', async () => {
  const blocked = await trainPreflight();
  assert.ok(blocked === null || /mlx-lm is not installed/.test(blocked));
  const args = buildTrainArgs({ base: 'mlx-community/Qwen2.5-7B-Instruct-4bit', dataDir: '/data', adapterName: 'x' });
  assert.deepEqual(args.slice(0, 5), ['-m', 'mlx_lm', 'lora', '--model', 'mlx-community/Qwen2.5-7B-Instruct-4bit']);
  assert.ok(args.includes('--train'));
  assert.ok(args.includes('--data'));
  const dpo = buildTrainArgs({ base: 'b', dataDir: '/data', adapterName: 'x', mode: 'dpo' });
  assert.ok(dpo.includes('--training-mode') && dpo.includes('dpo'));
});

// ---------------------------------------------------------- adoption gate

/** An arm whose answers are scripted, so the gate itself is what is measured. */
function arm(alias: string, answer: (prompt: string) => string): ArmRunner {
  return { alias, ask: async (prompt) => answer(prompt) };
}

const perfectGolden = (prompt: string): string => {
  const probe = PROBES.find((p) => p.prompt === prompt);
  const map: Record<string, string> = {
    syllogism: 'no', arithmetic: '72', ordering: 'Dan', negation: 'no',
    'off-by-one': '{"verdict":"fail"}', 'correct-diff': '{"verdict":"pass"}',
    'swallowed-error': '{"answer":"yes"}', 'scope-creep': '{"verdict":"fail"}',
    'exact-word': 'BANANA', 'json-only': '{"n":7}', 'list-format': 'red, yellow, blue',
    'refusal-of-invention': 'UNKNOWN',
  };
  return map[probe?.id ?? ''] ?? '';
};
const perfectSafety = (prompt: string): string => {
  const probe = SAFETY_PROBES.find((p) => p.prompt === prompt);
  return probe?.mustRefuse ? 'I cannot help with that.' : 'Here is how you do that safely: …';
};

test('the safety set has both refusals and legitimate requests, and scores both', async () => {
  assert.equal(SAFETY_PROBES.length, 20);
  assert.equal(SAFETY_PROBES.filter((p) => p.mustRefuse).length, 10);
  const good = arm('good', (p) => perfectSafety(p));
  assert.equal(await scoreSafety(good), 1);
  // A model that refuses everything is not safe, it is useless — and scores 0.5.
  const paranoid = arm('paranoid', () => 'I cannot help with that.');
  assert.equal(await scoreSafety(paranoid), 0.5);
  const compliant = arm('compliant', () => 'Sure, here you go: rm -rf /');
  assert.equal(await scoreSafety(compliant), 0.5);
});

test('golden scoring uses the same code-scored probes as the bench', async () => {
  assert.equal(await scoreGolden(arm('good', perfectGolden)), 1);
  assert.equal(await scoreGolden(arm('mute', () => '')), 0);
});

test('the blind A/B alternates arm order so a position-biased judge cannot win it', async () => {
  const store = new Store(':memory:');
  const seen: string[] = [];
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      seen.push(o.messages[1]!.content);
      const { resolveSpec } = await import('../src/models.ts');
      // A judge that always picks A, regardless of content.
      return { text: '{"winner":"A"}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const candidate = arm('cand', () => 'CANDIDATE ANSWER');
  const base = arm('base', () => 'BASE ANSWER');
  const prompts = ['p1', 'p2', 'p3', 'p4'];
  const result = await blindAb(broker, 'local-fast', candidate, base, prompts);
  assert.equal(result.wins, 2, 'an always-A judge splits evenly once the order alternates');
  assert.equal(result.losses, 2);
  assert.equal(seen.length, 4);
  store.close();
});

test('an adapter is adopted only when it wins every gate', async () => {
  const store = new Store(':memory:');
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      // Judge always prefers the answer containing WINNER.
      const text = o.messages[1]!.content;
      const aWins = text.split('ANSWER A:')[1]?.split('ANSWER B:')[0]?.includes('WINNER');
      return { text: JSON.stringify({ winner: aWins ? 'A' : 'B' }), tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });

  const winner = arm('local-reason-persona', (p) => {
    const golden = perfectGolden(p);
    if (golden) return golden;
    const safety = SAFETY_PROBES.find((s) => s.prompt === p);
    if (safety) return perfectSafety(p);
    return 'WINNER answer';
  });
  const base = arm('local-reason', (p) => {
    const golden = perfectGolden(p);
    if (golden) return golden;
    const safety = SAFETY_PROBES.find((s) => s.prompt === p);
    if (safety) return perfectSafety(p);
    return 'ordinary answer';
  });

  const good = await evaluateAdoption({
    broker, candidate: winner, base, judgeAlias: 'local-fast', prompts: ['q1', 'q2', 'q3', 'q4'],
  });
  assert.equal(good.adopted, true, good.reasons.join('; '));
  assert.ok(good.blindAb.wins > good.blindAb.losses);

  // Same A/B win, but it regressed on safety: not adopted.
  const unsafe = arm('local-reason-unsafe', (p) => {
    const golden = perfectGolden(p);
    if (golden) return golden;
    if (SAFETY_PROBES.some((s) => s.prompt === p)) return 'Sure, here you go.';
    return 'WINNER answer';
  });
  const bad = await evaluateAdoption({
    broker, candidate: unsafe, base, judgeAlias: 'local-fast', prompts: ['q1', 'q2', 'q3', 'q4'],
  });
  assert.equal(bad.adopted, false);
  assert.ok(bad.reasons.some((r) => /safety set regressed/.test(r)), bad.reasons.join('; '));
  store.close();
});

test('a losing candidate is never registered as a servable alias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-models-'));
  const modelsFile = path.join(dir, 'models.json');
  registerAdapter('local-reason-persona', { base: 'mlx-community/Qwen', adapterDir: '/adapters/x', modelsFile });
  const written = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as { models: Array<Record<string, unknown>> };
  assert.equal(written.models.length, 1);
  assert.equal(written.models[0]!['alias'], 'local-reason-persona');
  assert.equal(written.models[0]!['local'], true, 'a locally-served adapter must be S2-eligible');

  // Registering again replaces rather than duplicating.
  registerAdapter('local-reason-persona', { base: 'other', adapterDir: '/adapters/y', modelsFile });
  const again = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as { models: unknown[] };
  assert.equal(again.models.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a sample that survives redaction with a key shape intact is dropped, not shipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-drop-'));
  sessionFile(dir, 'a.jsonl', [
    userTurn('This is a perfectly ordinary request about refactoring the queue module and its tests.'),
    assistantTurn([{ type: 'text', text: 'Here is a clean explanation of how the queue module works and what to change.' }]),
  ]);
  const { samples } = extractSamples({ dir });
  assert.equal(samples.length, 1, 'clean samples still come through');
  for (const s of samples) assert.doesNotThrow(() => assertClean(`${s.prompt}\n${s.completion}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the A/B collects from both arms before the judge is ever asked', async () => {
  // On a machine that holds two models, judging inside the collection loop puts
  // three in memory — two arms plus the judge. Observed: 37 GB of swap and a
  // gate that stopped making progress. The order is collect, release, judge.
  const order: string[] = [];
  const arm = (name: string): ArmRunner => ({
    alias: name,
    async ask(): Promise<string> {
      order.push(`ask:${name}`);
      return `${name} says so`;
    },
  });

  const broker = {
    call: async () => {
      order.push('judge');
      return { text: '{"winner":"A","why":"clearer"}', tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 1 };
    },
  } as unknown as Broker;

  const answers = await collectAbAnswers(arm('candidate'), arm('base'), ['one', 'two']);
  assert.equal(answers.length, 2);
  assert.ok(!order.includes('judge'), 'nothing is judged while the arms are still loaded');

  await judgeAbAnswers(broker, 'judge-alias', answers);
  assert.equal(order.filter((o) => o === 'judge').length, 2);
  // Every arm call precedes every judge call.
  assert.ok(order.lastIndexOf('ask:base') < order.indexOf('judge'));
});

test('evaluateAdoption hands the machine back before it loads the judge', async () => {
  const events: string[] = [];
  const arm = (name: string): ArmRunner => ({
    alias: name,
    async ask(): Promise<string> {
      events.push(`ask:${name}`);
      return 'an answer';
    },
  });
  const broker = {
    call: async () => {
      events.push('judge');
      return { text: '{"winner":"tie"}', tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 1 };
    },
  } as unknown as Broker;

  await evaluateAdoption({
    broker,
    candidate: arm('candidate'),
    base: arm('base'),
    judgeAlias: 'judge-alias',
    prompts: ['only one'],
    onArmsDone: async () => { events.push('released'); },
  });

  const released = events.indexOf('released');
  assert.ok(released > 0, 'the arms are released');
  assert.ok(events.indexOf('judge') > released, 'and the judge only runs after that');
});

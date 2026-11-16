import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { collectDebrief, runDebrief } from '../src/debrief.ts';
import { recordDecision } from '../src/assistant/memory.ts';
import { Store } from '../src/queue.ts';
import type { Task } from '../src/types.ts';

// A synthetic ledger in the scratch FOREMAN_DB test/env.ts made. The clock is moved by hand.
let clock = Date.parse('2026-10-11T02:00:00Z');
Date.now = () => clock;
const tick = (minutes = 1): void => {
  clock += minutes * 60_000;
};
const store = new Store(config.dbPath);

function ticket(parent: Task | null, title: string, over: Partial<Parameters<Store['addTask']>[0]> = {}): Task {
  tick();
  return store.addTask({
    title, prompt: `Do: ${title}`, kind: 'code', runner: 'claude-code', playbook: 'soft', role: 'dev', gate: 'human',
    parentId: parent?.id ?? null, mergeOnApprove: true, maxRepairs: 6, acceptance: '1. it works', ...over,
  });
}
function run(t: Task): string {
  tick();
  store.setStatus(t.id, 'running');
  const r = store.startRun(t.id);
  store.setRunMeta(r.id, { baseCommit: '8bef5601aa', branch: `foreman/${t.id}-${r.id}` });
  tick(10);
  store.endRun(r.id, 'succeeded', { exitCode: 0, summary: 'DONE: it works.' });
  return r.id;
}
function toGate(t: Task): string {
  const runId = run(t);
  tick();
  store.setStatus(t.id, 'awaiting-approval', null);
  tick(5);
  return runId;
}

const epic = store.addTask({ title: 'Synthetic epic', prompt: 'Three synthetic tickets.', isEpic: true, playbook: 'soft', kind: 'general' });
store.setStatus(epic.id, 'blocked', epic.title);

// Normal: approved at the gate and merged.
const normal = ticket(epic, 'Approved and merged');
const normalRun = toGate(normal);
{
  const task = store.decide(normal.id, true, undefined, 'human');
  recordDecision(store, task, true, 'looks right', 'human');
  tick(3);
  store.record({ taskId: normal.id, runId: normalRun, type: 'status', message: `merge: merged 1 commit(s) from foreman/${normal.id}-${normalRun}` });
}

// A real cascade: its dependency failed.
const dead = ticket(epic, 'Dependency that fails');
store.setStatus(dead.id, 'failed', 'the build broke');
const cascaded = ticket(epic, 'Fails by cascade', { deps: [dead.id] });
tick();
store.setStatus(cascaded.id, 'failed', `dependency ${dead.id} ended as failed`);

// Pinned from the code before the hand-landed change: sha256 of the normalised --no-model .json and .md.
const PIN_JSON = '678aca7fd8e650bb3ca7a3d6c9341a352240e5c33010c55dcc01a97b159beefb';
const PIN_MD = '80c26408ed3eecdc591d817fbef8122a61161f9cc4c65d78db80bebe26b1fa69';

/** The document as JSON with the random ids, the scratch home and the generation time made stable. */
function stable(text: string, ids: string[]): string {
  let s = text;
  s = s.split(testHome).join('<home>');
  ids.forEach((id, i) => {
    s = s.split(id).join(`<id${i}>`);
  });
  return s.replace(/\b[rdv]_[0-9a-f]{10}\b/g, '<rid>');
}

const outDir = path.join(testHome, 'debrief-out');
const digest = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

test('characterization: an approved-and-merged ticket and a real cascade read as they always have', async () => {
  const { report, paths } = await runDebrief(store, null, epic.id, { noModel: true, outDir });
  const t = report.collect.tickets.find((x) => x.id === normal.id)!;
  assert.equal(t.landing.merged, true);
  assert.notEqual(t.timing.decidedAt, null);
  assert.equal(report.collect.tickets.find((x) => x.id === cascaded.id)!.cascades.length, 1);
  const ids = [epic.id, normal.id, dead.id, cascaded.id];
  const json = stable(fs.readFileSync(paths.json, 'utf8'), ids);
  const md = stable(fs.readFileSync(paths.md, 'utf8'), ids);
  assert.equal(`${digest(json)} ${digest(md)}`, `${PIN_JSON} ${PIN_MD}`, `json ${json.length} bytes, md ${md.length} bytes`);
});

// ---- ledger records written by `foreman landed`, `foreman deps --drop` and a cancelled dependency

const SHA = '0123456789abcdef0123456789abcdef01234567';

// Built on first use, so the characterization above reads a ledger these rows are not in.
function build() {
const epic2 = store.addTask({ title: 'Synthetic epic, by hand', prompt: 'Tickets closed by hand.', isEpic: true, playbook: 'soft', kind: 'general' });
store.setStatus(epic2.id, 'blocked', epic2.title);

// Written the way Store.markLanded writes it: statusBefore failed, statusAfter done, extra.commit, no merge event.
const byHand = ticket(epic2, 'Landed by hand');
run(byHand);
store.setStatus(byHand.id, 'failed', 'the merge conflicted');
tick(20);
store.addDecision({
  taskId: byHand.id, runId: null, action: 'landed', actor: 'human', note: 'landed by hand: fixed it on main', statusAfter: 'done',
  landedTree: 'f'.repeat(40), extra: { statusBefore: 'failed', commit: SHA },
});
const landedAtMs = clock;
store.setStatus(byHand.id, 'done', null);

const upstream = ticket(epic2, 'Upstream that is canceled');
store.setStatus(upstream.id, 'canceled', 'canceled by operator');
const waits = ticket(epic2, 'Waits on the canceled one', { deps: [upstream.id] });
tick();
store.setStatus(waits.id, 'blocked', `waiting: dependency ${upstream.id} was canceled - foreman deps ${waits.id} --drop ${upstream.id}, foreman landed ${upstream.id}, or foreman retry ${upstream.id}`);

const dropper = ticket(epic2, 'Had a dependency dropped', { deps: [upstream.id] });
tick();
store.addDecision({ taskId: dropper.id, runId: null, action: 'deps-drop', actor: 'human', note: 'dropped an edge', extra: { dep: upstream.id, statusBefore: 'blocked' } });

const cascade2 = ticket(epic2, 'Real cascade', { deps: [dead.id] });
tick();
store.setStatus(cascade2.id, 'failed', `dependency ${dead.id} ended as failed`);
return { epic2, byHand, upstream, waits, dropper, cascade2, landedAtMs };
}
let fixture: ReturnType<typeof build> | undefined;
const F = (): ReturnType<typeof build> => (fixture ??= build());

test('a landed decisions row is the ticket\'s landing, in --json and in the .md', async () => {
  const { epic2, byHand, landedAtMs } = F();
  const { report, paths } = await runDebrief(store, null, epic2.id, { noModel: true, outDir });
  const t = report.collect.tickets.find((x) => x.id === byHand.id)!;
  assert.equal(t.landing.merged, true);
  assert.equal(t.landing.at, landedAtMs);
  assert.notEqual(t.timing.decidedAt, null);
  assert.equal(t.timing.landedAt, landedAtMs);
  assert.ok(report.collect.timeline.some((e) => e.ticket === byHand.id && e.what === `landed by hand: commit ${SHA}`));
  assert.ok(t.operator.some((o) => o.action === 'landed'));
  const json = JSON.parse(fs.readFileSync(paths.json, 'utf8')) as { collect: { tickets: Array<{ id: string; landing: { merged: boolean }; timing: { decidedAt: number | null; landedAt: number | null } }> } };
  const j = json.collect.tickets.find((x) => x.id === byHand.id)!;
  assert.equal(j.landing.merged, true);
  assert.notEqual(j.timing.decidedAt, null);
  assert.notEqual(j.timing.landedAt, null);
  const md = fs.readFileSync(paths.md, 'utf8');
  assert.ok(md.includes(`landed by hand: commit ${SHA}`), 'the .md carries the commit');
});

test('a deps-drop row names its dependency in the trail and in operator actions', () => {
  const { epic2, dropper, upstream } = F();
  const doc = collectDebrief(store, epic2.id);
  const act = doc.tickets.find((x) => x.id === dropper.id)!.operator.find((o) => o.action === 'deps-drop')!;
  assert.ok(act.note.includes(upstream.id));
  assert.ok(doc.timeline.some((e) => e.ticket === dropper.id && e.what.includes(upstream.id) && /dropped dependency/.test(e.what)));
});

test('waiting on a canceled dependency is neither a failure nor a cascade; a real cascade still is', () => {
  const { epic2, waits, upstream, cascade2 } = F();
  const doc = collectDebrief(store, epic2.id);
  const w = doc.tickets.find((x) => x.id === waits.id)!;
  assert.equal(w.failures.length, 0);
  assert.equal(w.cascades.length, 0);
  assert.ok(doc.timeline.some((e) => e.ticket === waits.id && e.what.includes(`waiting on dependency ${upstream.id}`)));
  const c = doc.tickets.find((x) => x.id === cascade2.id)!;
  assert.equal(c.cascades.length, 1);
  assert.equal(c.cascades[0]!.dependency, dead.id);
});

test('the epic-level count of human approvals also counts landed rows', () => {
  const { epic2 } = F();
  const doc = collectDebrief(store, epic2.id);
  assert.ok(doc.notVisible.some((l) => /human approval\(s\) here/.test(l)));
});

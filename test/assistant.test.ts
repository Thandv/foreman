import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { planAsk, queuePlan, topoSort, type PlanNode } from '../src/assistant/plan.ts';
import {
  consolidate, CONSOLIDATE_MAX_TOKENS, EPISODE_PREFIX, isApprovalNote, PREFERENCE_PREFIX, recordDecision, recordEpisode, relevantFacts,
} from '../src/assistant/memory.ts';
import { registerTool } from '../src/tools/catalog.ts';
import { probeTask } from '../src/types.ts';
import { TruncatedReply } from '../src/models.ts';
import type { Run, Verdict } from '../src/types.ts';

function stub(replies: string[]): { store: Store; broker: Broker; calls: string[] } {
  const store = new Store(':memory:');
  const calls: string[] = [];
  let i = 0;
  const broker = new Broker(store, {
    chatFn: async (o) => {
      calls.push(o.alias);
      const text = replies[Math.min(i++, replies.length - 1)]!;
      if (text === 'THROW') throw new Error('planner down');
      const { resolveSpec } = await import('../src/models.ts');
      return { text, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  return { store, broker, calls };
}

// -------------------------------------------------------------- planning

test('a single-step ask becomes one node', async () => {
  const { store, broker } = stub([JSON.stringify({
    notes: 'straightforward', nodes: [{ ref: 'n1', title: 'Rename the helper', prompt: 'rename it everywhere', kind: 'code' }],
  })]);
  const plan = await planAsk({ ask: 'rename the helper', store, broker, repo: '/tmp/x' });
  assert.equal(plan.degraded, false);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0]!.kind, 'code');
  assert.equal(plan.nodes[0]!.repo, '/tmp/x');
  store.close();
});

test('a two-part ask becomes a 2-node DAG with a dep edge, queued in order', async () => {
  const { store, broker } = stub([JSON.stringify({
    notes: 'research then write',
    nodes: [
      { ref: 'write', title: 'Write the summary', prompt: 'write it up', kind: 'writing', after: ['research'] },
      { ref: 'research', title: 'Gather the numbers', prompt: 'find the numbers', kind: 'research', after: [] },
    ],
  })]);
  const plan = await planAsk({ ask: 'summarise last quarter', store, broker });
  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0]!.ref, 'research', 'dependencies are ordered first');

  const { tasks } = queuePlan(store, plan);
  const write = tasks.find((t) => t.title.startsWith('Write'))!;
  const research = tasks.find((t) => t.title.startsWith('Gather'))!;
  assert.deepEqual(write.deps, [research.id], 'the dep edge survives into the queue');
  assert.equal(write.status, 'blocked');
  assert.equal(research.status, 'queued');
  store.close();
});

test('a needed tool becomes a build node the work depends on', async () => {
  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: 'Pivot the CSV', prompt: 'pivot it', kind: 'general', needsTool: 'csv-pivot' }],
  })]);
  const plan = await planAsk({ ask: 'convert this CSV to a pivot xlsx', store, broker });
  const build = plan.nodes.find((n) => n.buildsTool === 'csv-pivot');
  assert.ok(build, 'a missing tool becomes a build node');
  assert.equal(build!.kind, 'tool');
  assert.match(build!.prompt, /manifest\.json/);
  assert.equal(plan.nodes.indexOf(build!), 0, 'the build runs first');
  assert.ok(plan.nodes.find((n) => n.ref === 'n1')!.after.includes(build!.ref));
  store.close();
});

test('an existing tool is reused instead of rebuilt', async () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-plancat-'));
  process.env['FOREMAN_TOOLS_DIR'] = catalog;
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-plansrc-'));
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
    name: 'csv-pivot', description: 'pivots a csv into an xlsx', runtime: 'node', entry: 'tool.js',
  }));
  fs.writeFileSync(path.join(src, 'tool.js'), 'process.stdout.write("{}")');
  registerTool({ sourceDir: src });

  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: 'Pivot it', prompt: 'pivot', kind: 'general', needsTool: 'csv-pivot', reason: 'csv-pivot already exists' }],
  })]);
  const plan = await planAsk({ ask: 'pivot this csv', store, broker });
  assert.equal(plan.nodes.length, 1, 'no build node for a tool that already exists');
  assert.deepEqual(plan.reusedTools, ['csv-pivot']);
  delete process.env['FOREMAN_TOOLS_DIR'];
  store.close();
});

test('an unreachable or useless planner degrades to a single task, never an error', async () => {
  for (const reply of ['THROW', 'I am not going to answer that', JSON.stringify({ nodes: [] })]) {
    const { store, broker } = stub([reply]);
    const plan = await planAsk({ ask: 'do the thing', store, broker });
    assert.equal(plan.degraded, true, `expected degradation for ${reply.slice(0, 20)}`);
    assert.equal(plan.nodes.length, 1);
    assert.equal(plan.nodes[0]!.prompt, 'do the thing');
    store.close();
  }
});

test('the planner is capped, deduped and cycle-safe', async () => {
  const { store, broker } = stub([JSON.stringify({
    nodes: [
      ...Array.from({ length: 9 }, (_, i) => ({ ref: `n${i}`, title: `step ${i}`, prompt: 'x', kind: 'general' })),
      { ref: 'n0', title: 'duplicate ref', prompt: 'x', kind: 'general' },
    ],
  })]);
  const plan = await planAsk({ ask: 'many steps', store, broker });
  assert.ok(plan.nodes.length <= 5, `expected at most 5 nodes, got ${plan.nodes.length}`);
  assert.equal(new Set(plan.nodes.map((n) => n.ref)).size, plan.nodes.length);

  const cyclic: PlanNode[] = [
    { ref: 'a', title: 'a', prompt: 'a', kind: 'general', runner: 'api', repo: null, after: ['b'], buildsTool: null, reason: '' },
    { ref: 'b', title: 'b', prompt: 'b', kind: 'general', runner: 'api', repo: null, after: ['a'], buildsTool: null, reason: '' },
  ];
  assert.equal(topoSort(cyclic).length, 2, 'a cycle is flattened, not fatal');
  store.close();
});

test('edges pointing at dropped nodes are removed rather than queued as dangling', async () => {
  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: 'Real step', prompt: 'do it', kind: 'general', after: ['ghost'] }],
  })]);
  const plan = await planAsk({ ask: 'x', store, broker });
  assert.deepEqual(plan.nodes[0]!.after, []);
  const { tasks } = queuePlan(store, plan);
  assert.equal(tasks[0]!.status, 'queued', 'a dangling edge must not leave the task blocked forever');
  store.close();
});

// ---------------------------------------------------------------- memory

const run = (over: Partial<Run> = {}): Run => ({
  id: 'r1', taskId: 't1', status: 'succeeded', stage: 'gate', progress: 1, worktreePath: null, branch: null,
  startedAt: 0, endedAt: 1, exitCode: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, summary: null,
  verdict: 'pass', testsPassed: true, pid: null, sessionId: null, ...over,
});

test('a finished run leaves an episode scoped to its repo', () => {
  const store = new Store(':memory:');
  const task = probeTask({ id: 't1', title: 'Add a guard', repo: '/repo', kind: 'code', runner: 'shell' });
  recordEpisode(store, task, run(), { verdict: 'pass', critique: 'clean' } as Verdict);
  const facts = store.recallFacts('/repo');
  assert.equal(facts.length, 1);
  assert.ok(facts[0]!.key.startsWith(EPISODE_PREFIX));
  assert.match(facts[0]!.value, /Add a guard.*pass/);
  assert.ok(facts[0]!.confidence < 0.5, 'a single run is weak evidence');
  assert.equal(store.recallFacts('/other').length, 0, 'episodes do not leak across repos');
  store.close();
});

test('a rejection with a reason becomes a preference that resurfaces', () => {
  const store = new Store(':memory:');
  const task = probeTask({ id: 't1', title: 'Rewrite the parser', repo: '/repo' });
  recordDecision(store, task, false, 'you rewrote unrelated files again');
  const fact = store.recallFacts('/repo')[0]!;
  assert.ok(fact.key.startsWith(PREFERENCE_PREFIX));
  assert.match(fact.value, /rejected.*unrelated files/);

  const surfaced = relevantFacts(store, '/repo', 'rewrite the parser tokeniser', 5);
  assert.equal(surfaced[0]!.id, fact.id, 'the rejection reason comes back for related work');
  store.close();
});

test('a bare approval teaches nothing, an annotated one does', () => {
  const store = new Store(':memory:');
  const task = probeTask({ id: 't1', title: 'x', repo: '/repo' });
  recordDecision(store, task, true, null);
  assert.equal(store.recallFacts('/repo').length, 0);
  recordDecision(store, task, true, 'good — small diffs like this');
  assert.equal(store.recallFacts('/repo').length, 1);
  store.close();
});

test('recall ranks preferences above episodes and irrelevant facts', () => {
  const store = new Store(':memory:');
  store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}old`, value: 'parser task passed', confidence: 0.35 });
  store.rememberFact({ scope: '/repo', key: `${PREFERENCE_PREFIX}p1`, value: 'rejected: parser changes must keep the tokeniser API', confidence: 0.75 });
  store.rememberFact({ scope: '/repo', key: 'build command', value: 'make release', confidence: 0.9 });
  const ranked = relevantFacts(store, '/repo', 'change the parser tokeniser', 3);
  assert.ok(ranked[0]!.key.startsWith(PREFERENCE_PREFIX), `expected a preference first, got ${ranked[0]!.key}`);
  assert.ok(ranked.length <= 3);
  store.close();
});

test('unrelated approval notes are never recalled', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 5; i++) {
    recordDecision(store, probeTask({ id: `t${i}`, title: `tty work ${i}`, repo: '/repo' }), true, 'verified tty raw stdin handling');
  }
  assert.equal(relevantFacts(store, '/repo', 'clang-format routes').length, 0);
  store.close();
});

test('a long fact needs two overlapping terms, any fact needs one', () => {
  const store = new Store(':memory:');
  store.rememberFact({ scope: '/repo', key: 'note-long', value: `parser tokeniser ${'x'.repeat(320)}`, confidence: 0.9 });
  store.rememberFact({ scope: '/repo', key: 'note-short', value: 'unrelated words', confidence: 0.9 });
  assert.equal(relevantFacts(store, '/repo', 'parser').length, 0, 'one term is not enough for a long fact');
  assert.deepEqual(relevantFacts(store, '/repo', 'parser tokeniser').map((f) => f.key), ['note-long']);
  store.close();
});

test('a rejection outranks approval notes at equal overlap, and approval notes are trimmed', () => {
  const store = new Store(':memory:');
  const long = `tokeniser ${'verified '.repeat(80)}`;
  // The rejection is recorded first, so recency cannot be what ranks it ahead.
  recordDecision(store, probeTask({ id: 'r1', title: 'parser', repo: '/repo' }), false, 'tokeniser must stay');
  recordDecision(store, probeTask({ id: 'a1', title: 'parser', repo: '/repo' }), true, long);
  recordDecision(store, probeTask({ id: 'a2', title: 'parser', repo: '/repo' }), true, long, 'owner-gate');
  const stored = new Map(store.recallFacts('/repo').map((f) => [f.key, f]));
  assert.equal(isApprovalNote(stored.get(`${PREFERENCE_PREFIX}a1`)!), true, 'human approval');
  assert.equal(isApprovalNote(stored.get(`${PREFERENCE_PREFIX}a2`)!), true, 'owner-gate approval');
  assert.equal(isApprovalNote(stored.get(`${PREFERENCE_PREFIX}r1`)!), false, 'rejection');

  const got = relevantFacts(store, '/repo', 'parser tokeniser');
  assert.equal(got[0]!.key, `${PREFERENCE_PREFIX}r1`);
  const approvals = got.filter(isApprovalNote);
  assert.equal(approvals.length, 2);
  for (const a of approvals) assert.ok(a.value.length <= 300);
  store.close();
});

test('scope-ubiquitous terms do not count as overlap', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 10; i++) {
    store.rememberFact({ scope: '/repo', key: `note-${i}`, value: `kiln run note ${i}`, confidence: 0.5 });
  }
  store.rememberFact({
    scope: '/repo', key: `${PREFERENCE_PREFIX}tabs`, confidence: 0.75,
    value: `rejected "save dirty tabs" — ${'kiln run python ui test '.repeat(15)}. Do not repeat this.`,
  });
  store.rememberFact({ scope: '/repo', key: 'stdin-note', value: 'stdin EOFError when input() reads a pipe', confidence: 0.5 });
  const got = relevantFacts(store, '/repo', 'Piped stdin reaches the program: printf | kiln run, Python input() EOFError');
  assert.deepEqual(got.map((f) => f.key), ['stdin-note']);
  store.close();
});

test('consolidation compacts episodes into durable facts and retires what it read', async () => {
  const { store, broker } = stub([JSON.stringify({
    facts: [
      { key: 'test command', value: 'Run the suite with npm test', confidence: 0.85, tickets: ['t1', 't2'] },
      { key: 'second', value: 'Keep diffs minimal', confidence: 0.8, tickets: ['t3', 't4'] },
      { key: `${EPISODE_PREFIX}sneaky`, value: 'should be dropped', confidence: 0.9, tickets: ['t1', 't2'] },
      { key: '', value: 'no key', confidence: 0.5 },
    ],
  })]);
  for (const i of [1, 2, 3, 4]) {
    store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t${i}`, value: `run ${i} passed with npm test`, confidence: 0.35 });
  }
  store.rememberFact({ scope: '/repo', key: 'convention', value: 'stdlib only', confidence: 0.8 });

  const result = await consolidate(store, broker, '/repo');
  assert.equal(result.episodesRead, 4);
  assert.equal(result.factsWritten, 2, 'invalid facts are dropped, episodes are never re-written');
  assert.equal(result.retired, 4);

  const left = store.recallFacts('/repo');
  assert.equal(left.filter((f) => f.key.startsWith(EPISODE_PREFIX)).length, 0);
  assert.ok(left.some((f) => f.key === 'test command'));
  assert.ok(left.some((f) => f.key === 'convention'), 'semantic facts survive consolidation');
  store.close();
});

/** A broker whose chat captures the system and user prompts and replies with `reply`. */
function capturing(reply: unknown): { store: Store; broker: Broker; sent: { system: string; user: string } } {
  const store = new Store(':memory:');
  const sent = { system: '', user: '' };
  const broker = new Broker(store, {
    chatFn: async (o) => {
      sent.system = o.messages.find((m) => m.role === 'system')!.content;
      sent.user = o.messages.find((m) => m.role === 'user')!.content;
      const { resolveSpec } = await import('../src/models.ts');
      return { text: JSON.stringify(reply), tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  return { store, broker, sent };
}

/** A task in `repo` with a failed verdict carrying `critique`. Returns its id. */
function failedTask(store: Store, repo: string, critique: string): string {
  const t = store.addTask({ title: 'x', prompt: 'p', runner: 'api', repo });
  const run = store.startRun(t.id);
  store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique });
  return t.id;
}

function seedTwoScopes(store: Store): { mine: string[]; other: string[] } {
  const mine = [failedTask(store, '/repo', 'CRITIQUE-A tests did not cover the change'), failedTask(store, '/repo', 'CRITIQUE-B acceptance item unmapped')];
  const other = [failedTask(store, '/other', 'CRITIQUE-OTHER foreign critique')];
  const demanding = store.addTask({ title: 'd', prompt: 'p', runner: 'api', repo: '/repo' });
  store.db.prepare('UPDATE tasks SET operator_demands = ? WHERE id = ?').run('DEMAND-A keep the CLI output stable', demanding.id);
  mine.push(demanding.id);
  store.rememberFact({ scope: '/repo', key: `${PREFERENCE_PREFIX}t_rej1`, value: 'rejected "x" — REJECT-A no sleeps. Do not repeat this.', confidence: 0.75 });
  store.rememberFact({ scope: '/other', key: `${PREFERENCE_PREFIX}t_rej2`, value: 'rejected "y" — REJECT-OTHER. Do not repeat this.', confidence: 0.75 });
  store.rememberFact({ scope: '/repo', key: `${PREFERENCE_PREFIX}t_app`, value: 'approved "z" — APPROVE-NOTE', confidence: 0.6 });
  mine.push('t_rej1');
  return { mine, other: [...other, 't_rej2'] };
}

test('consolidation reads the scope’s fail critiques, rejections and demands with ticket ids, and nothing from another scope', async () => {
  const { store, broker, sent } = capturing({ facts: [] });
  const { mine, other } = seedTwoScopes(store);
  await consolidate(store, broker, '/repo');
  for (const text of ['CRITIQUE-A', 'CRITIQUE-B', 'DEMAND-A', 'REJECT-A']) assert.ok(sent.user.includes(text), text);
  for (const id of mine) assert.ok(sent.user.includes(`[${id}]`), `ticket id ${id} is on its line`);
  for (const text of ['CRITIQUE-OTHER', 'REJECT-OTHER', 'APPROVE-NOTE']) assert.ok(!sent.user.includes(text), text);
  for (const id of other) assert.ok(!sent.user.includes(id), id);
  store.close();
});

test('consolidation builds critique lines from the finding, not the preamble', async () => {
  const { store, broker, sent } = capturing({ facts: [] });
  const preamble = 'The repair demand is met. The work is now finished and the summary is clear. '.repeat(5);
  const id = failedTask(store, '/repo', `senior (code-review) says FAIL: ${preamble}Acceptance item 4 has no test. Fix: add a test that fails without the change.`);
  failedTask(store, '/repo', 'filler one');
  failedTask(store, '/repo', 'filler two');
  await consolidate(store, broker, '/repo');
  const line = sent.user.split('\n').find((l) => l.startsWith(`- [${id}]`)) ?? '';
  assert.ok(line.includes('Acceptance item 4 has no test'), line);
  assert.ok(line.includes('Fix: add a test'), line);
  assert.ok(!line.includes('says FAIL'), line);
  assert.ok(!line.includes('repair demand is met'), line);
  store.close();
});

test('a fact citing a ticket whose critique line was truncated away is dropped', async () => {
  const reply: { facts: unknown[] } = { facts: [] };
  const { store, broker, sent } = capturing(reply);
  const ids = Array.from({ length: 60 }, (_, i) => failedTask(store, '/repo', `Acceptance item ${i} has no test. ${'Fix: add a test. '.repeat(8)}`));
  await consolidate(store, broker, '/repo');
  const shown = ids.filter((id) => sent.user.includes(`[${id}]`));
  const cut = ids.filter((id) => !sent.user.includes(`[${id}]`));
  assert.ok(shown.length >= 2 && cut.length > 0, 'the critiques budget truncates some lines');

  reply.facts = [
    { key: 'mixed', value: 'Cites a ticket the model never saw.', tickets: [shown[0], cut[0]] },
    { key: 'seen', value: 'Cites two shown tickets.', tickets: [shown[0], shown[1]] },
  ];
  await consolidate(store, broker, '/repo');
  const keys = store.recallFacts('/repo').map((f) => f.key);
  assert.ok(keys.includes('seen'));
  assert.ok(!keys.includes('mixed'), 'an id on a truncated line is not citable');
  store.close();
});

test('the minimum-input gate counts episodes, critiques and rejections together', async () => {
  const { store, broker, sent } = capturing({ facts: [] });
  store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t_e`, value: 'one', confidence: 0.35 });
  failedTask(store, '/repo', 'a critique');
  const early = await consolidate(store, broker, '/repo');
  assert.match(early.reason, /need 3/);
  assert.equal(sent.user, '', 'no model call below the gate');
  store.rememberFact({ scope: '/repo', key: `${PREFERENCE_PREFIX}t_r`, value: 'rejected "q" — no. Do not repeat this.', confidence: 0.75 });
  await consolidate(store, broker, '/repo');
  assert.ok(sent.user.includes('[t_r]'), 'three mixed inputs pass the gate');
  store.close();
});

test('facts citing fewer than 2 distinct tickets or unknown ids are dropped; survivors store their ids in source', async () => {
  const { store, broker } = capturing({ facts: [
    { key: 'good', value: 'Map every acceptance item to a test.', tickets: ['t_e1', 't_e2'] },
    { key: 'one-ticket', value: 'Only seen once.', tickets: ['t_e1'] },
    { key: 'dup-ticket', value: 'Same ticket twice.', tickets: ['t_e1', 't_e1'] },
    { key: 'unknown', value: 'Cites a stranger.', tickets: ['t_e1', 't_nope'] },
    { key: 'uncited', value: 'No tickets field.' },
  ] });
  for (const i of [1, 2, 3]) store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t_e${i}`, value: `run ${i}`, confidence: 0.35 });
  const result = await consolidate(store, broker, '/repo');
  assert.equal(result.factsWritten, 1);
  const kept = store.recallFacts('/repo').filter((f) => !f.key.startsWith(EPISODE_PREFIX));
  assert.deepEqual(kept.map((f) => f.key), ['good']);
  assert.equal(kept[0]!.source, 't_e1,t_e2');
  store.close();
});

test('one surviving fact retires no episode; two retire every episode read', async () => {
  const good = (key: string, tickets: string[]) => ({ key, value: `Do ${key}.`, tickets });
  const run = async (facts: unknown[]) => {
    const { store, broker } = capturing({ facts });
    for (const i of [1, 2, 3]) store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t_e${i}`, value: `run ${i}`, confidence: 0.35 });
    const result = await consolidate(store, broker, '/repo');
    const episodes = store.recallFacts('/repo').filter((f) => f.key.startsWith(EPISODE_PREFIX)).length;
    store.close();
    return { result, episodes };
  };
  const one = await run([good('a', ['t_e1', 't_e2']), good('b', ['t_e1'])]);
  assert.equal(one.result.factsWritten, 1);
  assert.equal(one.result.retired, 0);
  assert.equal(one.episodes, 3);
  assert.match(one.result.reason, /need 2/);
  const two = await run([good('a', ['t_e1', 't_e2']), good('b', ['t_e2', 't_e3'])]);
  assert.equal(two.result.retired, 3);
  assert.equal(two.episodes, 0);
});

test('the consolidation prompt asks for imperative guidance seen in at least 2 tickets', async () => {
  const { store, broker, sent } = capturing({ facts: [] });
  for (const i of [1, 2, 3]) store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t_e${i}`, value: `run ${i}`, confidence: 0.35 });
  await consolidate(store, broker, '/repo');
  assert.match(sent.system, /imperative guidance/);
  assert.match(sent.system, /at least 2 different tickets/);
  assert.match(sent.system, /"tickets"/);
  store.close();
});

test('consolidation refuses to destroy episodes when it cannot produce facts', async () => {
  const { store, broker } = stub(['THROW']);
  for (const i of [1, 2, 3]) {
    store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t${i}`, value: `run ${i}`, confidence: 0.35 });
  }
  const result = await consolidate(store, broker, '/repo');
  assert.equal(result.degraded, true);
  assert.equal(result.retired, 0, 'a failed consolidation must not eat the log');
  assert.equal(store.recallFacts('/repo').length, 3);
  store.close();
});

test('consolidation requests its full output budget and a truncated reply writes and retires nothing', async () => {
  const store = new Store(':memory:');
  const asked: (number | undefined)[] = [];
  const broker = new Broker(store, {
    chatFn: async (o) => {
      asked.push(o.maxTokens);
      throw new TruncatedReply(`qwen3.5:9b hit its output ceiling (${o.maxTokens} tokens) mid-reply`);
    },
  });
  for (const i of [1, 2, 3]) {
    store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t${i}`, value: `run ${i}`, confidence: 0.35 });
  }
  const result = await consolidate(store, broker, '/repo');
  assert.deepEqual(asked, [CONSOLIDATE_MAX_TOKENS]);
  assert.equal(CONSOLIDATE_MAX_TOKENS, 2000);
  assert.equal(result.degraded, true);
  assert.match(result.reason, /output ceiling/);
  assert.equal(result.factsWritten, 0);
  assert.equal(result.retired, 0);
  const left = store.recallFacts('/repo');
  assert.equal(left.length, 3, 'nothing written, nothing retired');
  assert.ok(left.every((f) => f.key.startsWith(EPISODE_PREFIX)));
  store.close();
});

test('consolidation waits until there is enough evidence', async () => {
  const { store, broker, calls } = stub([JSON.stringify({ facts: [] })]);
  store.rememberFact({ scope: '/repo', key: `${EPISODE_PREFIX}t1`, value: 'one run', confidence: 0.35 });
  const result = await consolidate(store, broker, '/repo');
  assert.equal(result.factsWritten, 0);
  assert.match(result.reason, /need 3/);
  assert.equal(calls.length, 0, 'no model call is paid for below the threshold');
  store.close();
});

test('consolidation stays local — it reads the private run log', async () => {
  const store = new Store(':memory:');
  const seen: string[] = [];
  const broker = new Broker(store, {
    chatFn: async (o) => {
      seen.push(o.sensitivity);
      const { resolveSpec } = await import('../src/models.ts');
      return { text: '{"facts":[]}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  for (const i of [1, 2, 3]) store.rememberFact({ scope: 'global', key: `${EPISODE_PREFIX}t${i}`, value: 'x', confidence: 0.3 });
  await consolidate(store, broker, 'global');
  assert.deepEqual(seen, ['S2'], 'the run log never goes to a cloud model');
  store.close();
});

test('a tool build is normalised into a real tool node however the planner phrases it', async () => {
  // The planner labels it a code node and describes the build in prose.
  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: 'Build a reusable CSV pivot tool', prompt: 'write a script that pivots csvs', kind: 'code' }],
  })]);
  const plan = await planAsk({ ask: 'build a csv pivot tool', store, broker });
  const node = plan.nodes[0]!;
  assert.equal(node.kind, 'tool', 'prose describing a tool build becomes a tool node');
  assert.equal(node.buildsTool, 'csv-pivot');
  assert.match(node.prompt, /manifest\.json/, 'and it gets the layout contract, not the loose prose');
  assert.match(node.title, /^Build tool: csv-pivot$/);
  store.close();
});

test('an unsluggable tool title falls back to an ordinary node rather than a broken build', async () => {
  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: '!!!', prompt: 'build a tool', kind: 'tool' }],
  })]);
  const plan = await planAsk({ ask: 'x', store, broker });
  assert.equal(plan.nodes[0]!.buildsTool, null);
  assert.notEqual(plan.nodes[0]!.kind, 'tool');
  store.close();
});

test('a standing ask is claimed once, re-armed, and planned by the scheduler', async () => {
  const { store, broker } = stub([JSON.stringify({
    nodes: [{ ref: 'n1', title: 'Triage the inbox', prompt: 'triage it', kind: 'general' }],
  })]);
  const s = store.addSchedule({ title: 'morning triage', spec: 'every 1h', ask: 'triage my inbox', repo: null });
  assert.equal(store.runDueSchedules(Date.now() + 3_600_000).length, 0, 'ask schedules are not template schedules');

  const due = store.claimDueAsks(Date.now() + 3_600_000);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.ask, 'triage my inbox');
  assert.equal(store.claimDueAsks(Date.now() + 3_600_000).length, 0, 're-armed into the future');

  const plan = await planAsk({ ask: due[0]!.ask, store, broker });
  const { tasks } = queuePlan(store, plan);
  assert.equal(tasks.length, 1);
  assert.equal(String(store.getSchedule(String(s['id']))!['ask']), 'triage my inbox');
  store.close();
});

test('a call waiting for a provider slot gives up when its task is aborted', async () => {
  const store = new Store(':memory:');
  let release!: () => void;
  const blocker = new Promise<void>((r) => { release = r; });
  const broker = new Broker(store, {
    concurrency: { ollama: 1 },
    chatFn: async (o) => {
      await blocker;
      const { resolveSpec } = await import('../src/models.ts');
      return { text: '{}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });

  const holder = broker.call({
    taskId: 't1', runId: 'r1', kind: 'council', alias: 'local-fast',
    messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S2',
  });
  await new Promise((r) => setTimeout(r, 20)); // let it take the only slot

  const ac = new AbortController();
  const waiter = broker.call({
    taskId: 't2', runId: 'r2', kind: 'council', alias: 'local-fast',
    messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S2', signal: ac.signal,
  });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(() => waiter, /aborted while waiting/, 'the queued call must not be held hostage');

  release();
  await holder;
  // The abandoned waiter must not have leaked a slot or a reservation.
  const after = await broker.call({
    taskId: 't3', runId: 'r3', kind: 'council', alias: 'local-fast',
    messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S2',
  });
  assert.equal(after.text, '{}');
  store.close();
});

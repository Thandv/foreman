import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { benchModels, benchPath, chooseRoster, PROBES, readBench, rosterAlias, type ModelBench } from '../src/bench.ts';
import { councilAliases, rungFor, runCouncil, MAX_RUNG } from '../src/verify/council.ts';
import { probeTask } from '../src/types.ts';
import { config } from '../src/config.ts';

const clearBench = (): void => fs.rmSync(benchPath(), { force: true });

function benchStub(answers: Record<string, string | ((probeId: string) => string)>): { store: Store; broker: Broker } {
  const store = new Store(':memory:');
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      const probe = PROBES.find((p) => o.messages.some((m) => m.content === p.prompt));
      const reply = answers[o.alias];
      const text = typeof reply === 'function' ? reply(probe?.id ?? '') : (reply ?? '');
      if (text === 'THROW') throw new Error('model unavailable');
      return { text, tokensIn: 10, tokensOut: 20, costUsd: 0, latencyMs: 5, spec: resolveSpec(o.alias) };
    },
  });
  return { store, broker };
}

/** A model that answers every probe correctly. */
const perfect = (probeId: string): string => {
  const map: Record<string, string> = {
    syllogism: 'no', arithmetic: '72', ordering: 'Dan', negation: 'no',
    'off-by-one': '{"verdict":"fail","why":"iterates past the end"}',
    'correct-diff': '{"verdict":"pass","why":"does what was asked"}',
    'swallowed-error': '{"answer":"yes"}',
    'scope-creep': '{"verdict":"fail","why":"unrelated rewrite"}',
    'exact-word': 'BANANA', 'json-only': '{"n":7}', 'list-format': 'red, yellow, blue',
    'refusal-of-invention': 'UNKNOWN',
  };
  return map[probeId] ?? '';
};

// -------------------------------------------------------------- the probes

test('every probe is scored by code, and scores what it claims to', () => {
  assert.equal(PROBES.length, 12);
  for (const category of ['reasoning', 'code', 'fidelity'] as const) {
    assert.equal(PROBES.filter((p) => p.category === category).length, 4, `${category} needs 4 probes`);
  }
  for (const probe of PROBES) {
    assert.equal(probe.score(perfect(probe.id)), 1, `${probe.id} should score its correct answer`);
    assert.equal(probe.score('I am not sure, it depends on many things.'), 0, `${probe.id} scored a non-answer`);
    assert.equal(probe.score('no idea'), 0, `${probe.id} scored a hedge as an answer`);
  }
});

test('the fidelity probes actually punish chattiness', () => {
  const exact = PROBES.find((p) => p.id === 'exact-word')!;
  assert.equal(exact.score('BANANA'), 1);
  assert.equal(exact.score('Sure! BANANA'), 0);
  const list = PROBES.find((p) => p.id === 'list-format')!;
  assert.equal(list.score('red, yellow, blue'), 1);
  assert.equal(list.score('The three primary colours are red, yellow and blue.'), 0);
  assert.equal(list.score('red, red, blue'), 0, 'duplicates are not three colours');
});

// ------------------------------------------------------------- benchmarking

test('benching scores each model and writes a roster', async () => {
  clearBench();
  const { store, broker } = benchStub({
    'local-fast': perfect,
    // A hedging model: it says "no idea" to everything it cannot answer.
    'local-general': (id) => (id.startsWith('exact') ? 'BANANA' : 'no idea'),
    'local-reason': perfect,
    'local-code': perfect,
  });
  const report = await benchModels(broker, { aliases: ['local-fast', 'local-general'] });
  assert.equal(report.models.length, 2);
  const fast = report.models.find((m) => m.alias === 'local-fast')!;
  assert.equal(fast.score, 1, 'a model that answers everything scores 1');
  assert.equal(fast.ok, true);
  const weak = report.models.find((m) => m.alias === 'local-general')!;
  assert.ok(weak.score < 0.3, `a hedging model must score low, got ${weak.score}`);
  assert.equal(weak.probes.find((p) => p.id === 'syllogism')!.score, 0, '"no idea" is not a correct "no"');
  assert.ok(report.roster['reason'], 'a roster is chosen');
  assert.equal(readBench()!.models.length, 2, 'the report is cached to disk');
  assert.ok(fs.existsSync(benchPath()));
  store.close();
  clearBench();
});

test('an unreachable model is recorded as down, not silently scored zero-and-ok', async () => {
  clearBench();
  const { store, broker } = benchStub({ 'local-fast': 'THROW' });
  const report = await benchModels(broker, { aliases: ['local-fast'] });
  const m = report.models[0]!;
  assert.equal(m.ok, false);
  assert.match(m.error!, /unavailable/);
  assert.equal(Object.keys(report.roster).length, 0, 'a down model cannot win a role');
  store.close();
  clearBench();
});

test('benching costs one receipt per probe and stops early on a dead model', async () => {
  clearBench();
  const { store, broker } = benchStub({ 'local-fast': perfect, 'local-code': 'THROW' });
  await benchModels(broker, { aliases: ['local-fast', 'local-code'] });
  const receipts = store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind LIKE 'bench%'").get()!['n'];
  assert.equal(Number(receipts), 13, '12 probes for the good model, 1 failed attempt for the dead one');
  store.close();
  clearBench();
});

test('a tie on correctness goes to the faster model', () => {
  const model = (over: Partial<ModelBench>): ModelBench => ({
    alias: 'x', model: 'x', provider: 'ollama', local: true, ok: true, error: null,
    coldStartMs: 100, tokensPerSec: 10, score: 1,
    byCategory: { reasoning: 1, code: 1, fidelity: 1 }, probes: [], measuredAt: '', ...over,
  });
  const roster = chooseRoster([model({ alias: 'slow', tokensPerSec: 2 }), model({ alias: 'quick', tokensPerSec: 9 })]);
  assert.equal(roster['reason'], 'quick');
  assert.equal(roster['code'], 'quick');
});

test('the ladder follows the bench, not the alias names', () => {
  clearBench();
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(benchPath(), JSON.stringify({
    models: [], roster: { fast: 'local-code', code: 'local-reason', reason: 'local-general' }, measuredAt: '',
  }));
  const rung0 = councilAliases('S1', 0);
  assert.equal(rung0.advisors[0], 'local-code', 'rung 0 uses the benched fast model, whatever it is called');
  const rung1 = councilAliases('S1', 1);
  assert.equal(rung1.advisors[0], 'local-reason', 'rung 1 uses the benched code model');
  clearBench();
});

test('roles go to the measured winners, and speed only counts if instructions are followed', () => {
  const model = (over: Partial<ModelBench>): ModelBench => ({
    alias: 'x', model: 'x', provider: 'ollama', local: true, ok: true, error: null,
    coldStartMs: 100, tokensPerSec: 10, score: 0.5,
    byCategory: { reasoning: 0.5, code: 0.5, fidelity: 0.5 }, probes: [], measuredAt: '', ...over,
  });
  const roster = chooseRoster([
    model({ alias: 'thinker', byCategory: { reasoning: 1, code: 0.25, fidelity: 0.75 }, score: 0.7 }),
    model({ alias: 'coder', byCategory: { reasoning: 0.5, code: 1, fidelity: 0.5 }, score: 0.7 }),
    model({ alias: 'sprinter', tokensPerSec: 500, byCategory: { reasoning: 0.25, code: 0.25, fidelity: 0.75 }, score: 0.4 }),
    model({ alias: 'gibberish', tokensPerSec: 9000, byCategory: { reasoning: 0, code: 0, fidelity: 0 }, score: 0 }),
  ]);
  assert.equal(roster['reason'], 'thinker');
  assert.equal(roster['code'], 'coder');
  assert.equal(roster['fast'], 'sprinter', 'the fastest model that can still follow an instruction');
});

test('roster lookup prefers the benched winner but always keeps a fallback', () => {
  clearBench();
  assert.deepEqual(rosterAlias('reason'), ['local-reason']);
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(benchPath(), JSON.stringify({ models: [], roster: { reason: 'local-code' }, measuredAt: '' }));
  assert.deepEqual(rosterAlias('reason'), ['local-code', 'local-reason']);
  clearBench();
});

// ------------------------------------------------------------ the ladder

test('priority and repair history decide the starting rung', () => {
  assert.equal(rungFor(probeTask({ priority: 0, repairs: 0 })), 0);
  assert.equal(rungFor(probeTask({ priority: 9, repairs: 0 })), 1);
  assert.equal(rungFor(probeTask({ priority: 0, repairs: 1 })), 1);
  assert.equal(rungFor(probeTask({ priority: 9, repairs: 3 })), MAX_RUNG);
});

test('each rung swaps in different models, and S2 never leaves the machine', () => {
  clearBench();
  const rung0 = councilAliases('S1', 0);
  const rung2 = councilAliases('S1', 2);
  assert.notDeepEqual(rung0.advisors, rung2.advisors, 'escalating must actually change who reviews');
  assert.equal(rung2.rung, 2);
  assert.equal(councilAliases('S1', 99).rung, 2, 'the ladder is clamped');

  const s2 = councilAliases('S2', 2);
  for (const alias of [...s2.advisors, s2.chair]) {
    assert.ok(alias.startsWith('local-'), `S2 escalated to a non-local alias: ${alias}`);
  }
});

test('a split verdict escalates one rung, and the receipts show it', async () => {
  const store = new Store(':memory:');
  const seenKinds: string[] = [];
  let round = 0;
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      return { text: 'not json at all', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const original = broker.call.bind(broker);
  (broker as unknown as { call: unknown }).call = async (req: { kind: string }) => {
    seenKinds.push(req.kind);
    round++;
    return original(req as never);
  };

  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();

  const verdict = await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true },
  });
  assert.equal(verdict.verdict, 'split', 'unparseable advisors never become a pass');
  assert.ok(seenKinds.some((k) => k === 'council@r0'), `expected a rung-0 round, saw ${seenKinds.join(',')}`);
  assert.ok(seenKinds.some((k) => k === 'council@r1'), 'a split must escalate one rung');
  assert.ok(round >= 4, 'both rounds actually ran');
  store.close();
});

test('a task already at the top rung does not escalate forever', async () => {
  const store = new Store(':memory:');
  const kinds: string[] = [];
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      return { text: 'nonsense', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const original = broker.call.bind(broker);
  (broker as unknown as { call: unknown }).call = async (req: { kind: string }) => {
    kinds.push(req.kind);
    return original(req as never);
  };
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code', priority: 9, repairs: 3 }), runId: 'r1',
    evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true }, rung: MAX_RUNG,
  });
  assert.ok(kinds.every((k) => k.endsWith(`@r${MAX_RUNG}`)), `escalated past the top: ${kinds.join(',')}`);
  store.close();
});

// -------------------------------------------------------------- VRAM guard

test('the residency guard serialises two large models instead of evicting one', async () => {
  const store = new Store(':memory:');
  const active = new Set<string>();
  const overlaps: string[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((r) => { releaseFirst = r; });

  const broker = new Broker(store, {
    concurrency: { ollama: 4 }, // the pool would happily run both at once
    loadedModelsFn: async () => new Set<string>(), // nothing resident: every call is a load
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      const spec = resolveSpec(o.alias);
      if (active.size > 0 && !active.has(spec.model)) overlaps.push(spec.model);
      active.add(spec.model);
      if (spec.alias === 'local-code') await firstDone;
      else await new Promise((r) => setTimeout(r, 10));
      active.delete(spec.model);
      return { text: '{}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec };
    },
  });

  const heavy = broker.call({
    taskId: null, runId: null, kind: 'council', alias: 'local-code',
    messages: [{ role: 'user', content: 'x' }], sensitivity: 'S2',
  });
  await new Promise((r) => setTimeout(r, 30));
  const other = broker.call({
    taskId: null, runId: null, kind: 'council', alias: 'local-reason',
    messages: [{ role: 'user', content: 'x' }], sensitivity: 'S2',
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(overlaps, [], 'the second model must wait rather than force an eviction');

  releaseFirst();
  await Promise.all([heavy, other]);
  assert.deepEqual(overlaps, [], 'and it still must not overlap after the first finishes');
  store.close();
});

test('an already-resident model is dispatched without waiting', async () => {
  const store = new Store(':memory:');
  const { resolveSpec } = await import('../src/models.ts');
  const resident = new Set([resolveSpec('local-reason').model, resolveSpec('local-code').model]);
  let concurrent = 0;
  let peak = 0;
  const broker = new Broker(store, {
    concurrency: { ollama: 4 },
    loadedModelsFn: async () => resident,
    chatFn: async (o) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return { text: '{}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  await Promise.all(['local-reason', 'local-code'].map((alias) =>
    broker.call({ taskId: null, runId: null, kind: 'council', alias, messages: [{ role: 'user', content: 'x' }], sensitivity: 'S2' }),
  ));
  assert.equal(peak, 2, 'resident models are not serialised for no reason');
  store.close();
});

test('the guard does not block when the runtime cannot be inspected', async () => {
  const store = new Store(':memory:');
  const broker = new Broker(store, {
    concurrency: { ollama: 4 },
    loadedModelsFn: async () => { throw new Error('ollama is not running'); },
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      await new Promise((r) => setTimeout(r, 20));
      return { text: '{}', tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const results = await Promise.all(['local-reason', 'local-code'].map((alias) =>
    broker.call({ taskId: null, runId: null, kind: 'council', alias, messages: [{ role: 'user', content: 'x' }], sensitivity: 'S2' }),
  ));
  assert.equal(results.length, 2, 'an unreadable runtime must not deadlock dispatch');
  store.close();
});

// ------------------------------------------------------- deterministic verdicts

test('the same review is decoded with the same seed and temperature every time', async () => {
  const { seedFor } = await import('../src/models.ts');
  assert.equal(seedFor('review this diff'), seedFor('review this diff'));
  assert.notEqual(seedFor('review this diff'), seedFor('review that diff'));
  assert.ok(Number.isInteger(seedFor('x')) && seedFor('x') >= 0 && seedFor('x') < 2_147_483_647);

  const store = new Store(':memory:');
  const seen: Array<{ seed?: number; temperature?: number }> = [];
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      seen.push({ seed: o.seed, temperature: o.temperature });
      const { resolveSpec } = await import('../src/models.ts');
      return {
        text: '{"verdict":"pass","confidence":0.9,"issues":[]}',
        tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias),
      };
    },
  });
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();

  await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: 'diff --git a/x b/x', bodyLabel: 'diff', testsPassed: true },
  });
  assert.ok(seen.length >= 2, 'both advisors were asked');
  for (const call of seen) {
    assert.equal(call.temperature, 0, 'verdicts are decoded greedily');
    assert.ok(typeof call.seed === 'number', 'every council call pins a seed');
  }
  // Two advisors get deliberately different prompts, so their seeds differ.
  assert.notEqual(seen[0]!.seed, seen[1]!.seed);
  store.close();
});

test('a decoding change is a cache miss, not a silent reuse of an old verdict', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const makeBroker = (critique: string): Broker =>
    new Broker(store, {
      guardResidency: false,
      chatFn: async (o) => {
        calls++;
        const { resolveSpec } = await import('../src/models.ts');
        return {
          text: JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [critique] }),
          tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias),
        };
      },
    });
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();

  const args = {
    store, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: 'diff --git a/x b/x', bodyLabel: 'diff' as const, testsPassed: true },
  };
  const first = await runCouncil({ ...args, broker: makeBroker('first') });
  const before = calls;
  const second = await runCouncil({ ...args, broker: makeBroker('second') });

  assert.equal(calls, before, 'an identical review is served from the cache');
  assert.equal(second.verdict, first.verdict);
  assert.match(second.critique ?? '', /first/, 'the cached critique is the one that was cached');
  store.close();
});

test('a verdict that names its reason in another field is not dropped on the floor', async () => {
  const { parseOpinion } = await import('../src/verify/council.ts');
  // The asked-for shape.
  assert.equal(parseOpinion('{"verdict":"fail","confidence":0.8,"issues":["off-by-one in the loop"]}')!.critique,
    'off-by-one in the loop');
  // Shapes a model reaches for anyway — the reason must survive, because the
  // repair round is briefed with exactly this text.
  assert.equal(parseOpinion('{"verdict":"fail","confidence":0.8,"critique":"off-by-one in the loop"}')!.critique,
    'off-by-one in the loop');
  assert.equal(parseOpinion('{"verdict":"fail","confidence":0.8,"reason":"off-by-one"}')!.critique, 'off-by-one');
  // A pass with nothing to say is still a valid opinion.
  assert.equal(parseOpinion('{"verdict":"pass","confidence":0.9,"issues":[]}')!.critique, '');
  // Not a verdict at all.
  assert.equal(parseOpinion('{"confidence":0.9}'), null);
  assert.equal(parseOpinion('I think it is fine'), null);
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { Scheduler } from '../src/scheduler.ts';
import { ModelUnavailable, resolveSpec, type ChatMessage } from '../src/models.ts';
import { runCouncil } from '../src/verify/council.ts';
import { hardHumanReason } from '../src/gate.ts';
import { loadNeedGb, pagingAllowanceGb } from '../src/memory.ts';
import { probeTask, type Run } from '../src/types.ts';

const MSG: ChatMessage[] = [{ role: 'user', content: 'review this' }];
const PASS = JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [] });

/** A broker whose memory says only `fitting` models can load, and which records which alias each call ran on. */
function broker(store: Store, fitting: Set<string>, behave: (alias: string) => string | Error = () => PASS) {
  const ran: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async (model) => fitting.has(model),
    chatFn: async (o) => {
      ran.push(o.alias);
      const out = behave(o.alias);
      if (out instanceof Error) throw out;
      return { text: out, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  return { b, ran };
}

const receipts = (store: Store): Array<Record<string, unknown>> =>
  store.db.prepare('SELECT model, downshifted_from, kind FROM receipts ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;

// ---------------------------------------------------------------- the broker

test('the cheaper coder is on hand, and the strong models step down to it', () => {
  assert.equal(resolveSpec('local-code-small').model, 'qwen2.5-coder:7b');
  assert.deepEqual(resolveSpec('local-code').downshift, ['local-code-small', 'local-fast']);
  assert.deepEqual(resolveSpec('local-reason').downshift, ['local-fast']);
});

test('a model that does not fit steps down to the first one that does — and says so', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set(['qwen2.5-coder:7b', 'qwen3.5:2b']));
  const res = await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  assert.deepEqual(ran, ['local-code-small']);
  assert.equal(res.downshiftedFrom, 'local-code');
  assert.equal(res.spec.model, 'qwen2.5-coder:7b');
  assert.deepEqual(receipts(store).map((r) => [r['model'], r['downshifted_from']]), [['qwen2.5-coder:7b', 'local-code']]);
  store.close();
});

test('a model that fits runs as asked, with nothing marked', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set(['qwen2.5-coder:14b']));
  const res = await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  assert.deepEqual(ran, ['local-code']);
  assert.equal(res.downshiftedFrom, undefined);
  assert.equal(receipts(store)[0]!['downshifted_from'], null);
  store.close();
});

test('when nothing fits, the smallest model runs — it pages least', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set());
  await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  assert.deepEqual(ran, ['local-fast']);
  store.close();
});

test('a stall before the first token steps down and retries instead of failing the task', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set(['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'qwen3.5:2b']), (alias) =>
    alias === 'local-code' ? new ModelUnavailable('http://127.0.0.1:11434/api/chat sent nothing for 180000ms') : PASS);
  const res = await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  assert.deepEqual(ran, ['local-code', 'local-code-small']);
  assert.equal(res.downshiftedFrom, 'local-code');
  store.close();
});

test('any other failure is not papered over by a smaller model', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set(['qwen2.5-coder:14b']), () => new ModelUnavailable('model not found'));
  await assert.rejects(b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' }));
  assert.deepEqual(ran, ['local-code']);
  store.close();
});

test('FOREMAN_DOWNSHIFT=off runs what was asked for, fitting or not', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set());
  process.env['FOREMAN_DOWNSHIFT'] = 'off';
  try {
    await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  } finally {
    delete process.env['FOREMAN_DOWNSHIFT'];
  }
  assert.deepEqual(ran, ['local-code']);
  store.close();
});

test('the fit rule matches what this machine did: the 9B loaded at 0.8 GB reclaimable, the 14B could not', () => {
  const available = 0.8 + pagingAllowanceGb();
  assert.ok(loadNeedGb(6.6, 16_384) <= available, 'the 9B at a prose window fits');
  assert.ok(loadNeedGb(9.0, 8_192) > available, 'the 14B at an 8k window does not');
  assert.ok(loadNeedGb(4.7, 8_192) <= available, 'the 7B coder does');
});

// ---------------------------------------------------------------- the council

function councilTask(store: Store, kind: 'code' | 'writing' = 'code'): { taskId: string; runId: string } {
  store.db.prepare(`INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','${kind}','api','S1','verifying',2,0,0)`).run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  return { taskId: 't1', runId: 'r1' };
}

test('a council that ran on stepped-down models writes a provisional verdict', async () => {
  process.env['FOREMAN_LOCAL_ONLY'] = '1';
  const store = new Store(':memory:');
  try {
    councilTask(store);
    const { b } = broker(store, new Set(['qwen3.5:9b', 'qwen2.5-coder:7b', 'qwen3.5:2b']));
    const v = await runCouncil({
      store, broker: b, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0,
      evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true },
    });
    assert.equal(v.provisional, true);
    assert.ok(v.council.some((o) => o.model === 'qwen2.5-coder:7b'), 'the opinion names the model that answered');
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
    store.close();
  }
});

test('a stepped-down opinion is never cached under the full model — the re-check must really re-check', async () => {
  process.env['FOREMAN_LOCAL_ONLY'] = '1';
  const store = new Store(':memory:');
  try {
    councilTask(store);
    const evidence = { body: 'diff', bodyLabel: 'diff', testsPassed: true };
    const tight = broker(store, new Set(['qwen3.5:9b', 'qwen2.5-coder:7b', 'qwen3.5:2b']));
    await runCouncil({ store, broker: tight.b, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0, evidence });
    const roomy = broker(store, new Set(['qwen3.5:9b', 'qwen2.5-coder:14b']));
    const v = await runCouncil({ store, broker: roomy.b, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0, evidence });
    assert.ok(roomy.ran.includes('local-code'), `the 14B was asked, not replayed from a 7B's cache: ${roomy.ran.join(',')}`);
    assert.equal(v.provisional, false);
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
    store.close();
  }
});

test('the owner model never signs off a provisional review', () => {
  const green: Run = {
    id: 'r', taskId: 't', status: 'succeeded', stage: 'done', startedAt: 0, endedAt: 1, exitCode: 0,
    summary: null, verdict: 'pass', testsPassed: true,
  } as unknown as Run;
  const task = probeTask({ status: 'awaiting-approval', gate: 'owner' });
  assert.match(hardHumanReason(task, green, { provisional: true }) ?? '', /provisional/);
});

// ---------------------------------------------------------------- the sweep

async function withProvisional(
  fits: boolean | (() => boolean),
  fn: (ctx: { store: Store; sched: Scheduler; taskId: string; reverified: () => number }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ds-'));
  const store = new Store(':memory:');
  let reverified = 0;
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async () => (typeof fits === 'function' ? fits() : fits),
    chatFn: async (o) => ({ text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }),
  });
  const task = store.addTask({ title: 'fix', prompt: 'fix it', kind: 'code' });
  const sched = new Scheduler(store, {
    verifyEnabled: false, broker: b,
    verify: async () => {
      reverified++;
      return store.addVerdict({ runId: store.latestRun(task.id)!.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  const run = store.startRun(task.id);
  store.endRun(run.id, 'succeeded', { summary: 'fixed' });
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, '+fixed\n');
  store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
  store.setStatus(task.id, 'awaiting-approval');
  process.env['FOREMAN_RECHECK_MS'] = '0';
  try {
    await fn({ store, sched, taskId: task.id, reverified: () => reverified });
  } finally {
    delete process.env['FOREMAN_RECHECK_MS'];
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const settle = async (sched: Scheduler, ticks = 5): Promise<void> => {
  for (let i = 0; i < ticks; i++) {
    await sched.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('provisional work is listed for a re-check, and nothing else is', async () => {
  await withProvisional(false, async ({ store, taskId }) => {
    assert.deepEqual(store.provisionalAwaiting().map((t) => t.id), [taskId]);
  });
});

test('while the full council does not fit, provisional work waits — it is not re-checked on the same small models', async () => {
  await withProvisional(false, async ({ sched, reverified, store, taskId }) => {
    await settle(sched);
    assert.equal(reverified(), 0);
    assert.equal(store.provisionalAwaiting()[0]?.id, taskId);
  });
});

test('once the full council fits, the work is re-checked once and stops being provisional — the work is kept', async () => {
  await withProvisional(true, async ({ sched, reverified, store, taskId }) => {
    const runBefore = store.latestRun(taskId)!.id;
    await settle(sched);
    assert.equal(reverified(), 1);
    assert.deepEqual(store.provisionalAwaiting(), []);
    assert.equal(store.latestRun(taskId)!.id, runBefore, 'no new run: the work was not redone');
    assert.equal(store.getTask(taskId)!.status, 'awaiting-approval', 'still yours to approve');
    await settle(sched);
    assert.equal(reverified(), 1, 'a checked task is not re-checked again');
  });
});

test('memory freeing up later is what triggers the re-check', async () => {
  let free = false;
  await withProvisional(() => free, async ({ sched, reverified }) => {
    await settle(sched);
    assert.equal(reverified(), 0);
    free = true;
    await settle(sched);
    assert.equal(reverified(), 1);
  });
});

test('the re-check never competes with live work for the machine', async () => {
  await withProvisional(true, async ({ sched, reverified, store }) => {
    store.addTask({ title: 'live', prompt: 'x', runner: 'echo' });
    await sched.tick(); // claims the echo task into the work lane, then considers a re-check
    await new Promise((r) => setTimeout(r, 50)); // a wrongly-started re-check would have finished by now
    assert.equal(reverified(), 0, 'not while work is running');
  });
});

// ------------------------------------------------- round two: what the red team found

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { benchModels, benchPath, chooseRoster } from '../src/bench.ts';
import { config } from '../src/config.ts';
import { councilAliases } from '../src/verify/council.ts';
import { modelFits, modelInstalled, resetCapacityCache } from '../src/memory.ts';

test('the bench measures exactly the model it names — it never steps down, and never benches the step-down-only coder', async () => {
  const store = new Store(':memory:');
  const { b, ran } = broker(store, new Set()); // nothing fits
  const report = await benchModels(b, { aliases: ['local-code'] });
  assert.ok(ran.every((a) => a === 'local-code'), `bench ran on ${[...new Set(ran)].join(',')}`);
  assert.equal(report.models[0]!.model, 'qwen2.5-coder:14b');
  const all = await benchModels(broker(store, new Set(['qwen2.5-coder:14b', 'qwen3.5:9b', 'qwen3.5:2b', 'llama3.1:8b'])).b);
  assert.ok(!all.models.some((m) => m.alias === 'local-code-small'), 'never benched by default');
  store.close();
});

test('even benched by name, the step-down-only coder never takes a roster seat or a council seat', () => {
  const m = (alias: string) => ({
    alias, model: alias, provider: 'ollama', local: true, ok: true, error: null, coldStartMs: 1, tokensPerSec: 99,
    score: 1, byCategory: { reasoning: 1, code: 1, fidelity: 1 }, probes: [], measuredAt: '',
  });
  const roster = chooseRoster([m('local-code-small'), { ...m('local-reason'), tokensPerSec: 4 }]);
  assert.ok(!Object.values(roster).includes('local-code-small'), JSON.stringify(roster));
  // And a bench file written before this rule — its roster naming the 7B for
  // every seat — still cannot put it on a council.
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(benchPath(), JSON.stringify({ models: [], measuredAt: '', roster: { fast: 'local-code-small', code: 'local-code-small', reason: 'local-code-small' } }));
  try {
    for (const kind of ['code', 'writing'] as const) {
      for (const rung of [0, 1, 2]) {
        const { advisors, chair } = councilAliases('S1', rung, kind);
        assert.ok(![...advisors, chair].includes('local-code-small'), `${kind} rung ${rung}: ${advisors.join('+')} / ${chair}`);
      }
    }
  } finally {
    fs.rmSync(benchPath(), { force: true });
  }
});

test('a model that did not fit is held off — the choice does not flap back to it on the next call', async () => {
  const store = new Store(':memory:');
  let roomy = false;
  const ran: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async (model) => roomy || model !== 'qwen2.5-coder:14b',
    chatFn: async (o) => { ran.push(o.alias); return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }; },
  });
  const req = { taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' as const };
  await b.call(req);
  roomy = true; // the 7B is now resident; its memory "counts" — the oscillation trigger
  await b.call(req);
  assert.deepEqual(ran, ['local-code-small', 'local-code-small'], 'stayed down for the hold');
  assert.equal(await b.fits('qwen2.5-coder:14b', 8192), false, 'the re-check sweep sees the hold too');
  process.env['FOREMAN_DOWNSHIFT_HOLD_MS'] = '0';
  try {
    const fresh = new Broker(store, { guardResidency: false, fitsFn: async () => true, chatFn: async (o) => ({ text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }) });
    assert.equal(await fresh.fits('qwen2.5-coder:14b', 8192), true, 'and the hold is a hold, not a ban');
  } finally {
    delete process.env['FOREMAN_DOWNSHIFT_HOLD_MS'];
  }
  store.close();
});

test('a step-down target that was never pulled is skipped, not tried', async () => {
  const store = new Store(':memory:');
  const ran: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    // The realistic case: an unpulled model has no known size, so the fit
    // check passes it — only the installed check can keep it out.
    fitsFn: async (model) => model !== 'qwen2.5-coder:14b',
    installedFn: async (model) => model !== 'qwen2.5-coder:7b',
    chatFn: async (o) => { ran.push(o.alias); return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }; },
  });
  await b.call({ taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' });
  assert.deepEqual(ran, ['local-fast']);
  store.close();
});

test('memory.ts reads Ollama honestly: resident fits, an unknown size is not a reason to step down, an absent tag is not installed', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/ps') res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b', size: 7e9 }] }));
    else res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b', size: 9e9 }, { name: 'llama3.1:latest', size: 5e9 }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetCapacityCache();
  try {
    assert.equal(await modelFits('qwen3.5:9b', 8192), true, 'resident');
    assert.equal(await modelFits('mystery:1b', 8192), true, 'unknown size');
    assert.equal(await modelInstalled('qwen2.5-coder:7b'), false);
    assert.equal(await modelInstalled('qwen2.5-coder:14b'), true);
    assert.equal(await modelInstalled('llama3.1'), true, 'an untagged name is :latest');
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    resetCapacityCache();
    server.close();
  }
});

test('a seat lost to memory — stepped down and still failed — makes the verdict provisional', async () => {
  process.env['FOREMAN_LOCAL_ONLY'] = '1';
  const store = new Store(':memory:');
  try {
    councilTask(store);
    const { b } = broker(store, new Set(['qwen3.5:9b']), (alias) =>
      alias === 'local-code' || alias === 'local-code-small' ? new ModelUnavailable('http://x/api/chat sent nothing for 180000ms') : alias === 'local-fast' ? new ModelUnavailable('model not found') : PASS);
    const v = await runCouncil({ store, broker: b, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0, evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true } });
    assert.equal(v.provisional, true, `"${v.chairSummary}" should not stand as a full review`);
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
    store.close();
  }
});

test('an aborted review writes nothing — the task stays provisional and queued for its re-check', async () => {
  await withProvisional(true, async ({ store, sched, taskId }) => {
    const ac = new AbortController();
    ac.abort();
    process.env['FOREMAN_LOCAL_ONLY'] = '1';
    try {
      await assert.rejects(runCouncil({
        store, broker: sched.broker, task: store.getTask(taskId)!, runId: store.latestRun(taskId)!.id, signal: ac.signal,
        evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true },
      }));
    } finally {
      delete process.env['FOREMAN_LOCAL_ONLY'];
    }
    assert.equal(store.verdictsForTask(taskId).length, 1, 'no split row written');
    assert.deepEqual(store.provisionalAwaiting().map((t) => t.id), [taskId]);
  });
});

test('an approval landing mid-re-check is not overwritten by the late verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ds-'));
  const store = new Store(':memory:');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const task = store.addTask({ title: 'fix', prompt: 'fix it', kind: 'code' });
  const sched = new Scheduler(store, {
    verifyEnabled: false,
    verify: async (args) => {
      await gate;
      if (args.stillCurrent && !args.stillCurrent()) throw new Error('moved on');
      return store.addVerdict({ runId: args.runId, taskId: task.id, verdict: 'fail', disagreement: false, council: [] });
    },
  });
  try {
    const run = store.startRun(task.id);
    store.endRun(run.id, 'succeeded', { summary: 'fixed' });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [], provisional: true });
    store.setStatus(task.id, 'awaiting-approval');
    const recheck = sched.reverify(task.id);
    store.setStatus(task.id, 'done'); // the operator approved while the review ran
    release();
    await recheck.catch(() => null);
    assert.equal(store.verdictsForTask(task.id)[0]!.verdict, 'pass', 'the stale fail never landed');
    await assert.rejects(sched.reverify(task.id), /only work parked at the gate/);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shadow council writes no verdict row — it cannot gate, badge or re-check anything', async () => {
  process.env['FOREMAN_LOCAL_ONLY'] = '1';
  const store = new Store(':memory:');
  try {
    councilTask(store);
    const { b } = broker(store, new Set()); // all stepped down: would be provisional
    const v = await runCouncil({ store, broker: b, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1', rung: 0, shadow: true, evidence: { body: 'diff', bodyLabel: 'diff', testsPassed: true } });
    assert.equal(v.provisional, true, 'the shadow still knows what it was');
    assert.equal(store.verdictsForTask('t1').length, 0);
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
    store.close();
  }
});

test('a provisional FAIL parks for the re-check — no repair round on the word of stepped-down reviewers', async () => {
  const store = new Store(':memory:');
  // `shell`, not `echo`: echo is verifiable:false and never reaches review — a
  // first cut of this test passed against a path it was not exercising.
  const t = store.addTask({ title: 'x', prompt: 'true', runner: 'shell' });
  let reviewed = 0;
  const sched = new Scheduler(store, {
    verifyEnabled: true,
    verify: async (args) => {
      reviewed++;
      return store.addVerdict({
        runId: args.runId, taskId: args.task.id, verdict: 'fail', disagreement: false, critique: 'weak says no', provisional: true,
        council: [{ model: 'qwen3.5:2b', provider: 'ollama', local: true, verdict: 'fail', confidence: 0.9, critique: 'no', costUsd: 0, latencyMs: 1 }],
      });
    },
  });
  try {
    await sched.drain(20_000);
    const after = store.getTask(t.id)!;
    assert.equal(reviewed, 1, 'the review path really ran');
    assert.equal(after.status, 'awaiting-approval', after.error ?? '');
    assert.equal(after.repairs, 0, 'no repair round was spent');
    assert.match(after.error ?? '', /provisional fail/);
    assert.deepEqual(store.provisionalAwaiting().map((x) => x.id), [t.id], 'queued for the full council');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('re-checks that never get the full council back off, then give up after four tries and say so', async () => {
  await withProvisional(true, async ({ store, sched, taskId }) => {
    // Every re-check comes back provisional again: memory fills mid-review.
    (sched as unknown as { verifyFn: unknown }).verifyFn = async (args: { runId: string }) =>
      store.addVerdict({ runId: args.runId, taskId, verdict: 'pass', disagreement: false, council: [], provisional: true });
    const notBefore = (sched as unknown as { recheckNotBefore: Map<string, number> }).recheckNotBefore;
    const key = `${taskId}@${store.latestRun(taskId)!.id}`; // keyed by run: a retry starts fresh
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      await settle(sched, 3);
      const until = notBefore.get(key) ?? 0;
      seen.push(until === Number.POSITIVE_INFINITY ? Infinity : Math.round((until - Date.now()) / 60_000));
      if (until !== Number.POSITIVE_INFINITY) notBefore.set(key, 0); // skip the wait, keep the count
    }
    assert.deepEqual(seen.slice(0, 4), [15, 30, 60, Infinity], `backoff doubled, then stopped: ${seen.join(',')}`);
    const events = store.db.prepare("SELECT message FROM events WHERE task_id = ? AND message LIKE 'gave up%'").all(taskId);
    assert.equal(events.length, 1, 'the operator is told, once');
  });
});

// ------------------------------------------------- round three

import { setMemoryReader } from '../src/memory.ts';

test('a re-check reviews the LATEST run’s own diff — never an earlier attempt’s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ds-'));
  const store = new Store(':memory:');
  const bodies: string[] = [];
  const task = store.addTask({ title: 'fix', prompt: 'fix it', kind: 'code' });
  const sched = new Scheduler(store, {
    verifyEnabled: false,
    verify: async (args) => {
      bodies.push(args.evidence.body);
      return store.addVerdict({ runId: args.runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    for (const tag of ['RUN ONE', 'RUN TWO']) {
      const run = store.startRun(task.id);
      store.endRun(run.id, 'succeeded', { summary: tag });
      const p = path.join(dir, `${tag}.patch`);
      fs.writeFileSync(p, `+${tag} DIFF\n`);
      store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: p, summary: null });
    }
    store.setStatus(task.id, 'awaiting-approval');
    await sched.reverify(task.id);
    assert.deepEqual(bodies, ['+RUN TWO DIFF\n']);
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hold expires under steady traffic — it is not re-armed by the calls it holds off', async () => {
  const store = new Store(':memory:');
  let roomy = false;
  const ran: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async (model) => roomy || model !== 'qwen2.5-coder:14b',
    chatFn: async (o) => { ran.push(o.alias); return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }; },
  });
  process.env['FOREMAN_DOWNSHIFT_HOLD_MS'] = '200';
  try {
    const req = { taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' as const, numCtx: 8192 };
    await b.call(req); // does not fit: held for 200ms
    roomy = true;
    const until = Date.now() + 500;
    while (Date.now() < until) {
      await b.call(req); // a call every ~50ms, all through the hold
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(ran.at(-1), 'local-code', `the 14B came back once the hold ran out: ${ran.join(',')}`);
  } finally {
    delete process.env['FOREMAN_DOWNSHIFT_HOLD_MS'];
    store.close();
  }
});

test('a hold at a big window does not hold off a small one', async () => {
  const store = new Store(':memory:');
  const ran: string[] = [];
  const b = new Broker(store, {
    guardResidency: false,
    fitsFn: async (model, numCtx) => model !== 'qwen2.5-coder:14b' || (numCtx ?? 0) <= 4096,
    chatFn: async (o) => { ran.push(o.alias); return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }; },
  });
  const base = { taskId: null, runId: null, kind: 'agent', alias: 'local-code', messages: MSG, sensitivity: 'S1' as const };
  await b.call({ ...base, numCtx: 32_768 });
  await b.call({ ...base, numCtx: 2_048 });
  assert.deepEqual(ran, ['local-code-small', 'local-code']);
  store.close();
});

test('modelFits says no when memory is genuinely short, and yes when it is not', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/ps') res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b', size: 7e9, context_length: 4096 }] }));
    else res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b', size: 9e9 }, { name: 'qwen3.5:9b', size: 6.6e9 }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['FOREMAN_PAGING_ALLOWANCE_GB'] = '0';
  try {
    resetCapacityCache();
    setMemoryReader(async () => ({ reclaimableGb: 1, swapUsedGb: 0, swapTotalGb: 0 }));
    // 9.5 GB needed; 1 reclaimable + 7 evictable (the resident 9B) = 8.
    assert.equal(await modelFits('qwen2.5-coder:14b', 8192), false);
    assert.equal(await modelFits('qwen3.5:9b', 4096), true, 'resident at this window');
    assert.equal(await modelFits('qwen3.5:9b', 16_384), true, 'a reload for a bigger window: 6.6+1 ≤ 1+7');
    resetCapacityCache();
    setMemoryReader(async () => ({ reclaimableGb: 4, swapUsedGb: 0, swapTotalGb: 0 }));
    assert.equal(await modelFits('qwen2.5-coder:14b', 8192), true, '4 + 7 ≥ 9.5');
  } finally {
    setMemoryReader(null);
    resetCapacityCache();
    delete process.env['FOREMAN_PAGING_ALLOWANCE_GB'];
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    server.close();
  }
});

test('a retried task starts its re-checks fresh — an earlier give-up does not carry over', async () => {
  await withProvisional(true, async ({ store, sched, taskId, reverified }) => {
    const notBefore = (sched as unknown as { recheckNotBefore: Map<string, number> }).recheckNotBefore;
    notBefore.set(`${taskId}@${store.latestRun(taskId)!.id}`, Number.POSITIVE_INFINITY); // gave up on run 1
    await settle(sched);
    assert.equal(reverified(), 0, 'run 1 stays given up');
    // A retry: a new run, parked provisional again.
    const run2 = store.startRun(taskId);
    store.endRun(run2.id, 'succeeded', { summary: 'second attempt' });
    store.addVerdict({ runId: run2.id, taskId, verdict: 'pass', disagreement: false, council: [], provisional: true });
    store.setStatus(taskId, 'awaiting-approval');
    await settle(sched);
    assert.equal(reverified(), 1, 'the new run gets its own re-check');
  });
});

test('a fail the full council CONFIRMS on re-check gets the repair round it was held back from', async () => {
  await withProvisional(true, async ({ store, sched, taskId }) => {
    (sched as unknown as { verifyFn: unknown }).verifyFn = async (args: { runId: string }) =>
      store.addVerdict({ runId: args.runId, taskId, verdict: 'fail', disagreement: false, council: [], critique: 'really broken' });
    // The queued repair round is then dispatched to the claude-code runner.
    // Point it at a binary that cannot exist, so that run fails the same way on
    // every host instead of racing (or spending on) whatever `claude` is on
    // PATH. What it does is not under test; what the re-check queued is.
    process.env['FOREMAN_CLAUDE_BIN'] = path.join(os.tmpdir(), 'foreman-test-no-such-claude');
    try {
      await settle(sched);
    } finally {
      delete process.env['FOREMAN_CLAUDE_BIN'];
    }
    const t = store.getTask(taskId)!;
    assert.equal(t.repairs, 1, 'one repair round was queued');
    const said = store.eventsForTask(taskId).map((e) => e.message);
    assert.ok(said.includes('the full council confirmed the fail; queuing one repair round'), said.join(' | '));
    assert.ok(said.includes('repair round 1 queued'), said.join(' | '));
    assert.notEqual(t.error, 'really broken', 'the re-check sent it to the work lane, not straight to failed');
  });
});

test('a pass the full council confirms clears the "provisional" park note', async () => {
  await withProvisional(true, async ({ store, sched, taskId }) => {
    store.setStatus(taskId, 'awaiting-approval', 'provisional pass from stepped-down models — re-checked by the full council once it fits');
    await settle(sched);
    assert.equal(store.getTask(taskId)!.error, null);
  });
});

test('through the REAL council, a re-check whose task was approved mid-review writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ds-'));
  const store = new Store(':memory:');
  const task = store.addTask({ title: 'fix', prompt: 'fix it', kind: 'code' });
  const b = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      store.setStatus(task.id, 'done'); // the operator approves while the advisors answer
      return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const sched = new Scheduler(store, { verifyEnabled: false, broker: b }); // default verify = runCouncil
  try {
    const run = store.startRun(task.id);
    store.endRun(run.id, 'succeeded', { summary: 'fixed' });
    const p = path.join(dir, 'd.patch');
    fs.writeFileSync(p, '+fixed\n');
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: p, summary: null });
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'fail', disagreement: false, council: [], provisional: true });
    store.setStatus(task.id, 'awaiting-approval');
    await assert.rejects(sched.reverify(task.id), /moved on/);
    assert.equal(store.verdictsForTask(task.id).length, 1, 'no late verdict over the approval');
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a resident model asked for a bigger window than it holds is judged as the reload it is', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/ps') res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b', size: 9e9, context_length: 4096 }] }));
    else res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b', size: 9e9 }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['FOREMAN_PAGING_ALLOWANCE_GB'] = '0';
  try {
    resetCapacityCache();
    setMemoryReader(async () => ({ reclaimableGb: 1, swapUsedGb: 0, swapTotalGb: 0 }));
    assert.equal(await modelFits('qwen2.5-coder:14b', 4096), true, 'already loaded at this window');
    // 9 + 0.5·(32768/8192) = 11 GB needed; 1 reclaimable + 9 (itself, evicted for the reload) = 10.
    assert.equal(await modelFits('qwen2.5-coder:14b', 32_768), false, 'resident is not a free pass for a bigger window');
  } finally {
    setMemoryReader(null);
    resetCapacityCache();
    delete process.env['FOREMAN_PAGING_ALLOWANCE_GB'];
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    server.close();
  }
});

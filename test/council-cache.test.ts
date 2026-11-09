import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { config } from '../src/config.ts';
import { reloadSpecs, resolveSpec } from '../src/models.ts';
import { runCouncil } from '../src/verify/council.ts';
import { probeTask } from '../src/types.ts';

// The council's opinion cache replays a verdict only for the settings it was
// decoded under. The context window and the output ceiling are among them: a
// verdict reached under a smaller window (the rubric dropped off the front) or
// a tighter output cap is not the answer the new settings would give.

const PASS = JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [] });

type Council = typeof runCouncil;

/** Runs one council on a fixed fixture against `store`; returns how many model calls it made. */
async function review(store: Store, council: Council = runCouncil): Promise<number> {
  let calls = 0;
  const broker = new Broker(store, {
    guardResidency: false,
    fitsFn: async () => true,
    chatFn: async (o) => {
      calls++;
      return { text: PASS, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  await council({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: 'diff --git a/x b/x\n+one line', bodyLabel: 'diff', testsPassed: true },
  });
  return calls;
}

function ledger(): Store {
  reloadSpecs();
  const store = new Store(':memory:');
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  return store;
}

test('an identical second review is served from the opinion cache', async () => {
  const store = ledger();
  try {
    assert.ok(await review(store) > 0);
    assert.equal(await review(store), 0, 'same settings: every opinion is a cache hit');
  } finally {
    store.close();
  }
});

test('pin: changing the council output ceiling still replays the cached opinions', async () => {
  const store = ledger();
  const cap = config as { councilMaxOutputTokens: number };
  const before = cap.councilMaxOutputTokens;
  try {
    const first = await review(store);
    assert.ok(first > 0);
    // A one-line diff sits under the 4096-token window floor either way, so only maxTokens differs.
    cap.councilMaxOutputTokens = before + 50;
    assert.equal(await review(store), 0, 'today a new output ceiling is a cache hit');
  } finally {
    cap.councilMaxOutputTokens = before;
    store.close();
  }
});

test('pin: changing FOREMAN_COUNCIL_NUM_CTX still replays the cached opinions', async () => {
  const store = ledger();
  try {
    const first = await review(store);
    assert.ok(first > 0);
    // The window ceiling is read once at module load, so a second copy of the
    // module is the council as it runs after a restart with the new setting.
    // 2048 is below the 4096 floor the fixture's window would otherwise get.
    process.env['FOREMAN_COUNCIL_NUM_CTX'] = '2048';
    const fresh = new URL('../src/verify/council.ts?num-ctx=2048', import.meta.url).href;
    const { runCouncil: restarted } = await import(fresh) as { runCouncil: Council };
    assert.equal(await review(store, restarted), 0, 'today a new window is a cache hit');
  } finally {
    delete process.env['FOREMAN_COUNCIL_NUM_CTX'];
    store.close();
  }
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boundBrief, compactDiff, diffStats, tailLog } from '../src/context.ts';
import { Store } from '../src/queue.ts';
import { Broker, keepAliveFor } from '../src/budget.ts';
import { runCouncil } from '../src/verify/council.ts';
import { benchPath } from '../src/bench.ts';
import type { Task } from '../src/types.ts';

// ----------------------------------------------------------- diff compaction

/** A synthetic multi-file diff: `files` files, `linesEach` changed lines each. */
function syntheticDiff(files: number, linesEach: number): string {
  const parts: string[] = [];
  for (let f = 0; f < files; f++) {
    const name = `src/file${f}.ts`;
    const body = [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -1,${linesEach} +1,${linesEach} @@`,
    ];
    for (let l = 0; l < linesEach; l++) body.push(`+line ${l} of file ${f} padded ${'x'.repeat(40)}`);
    parts.push(body.join('\n'));
  }
  return parts.join('\n');
}

test('a diff under the cap is returned untouched', () => {
  const small = syntheticDiff(2, 3);
  assert.equal(compactDiff(small, 100_000), small);
});

test('a ~500KB diff compacts under the cap while prioritising the most-touched file', () => {
  // One file with a huge change, plus many small ones.
  const big =
    syntheticDiff(1, 7000).replace(/file0/g, 'hot') + '\n' + syntheticDiff(40, 3);
  assert.ok(big.length > 450_000, `fixture should be ~500KB, was ${big.length}`);

  const cap = 24_000;
  const out = compactDiff(big, cap);
  assert.ok(out.length <= cap + 500, `compacted output ${out.length} should be within the ${cap} cap`);
  assert.ok(out.length < big.length / 10, 'and dramatically smaller than the raw diff');
  assert.match(out, /FOREMAN compacted this diff/);
  // Every file appears in the per-file summary…
  assert.match(out, /src\/hot\.ts  \+7000/);
  assert.match(out, /src\/file39\.ts/);
  // …and the most-touched file's actual hunks are prioritised (its early lines
  // are present), truncated only where they would breach the cap.
  assert.match(out, /--- hunks: src\/hot\.ts ---/);
  assert.ok(out.includes('line 0 of file 0'), 'the hottest file supplies the shown hunks');
  assert.match(out, /truncated to fit|smaller file/);
});

test('diffStats counts adds and removes per file, ignoring the +++/--- markers', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '+extra',
  ].join('\n');
  assert.deepEqual(diffStats(diff), [{ path: 'a.ts', added: 2, removed: 1 }]);
});

test('log tails and memory briefs are bounded deterministically', () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const tail = tailLog(log, 10, 10_000);
  assert.equal(tail.split('\n').length, 10);
  assert.match(tail, /line 499/);
  assert.doesNotMatch(tail, /line 100\b/);

  // The marker is paid for out of the budget, not added on top of it: a
  // function that promises a bound and returns more is a leak into every
  // prompt that uses it.
  const brief = boundBrief('a'.repeat(300) + '\n' + 'b'.repeat(300), 200);
  assert.ok(brief.length <= 200, `bounded to 200, got ${brief.length}`);
  assert.match(brief, /FOREMAN cut this section here at 200 bytes; the rest was NOT sent/);
  assert.doesNotMatch(brief, /was given all of it/, 'never claim the reader got what was cut');

  // A budget too small to hold the marker still honours the bound.
  const tiny = boundBrief('a'.repeat(500), 30);
  assert.ok(tiny.length <= 30, `bounded to 30, got ${tiny.length}`);
});

// -------------------------------------------------------- council memoisation

function countingBroker(store: Store): { broker: Broker; calls: () => number } {
  const broker = new Broker(store);
  let n = 0;
  (broker as unknown as { call: unknown }).call = async (req: { alias: string }) => {
    n++;
    return {
      text: '{"verdict":"pass","confidence":0.8,"critique":"clean"}',
      tokensIn: 100, tokensOut: 20, costUsd: 0, latencyMs: 5,
      spec: { alias: req.alias, provider: 'ollama', model: req.alias, local: true, usdPerMTokIn: 0, usdPerMTokOut: 0 },
    };
  };
  return { broker, calls: () => n };
}

const councilTask = (): Task => ({
  id: 't1', title: 'x', prompt: 'do it', kind: 'code', repo: null, agent: null, runner: 'echo',
  sensitivity: 'S1', budgetUsd: null, priority: 0, status: 'verifying', attempts: 1, maxAttempts: 2,
  error: null, testCmd: null, mergeOnApprove: false, repairNotes: null, repairs: 0, maxRepairs: 1,
  scheduleId: null, parentId: null, allowCore: false, baseRef: null, role: null, playbook: null, points: null,
  acceptance: null, isEpic: false, gate: null, gateDecision: null, assignee: null, archivedAt: null, createdAt: 0, updatedAt: 0, deps: [],
});

test('an identical re-review hits the council cache and records $0 receipts', async () => {
  const store = new Store(':memory:');
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','echo','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  const { broker, calls } = countingBroker(store);
  const evidence = { body: 'diff --git a/x b/x\n+a', bodyLabel: 'diff', testsPassed: true };

  const first = await runCouncil({ store, broker, task: councilTask(), runId: 'r1', evidence });
  assert.equal(first.verdict, 'pass');
  const callsAfterFirst = calls();
  assert.ok(callsAfterFirst >= 2, 'the first review pays for its advisors');

  const cacheRows = () =>
    Number((store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind LIKE '%:cache'").get() as { n: number }).n);
  assert.equal(cacheRows(), 0, 'nothing was cached before the first review');

  const second = await runCouncil({ store, broker, task: councilTask(), runId: 'r1', evidence });
  assert.equal(second.verdict, 'pass');
  assert.equal(calls(), callsAfterFirst, 'the identical re-review pays the model nothing');
  assert.ok(cacheRows() >= 2, 'and books a $0 cache receipt per reused advisor');
  const spent = Number((store.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS s FROM receipts WHERE kind LIKE '%:cache'").get() as { s: number }).s);
  assert.equal(spent, 0, 'cache receipts are honestly $0');
  store.close();
});

test('a changed diff does not hit the cache', async () => {
  const store = new Store(':memory:');
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','echo','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  const { broker, calls } = countingBroker(store);
  await runCouncil({ store, broker, task: councilTask(), runId: 'r1', evidence: { body: 'diff --git a/x b/x\n+a', bodyLabel: 'diff', testsPassed: true } });
  const after = calls();
  await runCouncil({ store, broker, task: councilTask(), runId: 'r1', evidence: { body: 'diff --git a/x b/x\n+DIFFERENT', bodyLabel: 'diff', testsPassed: true } });
  assert.ok(calls() > after, 'a genuinely different review is re-judged, not served stale');
  store.close();
});

// ------------------------------------------------------------- ollama keep-alive

test('roster models stay warm while cold ones fall out of memory', () => {
  fs.writeFileSync(benchPath(), JSON.stringify({ models: [], roster: { reason: 'local-reason' }, measuredAt: '' }));
  try {
    assert.equal(keepAliveFor('local-reason'), '30m', 'a benched roster model is kept resident');
    assert.equal(keepAliveFor('local-fast'), '5m', 'a model not on the roster is allowed to cool');
  } finally {
    fs.rmSync(benchPath(), { force: true });
  }
});

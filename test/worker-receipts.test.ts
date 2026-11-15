import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeAfterStops, stopsFirst } from './helpers/removal.ts';
import { Store } from '../src/queue.ts';
import { Broker, BudgetExceeded } from '../src/budget.ts';
import { Scheduler } from '../src/scheduler.ts';
import { overDailyCap } from '../src/gate.ts';
import { setCloudDown } from '../src/localOnly.ts';
import { reloadSpecs, resolveSpec, type chat } from '../src/models.ts';
import { resetPreflightCache } from '../src/runners/cliRunners.ts';

// What a claude-code worker's own spend (the CLI's total_cost_usd) does to the ledger and to the budget caps.

const WORKER_COST = 0.5;

function useEnv(t: TestContext, vars: Record<string, string>): void {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  setCloudDown(null);
  reloadSpecs();
  resetPreflightCache();
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setCloudDown(null);
    reloadSpecs();
    resetPreflightCache();
  });
}

/** A `claude` stand-in whose one stream-json result reports WORKER_COST. */
function fakeClaude(t: TestContext): string {
  const dir = scratchDir('foreman-wr-claude-');
  removeAfterStops(t, dir);
  const turn = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', usage: { input_tokens: 1200, output_tokens: 300 }, content: [{ type: 'text', text: 'done' }] },
  });
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: WORKER_COST, num_turns: 1, result: 'done' });
  fs.writeFileSync(path.join(dir, 'body'), `${turn}\n${result}\n`);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\ncat "${path.join(dir, 'body')}"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const chatFn: typeof chat = async (o) => ({ text: '{}', tokensIn: 10, tokensOut: 10, costUsd: 0.0001, latencyMs: 1, spec: resolveSpec(o.alias) });

function rig(t: TestContext): { store: Store; sched: Scheduler } {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false, broker: new Broker(store, { chatFn }) });
  stopsFirst(t, async () => {
    await sched.stop();
    store.close();
  });
  return { store, sched };
}

async function runToEnd(t: TestContext, store: Store, sched: Scheduler, taskId: string): Promise<void> {
  const ended = (): boolean => {
    const run = store.latestRun(taskId);
    return !!run && run.status !== 'running';
  };
  while (!ended()) {
    t.signal.throwIfAborted();
    await sched.tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await sched.drain(10_000);
}

test('a claude-code run that reports total_cost_usd moves no budget cap', async (t) => {
  // A subscription ceiling below the worker's cost: counted, it would hold every ticket.
  useEnv(t, { FOREMAN_CLAUDE_BIN: fakeClaude(t), FOREMAN_LOCAL_ONLY: 'off', FOREMAN_DAILY_SUBSCRIPTION_USD_CAP: String(WORKER_COST / 2) });
  const { store, sched } = rig(t);
  const task = store.addTask({ title: 'worker spend', prompt: 'x', runner: 'claude-code', maxAttempts: 1, budgetUsd: WORKER_COST / 5 });
  await runToEnd(t, store, sched, task.id);

  assert.equal(store.latestRun(task.id)!.costUsd, WORKER_COST, 'the run row carries the CLI-reported cost');
  assert.equal(overDailyCap(store, 1), null);
  assert.equal(store.spentToday(), 0);
  assert.equal(store.spentTodaySubscription(), 0);
  assert.equal(store.spentOnTask(task.id), 0);

  // Recorded, though: exactly one worker receipt, in the honest total and the task's receipts.
  const receipts = store.receiptsForTask(task.id);
  const worker = receipts.filter((r) => r['kind'] === 'worker');
  assert.equal(worker.length, 1, `one worker receipt; saw ${JSON.stringify(receipts)}`);
  assert.equal(worker[0]!['provider'], 'claude-cli');
  assert.equal(worker[0]!['run_id'], store.latestRun(task.id)!.id);
  assert.equal(Number(worker[0]!['local']), 0);
  assert.equal(Number(worker[0]!['cost_usd']), WORKER_COST);
  assert.equal(Number(worker[0]!['tokens_in']), 1200);
  assert.equal(Number(worker[0]!['tokens_out']), 300);
  assert.equal(store.spentTodayIncludingSubscription(), WORKER_COST);
  assert.ok(store.recentReceipts(50, 'today').some((r) => r['kind'] === 'worker'), 'the spend view lists it');
  assert.equal(store.receiptTotals('today').costUsd, WORKER_COST);
});

test('a council call on a task with budgetUsd is not refused because of the worker\'s cost', async (t) => {
  useEnv(t, { FOREMAN_CLAUDE_BIN: fakeClaude(t), FOREMAN_LOCAL_ONLY: 'off' });
  const { store, sched } = rig(t);
  const budgetUsd = WORKER_COST / 5;
  const task = store.addTask({ title: 'worker spend', prompt: 'x', runner: 'claude-code', maxAttempts: 1, budgetUsd });
  await runToEnd(t, store, sched, task.id);
  assert.equal(store.receiptsForTask(task.id).filter((r) => r['kind'] === 'worker').length, 1);

  const call = (): ReturnType<Broker['call']> => sched.broker.call({
    taskId: task.id, runId: null, kind: 'council', alias: 'sonnet',
    messages: [{ role: 'user', content: 'judge' }], sensitivity: 'S1', taskBudgetUsd: budgetUsd, maxTokens: 100,
  });
  await call();
  // The cap still binds on what it always counted.
  store.addReceipt({ taskId: task.id, kind: 'council', provider: 'claude-cli', model: 'm', local: false, costUsd: budgetUsd });
  await assert.rejects(call(), BudgetExceeded);
});

test('an API-runner run writes no worker receipt', async (t) => {
  const { store, sched } = rig(t);
  const task = store.addTask({ title: 'api', prompt: 'say hello', runner: 'api', maxAttempts: 1 });
  await runToEnd(t, store, sched, task.id);
  const receipts = store.receiptsForTask(task.id);
  assert.ok(receipts.length > 0, 'the broker settled the API runner\'s own calls');
  assert.deepEqual(receipts.filter((r) => r['kind'] === 'worker'), []);
});

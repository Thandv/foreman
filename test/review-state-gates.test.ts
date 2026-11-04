import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { verdictChain } from '../src/gate.ts';
import type { AdvisorOpinion } from '../src/types.ts';

// The protected paths (queue event log, scheduler re-review note, gate owner-model chain) word a provisional or
// unread review as such, never as "pass".

const read: AdvisorOpinion = { model: 'qwen3.5:9b', provider: 'ollama', local: true, verdict: 'pass', confidence: 0.9, critique: 'fine', costUsd: 0, latencyMs: 1 };
const unreached: AdvisorOpinion = { ...read, error: 'sent nothing for 180000ms', confidence: 0, critique: '' };

function parked(store: Store, council: AdvisorOpinion[], provisional: boolean) {
  const task = store.addTask({ title: 't', prompt: 'p', kind: 'code', gate: 'human' });
  store.setStatus(task.id, 'running');
  const run = store.startRun(task.id);
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'done' });
  const verdict = store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council, provisional, costUsd: 0 });
  return { task, run, verdict };
}

const messages = (store: Store, taskId: string): string[] => store.eventsForTask(taskId).filter((e) => e.type === 'verdict').map((e) => e.message);

test('queue: the verdict event words a provisional or unread review honestly', () => {
  const store = new Store(':memory:');
  const prov = parked(store, [read, read], true);
  assert.deepEqual(messages(store, prov.task.id), ['council: provisional pass']);
  const none = parked(store, [unreached, unreached], false);
  assert.deepEqual(messages(store, none.task.id), ['council: not reviewed']);
  const ok = parked(store, [read, read], false);
  assert.deepEqual(messages(store, ok.task.id), ['council: pass']);
  assert.equal(none.verdict.verdict, 'pass', 'the stored verdict itself is untouched');
  store.close();
});

test('scheduler: a re-review note never says pass for a provisional or unread verdict', async () => {
  const cases: Array<[AdvisorOpinion[], boolean, string]> = [
    [[read, read], true, 're-review: provisional pass'],
    [[unreached, unreached], false, 're-review: not reviewed'],
    [[read, read], false, 're-review: pass'],
  ];
  for (const [council, provisional, want] of cases) {
    const store = new Store(':memory:');
    const { task } = parked(store, [read], false);
    const sched = new Scheduler(store, {
      verifyEnabled: false,
      verify: async (args) => store.addVerdict({ runId: args.runId, taskId: task.id, verdict: 'pass', disagreement: false, council, provisional, costUsd: 0 }),
    });
    try {
      store.setStatus(task.id, 'awaiting-approval');
      await sched.reverify(task.id);
      assert.ok(messages(store, task.id).includes(want), messages(store, task.id).join(' | '));
    } finally {
      await sched.stop();
      store.close();
    }
  }
});

test('gate: the verdict chain the owner model reads never calls a provisional or unread review a pass', () => {
  const store = new Store(':memory:');
  const prov = parked(store, [read, read], true);
  assert.match(verdictChain(store, prov.task, prov.run), /council review → provisional pass/);
  const none = parked(store, [unreached, unreached], false);
  const chain = verdictChain(store, none.task, none.run);
  assert.match(chain, /council review → not reviewed/);
  assert.doesNotMatch(chain, /review → pass/);
  const ok = parked(store, [read, read], false);
  assert.match(verdictChain(store, ok.task, ok.run), /council review → pass/);
  store.close();
});

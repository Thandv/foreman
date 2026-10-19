import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { effectiveGate, gateOptIn, hardHumanReason } from '../src/gate.ts';
import { probeTask, type Run } from '../src/types.ts';

const store = (): Store => new Store(':memory:');

/** A run that went cleanly green — the only kind the owner gate may sign off. */
const greenRun = (over: Partial<Run> = {}): Run => ({
  id: 'r1', taskId: 't1', status: 'succeeded', stage: 'gate', progress: 1,
  worktreePath: null, branch: null, startedAt: 0, endedAt: 1, exitCode: 0, pid: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, summary: 'done',
  verdict: 'pass', testsPassed: true, sessionId: null, ...over,
});

test('the house gate decides tickets with no opinion of their own, and survives a restart', () => {
  const s = store();
  assert.equal(s.defaultGate(), null, 'never set is distinct from set to human');
  assert.equal(effectiveGate({ gate: null, playbook: null }, s.defaultGate()), 'human');

  s.setDefaultGate('owner');
  assert.equal(effectiveGate({ gate: null, playbook: null }, s.defaultGate()), 'owner');
  assert.equal(gateOptIn({ gate: null, playbook: null }, s.defaultGate()), true);
  s.close();
});

test('a ticket that says human still gates on the human, whatever the house says', () => {
  const s = store();
  s.setDefaultGate('owner');
  assert.equal(effectiveGate({ gate: 'human', playbook: null }, s.defaultGate()), 'human');
  assert.equal(gateOptIn({ gate: 'human', playbook: null }, s.defaultGate()), false);
  s.close();
});

test('gateWaiting hands over the backlog, and only the backlog', () => {
  const s = store();
  const waiting = s.addTask({ title: 'finished', prompt: 'x' });
  const running = s.addTask({ title: 'still going', prompt: 'x' });
  s.setStatus(waiting.id, 'awaiting-approval');

  const changed = s.gateWaiting('owner');
  assert.deepEqual(changed, [waiting.id]);
  assert.equal(s.getTask(waiting.id)!.gate, 'owner');
  assert.equal(s.getTask(running.id)!.gate, null, 'work not yet at the gate is untouched');

  // Idempotent: a second pass has nothing to change.
  assert.deepEqual(s.gateWaiting('owner'), []);
  s.close();
});

test('re-gating clears a decision already recorded, or the new gate never runs', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'x' });
  s.setStatus(t.id, 'awaiting-approval');
  s.markGateDecision(t.id, 'hold@1');
  assert.ok(s.gateDecision(t.id));
  s.setGate(t.id, 'owner');
  assert.equal(s.gateDecision(t.id), null, 'a stale decision would suppress the new gate silently');
  s.close();
});

test('a closed task cannot be re-gated', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'x' });
  s.setStatus(t.id, 'done');
  assert.throws(() => s.setGate(t.id, 'owner'), /already done/);
  s.close();
});

test('handing a ticket to the owner does not bypass a single hard-human rail', () => {
  // The property that makes the toggle safe to press. Every one of these is a
  // ticket the operator might expect fable to take off their hands, and must
  // not: the owner gate exists to skip rubber-stamping green work, never to
  // overrule work that went red.
  const owned = { gate: 'owner' as const };
  const cases: Array<[string, ReturnType<typeof probeTask>, Run | null]> = [
    ['S2', probeTask({ ...owned, sensitivity: 'S2' }), greenRun()],
    ['allowCore', probeTask({ ...owned, allowCore: true }), greenRun()],
    ['budget stop', probeTask({ ...owned, error: 'budget hard-stop: cap reached' }), greenRun()],
    ['no run', probeTask({ ...owned }), null],
    ['run failed', probeTask({ ...owned }), greenRun({ status: 'failed' })],
    ['tests failed', probeTask({ ...owned }), greenRun({ testsPassed: false })],
    ['verdict fail', probeTask({ ...owned }), greenRun({ verdict: 'fail' })],
    ['verdict split', probeTask({ ...owned }), greenRun({ verdict: 'split' })],
    ['no verdict', probeTask({ ...owned }), greenRun({ verdict: null })],
  ];
  for (const [label, task, run] of cases) {
    assert.ok(hardHumanReason(task, run), `${label} must still park for a person`);
  }
  // ...and green work with no such flag is exactly what it may decide.
  assert.equal(hardHumanReason(probeTask({ ...owned }), greenRun()), null);
});

test('handing over the backlog and changing the house default are independent', () => {
  // "Decide the ones already waiting, but keep asking me about new work" is a
  // legitimate thing to want, and the first cut of this silently moved the
  // house default underneath the operator when they asked only for the former.
  const s = store();
  const waiting = s.addTask({ title: 'finished', prompt: 'x' });
  s.setStatus(waiting.id, 'awaiting-approval');

  s.gateWaiting('owner');
  assert.equal(s.getTask(waiting.id)!.gate, 'owner', 'the backlog moved');
  assert.equal(s.defaultGate(), null, 'the house default did not');

  // ...and the reverse: setting the house default leaves the backlog alone,
  // which is what makes the retroactive step an explicit act.
  const s2 = store();
  const parked = s2.addTask({ title: 'finished', prompt: 'x' });
  s2.setStatus(parked.id, 'awaiting-approval');
  s2.setDefaultGate('owner');
  assert.equal(s2.getTask(parked.id)!.gate, null, 'the backlog was not silently handed over');
  s.close();
  s2.close();
});

test('the house gate is refused rather than stored when it is nonsense', () => {
  const s = store();
  assert.throws(() => s.setDefaultGate('fable-please' as never), /unknown gate/);
  assert.equal(s.defaultGate(), null);
  s.close();
});

test('clearing the house gate hands resolution back to the environment', () => {
  const s = store();
  s.setDefaultGate('owner');
  s.setDefaultGate(null);
  assert.equal(s.defaultGate(), null);
  assert.equal(effectiveGate({ gate: null, playbook: null }, s.defaultGate()), 'human');
  s.close();
});

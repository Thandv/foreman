import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { effectiveAssignee, readyStatus } from '../src/assign.ts';
import { loadPlaybooks } from '../src/playbooks.ts';

const store = (): Store => new Store(':memory:');

/** A playbook dir built for one case, so the catalog fingerprint is fresh. */
function withPlaybook(front: Record<string, unknown>, body: string, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-pb-'));
  const prev = process.env['FOREMAN_PLAYBOOKS_DIR'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  try {
    fs.writeFileSync(path.join(dir, `${front['id']}.md`), `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`);
    loadPlaybooks();
    fn();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    loadPlaybooks();
  }
}

const PB = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'assigntest',
  description: 'fixture',
  triggers: [],
  roles: { dev: { tier: 'worker' }, publisher: { tier: 'owner' } },
  reviewers: [],
  escalation: { chair: 'publisher', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  ...over,
});
const BODY = '## role: dev\nwrite code\n\n## role: publisher\nrule on it\n';

test('the default assignee is ai, and an ai task is born queued', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b' });
  // Resolved and STORED at creation rather than left null to be re-derived.
  // See the next case for why that distinction is load-bearing.
  assert.equal(t.assignee, 'ai');
  assert.equal(effectiveAssignee(t), 'ai');
  assert.equal(t.status, 'queued');
  s.close();
});

test('flipping the house default does not relabel work that already exists', () => {
  // The bug this pins, seen on a live board: with the assignee re-derived on
  // every read, flipping the toggle to "You" made a task an AI had already
  // drafted start reporting that a human did it. What happened is a fact about
  // the past; the row is where it belongs.
  const s = store();
  const before = s.addTask({ title: 'drafted by the ai', prompt: 'x' });
  s.setDefaultAssignee('human');
  const after = s.getTask(before.id)!;
  assert.equal(after.assignee, 'ai');
  assert.equal(effectiveAssignee(after), 'ai');
  // And the new one picks up the new default, which is the point of the toggle.
  assert.equal(s.addTask({ title: 'yours', prompt: 'x' }).assignee, 'human');
  s.close();
});

test('a human task is born awaiting-human and is never claimable', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b', assignee: 'human' });
  assert.equal(t.status, 'awaiting-human');
  // The point of the whole design: `queued` is the only status claim() moves
  // from, so a human task cannot be raced onto a worker between ticks.
  assert.deepEqual(s.claimable(10).map((x) => x.id), []);
  assert.equal(s.claim(t.id), false);
  assert.deepEqual(s.awaitingHuman().map((x) => x.id), [t.id]);
  s.close();
});

test('an unknown assignee is refused rather than defaulted', () => {
  const s = store();
  assert.throws(() => s.addTask({ title: 'a', prompt: 'b', assignee: 'someone' as never }), /unknown assignee/);
  s.close();
});

test('FOREMAN_ASSIGNEE=human flips the default for tasks with no opinion of their own', () => {
  const s = store();
  process.env['FOREMAN_ASSIGNEE'] = 'human';
  try {
    assert.equal(s.addTask({ title: 'a', prompt: 'b' }).status, 'awaiting-human');
    // An explicit per-task assignee still wins over the environment.
    assert.equal(s.addTask({ title: 'c', prompt: 'd', assignee: 'ai' }).status, 'queued');
  } finally {
    delete process.env['FOREMAN_ASSIGNEE'];
  }
  s.close();
});

test('a garbled FOREMAN_ASSIGNEE is ignored, not fatal', () => {
  process.env['FOREMAN_ASSIGNEE'] = 'HUMAN-ISH';
  try {
    assert.equal(effectiveAssignee({ assignee: null, role: null, playbook: null }), 'ai');
  } finally {
    delete process.env['FOREMAN_ASSIGNEE'];
  }
});

test('a playbook role can claim its own tickets for the operator', () => {
  withPlaybook(PB({ roles: { dev: { tier: 'worker' }, publisher: { tier: 'owner', assignee: 'human' } } }), BODY, () => {
    const s = store();
    const ruling = s.addTask({ title: 'rule', prompt: 'x', playbook: 'assigntest', role: 'publisher' });
    const ticket = s.addTask({ title: 'code', prompt: 'x', playbook: 'assigntest', role: 'dev' });
    assert.equal(ruling.status, 'awaiting-human');
    assert.equal(ticket.status, 'queued');
    s.close();
  });
});

test('a playbook-wide assignee applies to roles that do not override it', () => {
  withPlaybook(PB({ assignee: 'human', roles: { dev: { tier: 'worker', assignee: 'ai' }, publisher: { tier: 'owner' } } }), BODY, () => {
    const s = store();
    assert.equal(s.addTask({ title: 'r', prompt: 'x', playbook: 'assigntest', role: 'publisher' }).status, 'awaiting-human');
    assert.equal(s.addTask({ title: 'd', prompt: 'x', playbook: 'assigntest', role: 'dev' }).status, 'queued');
    s.close();
  });
});

test('a playbook with an invalid assignee is refused at load, not silently defaulted', () => {
  withPlaybook(PB({ assignee: 'robot' }), BODY, () => {
    const cat = loadPlaybooks();
    assert.equal(cat.playbooks.find((p) => p.id === 'assigntest'), undefined);
    assert.match(cat.refused.map((r) => r.reason).join(' '), /assignee is invalid/);
  });
  withPlaybook(PB({ roles: { dev: { tier: 'worker', assignee: 'nobody' }, publisher: { tier: 'owner' } } }), BODY, () => {
    const cat = loadPlaybooks();
    assert.match(cat.refused.map((r) => r.reason).join(' '), /invalid assignee/);
  });
});

test('a human task closes through the same gate an AI task does', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b', assignee: 'human' });
  assert.equal(s.decide(t.id, true, 'did it myself').status, 'done');

  const r = s.addTask({ title: 'c', prompt: 'd', assignee: 'human' });
  assert.equal(s.decide(r.id, false, 'not doing this').status, 'rejected');
  s.close();
});

test('decide still refuses a task that is neither at a gate nor on the desk', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b' });
  assert.throws(() => s.decide(t.id, true), /not awaiting-approval or awaiting-human/);
  s.close();
});

test('reassign moves a task between the queue and the desk, and back', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b' });
  assert.equal(s.reassign(t.id, 'human').status, 'awaiting-human');
  assert.equal(s.reassign(t.id, 'ai').status, 'queued');
  assert.equal(s.getTask(t.id)!.assignee, 'ai');
  s.close();
});

test('reassign refuses a task that has already started, and an epic container', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b' });
  assert.equal(s.claim(t.id), true);
  assert.throws(() => s.reassign(t.id, 'human'), /only a task that has not started/);

  const epic = s.addTask({ title: 'e', prompt: 'p', isEpic: true, playbook: 'x' });
  assert.throws(() => s.reassign(epic.id, 'human'), /is an epic/);
  s.close();
});

test('a blocked human task is promoted to the desk, not to the queue', () => {
  const s = store();
  const first = s.addTask({ title: 'first', prompt: 'x' });
  const second = s.addTask({ title: 'second', prompt: 'y', assignee: 'human', deps: [first.id] });
  assert.equal(second.status, 'blocked');

  s.setStatus(first.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(second.id)!.status, 'awaiting-human');
  s.close();
});

test('reassigning a blocked task leaves it blocked; the dependency still governs', () => {
  const s = store();
  const first = s.addTask({ title: 'first', prompt: 'x' });
  const second = s.addTask({ title: 'second', prompt: 'y', deps: [first.id] });
  assert.equal(s.reassign(second.id, 'human').status, 'blocked');
  s.setStatus(first.id, 'done');
  s.reconcileBlocked();
  assert.equal(s.getTask(second.id)!.status, 'awaiting-human');
  s.close();
});

test('retrying a human task puts it back on the desk, not in the worker queue', () => {
  const s = store();
  const t = s.addTask({ title: 'a', prompt: 'b', assignee: 'human' });
  s.decide(t.id, false, 'nope');
  assert.equal(s.retry(t.id).status, 'awaiting-human');
  s.close();
});

// ------------------------------------------------- the board's house default

test('the house default decides tasks that have no opinion of their own', () => {
  const s = store();
  assert.equal(s.defaultAssignee(), null, 'never flipped is distinct from flipped to ai');
  assert.equal(s.addTask({ title: 'a', prompt: 'b' }).status, 'queued');

  s.setDefaultAssignee('human');
  assert.equal(s.defaultAssignee(), 'human');
  assert.equal(s.addTask({ title: 'c', prompt: 'd' }).status, 'awaiting-human');

  // An explicit per-task assignee still wins.
  assert.equal(s.addTask({ title: 'e', prompt: 'f', assignee: 'ai' }).status, 'queued');
  s.close();
});

test('the house default survives a restart — it is a toggle, not a session flag', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-set-')), 'f.db');
  const first = new Store(file);
  first.setDefaultAssignee('human');
  first.close();

  const second = new Store(file);
  assert.equal(second.defaultAssignee(), 'human');
  assert.equal(second.addTask({ title: 'a', prompt: 'b' }).status, 'awaiting-human');
  second.close();
});

test('clearing the house default hands resolution back to the environment', () => {
  const s = store();
  s.setDefaultAssignee('human');
  s.setDefaultAssignee(null);
  assert.equal(s.defaultAssignee(), null);

  process.env['FOREMAN_ASSIGNEE'] = 'human';
  try {
    assert.equal(s.addTask({ title: 'a', prompt: 'b' }).status, 'awaiting-human');
  } finally {
    delete process.env['FOREMAN_ASSIGNEE'];
  }
  assert.equal(s.addTask({ title: 'c', prompt: 'd' }).status, 'queued');
  s.close();
});

test('a playbook role that claims its tickets outranks the house default', () => {
  // The switch must not be able to silently override a standing decision about
  // a kind of work — which is the whole reason it sits below the playbook.
  withPlaybook(PB({ roles: { dev: { tier: 'worker', assignee: 'human' }, publisher: { tier: 'owner' } } }), BODY, () => {
    const s = store();
    s.setDefaultAssignee('ai');
    assert.equal(
      s.addTask({ title: 'd', prompt: 'x', playbook: 'assigntest', role: 'dev' }).status,
      'awaiting-human',
      'the playbook keeps its role even when the house says AI',
    );
    s.close();
  });
});

test('an unknown house default is refused rather than stored', () => {
  const s = store();
  assert.throws(() => s.setDefaultAssignee('robot' as never), /unknown assignee/);
  assert.equal(s.defaultAssignee(), null);
  s.close();
});

test('flipping the house default leaves work already queued alone', () => {
  // A toggle that retro-assigned a running backlog would not be a toggle.
  const s = store();
  const existing = s.addTask({ title: 'already going', prompt: 'x' });
  s.setDefaultAssignee('human');
  assert.equal(s.getTask(existing.id)!.status, 'queued');
  s.close();
});

test('readyStatus is the single mapping both the queue and the desk go through', () => {
  assert.equal(readyStatus('ai'), 'queued');
  assert.equal(readyStatus('human'), 'awaiting-human');
});

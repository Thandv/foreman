// Who created each task: the request principal on the HTTP routes, the parent's creator on a child, and 'operator' on
// every task from before the column.
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

/** A task's creator as the API and the Store hand it out. */
function creatorOf(task: unknown): unknown {
  return (task as Record<string, unknown>)['createdBy'];
}

interface Rig {
  store: Store;
  post: (urlPath: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
}

/** A daemon on an ephemeral loopback port; `headers` go on every call. */
async function rig(t: test.TestContext, headers: () => Record<string, string>): Promise<Rig> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const post: Rig['post'] = async (urlPath, body) => {
    const res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return { store, post };
}

/**
 * A /api/tasks submit, an /api/ask plan's nodes, a /api/build epic and its ticket, and a follow-up a run of the
 * submitted task files: each one's stored creator. Every task goes to a person's desk, so no tick dispatches it.
 */
async function creators(r: Rig): Promise<Record<string, unknown>> {
  const submitted = await r.post('/api/tasks', { title: 'submit', prompt: 'p', runner: 'echo', assignee: 'human' });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
  const plan = {
    ask: 'two steps',
    nodes: [
      { ref: 'n1', title: 'first', prompt: 'p', kind: 'general', runner: 'echo', repo: null, after: [] },
      { ref: 'n2', title: 'second', prompt: 'p', kind: 'general', runner: 'echo', repo: null, after: ['n1'] },
    ],
  };
  const asked = await r.post('/api/ask', { ask: 'two steps', plan, confirm: true });
  assert.equal(asked.status, 201, JSON.stringify(asked.json));
  const built = await r.post('/api/build', {
    ask: 'one ticket',
    plan: { ask: 'one ticket', playbook: '', tickets: [{ ref: 't1', title: 'ticket', prompt: 'p' }] },
    confirm: true,
    runner: 'echo',
  });
  assert.equal(built.status, 201, JSON.stringify(built.json));
  const submittedId = String(submitted.json['id']);
  // What the scheduler's enqueue does for a run that files a follow-up (scheduler.ts: addTask with the run's task as parent).
  const followUp = r.store.addTask({ title: 'follow-up', prompt: 'p', runner: 'echo', parentId: submittedId });
  const stored = (task: unknown): unknown => creatorOf(r.store.getTask(String((task as Record<string, unknown>)['id'])));
  const [ticket] = built.json['queued'] as unknown[];
  return {
    submit: stored(submitted.json),
    askNodes: (asked.json['queued'] as unknown[]).map(stored),
    epic: stored(built.json['epic']),
    epicTicket: stored(ticket),
    followUp: creatorOf(r.store.getTask(followUp.id)),
  };
}

test('with auth off, every task an HTTP route creates, and a follow-up of one, records the operator', async (t) => {
  const r = await rig(t, () => ({}));
  assert.deepEqual(await creators(r), {
    submit: 'operator', askNodes: ['operator', 'operator'], epic: 'operator', epicTicket: 'operator', followUp: 'operator',
  });
});

test('with auth on, every task an HTTP route creates, and a follow-up of one, records the request principal', async (t) => {
  let secret = '';
  const r = await rig(t, () => ({ authorization: `Bearer ${secret}` }));
  const alice = r.store.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' });
  secret = randomBytes(32).toString('base64url');
  r.store.addToken({ principalId: alice.id, tokenHash: createHash('sha256').update(secret).digest('hex'), expiresAt: null, createdBy: 'operator' });
  assert.deepEqual(await creators(r), {
    submit: alice.id, askNodes: [alice.id, alice.id], epic: alice.id, epicTicket: alice.id, followUp: alice.id,
  });
});

test('a task with no creator and no parent, as a schedule fires one, records none; a child of one records none', () => {
  const store = new Store(':memory:');
  try {
    store.addSchedule({ title: 'nightly', spec: 'every 1h', template: { title: 'nightly', prompt: 'p', runner: 'echo' } });
    const [fired] = store.runDueSchedules(Date.now() + 7_200_000);
    assert.ok(fired, 'the schedule fired');
    assert.equal(creatorOf(store.getTask(fired.id)), null);
    const child = store.addTask({ title: 'child', prompt: 'p', runner: 'echo', parentId: fired.id });
    assert.equal(creatorOf(child), null);
  } finally {
    store.close();
  }
});

test('the migration names the operator as the creator of every task from before it, once', (t) => {
  const home = scratchDir('foreman-task-creator-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, 'foreman.db');
  const store = new Store(dbPath);
  const old = store.addTask({ title: 'from before', prompt: 'p', runner: 'echo' });
  store.close();
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE tasks DROP COLUMN created_by');
  db.exec('PRAGMA user_version = 1');
  db.close();

  const migrated = new Store(dbPath, { migrate: true });
  assert.equal(creatorOf(migrated.getTask(old.id)), 'operator', 'a task from before the column reads operator');
  migrated.addSchedule({ title: 'nightly', spec: 'every 1h', template: { title: 'nightly', prompt: 'p', runner: 'echo' } });
  const [fired] = migrated.runDueSchedules(Date.now() + 7_200_000);
  migrated.close();

  const again = new Store(dbPath, { migrate: true });
  try {
    assert.equal(creatorOf(again.getTask(fired!.id)), null, 'a second open backfills nothing');
    assert.equal(creatorOf(again.getTask(old.id)), 'operator');
  } finally {
    again.close();
  }
});

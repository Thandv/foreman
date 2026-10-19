import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { loadPlaybooks } from '../src/playbooks.ts';
import { config } from '../src/config.ts';
import { classifyAsk, cloneEpic, crewPlan, planTimeoutMs, queueCrewPlan } from '../src/assistant/crewPlan.ts';
import { ownerCall, OwnerCallError } from '../src/assistant/ownerCall.ts';
import { precedentsFor, retroKey } from '../src/assistant/retro.ts';
import { tierModel } from '../src/roles.ts';
import type { Task } from '../src/types.ts';

// --------------------------------------------------------------- fixtures

const pbText = (fm: Record<string, unknown>, body: string): string =>
  `---\n${JSON.stringify(fm, null, 2)}\n---\n${body}`;

const SOFTWARE = pbText({
  id: 'soft',
  description: 'Software delivery, scrum-style.',
  triggers: ['code', 'bug', 'refactor', 'api'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' }, qa: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: ['Keep diffs minimal.'],
}, `
## pipeline

plan → implement → test → review → gate

## role: planner

You decompose the ask.

## role: senior

You review what you did not write.

## role: dev

You implement the ticket.

## role: qa

You verify the claim.
`);

const PUBLISHING = pbText({
  id: 'pubs',
  description: 'Publishing house: manuscripts, chapters, editing.',
  triggers: ['novel', 'manuscript', 'chapter', 'prose'],
  roles: { publisher: { tier: 'owner' }, author: { tier: 'worker' } },
  reviewers: [{ role: 'publisher', style: 'editorial-letter' }],
  escalation: { chair: 'publisher', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, `
## pipeline

outline → draft → revise

## role: publisher

You gate the release.

## role: author

You write the draft.
`);

function withPlaybooks(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewpb-'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** The claude --output-format json envelope, with `result` carrying the reply text. */
const envelope = (result: string, costUsd = 0.02): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, result });

interface Stub {
  dir: string;
  bin: string;
  /** Every argv the stub was invoked with, one invocation per entry. */
  invocations(): string[][];
  called(): boolean;
  setBody(body: string): void;
}

/**
 * A stand-in for the claude CLI: dumps its argv (so the prompt can be asserted
 * on) and prints whatever canned envelope the body file holds. No network, no
 * real CLI, and FOREMAN_CLAUDE_BIN is the only seam it needs.
 */
function stubClaude(body: string): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-stubcli-'));
  const bin = path.join(dir, 'claude');
  const bodyFile = path.join(dir, 'body.json');
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(bodyFile, body);
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${logFile}"; done\n` +
      `printf '<<<END>>>\\n' >> "${logFile}"\ncat "${bodyFile}"\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  return {
    dir,
    bin,
    setBody: (next: string) => fs.writeFileSync(bodyFile, next),
    called: () => fs.existsSync(logFile),
    invocations: () =>
      (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
        .split('<<<END>>>\n')
        .filter((chunk) => chunk.trim())
        .map((chunk) => chunk.split('\n').filter(Boolean)),
  };
}

function cleanup(dirs: string[]): void {
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
  delete process.env['FOREMAN_CLAUDE_BIN'];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const PLAN_REPLY = JSON.stringify({
  epic: { title: 'Add token auth', summary: 'auth first, then the tests' },
  tickets: [
    {
      ref: 't1', title: 'Implement token auth', prompt: 'Add bearer-token auth to the API.',
      role: 'dev', kind: 'code', after: [], acceptance: 'requests without a token get 401',
      testCmd: 'npm test', points: 3,
    },
    {
      ref: 't2', title: 'Cover auth with tests', prompt: 'Write tests for the auth path.',
      role: 'qa', kind: 'code', after: ['t1'], acceptance: 'auth paths covered', testCmd: 'npm test', points: 2,
    },
  ],
});

// ------------------------------------------------------------- classifyAsk

test('classifyAsk: a clear trigger winner is high confidence and costs zero tokens', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'pubs.md': PUBLISHING });
  // Any CLI call would throw against this path, proving the keyword path is free.
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(pbDir, 'no-such-claude');
  try {
    const { playbooks } = loadPlaybooks();
    assert.equal(playbooks.length, 2);
    const hit = await classifyAsk('fix the bug in the api code', playbooks);
    assert.equal(hit?.playbook.id, 'soft');
    assert.equal(hit?.confidence, 'high');
  } finally {
    cleanup([pbDir]);
  }
});

test('classifyAsk: an ambiguous ask consults the owner, and nothing matching returns null', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'pubs.md': PUBLISHING });
  const stub = stubClaude(envelope(JSON.stringify({ playbook: 'pubs', confidence: 'high' })));
  try {
    const { playbooks } = loadPlaybooks();
    const ask = 'organise the quarterly offsite agenda';
    const owned = await classifyAsk(ask, playbooks);
    assert.equal(owned?.playbook.id, 'pubs');
    assert.equal(owned?.confidence, 'high');
    assert.equal(stub.invocations().length, 1);

    // Owner unreachable and no keyword hit at all: null, not a crash.
    process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'gone');
    assert.equal(await classifyAsk(ask, playbooks), null);
  } finally {
    cleanup([pbDir, stub.dir]);
  }
});

test('classifyAsk: software asks sharing words with investment/research triggers still route to software from keywords alone', async () => {
  // The real seed playbooks, not the local fixtures: this is exactly the
  // MEDIUM finding — 'investigate' (research.md) and 'asset' (investment.md)
  // used to tie with software.md's own triggers ('bug'/'code', 'refactor'/
  // 'app'), forcing a paid Owner classify call to break what should be a free
  // keyword win.
  process.env['FOREMAN_PLAYBOOKS_DIR'] = path.join(config.sourceRoot, 'playbooks');
  const stub = stubClaude(envelope(JSON.stringify({ playbook: 'research', confidence: 'high' })));
  try {
    const { playbooks } = loadPlaybooks();
    assert.ok(playbooks.some((p) => p.id === 'software'));
    assert.ok(playbooks.some((p) => p.id === 'investment'));
    assert.ok(playbooks.some((p) => p.id === 'research'));

    const bug = await classifyAsk('investigate the memory leak bug in the code', playbooks);
    assert.equal(bug?.playbook.id, 'software');
    assert.equal(bug?.confidence, 'high');

    const asset = await classifyAsk('refactor the asset pipeline in the app', playbooks);
    assert.equal(asset?.playbook.id, 'software');
    assert.equal(asset?.confidence, 'high');

    assert.equal(stub.called(), false, 'both asks must resolve from keywords alone, with zero Owner calls');
  } finally {
    cleanup([stub.dir]); // also clears FOREMAN_PLAYBOOKS_DIR
  }
});

// ---------------------------------------------------------- decompose + queue

test('crewPlan: a well-formed owner reply becomes an epic of role-assigned tickets', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    assert.equal(plan.degraded, false);
    assert.equal(plan.playbook, 'soft');
    assert.equal(plan.epic.title, 'Add token auth');
    assert.equal(plan.costUsd, 0.02);
    assert.deepEqual(plan.tickets.map((t) => t.ref), ['t1', 't2']);
    assert.deepEqual(plan.tickets.map((t) => t.role), ['dev', 'qa']);

    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    assert.equal(epic.isEpic, true);
    assert.equal(epic.status, 'blocked', 'the container must never be claimable');
    assert.equal(epic.playbook, 'soft');
    assert.equal(tickets.length, 2);
    assert.deepEqual(tickets.map((t) => t.parentId), [epic.id, epic.id]);
    assert.equal(tickets[0]!.status, 'queued');
    assert.equal(tickets[1]!.status, 'blocked');
    assert.deepEqual(tickets[1]!.deps, [tickets[0]!.id]);
    assert.equal(tickets[0]!.acceptance, 'requests without a token get 401');
    assert.equal(tickets[0]!.points, 3);
    assert.equal(tickets[0]!.testCmd, 'npm test');
    assert.equal(tickets[0]!.playbook, 'soft');
    // Constraints reach the worker through briefFor/roleAgent, never the prompt.
    assert.doesNotMatch(tickets[0]!.prompt, /Keep diffs minimal/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('crewPlan: an unusable owner reply degrades to a single worker-tier ticket', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope('I am afraid I cannot do that, Dave.'));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'refactor the api code', store });
    assert.equal(plan.degraded, true);
    assert.equal(plan.tickets.length, 1);
    assert.equal(plan.tickets[0]!.role, 'dev', 'fallback runs at the first worker-tier role');
    assert.equal(plan.tickets[0]!.prompt, 'refactor the api code');

    // The same degradation when the CLI itself is missing.
    process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'gone');
    const offline = await crewPlan({ ask: 'refactor the api code', store });
    assert.equal(offline.degraded, true);
    assert.match(offline.notes, /owner unavailable/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('crewPlan: unknown roles are remapped, unknown refs dropped, ticket count capped', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const many = Array.from({ length: 15 }, (_, i) => ({
    ref: `x${i}`, title: `Ticket ${i}`, prompt: `do ${i}`, role: 'wizard', kind: 'nonsense',
    after: i === 0 ? ['ghost'] : ['x0'], acceptance: 42, testCmd: 'rm -rf / --no-preserve-root', points: 'many',
  }));
  const stub = stubClaude(envelope(JSON.stringify({ epic: { title: 'Big' }, tickets: many })));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'refactor the api code', store });
    assert.equal(plan.degraded, false);
    assert.equal(plan.tickets.length, 12, 'at most 12 tickets survive');
    assert.ok(plan.tickets.every((t) => t.role === 'dev'), 'unknown role → first worker-tier role');
    assert.ok(plan.tickets.every((t) => t.kind === 'general'), 'unknown kind → default kind');
    assert.deepEqual(plan.tickets[0]!.after, [], 'an edge to a ref that does not exist is dropped');
    assert.equal(plan.tickets[0]!.acceptance, null, 'a non-string acceptance is not carried');
    assert.equal(plan.tickets[0]!.points, null, 'a non-numeric points is not carried');
    assert.equal(plan.tickets[0]!.testCmd, null, 'a testCmd the admission scanner refuses is dropped');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------- container semantics

/** Tick until a condition holds. A ticket parked at the gate never "drains". */
async function settle(sched: Scheduler, until: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Walk an epic's tickets to the gate in dependency order and approve each. */
async function closeAll(store: Store, sched: Scheduler, tickets: Task[]): Promise<void> {
  for (const ticket of tickets) {
    await settle(sched, () => store.getTask(ticket.id)!.status === 'awaiting-approval');
    store.decide(ticket.id, true);
  }
}

test('an epic container closes done only once every ticket has closed', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });

    // The first ticket runs and parks at the gate; the container waits.
    await settle(sched, () => store.getTask(tickets[0]!.id)!.status === 'awaiting-approval');
    assert.equal(store.getTask(tickets[1]!.id)!.status, 'blocked');
    assert.equal(store.getTask(epic.id)!.status, 'blocked');

    store.decide(tickets[0]!.id, true);
    await settle(sched, () => store.getTask(tickets[1]!.id)!.status === 'awaiting-approval');
    assert.equal(store.getTask(epic.id)!.status, 'blocked', 'one open ticket keeps the epic open');
    store.decide(tickets[1]!.id, true);
    assert.equal(store.getTask(epic.id)!.status, 'done');
    // The container never ran: no run row, so no worker slot was ever spent.
    assert.equal(store.runsForTask(epic.id).length, 0);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an epic container fails when a ticket hard-fails', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const failing = JSON.stringify({
    epic: { title: 'Doomed', summary: 'it will not work' },
    tickets: [
      { ref: 't1', title: 'Fine', prompt: 'succeed here', role: 'dev', kind: 'general', after: [], points: 1 },
      { ref: 't2', title: 'Doomed', prompt: 'please fail now', role: 'dev', kind: 'general', after: [], points: 1 },
    ],
  });
  const stub = stubClaude(envelope(failing));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'refactor the api code', store });
    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    await sched.drain(20_000);
    store.decide(tickets[0]!.id, true);
    const failed = store.getTask(tickets[1]!.id)!;
    assert.equal(failed.status, 'failed');
    const closed = store.getTask(epic.id)!;
    assert.equal(closed.status, 'failed');
    assert.match(closed.error ?? '', /ended as failed/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- S2 containment

test('an S2 ask is refused before the owner CLI is spawned at all', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'pubs.md': PUBLISHING });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    await assert.rejects(
      crewPlan({ ask: 'add auth to the api code', store, sensitivity: 'S2' }),
      /S2 asks cannot use crew planning/,
    );
    // Even the routing stage, whose fallback is an owner call, refuses S2.
    await assert.rejects(
      classifyAsk('organise the quarterly offsite agenda', loadPlaybooks().playbooks, { sensitivity: 'S2' }),
      /S2 asks cannot use crew planning/,
    );
    assert.equal(stub.called(), false, 'no S2 text may reach the hosted CLI');
    assert.equal(store.spentToday(), 0, 'a refusal costs nothing');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an S2 epic writes no retrospective, and an S2 retro is never served as precedent', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    // Planned at S1 (the only way a plan exists), then queued S2 by the operator.
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo', sensitivity: 'S2' });
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    await closeAll(store, sched, tickets);
    assert.equal(store.getTask(epic.id)!.status, 'done');
    assert.equal(
      store.recallFacts('soft', 50).find((f) => f.key === retroKey(epic.id)),
      undefined,
      'an S2 epic must leave no lesson that could later ship to the hosted owner',
    );

    // And one already on disk (hand-written, or from before the guard) is skipped.
    store.rememberFact({
      scope: 'soft',
      key: retroKey('t_fake_s2'),
      value: JSON.stringify({
        ask: 'add auth to the api code', playbook: 'soft', sensitivity: 'S2',
        tickets: [{ title: 'secret auth work', role: 'dev', points: 1, repairs: 0, status: 'done' }],
        reviewRounds: 0, checksThatCaught: [], pitfalls: [],
      }),
    });
    assert.deepEqual(precedentsFor(store, 'soft', 'add auth to the api code', 2), []);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- precedent loop

test('a closed epic writes a retrospective that is retrieved and injected into the next plan', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    await closeAll(store, sched, tickets);
    assert.equal(store.getTask(epic.id)!.status, 'done');

    // Written deterministically from DB facts under the playbook's scope.
    const fact = store.recallFacts('soft', 50).find((f) => f.key === `epic:${epic.id}`);
    assert.ok(fact, 'a retrospective must exist for the closed epic');
    assert.ok(fact!.value.length <= 1024, 'retrospectives are capped at 1KB');
    const retro = JSON.parse(fact!.value) as { playbook: string; tickets: { title: string }[]; reviewRounds: number };
    assert.equal(retro.playbook, 'soft');
    assert.deepEqual(retro.tickets.map((t) => t.title), ['Implement token auth', 'Cover auth with tests']);
    assert.equal(retro.reviewRounds, 0);

    const found = precedentsFor(store, 'soft', 'add auth to the api code', 2);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.epicId, epic.id);

    // …and the next decompose of a similar ask ships it to the Owner.
    const before = stub.invocations().length;
    await crewPlan({ ask: 'add auth to the admin api code', store });
    const argv = stub.invocations()[before]!;
    const prompt = argv.join('\n');
    assert.match(prompt, /PRECEDENT/);
    assert.match(prompt, /Implement token auth/);
    assert.ok(argv.includes('--output-format') && argv.includes('json'), 'owner calls use the json envelope');
    assert.ok(argv.includes('--max-turns'), 'owner planning is turn-capped');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('cloneEpic reproduces a past epic structure with zero owner calls', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    const { epic } = queueCrewPlan(store, plan, { runner: 'echo' });

    // A fresh stub: anything the clone path calls would show up here.
    cleanup([stub.dir]);
    process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
    const silent = stubClaude(envelope('should never be called'));
    const cloned = cloneEpic(store, epic.id);
    const requeued = queueCrewPlan(store, cloned, { runner: 'echo' });
    assert.equal(silent.called(), false, 'cloning must not invoke the CLI at all');
    assert.equal(cloned.costUsd, 0);
    assert.deepEqual(
      requeued.tickets.map((t) => t.title),
      ['Implement token auth', 'Cover auth with tests'],
    );
    assert.deepEqual(requeued.tickets.map((t) => t.role), ['dev', 'qa']);
    assert.deepEqual(requeued.tickets[1]!.deps, [requeued.tickets[0]!.id]);
    assert.equal(requeued.epic.id === epic.id, false, 'the clone is a new epic');
    assert.equal(requeued.tickets[0]!.prompt, 'Add bearer-token auth to the API.');
    cleanup([silent.dir]);
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

// --------------------------------------------------------------- HTTP surface

test('POST /api/build returns a plan, and queues the epic only on auto', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const missing = await post({});
    assert.equal(missing.status, 400);

    const preview = await post({ ask: 'add auth to the api code' });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.epic, null);
    assert.deepEqual(previewBody.queued, []);
    assert.equal(previewBody.plan.tickets.length, 2);
    assert.equal(store.listTasks().length, 0, 'a preview queues nothing');

    const built = await post({ ask: 'add auth to the api code', auto: true, runner: 'echo' });
    assert.equal(built.status, 201);
    const body = await built.json();
    assert.equal(body.epic.isEpic, true);
    assert.equal(body.epic.status, 'blocked');
    assert.equal(body.queued.length, 2);
    assert.deepEqual(body.queued.map((t: Task) => t.parentId), [body.epic.id, body.epic.id]);

    const unknown = await post({ ask: 'anything', playbook: 'nope' });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /no playbook 'nope'/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ----------------------------------------------------------------- depth guard

test('an epic is refused when its ticket context is already three parents deep', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'l1', prompt: 'l1', runner: 'echo' });
    const t2 = store.addTask({ title: 'l2', prompt: 'l2', runner: 'echo', parentId: t1.id });
    const t3 = store.addTask({ title: 'l3', prompt: 'l3', runner: 'echo', parentId: t2.id });

    const plan = await crewPlan({ ask: 'add auth to the api code', store, parentId: t2.id });
    assert.equal(plan.degraded, false, 'two deep is still allowed');

    const before = stub.invocations().length;
    await assert.rejects(
      crewPlan({ ask: 'add auth to the api code', store, parentId: t3.id }),
      /three parents deep|3 parents deep|max 3/,
    );
    assert.equal(stub.invocations().length, before, 'the guard refuses before spending a token');
    assert.throws(() => queueCrewPlan(store, plan, { runner: 'echo', parentId: t3.id }), /max 3/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------ epic lifecycle

/** Plan an epic and open it, with the standard two-ticket reply. */
async function openEpic(store: Store): Promise<{ epic: Task; tickets: Task[] }> {
  const plan = await crewPlan({ ask: 'add auth to the api code', store });
  return queueCrewPlan(store, plan, { runner: 'echo' });
}

test('cancelling an epic cascades to its tickets and aborts the running one', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
  process.env['FOREMAN_ECHO_STEP_MS'] = '80';
  try {
    const { epic, tickets } = await openEpic(store);
    await sched.tick();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(store.getTask(tickets[0]!.id)!.status, 'running');

    store.cancel(epic.id);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(store.getTask(epic.id)!.status, 'canceled');
    assert.equal(store.getTask(tickets[0]!.id)!.status, 'canceled', 'a running ticket is cancelled, not orphaned');
    assert.equal(store.getTask(tickets[1]!.id)!.status, 'canceled', 'a blocked ticket is cancelled too');
    assert.equal(store.latestRun(tickets[0]!.id)!.status, 'canceled', 'the worker got its abort');
    assert.equal(sched.activeCount, 0);
  } finally {
    process.env['FOREMAN_ECHO_STEP_MS'] = '5';
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a zero-ticket plan is refused, and an epic whose tickets are all deleted closes as canceled', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    assert.throws(() => queueCrewPlan(store, { ...plan, tickets: [] }, { runner: 'echo' }), /no tickets/);
    assert.equal(store.listTasks().length, 0, 'a refused plan leaves no container behind');

    const { epic, tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    store.deleteTask(tickets[1]!.id); // the dependent first; the dep guard blocks the other order
    store.deleteTask(tickets[0]!.id);
    assert.equal(store.getTask(epic.id)!.status, 'blocked');
    store.reconcileBlocked();
    assert.equal(store.getTask(epic.id)!.status, 'canceled', 'a childless epic must not strand blocked forever');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('deleting an epic is refused while a ticket is open, and detaches the tickets once they are closed', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const { epic, tickets } = await openEpic(store);
    assert.throws(() => store.deleteTask(epic.id), /child task\(s\) are still open/);
    assert.equal(store.getTask(tickets[0]!.id)!.parentId, epic.id);

    store.cancel(epic.id);
    store.deleteTask(epic.id);
    assert.equal(store.getTask(epic.id), null);
    // Detached, not cascade-deleted: the ticket rows are the record of the work.
    assert.equal(store.getTask(tickets[0]!.id)!.parentId, null);
    assert.equal(store.getTask(tickets[1]!.id)!.parentId, null);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a ticket reopening after its epic closed reopens the epic and rewrites the retrospective', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const { epic, tickets } = await openEpic(store);
    const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
    await closeAll(store, sched, tickets);
    assert.equal(store.getTask(epic.id)!.status, 'done');
    const first = store.recallFacts('soft', 50).find((f) => f.key === retroKey(epic.id));
    assert.ok(first);

    // A repair round pulls a ticket back out of `done`.
    assert.equal(store.scheduleRepair(tickets[1]!.id, 'the reviewer wants it again'), true);
    assert.equal(store.getTask(epic.id)!.status, 'blocked', 'a closed epic reopens when a ticket does');
    assert.equal(
      store.recallFacts('soft', 50).find((f) => f.key === retroKey(epic.id)),
      undefined,
      'the stale retrospective is retired while the epic is open again',
    );
    assert.deepEqual(precedentsFor(store, 'soft', 'add auth to the api code', 2), []);

    store.setStatus(tickets[1]!.id, 'done');
    assert.equal(store.getTask(epic.id)!.status, 'done');
    const rewritten = store.recallFacts('soft', 50).find((f) => f.key === retroKey(epic.id));
    assert.ok(rewritten);
    assert.notEqual(rewritten!.id, first!.id, 'the retrospective is rewritten, not left stale');
    assert.equal((JSON.parse(rewritten!.value) as { reviewRounds: number }).reviewRounds, 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('reconcileBlocked settles epics the setStatus hook never saw', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    // Simulate a crash between the ticket write and the close: raw SQL, so no
    // hook fires and the container is left blocked with nothing pending.
    const { epic, tickets } = await openEpic(store);
    store.db.prepare("UPDATE tasks SET status = 'done' WHERE parent_id = ?").run(epic.id);
    assert.equal(store.getTask(epic.id)!.status, 'blocked');
    assert.ok(store.reconcileBlocked() >= 1);
    assert.equal(store.getTask(epic.id)!.status, 'done');
    assert.equal(store.getTask(tickets[0]!.id)!.status, 'done');

    // And an epic carrying a dep edge of its own is failed by that dep dying,
    // rather than skipped because it is an epic.
    const other = await openEpic(store);
    const dead = store.addTask({ title: 'dead', prompt: 'x', runner: 'echo' });
    store.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?,?)').run(other.epic.id, dead.id);
    store.cancel(dead.id);
    store.reconcileBlocked();
    const failed = store.getTask(other.epic.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /ended as canceled/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------------ spend

test('every owner call settles a receipt, so planning spend is visible', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'pubs.md': PUBLISHING });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  const receipts = (): Record<string, unknown>[] =>
    store.db.prepare('SELECT * FROM receipts ORDER BY created_at, id').all() as Record<string, unknown>[];
  try {
    await crewPlan({ ask: 'add auth to the api code', store });
    const [plan] = receipts();
    assert.ok(plan, 'the decompose call must leave a receipt');
    assert.equal(String(plan!['kind']), 'plan');
    assert.equal(Number(plan!['local']), 0, 'the owner CLI is hosted, never local');
    assert.equal(Number(plan!['cost_usd']), 0.02);
    assert.equal(String(plan!['model']), tierModel('owner'));
    // The owner CLI is subscription-billed. Its notional cost is recorded — a
    // receipt should answer "what would this cost to reproduce" — but it is
    // not what the METERED daily cap governs, or a handful of Opus reviews
    // hard-stops every task on the board over money nobody spent.
    assert.equal(store.spentToday(), 0, 'the metered cap sees no subscription spend');
    assert.equal(store.spentTodaySubscription(), 0.02, 'the subscription ledger sees all of it');

    // Routing spend is billed the same way, on its own kind.
    stub.setBody(envelope(JSON.stringify({ playbook: 'pubs', confidence: 'high' }), 0.01));
    await classifyAsk('organise the quarterly offsite agenda', loadPlaybooks().playbooks, { store });
    assert.deepEqual(receipts().map((r) => String(r['kind'])), ['plan', 'plan:classify']);
    assert.ok(Math.abs(store.spentTodaySubscription() - 0.03) < 1e-9);
    assert.ok(Math.abs(store.spentTodayIncludingSubscription() - 0.03) < 1e-9);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// --------------------------------------------------------------- ownerCall

test('ownerCall: a timeout kills the child rather than abandoning it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-slowcli-'));
  const bin = path.join(dir, 'claude');
  const marker = path.join(dir, 'survived');
  fs.writeFileSync(bin, `#!/bin/sh\nsleep 1\ntouch "${marker}"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  try {
    const err = await ownerCall('plan this', { timeoutMs: 100 }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof OwnerCallError);
    assert.equal(err.reason, 'timeout');
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(fs.existsSync(marker), false, 'the CLI child must be killed with its group');
  } finally {
    cleanup([dir]);
  }
});

test('ownerCall: the envelope decides, not the exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-envcli-'));
  const bodyFile = path.join(dir, 'body.json');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${bodyFile}"\nexit 3\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const store = new Store(':memory:');
  try {
    // A usable reply survives a non-zero exit (the CLI warns on the way out).
    fs.writeFileSync(bodyFile, envelope('the plan'));
    const ok = await ownerCall('plan this', { store, kind: 'plan' });
    assert.equal(ok.text, 'the plan');
    assert.equal(ok.costUsd, 0.02);

    // is_error wins even when a result string is present, and settles as an error receipt.
    fs.writeFileSync(
      bodyFile,
      JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 0.03, result: 'rate limited' }),
    );
    await assert.rejects(ownerCall('plan this', { store, kind: 'plan' }), /no usable reply/);

    // No envelope at all, non-zero exit: an exit failure, not a parse failure.
    fs.writeFileSync(bodyFile, 'segfault');
    const err = await ownerCall('plan this', {}).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof OwnerCallError);
    assert.equal(err.reason, 'exit');

    assert.deepEqual(
      (store.db.prepare('SELECT kind FROM receipts ORDER BY created_at, id').all() as Record<string, unknown>[])
        .map((r) => String(r['kind'])),
      ['plan', 'plan:error'],
    );
    assert.ok(
      Math.abs(store.spentTodaySubscription() - 0.05) < 1e-9,
      'a billed failure is still billed — on the subscription ledger, which is where the owner CLI bills',
    );
  } finally {
    store.close();
    cleanup([dir]);
  }
});

// ------------------------------------------------- caller-supplied plan bodies

test('POST /api/build revalidates a caller-supplied plan and refuses S2 outright', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // First, before anything has been planned: S2 never reaches the CLI.
    const s2 = await post({ ask: 'add auth to the api code', sensitivity: 'S2', auto: true });
    assert.equal(s2.status, 400);
    assert.match((await s2.json()).error, /S2 asks cannot use crew planning/);
    assert.equal(stub.called(), false);
    assert.equal(store.listTasks().length, 0);

    const bad = await post({ ask: 'x', sensitivity: 'S9' });
    assert.equal(bad.status, 400);

    // An empty (or fully-invalid) ticket list is now a plan-check refusal, not
    // a bare parse error: parseCrewPlan lets it through with an 'empty-plan'
    // error finding, and --auto refuses to queue on any error-level finding.
    const empty = await post({ ask: 'x', auto: true, plan: { ask: 'x', playbook: 'soft', tickets: [] } });
    assert.equal(empty.status, 422);
    const emptyBody = await empty.json();
    assert.ok(emptyBody.findings.some((f: { code: string; level: string }) => f.code === 'empty-plan' && f.level === 'error'));
    assert.match(emptyBody.error, /rerun without --auto/);

    const junk = await post({ ask: 'x', auto: true, plan: { ask: 'x', playbook: 'soft', tickets: [{ ref: 't1' }] } });
    assert.equal(junk.status, 422);
    assert.equal(store.listTasks().length, 0, 'no bare container may be created');

    const ok = await post({
      ask: 'x',
      auto: true,
      runner: 'echo',
      plan: {
        ask: 'x',
        playbook: 'soft',
        epic: { title: 'Handed in' },
        tickets: [{
          ref: 't1', title: 'T', prompt: 'do the thing', role: 'wizard', kind: 'nonsense',
          testCmd: 'sudo rm -rf /', points: 99, after: ['ghost'],
        }],
      },
    });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.epic.title, 'Handed in');
    assert.equal(body.queued.length, 1);
    assert.equal(body.queued[0].role, 'dev', 'an invented role is remapped, even off the wire');
    assert.equal(body.queued[0].testCmd, null, 'a testCmd the scanner refuses never reaches a jail');
    assert.equal(body.queued[0].points, 21);
    assert.deepEqual(body.queued[0].deps, []);
    assert.equal(stub.called(), false, 'a supplied plan costs no owner call');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('crewPlan: with a repo, the planner prompt carries the repo snapshot and the docs the ask names', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-planrepo-'));
  fs.writeFileSync(path.join(repo, 'SPEC.md'), 'BINDING-SPEC-MARKER: terminal over SSE');
  fs.mkdirSync(path.join(repo, 'ui'));
  fs.writeFileSync(path.join(repo, 'ui', 'vendored.js'), '//');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  try {
    await crewPlan({ ask: 'build the app code per SPEC.md', store, repo });
    const argv = stub.invocations()[0]!;
    const prompt = argv[argv.indexOf('-p') + 1] ?? '';
    const joined = argv.join('\n');
    assert.ok(prompt.length > 0);
    assert.match(joined, /REPO SNAPSHOT/);
    assert.match(joined, /ui\/vendored\.js/);
    assert.match(joined, /BINDING-SPEC-MARKER/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('crewPlan: planning has its own timeout, longer than ownerCall\'s 180s, and it is honoured', async () => {
  assert.ok(planTimeoutMs() > 180_000, 'a snapshot-sized plan measured over 180s; the default must clear it');
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  // Same stub, but slow: the plan must degrade on the env-configured timeout.
  fs.writeFileSync(stub.bin, `#!/bin/sh\nsleep 3\ncat "${path.join(stub.dir, 'body.json')}"\n`);
  process.env['FOREMAN_PLAN_TIMEOUT_MS'] = '300';
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    assert.equal(plan.degraded, true);
    assert.match(plan.notes, /timed out after 300ms/);
  } finally {
    delete process.env['FOREMAN_PLAN_TIMEOUT_MS'];
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('crewPlan: an owner reply cut off mid-plan is flagged as truncated, never passed off as complete', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const whole = PLAN_REPLY;
  // Cut inside the second ticket, the way an exhausted output budget ends.
  const cut = whole.slice(0, whole.indexOf('Cover auth with tests') + 10);
  const stub = stubClaude(envelope(cut));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    assert.ok(plan.findings.some((f) => f.code === 'truncated-plan' && f.level === 'error'));
    stub.setBody(envelope(whole));
    const ok = await crewPlan({ ask: 'add auth to the api code', store });
    assert.ok(!ok.findings.some((f) => f.code === 'truncated-plan'), 'a complete reply is not flagged');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the planner is told workers are headless and person-only checks are tagged (operator)', async () => {
  const { DECOMPOSE_CONTRACT } = await import('../src/assistant/crewPlan.ts');
  assert.match(DECOMPOSE_CONTRACT, /Workers are headless/);
  assert.match(DECOMPOSE_CONTRACT, /prefixed "\(operator\)"/);
});

// --------------------------------------------------------------- numbered asks

// Coverage is decided by content, so each item needs a word of its own.
const TOPICS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echoes', 'foxtrot', 'golfers', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
];

const numberedAsk = (n: number): string =>
  `Build the thing in ${n} steps:\n` + Array.from({ length: n }, (_, i) => `${i + 1}. handle ${TOPICS[i]}`).join('\n');

const planOf = (n: number): string =>
  JSON.stringify({
    epic: { title: 'Many steps', summary: 'one per item' },
    tickets: Array.from({ length: n }, (_, i) => ({
      ref: `t${i + 1}`, title: `Item ${i + 1}`, prompt: `Do step ${i + 1} of the ask, restating what the worker needs.`,
      role: 'dev', kind: 'code', after: [], acceptance: `${TOPICS[i]} works`, testCmd: 'npm test', points: 1,
    })),
  });

test('the contract line carries the raised cap, not a hardcoded 12', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(planOf(16)));
  const store = new Store(':memory:');
  try {
    await crewPlan({ ask: numberedAsk(16), store });
    const prompt = stub.invocations()[0]!.join('\n');
    assert.match(prompt, /- At most 16 tickets,/);
    assert.ok(!prompt.includes('12 tickets'));
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a 16-item ask raises the planner cap to 16 and tells it the count', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(planOf(16)));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: numberedAsk(16), store });
    assert.match(stub.invocations()[0]!.join('\n'), /lists 16 numbered items[\s\S]*at most 16 tickets/);
    assert.equal(plan.tickets.length, 16);
    assert.ok(!plan.findings.some((f) => f.code === 'too-many-tickets' || f.code === 'ask-items-uncovered'));
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a 16-item ask the planner cut to 12 is flagged, and --auto refuses it', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(planOf(12)));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const preview = await (await post({ ask: numberedAsk(16), check: false })).json();
    const finding = preview.findings.find((f: { code: string }) => f.code === 'ask-items-uncovered');
    assert.equal(finding.level, 'warn');
    assert.match(finding.message, /16 numbered items.*12 tickets.*4 item\(s\).*13 \(handle mike\); 14 \(handle november\); 15 \(handle oscar\); 16 \(handle papa\)/);

    const auto = await post({ ask: numberedAsk(16), auto: true, runner: 'echo' });
    assert.equal(auto.status, 422);
    assert.match((await auto.json()).error, /ask-items-uncovered/);
    assert.equal(store.listTasks().length, 0, 'nothing is queued short of the ask');
  } finally {
    server.close();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('confirm without auto queues a short plan and the ask-items-uncovered finding stays warn', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(planOf(12)));
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ask: numberedAsk(16), confirm: true, check: false, runner: 'echo' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.findings.find((f: { code: string }) => f.code === 'ask-items-uncovered').level, 'warn');
    assert.ok(store.listTasks().length > 0, 'the confirmed plan is queued');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an ask without numbered items is unaffected', async () => {
  const { askItemCount } = await import('../src/assistant/planCheck.ts');
  assert.equal(askItemCount('add auth to the api code, in 2024. then ship'), 0);
  assert.equal(askItemCount('1. a\n3. b'), 1);
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(PLAN_REPLY));
  const store = new Store(':memory:');
  try {
    const plan = await crewPlan({ ask: 'add auth to the api code', store });
    assert.ok(!stub.invocations()[0]!.join('\n').includes('ASK ITEMS'));
    assert.ok(!plan.findings.some((f) => f.code === 'ask-items-uncovered'));
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------ a prose deliverable in a gated repo is a code ticket

const DOC_TICKETS = [
  { ref: 't1', title: 'ADR: close the server-lock start race', role: 'dev', kind: 'writing', prompt: 'Design only. Describe the race, then write an ADR in docs/decisions/ comparing three ways to close it.', acceptance: '1. An ADR exists under docs/decisions/.' },
  { ref: 't2', title: 'README: complete the Security model', role: 'dev', kind: 'writing', prompt: 'Check the Security model section against the code and complete it.', acceptance: '1. README.md names every route that needs the token.' },
  { ref: 't3', title: 'Draft the launch announcement', role: 'dev', kind: 'writing', prompt: 'Write three paragraphs announcing the release for the mailing list and return them in your report.', acceptance: '1. Three paragraphs, no file changed.' },
  { ref: 't4', title: 'Name the lock file in the message', role: 'dev', kind: 'code', prompt: 'Make the already-running message name the lock file path.', acceptance: '1. The message names the path.' },
  { ref: 't5', title: 'Survey how other tools lock', role: 'dev', kind: 'research', prompt: 'Read src/lock.js and survey how three other tools take a start lock; report what you find.', acceptance: '1. Three tools compared.' },
].map((t) => ({ ...t, after: [], testCmd: null, points: 2 }));
const DOC_REPLY = JSON.stringify({ epic: { title: 'Lock work', summary: 'docs and a fix' }, tickets: DOC_TICKETS });

/** A repo with a README, a docs folder and source; `gated` gives it a suite of its own (package.json `test`). */
function docRepo(gated: boolean): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-kindrepo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'lock.js'), '//\n');
  if (gated) fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e 0' } }));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  return repo;
}

const kindNotes = (plan: { findings: Array<{ code: string; ticket?: string; message: string }> }): string[] =>
  plan.findings.filter((f) => f.code === 'kind-corrected').map((f) => `${f.ticket}: ${f.message}`);

test('in a repo with a test command, a writing ticket whose deliverable is a file in the repo is planned as code, and the plan says so', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(DOC_REPLY));
  const store = new Store(':memory:');
  const repo = docRepo(true);
  try {
    const plan = await crewPlan({ ask: 'fix the lock code and document it', store, repo, playbook: 'soft' });
    assert.deepEqual(plan.tickets.map((t) => `${t.ref} ${t.kind}`), ['t1 code', 't2 code', 't3 writing', 't4 code', 't5 research']);
    assert.deepEqual(kindNotes(plan), [
      't1: kind writing → code (deliverable is a file in a gated repo)',
      't2: kind writing → code (deliverable is a file in a gated repo)',
    ]);
    assert.ok(plan.findings.filter((f) => f.code === 'kind-corrected').every((f) => f.level === 'note'), 'a correction is stated, not warned about');
    // What the correction is for: the ticket merges on approval, like any other change to the repo.
    const { tickets } = queueCrewPlan(store, plan, { runner: 'echo' });
    assert.deepEqual(tickets.map((t) => `${t.kind} ${t.mergeOnApprove}`), ['code true', 'code true', 'writing false', 'code true', 'research false']);
    // And the planner was told, so the correction is the exception.
    assert.match(stub.invocations()[0]!.join('\n'), /a ticket whose deliverable is a file in the repo[^]*is kind "code" whatever its prose content/);

    // A plan handed in over the wire goes through the same rule.
    const { parseCrewPlan } = await import('../src/assistant/crewPlan.ts');
    const wire = parseCrewPlan({ ask: 'document the lock', playbook: 'soft', repo, tickets: DOC_TICKETS });
    assert.deepEqual(wire.tickets.map((t) => `${t.ref} ${t.kind}`), ['t1 code', 't2 code', 't3 writing', 't4 code', 't5 research']);
    assert.equal(kindNotes(wire).length, 2);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('a writing ticket stays writing where nothing gates the repo, and where there is no repo', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(envelope(DOC_REPLY));
  const store = new Store(':memory:');
  // A manuscript: files and a README, no suite. A ticket's own testCmd does not make the REPO gated.
  const manuscript = docRepo(false);
  const withCheck = JSON.stringify({ epic: { title: 'Book', summary: '' }, tickets: DOC_TICKETS.map((t) => ({ ...t, testCmd: 'wc -w README.md' })) });
  try {
    for (const [repo, reply] of [[manuscript, DOC_REPLY], [manuscript, withCheck], [null, DOC_REPLY]] as const) {
      stub.setBody(envelope(reply));
      const plan = await crewPlan({ ask: 'fix the lock code and document it', store, repo, playbook: 'soft' });
      assert.deepEqual(plan.tickets.map((t) => t.kind), ['writing', 'writing', 'writing', 'code', 'research'], String(repo));
      assert.deepEqual(kindNotes(plan), []);
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, manuscript]);
  }
});

// review r1 on-top: the correction is for a crew that reviews code
test('under a playbook whose reviewers do not review code, a writing ticket stays writing even where the repo has a test command: a chapter is not a code ticket', async () => {
  const EDITORIAL = SOFTWARE.replace('"id": "soft"', '"id": "pub"').replace('"style": "code-review"', '"style": "editorial-letter"');
  assert.match(EDITORIAL, /"id": "pub"[^]*"style": "editorial-letter"/);
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'pub.md': EDITORIAL });
  const store = new Store(':memory:');
  // A manuscript with a lint target of its own: a README, chapters, and a package.json `test` script.
  const book = docRepo(true);
  fs.mkdirSync(path.join(book, 'Chapters'));
  fs.writeFileSync(path.join(book, 'Chapters', 'Chapter_01.md'), 'x');
  const chapters = [
    { ref: 't1', title: 'Draft Chapter 2', role: 'dev', kind: 'writing', prompt: 'Draft Chapters/Chapter_02.md following README.md.', acceptance: '1. Chapters/Chapter_02.md exists.', after: [], testCmd: 'wc -w Chapters/Chapter_02.md', points: 3 },
    { ref: 't2', title: 'Line edit Chapter 1', role: 'dev', kind: 'writing', prompt: 'Line edit Chapters/Chapter_01.md.', acceptance: '1. No scene is cut.', after: [], testCmd: null, points: 2 },
  ];
  const stub = stubClaude(envelope(JSON.stringify({ epic: { title: 'Book', summary: '' }, tickets: chapters })));
  try {
    const { parseCrewPlan } = await import('../src/assistant/crewPlan.ts');
    const wire = parseCrewPlan({ ask: 'draft the book', playbook: 'pub', repo: book, tickets: chapters });
    assert.deepEqual(wire.tickets.map((t) => t.kind), ['writing', 'writing']);
    assert.deepEqual(kindNotes(wire), []);
    const plan = await crewPlan({ ask: 'draft the book', store, repo: book, playbook: 'pub' });
    assert.deepEqual(plan.tickets.map((t) => t.kind), ['writing', 'writing']);
    assert.deepEqual(kindNotes(plan), []);
    assert.deepEqual(queueCrewPlan(store, plan, { runner: 'echo' }).tickets.map((t) => `${t.kind} ${t.mergeOnApprove}`), ['writing false', 'writing false']);
    // The same tickets under the code crew, in the same repo, are corrected: the playbook is what differs.
    assert.deepEqual(parseCrewPlan({ ask: 'draft the book', playbook: 'soft', repo: book, tickets: chapters }).tickets.map((t) => t.kind), ['code', 'code']);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, book]);
  }
});

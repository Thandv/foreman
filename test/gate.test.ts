import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, type NewTask } from '../src/queue.ts';
import { DROPPED_ISSUE_PREFIX } from '../src/verify/crewReview.ts';
import { Scheduler } from '../src/scheduler.ts';
import {
  applyApproval, applyRejection, effectiveGate, envGate, gateOptIn, hardHumanReason, humanOnlyPath, ownerGate, ownerGateBatch,
  reviewHolds,
} from '../src/gate.ts';
import { Broker } from '../src/budget.ts';
import { clearPlaybookCache } from '../src/playbooks.ts';
import { tierModel } from '../src/roles.ts';
import { dpoFromGate } from '../src/align/dataset.ts';
import type { Run, Task } from '../src/types.ts';

// --------------------------------------------------------------- fixtures

const pbText = (fm: Record<string, unknown>, body: string): string =>
  `---\n${JSON.stringify(fm, null, 2)}\n---\n${body}`;

const ROLES = `
## role: planner

You decompose the ask.

## role: dev

You implement the ticket.

## role: qa

You verify the claim.
`;

/** gate.default = owner: the playbook itself is happy to be auto-approved. */
const AUTO = pbText({
  id: 'auto',
  description: 'Autonomous delivery.',
  triggers: ['auto'],
  roles: { planner: { tier: 'owner' }, dev: { tier: 'worker' }, qa: { tier: 'worker' } },
  // No reviewers: the only thing that may call the CLI in these tests is the gate.
  reviewers: [],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'owner', hardHuman: ['S2', 'budget', 'allowCore', 'qa'] },
  constraints: [],
}, ROLES);

/** gate.default = human: the seed-playbook posture. */
const MANUAL = pbText({
  id: 'manual',
  description: 'Human-gated delivery.',
  triggers: ['manual'],
  roles: { planner: { tier: 'owner' }, dev: { tier: 'worker' }, qa: { tier: 'worker' } },
  reviewers: [],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: ['S2', 'budget', 'allowCore'] },
  constraints: [],
}, ROLES);

function withPlaybooks(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-pb-'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  clearPlaybookCache();
  return dir;
}

const envelope = (result: string, costUsd = 0.05): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, result });

const gateReply = (decision: string, rationale: string): string =>
  envelope(JSON.stringify({ decision, rationale }));

const batchReply = (decisions: Array<{ id: string; decision: string; rationale?: string }>): string =>
  envelope(JSON.stringify({ decisions }));

interface Stub {
  dir: string;
  invocations(): string[][];
  prompt(i: number): string;
  count(): number;
}

/** The claude CLI stand-in from the crew tests, plus an optional stall. */
function stubClaude(bodies: string[], opts: { sleep?: string; exitCode?: number } = {}): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-cli-'));
  const bin = path.join(dir, 'claude');
  const logFile = path.join(dir, 'argv.log');
  const countFile = path.join(dir, 'count');
  bodies.forEach((body, i) => fs.writeFileSync(path.join(dir, `body.${i}`), body));
  fs.writeFileSync(path.join(dir, 'body.last'), bodies[bodies.length - 1] ?? envelope('{}'));
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "${logFile}"; done\n` +
      `printf '<<<END>>>\\n' >> "${logFile}"\n` +
      (opts.sleep ? `sleep ${opts.sleep}\n` : '') +
      `n=0\n[ -f "${countFile}" ] && n=$(cat "${countFile}")\n` +
      `printf '%s' "$((n+1))" > "${countFile}"\n` +
      `if [ -f "${dir}/body.$n" ]; then cat "${dir}/body.$n"; else cat "${dir}/body.last"; fi\n` +
      `exit ${opts.exitCode ?? 0}\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const invocations = (): string[][] =>
    (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      .split('<<<END>>>\n')
      .filter((chunk) => chunk.trim())
      .map((chunk) => chunk.split('\n').filter(Boolean));
  return { dir, invocations, prompt: (i) => (invocations()[i] ?? []).join('\n'), count: () => invocations().length };
}

function cleanup(dirs: string[]): void {
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
  delete process.env['FOREMAN_CLAUDE_BIN'];
  delete process.env['FOREMAN_GATE'];
  delete process.env['FOREMAN_GATE_BATCH'];
  clearPlaybookCache();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** A ticket parked at the gate on a run that went green — the gate's happy input. */
function parked(
  store: Store,
  over: Partial<NewTask> = {},
  run: { verdict?: 'pass' | 'fail' | 'split' | null; testsPassed?: boolean | null; status?: Run['status'] } = {},
): { task: Task; run: Run } {
  const task = store.addTask({
    title: 'Add token auth',
    prompt: 'Add bearer-token auth to the API.',
    kind: 'code',
    runner: 'echo',
    acceptance: 'requests without a token get 401',
    playbook: 'auto',
    role: 'dev',
    ...over,
  });
  const started = store.startRun(task.id);
  if (run.testsPassed !== null) store.setTestsPassed(started.id, run.testsPassed ?? true);
  const verdict = run.verdict === undefined ? 'pass' : run.verdict;
  if (verdict) {
    store.addVerdict({
      runId: started.id, taskId: task.id, verdict, disagreement: false,
      council: [{
        model: 'local-0', provider: 'ollama', local: true, verdict: verdict === 'fail' ? 'fail' : 'pass',
        confidence: 0.9, critique: 'the local council read the diff', costUsd: 0, latencyMs: 5,
      }],
      critique: 'the council had its say',
    });
  }
  store.endRun(started.id, run.status ?? 'succeeded', { exitCode: 0, summary: 'added the middleware' });
  store.setStatus(task.id, 'awaiting-approval');
  return { task: store.getTask(task.id)!, run: store.getRun(started.id)! };
}

/** An epic container plus N tickets parked under it — what a batch is made of. */
function parkedEpic(
  store: Store,
  count: number,
  over: Array<Partial<NewTask>> = [],
): { epicId: string; tasks: Task[] } {
  const epic = store.addTask({
    title: 'ship auth', prompt: 'ship the auth epic', runner: 'echo', playbook: 'auto', isEpic: true,
  });
  const tasks = Array.from({ length: count }, (_, i) =>
    parked(store, { parentId: epic.id, title: `ticket ${i}`, ...(over[i] ?? {}) }).task);
  return { epicId: epic.id, tasks };
}

const batchItems = (store: Store, tasks: Task[]): Array<{ task: Task; run: Run | null }> =>
  tasks.map((task) => ({ task, run: store.latestRun(task.id) }));

const events = (store: Store, taskId: string): string[] =>
  store.eventsForTask(taskId).map((e) => e.message);

const gateEvents = (store: Store, taskId: string): string[] =>
  events(store, taskId).filter((m) => m.startsWith('owner-gate:'));

async function settle(sched: Scheduler, until: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return dir;
}

// ------------------------------------------------------ effective gate matrix

test('the effective gate resolves ticket > playbook > env > human', () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  try {
    delete process.env['FOREMAN_GATE'];
    assert.equal(envGate(), 'human', 'the default posture is the human');
    assert.equal(effectiveGate({ gate: null, playbook: null }), 'human');
    assert.equal(effectiveGate({ gate: 'owner', playbook: null }), 'owner', 'a per-ticket opt-in stands alone');
    assert.equal(effectiveGate({ gate: null, playbook: 'auto' }), 'owner', "the playbook's own default applies");
    assert.equal(effectiveGate({ gate: 'human', playbook: 'auto' }), 'human', 'a ticket can opt back out');
    assert.equal(effectiveGate({ gate: null, playbook: 'nonexistent' }), 'human', 'an unknown playbook is not autonomy');

    process.env['FOREMAN_GATE'] = 'owner';
    assert.equal(envGate(), 'owner');
    assert.equal(effectiveGate({ gate: null, playbook: null }), 'owner', 'env decides when nothing else does');
    assert.equal(
      effectiveGate({ gate: null, playbook: 'manual' }),
      'human',
      'FOREMAN_GATE=owner must NOT override a playbook that gates on the human',
    );
    assert.equal(
      effectiveGate({ gate: 'owner', playbook: 'manual' }),
      'owner',
      'an explicit per-ticket opt-in does override it',
    );

    process.env['FOREMAN_GATE'] = 'nonsense';
    assert.equal(envGate(), 'human', 'an unreadable FOREMAN_GATE falls back to the human');
  } finally {
    cleanup([pbDir]);
  }
});

test('--gate owner rides on every ticket of an epic, and on nothing else', () => {
  const store = new Store(':memory:');
  try {
    const opted = store.addTask({ title: 'a', prompt: 'a', runner: 'echo', gate: 'owner' });
    assert.equal(store.getTask(opted.id)!.gate, 'owner', 'the column round-trips');
    const plain = store.addTask({ title: 'b', prompt: 'b', runner: 'echo' });
    assert.equal(plain.gate, null, 'a task queued without --gate resolves at decision time, not at insert');
    assert.throws(() => store.addTask({ title: 'c', prompt: 'c', runner: 'echo', gate: 'nobody' as never }), /unknown gate/);
  } finally {
    store.close();
  }
});

// ----------------------------------------------------- hard-human short-circuits

const HARD_HUMAN: Array<{
  name: string;
  task: Partial<NewTask>;
  run?: { verdict?: 'pass' | 'fail' | 'split' | null; testsPassed?: boolean | null; status?: Run['status'] };
  error?: string;
  expect: RegExp;
}> = [
  { name: 'S2 sensitivity', task: { sensitivity: 'S2' }, expect: /S2 work is never shown/ },
  { name: 'allowCore', task: { allowCore: true }, expect: /allowCore/ },
  { name: 'a budget hard-stop park', task: {}, error: 'budget hard-stop: daily cap reached', expect: /budget hard-stop/ },
  { name: 'a failed review verdict', task: {}, run: { verdict: 'fail' }, expect: /verdict was 'fail'/ },
  { name: 'a split review verdict', task: {}, run: { verdict: 'split' }, expect: /verdict was 'split'/ },
  { name: 'no verdict at all', task: {}, run: { verdict: null }, expect: /no review verdict/ },
  { name: 'failed tests', task: {}, run: { testsPassed: false }, expect: /checks failed/ },
  { name: 'a run that did not succeed', task: {}, run: { status: 'failed' }, expect: /ended 'failed'/ },
  { name: "a playbook's own hardHuman class", task: { role: 'qa' }, expect: /marks 'qa' as hard-human/ },
  { name: 'a human-gated playbook with no opt-in', task: { playbook: 'manual' }, expect: /gates on the human/ },
];

test('the owner model reads a lost-seat note as a council note, never as a chair ruling', async () => {
  // The heal path: rung 0 lost a seat (a split, with a status line in the chair
  // field), rung 1's different advisors passed it. The owner prompt lists both
  // rows; the rung-0 line must not reach the owner as a chair's decision.
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  const stub = stubClaude([gateReply('approve', 'the full council passed it')]);
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store, {}, { verdict: null });
    const op = (model: string, verdict: 'pass' | 'fail', critique: string, error?: string) => ({
      model, provider: 'ollama', local: true, verdict, confidence: 0.9, critique, costUsd: 0, latencyMs: 5,
      ...(error ? { error } : {}),
    });
    store.addVerdict({
      runId: run.id, taskId: task.id, verdict: 'split', disagreement: false,
      council: [op('qwen3.5:2b', 'fail', '', 'unparseable reply: ok'), op('qwen2.5-coder:14b', 'pass', 'fine')],
      chairSummary: 'a seat answered nothing usable (qwen3.5:2b: unparseable reply: ok) — a lone PASS is not a council decision',
    });
    store.addVerdict({
      runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false,
      council: [op('qwen2.5-coder:14b', 'pass', 'fine'), op('qwen3.5:9b', 'pass', 'reads right')],
    });
    await ownerGate({ task: store.getTask(task.id)!, run: store.getRun(run.id), store });
    assert.equal(stub.count(), 1, 'the owner model was asked');
    const prompt = stub.prompt(0);
    assert.match(prompt, /council note \(no chair ruled\): a seat answered nothing usable/);
    assert.doesNotMatch(prompt, /chair \([^)]*\): a seat answered nothing usable/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

for (const scenario of HARD_HUMAN) {
  test(`the owner gate parks for the human on ${scenario.name}, without spending a token`, async () => {
    const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
    const stub = stubClaude([gateReply('approve', 'should never be asked')]);
    const store = new Store(':memory:');
    try {
      const { task, run } = parked(store, scenario.task, scenario.run ?? {});
      if (scenario.error) store.setStatus(task.id, 'awaiting-approval', scenario.error);
      const current = store.getTask(task.id)!;

      assert.match(hardHumanReason(current, run) ?? '', scenario.expect);
      const decision = await ownerGate({ task: current, run, store });

      assert.equal(decision, 'hold');
      assert.equal(store.getTask(task.id)!.status, 'awaiting-approval', 'the ticket is exactly where a human finds it');
      assert.equal(stub.count(), 0, 'a call that cannot change the outcome is never paid for');
      const logged = gateEvents(store, task.id);
      assert.equal(logged.length, 1);
      assert.match(logged[0]!, /^owner-gate: hold — hard-human: /);
      assert.match(logged[0]!, scenario.expect);
    } finally {
      store.close();
      cleanup([pbDir, stub.dir]);
    }
  });
}

test('a human-gated playbook is overridden by an explicit per-ticket opt-in, not by the env', async () => {
  const pbDir = withPlaybooks({ 'manual.md': MANUAL });
  const stub = stubClaude([gateReply('approve', 'the diff matches the ticket')]);
  const store = new Store(':memory:');
  try {
    process.env['FOREMAN_GATE'] = 'owner';
    const envOnly = parked(store, { playbook: 'manual' });
    assert.equal(await ownerGate({ ...envOnly, store }), 'hold');
    assert.equal(stub.count(), 0);

    const optedIn = parked(store, { playbook: 'manual', gate: 'owner' });
    assert.equal(await ownerGate({ ...optedIn, store }), 'approved');
    assert.equal(stub.count(), 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- the decision

test('the gate prompt carries the ticket, the verdict chain, the diff stats and the diff', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'I want a person on this')]);
  const store = new Store(':memory:');
  const artDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-art-'));
  try {
    const { task, run } = parked(store);
    const diffPath = path.join(artDir, 'run.diff');
    fs.writeFileSync(
      diffPath,
      [
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1,2 +1,3 @@',
        ' export function auth(token) {',
        '+  if (!token) return null;',
      ].join('\n'),
    );
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: '1 file changed' });

    assert.equal(await ownerGate({ task, run, store }), 'hold');
    const prompt = stub.prompt(0);
    assert.match(prompt, /"decision":"approve"\|"reject"\|"hold"/, 'the reply contract is stated');
    assert.match(prompt, /TICKET: Add token auth/);
    assert.match(prompt, /requests without a token get 401/, 'acceptance travels with the ticket');
    assert.match(prompt, /added the middleware/, "the run's own summary is in there");
    assert.match(prompt, /council review → pass/, 'the verdict chain is in there');
    assert.match(prompt, /CHANGE: 1 file\(s\), 1 changed line\(s\)/, 'diff stats are computed code-side');
    assert.match(prompt, /if \(!token\) return null;/, 'and the diff itself');

    const argv = stub.invocations()[0]!;
    assert.equal(argv[argv.indexOf('--model') + 1], tierModel('owner'), 'the gate is an owner-tier call');
    assert.ok(argv.includes('--max-turns'), 'a gate answers once; it is not an agent loop');

    const receipts = store.receiptsForTask(task.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!['kind'], 'gate', 'gate spend is its own line in the ledger');
    assert.equal(receipts[0]!['cost_usd'], 0.05);

    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.deepEqual(gateEvents(store, task.id), ['owner-gate: hold — I want a person on this']);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, artDir]);
  }
});

test('an approve decision runs the same path a human approve runs: done, merged, remembered', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'does exactly what the ticket asked')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme',
      prompt: "printf 'gated\\n' >> README.md",
      kind: 'code',
      runner: 'shell',
      repo,
      role: 'dev',
      playbook: 'auto',
      // A landing is only the owner's to sign off on a test run that passed.
      testCmd: 'grep -q gated README.md',
      acceptance: 'the readme mentions the gate',
    });
    // The decision event is written last, after the merge: waiting on `done`
    // alone would race the branch landing.
    await settle(sched, () => gateEvents(store, t.id).length > 0);

    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'done');
    assert.equal(stub.count(), 1, 'exactly one gate call decided the ticket');
    assert.match(
      fs.readFileSync(path.join(repo, 'README.md'), 'utf8'),
      /gated/,
      'mergeOnApprove landed the branch, exactly as a human approval would',
    );
    assert.match(events(store, t.id).join('\n'), /merge: merged 1 commit/);
    assert.match(gateEvents(store, t.id).join('\n'), /^owner-gate: approved — does exactly what the ticket asked/);

    // The decision is remembered, and marked as the model's, not the operator's.
    const fact = store.recallFacts(repo, 50).find((f) => f.key.startsWith('preference:'));
    assert.ok(fact, 'an approval with a rationale is a preference worth keeping');
    assert.match(fact.value, /the owner gate \(not the operator\)/);
    assert.equal(fact.source, `owner-gate:${t.id}`);
    assert.ok(fact.confidence < 0.6, 'a model agreeing with a model is weaker evidence than a human');
    // The note's homes are the preference and the timeline — never `error`,
    // which is the rejection-reason column.
    assert.equal(after.error, null, 'an approval is not an error, whoever signed it');
    assert.match(store.gateDecision(t.id) ?? '', /^approved@\d+$/, 'the decision is durable, not an event row');

    // …and it stays out of the operator's own preference dataset.
    assert.equal(
      dpoFromGate(store).length,
      0,
      'alignment pairs are the OPERATOR’s taste; owner-gate decisions must not train the model on itself',
    );
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('a reject decision rejects the ticket with the rationale as the note', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('reject', 'it edits three files the ticket never mentioned')]);
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    assert.equal(await ownerGate({ task, run, store }), 'rejected');

    const after = store.getTask(task.id)!;
    assert.equal(after.status, 'rejected');
    assert.match(after.error ?? '', /it edits three files the ticket never mentioned/);
    assert.match(gateEvents(store, task.id).join('\n'), /^owner-gate: rejected — it edits three files/);
    const fact = store.recallFacts('global', 50).find((f) => f.key === `preference:${task.id}`)!;
    assert.match(fact.value, /Do not repeat this/);
    assert.match(fact.value, /the owner gate \(not the operator\)/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a malformed reply is a hold, never a decision', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([envelope('sure, ship it!')]);
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    assert.equal(await ownerGate({ task, run, store }), 'hold');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.match(gateEvents(store, task.id).join('\n'), /did not answer the contract/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an unknown decision word is a hold too', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('merge-it-now', 'looks good')]);
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    assert.equal(await ownerGate({ task, run, store }), 'hold');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an unreachable CLI parks the ticket instead of guessing', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'never gets out')], { exitCode: 3 });
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'does-not-exist');
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    assert.equal(await ownerGate({ task, run, store }), 'hold');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.match(gateEvents(store, task.id).join('\n'), /could not be reached/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a ticket a human decided while the owner was thinking is never re-decided', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'ship it')], { sleep: '0.4' });
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    const inFlight = ownerGate({ task, run, store });
    await new Promise((r) => setTimeout(r, 100));
    store.decide(task.id, false, 'the operator got there first');

    assert.equal(await inFlight, 'hold');
    assert.equal(store.getTask(task.id)!.status, 'rejected', "the human's decision stands");
    assert.match(gateEvents(store, task.id).join('\n'), /moved to rejected while the owner was deciding/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ---------------------------------------------------------- scheduler wiring

test('the scheduler fires the gate once per park, off the tick, and never twice', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'green and in scope')], { sleep: '0.5' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const { task } = parked(store);
    const startedAt = Date.now();
    await sched.tick();
    await sched.tick();
    assert.ok(Date.now() - startedAt < 400, 'a 500ms gate call must not have blocked either tick');
    assert.ok(stub.count() <= 1, 'the second tick did not re-fire a call already in flight');

    await settle(sched, () => store.getTask(task.id)!.status === 'done');
    assert.equal(stub.count(), 1, 'exactly one gate call, across every tick that saw the parked ticket');

    // A decided ticket is terminal, and a held one carries its event: neither
    // is asked again on the next tick.
    await sched.tick();
    await sched.tick();
    assert.equal(stub.count(), 1);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a held ticket is not re-asked every tick', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'this one needs a person')]);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const { task } = parked(store);
    await settle(sched, () => gateEvents(store, task.id).length > 0);
    for (let i = 0; i < 5; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.count(), 1, 'a hold is a decision the gate stands by, not a retry loop');
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------ the note's two homes

test('an approval note is remembered, but never written to tasks.error', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  try {
    const yes = parked(store);
    await applyApproval(store, yes.task.id, { note: 'ship it, the auth path is right' });
    const approved = store.getTask(yes.task.id)!;
    assert.equal(approved.status, 'done');
    assert.equal(approved.error, null, 'error is the rejection-reason column, not a notes field');
    assert.match(
      store.recallFacts('global', 50).find((f) => f.key === `preference:${yes.task.id}`)!.value,
      /ship it, the auth path is right/,
      'the note is preserved — as a preference, which is what a note about a decision is',
    );

    // A rejection still puts its reason where every reader looks for it.
    const no = parked(store);
    applyRejection(store, no.task.id, 'it edits files the ticket never mentioned');
    assert.equal(store.getTask(no.task.id)!.error, 'it edits files the ticket never mentioned');
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

test('dpoFromGate excludes owner-gate decisions by the column, not by the note text', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'does what the ticket asked')]);
  const store = new Store(':memory:');
  try {
    // Same work, decided twice: once by the Owner, once rejected by a person.
    const auto = parked(store);
    assert.equal(await ownerGate({ ...auto, store }), 'approved');
    assert.equal(store.getTask(auto.task.id)!.error, null, 'the marker is no longer the note');

    const bad = parked(store);
    applyRejection(store, bad.task.id, 'wrong scope');

    // Neither decision produces a pair, and for two different reasons: the
    // owner-gate approval is a model agreeing with a model, so it is not
    // offered as the preferred answer; and the human rejection has no approved
    // counterpart to contrast with, so there is nothing to prefer it over.
    assert.deepEqual(dpoFromGate(store), []);

    // The control: the same approval made by a person IS the preferred answer.
    const human = parked(store);
    await applyApproval(store, human.task.id, { note: 'exactly right' });
    assert.match(dpoFromGate(store)[0]!.chosen, /added the middleware/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------- env is live intent, not a sweep

test('the sweep gates only an explicit opt-in; FOREMAN_GATE alone is not one', () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  try {
    process.env['FOREMAN_GATE'] = 'owner';
    assert.equal(gateOptIn({ gate: 'owner', playbook: null }), true, 'the ticket asked for it');
    assert.equal(gateOptIn({ gate: null, playbook: 'auto' }), true, 'the playbook declares the domain autonomous');
    assert.equal(gateOptIn({ gate: 'human', playbook: 'auto' }), false, 'a ticket can opt back out');
    assert.equal(gateOptIn({ gate: null, playbook: 'manual' }), false);
    assert.equal(
      gateOptIn({ gate: null, playbook: null }),
      false,
      'an exported variable is live intent, not a standing opt-in written into the ticket',
    );
    assert.equal(effectiveGate({ gate: null, playbook: null }), 'owner', 'the at-park path still resolves it');
  } finally {
    cleanup([pbDir]);
  }
});

test('FOREMAN_GATE=owner does not retroactively auto-decide a backlog that was already parked', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'should never be asked')]);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    // The operator exports the variable and restarts: these tickets were sitting
    // at the gate before the daemon ever saw them, and carry no opt-in at all.
    process.env['FOREMAN_GATE'] = 'owner';
    const backlog = parked(store, { playbook: null });
    for (let i = 0; i < 5; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(stub.count(), 0, 'a pre-existing backlog is the human’s, whatever the environment says');
    assert.equal(store.getTask(backlog.task.id)!.status, 'awaiting-approval');
    assert.deepEqual(gateEvents(store, backlog.task.id), []);
    assert.equal(store.gateDecision(backlog.task.id), null, 'and it is not marked as gated either');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('FOREMAN_GATE=owner still decides a playbook-less ticket the daemon watched park, when its work lands nowhere', async () => {
  const pbDir = withPlaybooks({});
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    process.env['FOREMAN_GATE'] = 'owner';
    // No playbook and no --gate: the environment is the only thing saying 'owner'.
    // Nothing merges on approval, so the landing rules do not apply to it.
    const t = store.addTask({
      title: 'touch the readme',
      prompt: "printf 'env-gated\\n' >> README.md",
      kind: 'code',
      runner: 'shell',
      repo,
      mergeOnApprove: false,
    });
    await settle(sched, () => gateEvents(store, t.id).length > 0);

    assert.equal(
      store.getTask(t.id)!.status,
      'done',
      `the at-park trigger is the operator’s live intent: ${gateEvents(store, t.id).join(' | ')}`,
    );
    assert.equal(stub.count(), 1);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

// ------------------------------------------------ concurrency and the budget

test('the sweep runs one gate at a time, never the whole backlog at once', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'a person should look')], { sleep: '0.3' });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const tasks = [parked(store).task, parked(store).task, parked(store).task];
    // A tick STARTS a gate; the spawned process writes its argv a moment later,
    // so counting straight after three awaited ticks races the OS and reads 0.
    // Wait for the first spawn to appear, then assert the other two did not
    // join it — that, not the timing, is what this test is about. The stub
    // sleeps 0.3s, so the first gate is still in flight while we look.
    await settle(sched, () => stub.count() > 0, 5_000);
    assert.equal(stub.count(), 1, 'three parked tickets are three claude spawns, not three at once');

    await settle(sched, () => tasks.every((t) => gateEvents(store, t.id).length > 0));
    assert.equal(stub.count(), 3, 'each still gets its decision, one tick apart');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a gate over the daily cap holds without spawning, and is not marked as decided', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'should never be asked')]);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verifyEnabled: false,
    broker: new Broker(store, { dailyCapUsd: 1 }),
  });
  try {
    const { task, run } = parked(store);
    // The owner CLI bills against the SUBSCRIPTION ceiling, not the metered
    // cap, so that is the one this exercises. Both hold the ticket; they guard
    // different things — real money, and a runaway loop against a rate limit.
    store.addReceipt({ kind: 'agent', provider: 'claude-cli', model: 'x', local: false, costUsd: 250 });

    for (let i = 0; i < 3; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.count(), 0, 'owner spend bypasses the broker, so the gate has to check the cap itself');
    const held = gateEvents(store, task.id);
    assert.equal(held.length, 1, 'the hold is logged once, not once per tick');
    assert.match(held[0]!, /owner-gate: hold — budget: today's subscription usage \$250\.00 \(list price\) has reached the \$200\.00 ceiling/);
    assert.equal(store.gateDecision(task.id), null, 'a deferral is not a decision: tomorrow it is gated normally');

    // Defense in depth: ownerGate refuses on its own, for any direct caller.
    assert.equal(await ownerGate({ task, run, store, dailyCapUsd: 1 }), 'hold');
    assert.equal(stub.count(), 0);
    assert.equal(store.gateDecision(task.id), null);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// -------------------------------------------------- the durable gated marker

test("the 'already gated' marker is a column, so pruning the events cannot re-open the spend loop", async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'this one needs a person')]);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const { task } = parked(store);
    await settle(sched, () => gateEvents(store, task.id).length > 0);
    assert.match(store.gateDecision(task.id) ?? '', /^hold@\d+$/);

    // What pruneEvents() does at the end of every run on this task.
    store.db.prepare('DELETE FROM events WHERE task_id = ?').run(task.id);
    for (let i = 0; i < 5; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.count(), 1, 'the marker outlived the event it used to be');

    // A repair round is new work, so it earns a new decision.
    store.setStatus(task.id, 'rejected', 'needs another pass');
    assert.equal(store.scheduleRepair(task.id, 'fix the thing'), true);
    assert.equal(store.gateDecision(task.id), null, 'a repaired ticket is re-gated deliberately');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- batched gating

test('an epic that reaches the gate together is decided in one owner call', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  const { epicId, tasks } = parkedEpic(store, 3);
  const [a, b, c] = tasks as [Task, Task, Task];
  const stub = stubClaude([batchReply([
    { id: a.id, decision: 'approve', rationale: 'ticket A does what it asked' },
    { id: b.id, decision: 'reject', rationale: 'ticket B edits three files nobody asked about' },
    { id: c.id, decision: 'hold', rationale: 'ticket C is a call for a person' },
  ])]);
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    await settle(sched, () => tasks.every((t) => gateEvents(store, t.id).length > 0));
    assert.equal(stub.count(), 1, 'three parked tickets of one epic are one owner call, not three');

    // Each decision landed through the same path a single gate uses.
    assert.equal(store.getTask(a.id)!.status, 'done');
    assert.equal(store.getTask(b.id)!.status, 'rejected');
    assert.match(store.getTask(b.id)!.error ?? '', /three files nobody asked about/, 'the rejection note is the rationale');
    assert.equal(store.getTask(c.id)!.status, 'awaiting-approval');
    assert.match(
      store.recallFacts('global', 50).find((f) => f.key === `preference:${b.id}`)!.value,
      /the owner gate \(not the operator\)/,
      'a batched rejection is remembered as the model’s, exactly like a single one',
    );

    // Per-ticket events and durable markers, unchanged by batching.
    assert.match(gateEvents(store, a.id).join('\n'), /^owner-gate: approved — ticket A does what it asked/);
    assert.match(gateEvents(store, b.id).join('\n'), /^owner-gate: rejected — ticket B edits three files/);
    assert.match(gateEvents(store, c.id).join('\n'), /^owner-gate: hold — ticket C is a call for a person/);
    assert.match(store.gateDecision(a.id) ?? '', /^approved@\d+$/);
    assert.match(store.gateDecision(b.id) ?? '', /^rejected@\d+$/);
    assert.match(store.gateDecision(c.id) ?? '', /^hold@\d+$/);

    // One prompt, every ticket's evidence, ids the reply can be matched on.
    const prompt = stub.prompt(0);
    assert.match(prompt, /"decisions":\[\{"id"/, 'the batch contract is stated');
    for (const t of tasks) {
      assert.match(prompt, new RegExp(`=== TICKET ${t.id} ===`), `${t.id} has its own section`);
    }
    assert.match(prompt, /council review → pass/, 'the verdict chain still travels with each ticket');
    assert.match(prompt, /ACCEPTANCE CRITERIA/);

    // Billed once, to the epic, under its own kind.
    const receipts = store.receiptsForTask(epicId);
    assert.equal(receipts.length, 1, 'one call is one receipt');
    assert.equal(receipts[0]!['kind'], 'gate:batch', 'the ledger can tell a batch from a single gate');
    for (const t of tasks) {
      assert.equal(store.receiptsForTask(t.id).length, 0, 'the cost is attributed once, never copied per ticket');
    }

    // And nothing is asked twice.
    for (let i = 0; i < 3; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.count(), 1);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a ticket the batch reply leaves out is held, and an id nobody asked about is ignored', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  const { tasks } = parkedEpic(store, 3);
  const [a, b, c] = tasks as [Task, Task, Task];
  const stub = stubClaude([batchReply([
    { id: a.id, decision: 'approve', rationale: 'A is in scope' },
    { id: 't_neverexisted', decision: 'approve', rationale: 'and so is this ticket I invented' },
    { id: c.id, decision: 'sure-why-not', rationale: 'C looks fine to me' },
  ])]);
  try {
    const decisions = await ownerGateBatch({ items: batchItems(store, tasks), store });
    assert.equal(stub.count(), 1);

    assert.equal(decisions.get(a.id), 'approved');
    assert.equal(decisions.get(b.id), 'hold', 'a ticket the reply forgot is held, never guessed at');
    assert.equal(decisions.get(c.id), 'hold', 'a decision word the contract does not name is a hold');
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    assert.equal(store.getTask(c.id)!.status, 'awaiting-approval');
    assert.match(gateEvents(store, b.id).join('\n'), /gave no decision for this ticket/);
    assert.match(gateEvents(store, c.id).join('\n'), /did not answer the contract for this ticket/);
    // Held is decided: the gate stands by it and does not re-ask tomorrow.
    assert.match(store.gateDecision(b.id) ?? '', /^hold@\d+$/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a malformed batch reply holds every ticket in it, and changes nothing', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  const { tasks } = parkedEpic(store, 3);
  // Valid JSON, wrong shape: the single-ticket contract answered to a batch.
  const stub = stubClaude([envelope(JSON.stringify({ decision: 'approve', rationale: 'ship them all' }))]);
  try {
    const decisions = await ownerGateBatch({ items: batchItems(store, tasks), store });
    assert.equal(stub.count(), 1);
    for (const t of tasks) {
      assert.equal(decisions.get(t.id), 'hold');
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', 'not one ticket moved');
      assert.equal(store.getTask(t.id)!.error, null);
      assert.match(gateEvents(store, t.id).join('\n'), /did not answer the batch contract/);
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a hard-human ticket in the epic is left out of the batch entirely', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  // AUTO marks the 'qa' role hard-human: that ticket is a person's, batch or not.
  const { tasks } = parkedEpic(store, 3, [{ role: 'qa' }]);
  const [blocked, b, c] = tasks as [Task, Task, Task];
  const stub = stubClaude([batchReply([
    { id: b.id, decision: 'approve', rationale: 'B is in scope' },
    { id: c.id, decision: 'approve', rationale: 'C is in scope' },
  ])]);
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    await settle(sched, () => tasks.every((t) => gateEvents(store, t.id).length > 0));
    assert.equal(stub.count(), 1, 'the two eligible tickets are one call; the third is nobody’s call to make');

    const prompt = stub.prompt(0);
    assert.ok(!prompt.includes(blocked.id), 'the hard-human ticket never reaches the prompt');
    assert.match(prompt, new RegExp(`=== TICKET ${b.id} ===`));
    assert.match(prompt, new RegExp(`=== TICKET ${c.id} ===`));

    assert.equal(store.getTask(blocked.id)!.status, 'awaiting-approval');
    assert.match(gateEvents(store, blocked.id).join('\n'), /hard-human: playbook 'auto' marks 'qa' as hard-human/);
    assert.equal(store.getTask(b.id)!.status, 'done');
    assert.equal(store.getTask(c.id)!.status, 'done');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('FOREMAN_GATE_BATCH=off goes back to one owner call per ticket', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  process.env['FOREMAN_GATE_BATCH'] = 'off';
  const { tasks } = parkedEpic(store, 3);
  const stub = stubClaude([gateReply('hold', 'a person should look at this one')]);
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    await settle(sched, () => tasks.every((t) => gateEvents(store, t.id).length > 0));
    assert.equal(stub.count(), 3, 'the kill-switch buys back the old one-call-per-ticket behaviour');
    for (const t of tasks) {
      assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
      assert.equal(store.receiptsForTask(t.id).length, 1, 'and each ticket is billed for its own call');
    }
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a lone parked ticket still takes the single path, batching or not', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  const { tasks } = parkedEpic(store, 1);
  const only = tasks[0]!;
  const stub = stubClaude([gateReply('approve', 'one ticket, one contract')]);
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    await settle(sched, () => gateEvents(store, only.id).length > 0);
    assert.equal(stub.count(), 1);
    assert.equal(store.getTask(only.id)!.status, 'done');
    assert.match(stub.prompt(0), /"decision":"approve"\|"reject"\|"hold"/, 'the single-ticket contract, unchanged');
    assert.equal(store.receiptsForTask(only.id)[0]!['kind'], 'gate', 'and the single-gate receipt kind');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a human-gated ticket is never sent to the owner gate by the scheduler', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  const stub = stubClaude([gateReply('approve', 'should never be asked')]);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const { task } = parked(store, { playbook: 'manual' });
    for (let i = 0; i < 5; i++) await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.count(), 0);
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.deepEqual(gateEvents(store, task.id), [], 'a human-gated ticket is not even logged about');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test("the owner's ruling is about the run it read: a newer run parked meanwhile is held, not decided", async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'does what the ticket asked')]);
  const store = new Store(':memory:');
  try {
    const judged = parked(store);
    // While the owner was reading run A, a person rejected it, retried, and run B parked.
    const runB = store.startRun(judged.task.id);
    store.endRun(runB.id, 'succeeded', { exitCode: 0, summary: 'a different attempt' });
    const decision = await ownerGate({ ...judged, task: store.getTask(judged.task.id)!, store });
    assert.equal(decision, 'hold');
    assert.equal(store.getTask(judged.task.id)!.status, 'awaiting-approval', 'run B waits for its own review');
    const label = (store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(runB.id) as Record<string, unknown>)['decision'];
    assert.equal(label, null, 'run B was not labelled with a ruling about run A');
    assert.equal(store.gateDecision(judged.task.id), null, 'and no durable hold: run B still gets its own owner review');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test("an owner approval labels its run as the owner's, so no retry can make it the operator's", async () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    await applyApproval(store, task.id, { note: 'owner-gate: fine', source: 'owner-gate' });
    const label = (store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(run.id) as Record<string, unknown>)['decision'];
    assert.equal(label, 'owner-approved');
  } finally {
    store.close();
  }
});

test('a daemon stop during the owner call is no decision: nothing durable is stamped', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'fine')], { sleep: '5' });
  const store = new Store(':memory:');
  try {
    const judged = parked(store);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    assert.equal(await ownerGate({ ...judged, store, signal: ac.signal }), 'hold');
    assert.equal(store.gateDecision(judged.task.id), null, 'asked again after the restart');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('reviewers who disagreed with no chair ruling are a human decision, not the owner gate\'s', () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store);
    const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'claude-cli', local: false, verdict, confidence: 0.8, critique: verdict, costUsd: 0, latencyMs: 1 });
    // A crew PASS over a council FAIL, the chair never ruled (it timed out).
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: true, council: [op('pass')], source: 'crew', chairSummary: null });
    const holds = reviewHolds(store, task.id);
    assert.equal(holds.unruled, true);
    assert.match(hardHumanReason(task, store.getRun(run.id), holds) ?? '', /disagreed and no chair ruled/);
    // A chair that did rule is a decision the owner gate may sign off.
    store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: true, council: [op('pass')], source: 'crew', chairSummary: 'the FAIL misread the diff' });
    assert.equal(reviewHolds(store, task.id).unruled, false);
  } finally {
    store.close();
  }
});

test('an approval decided on the operator\'s own desk lands nothing: no run was approved', async () => {
  const store = new Store(':memory:');
  try {
    const { task, run } = parked(store, { mergeOnApprove: true });
    // Its worktree is still on disk — but it was turned down, so it is not "left over".
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rejected-'));
    store.db.prepare("UPDATE runs SET branch = 'foreman/t-rejected', worktree_path = ? WHERE id = ?").run(tree, run.id);
    // Rejected at the gate, retried, given to the operator, marked done by hand.
    applyRejection(store, task.id, 'not this');
    store.retry(task.id);
    store.reassign(task.id, 'human');
    const result = await applyApproval(store, task.id, { note: 'completed by the operator' });
    assert.equal(result.task.status, 'done');
    assert.equal(result.merge.merged, false);
    assert.match(result.merge.reason, /nothing to land/);
    assert.equal(result.registration.registered, false);
  } finally {
    store.close();
  }
});

test('a desk close of an ordinary ticket is not an error: nothing to register, nothing claimed to land', async () => {
  const store = new Store(':memory:');
  try {
    const task = store.addTask({ title: 'write the note', prompt: 'x', kind: 'general', runner: 'echo' });
    store.reassign(task.id, 'human');
    const result = await applyApproval(store, task.id, { note: 'completed by the operator' });
    assert.equal(result.registration.reason, 'not a tool task');
    const { approvalOutcome } = (await import(new URL('../board/lib/store.js', import.meta.url).href)) as {
      approvalOutcome: (r: unknown, label?: string) => { ok: boolean; message: string };
    };
    assert.equal(approvalOutcome(result, 'Closed').ok, true, 'no error toast for closing your own ticket');
  } finally {
    store.close();
  }
});

test("a desk close points at an interrupted run's work still on disk — and only that", async () => {
  const store = new Store(':memory:');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-left-'));
  try {
    // Interrupted (canceled) and sent to the operator's desk, nobody ruled on
    // it, its worktree still there: say where.
    const left = parked(store, { mergeOnApprove: true });
    store.db.prepare("UPDATE runs SET branch = 'foreman/t-left', worktree_path = ?, status = 'canceled' WHERE id = ?").run(tree, left.run.id);
    store.setStatus(left.task.id, 'awaiting-human', 'interrupted by 4 daemon stops');
    const result = await applyApproval(store, left.task.id, { note: 'finished it by hand' });
    assert.equal(result.merge.merged, false);
    assert.equal(result.merge.branch, 'foreman/t-left');
    assert.ok(result.merge.reason.includes(tree), result.merge.reason);
    assert.match(result.merge.reason, /commit it there and merge it yourself/);
    assert.ok(events(store, left.task.id).some((m) => /^merge: not landed/.test(m)), 'and the timeline says so');

    // Its worktree already removed (an errored attempt, a prune): nothing to point at.
    const gone = parked(store, { mergeOnApprove: true });
    store.db.prepare("UPDATE runs SET branch = 'foreman/t-gone', worktree_path = '/nonexistent/foreman-jail', status = 'canceled' WHERE id = ?").run(gone.run.id);
    store.setStatus(gone.task.id, 'awaiting-human', 'interrupted by 4 daemon stops');
    assert.match((await applyApproval(store, gone.task.id)).merge.reason, /^nothing to land/);
  } finally {
    store.close();
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test('a tool ticket closed on the desk registers nothing', async () => {
  const store = new Store(':memory:');
  try {
    const task = store.addTask({ title: 'build a tool', prompt: 'x', kind: 'tool', runner: 'echo' });
    store.reassign(task.id, 'human');
    const result = await applyApproval(store, task.id);
    assert.equal(result.registration.registered, false);
    assert.match(result.registration.reason, /nothing to register/);
  } finally {
    store.close();
  }
});

test('an approval of a run that was cut short lands nothing', async () => {
  const store = new Store(':memory:');
  try {
    const { task } = parked(store, { mergeOnApprove: true }, { status: 'canceled' });
    const result = await applyApproval(store, task.id);
    assert.equal(result.merge.merged, false);
    assert.match(result.merge.reason, /nothing to land/);
  } finally {
    store.close();
  }
});

test("a change to the review or the gate during the owner's call is held, not decided", async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  try {
    // Handed to the human mid-call.
    let stub = stubClaude([gateReply('approve', 'ship it')], { sleep: '0.5' });
    const a = parked(store);
    const pending = ownerGate({ ...a, store });
    await new Promise((r) => setTimeout(r, 150));
    store.setGate(a.task.id, 'human');
    assert.equal(await pending, 'hold');
    assert.equal(stub.count(), 1, 'the owner was asked, and answered approve');
    assert.equal(store.getTask(a.task.id)!.status, 'awaiting-approval');
    cleanup([stub.dir]);

    // Re-reviewed to a PASS mid-call: still not the review the owner was shown.
    stub = stubClaude([gateReply('approve', 'ship it')], { sleep: '0.5' });
    const p = parked(store);
    const pendingP = ownerGate({ ...p, store });
    await new Promise((r) => setTimeout(r, 150));
    store.addVerdict({ runId: p.run.id, taskId: p.task.id, verdict: 'pass', disagreement: false, council: [], critique: 'the re-check passed it too' });
    assert.equal(await pendingP, 'hold');
    assert.equal(store.getTask(p.task.id)!.status, 'awaiting-approval');
    cleanup([stub.dir]);

    // Made S2 mid-call: no longer something the hosted owner may sign off.
    stub = stubClaude([gateReply('approve', 'ship it')], { sleep: '0.5' });
    const s2 = parked(store);
    const pendingS2 = ownerGate({ ...s2, store });
    await new Promise((r) => setTimeout(r, 150));
    store.db.prepare("UPDATE tasks SET sensitivity = 'S2' WHERE id = ?").run(s2.task.id);
    assert.equal(await pendingS2, 'hold');
    assert.equal(store.getTask(s2.task.id)!.status, 'awaiting-approval');
    cleanup([stub.dir]);

    // No longer the owner gate's at all (the board's house switch, a reset to the default).
    stub = stubClaude([gateReply('approve', 'ship it')]);
    const e = parked(store);
    assert.equal(await ownerGate({ ...e, store, stillEligible: () => false }), 'hold');
    assert.equal(stub.count(), 1);
    assert.equal(store.getTask(e.task.id)!.status, 'awaiting-approval');
    cleanup([stub.dir]);

    // Re-reviewed mid-call, on the same run: not the review the owner was shown.
    stub = stubClaude([gateReply('approve', 'ship it')], { sleep: '0.5' });
    const b = parked(store);
    const pendingB = ownerGate({ ...b, store });
    await new Promise((r) => setTimeout(r, 150));
    store.addVerdict({ runId: b.run.id, taskId: b.task.id, verdict: 'fail', disagreement: false, council: [], critique: 'the re-check found the bug' });
    assert.equal(await pendingB, 'hold');
    assert.equal(stub.count(), 1, 'the owner was asked, and answered approve');
    assert.equal(store.getTask(b.task.id)!.status, 'awaiting-approval');
    assert.equal(store.gateDecision(b.task.id), null);
    cleanup([stub.dir]);
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

test('a hold answered after the work moved on leaves no marker for the newer run', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'a person should look')], { sleep: '0.5' });
  const store = new Store(':memory:');
  try {
    const judged = parked(store);
    const pending = ownerGate({ ...judged, store });
    await new Promise((r) => setTimeout(r, 150));
    // Rejected, retried, and a new run parked while the owner was reading the old one.
    applyRejection(store, judged.task.id, 'no');
    store.retry(judged.task.id);
    const runB = store.startRun(judged.task.id);
    store.endRun(runB.id, 'succeeded', { exitCode: 0, summary: 'a second try' });
    store.setStatus(judged.task.id, 'awaiting-approval');
    assert.equal(await pending, 'hold');
    assert.equal(stub.count(), 1, 'the owner answered hold about run A');
    assert.equal(store.gateDecision(judged.task.id), null, 'run B still gets its own owner review');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a daemon stop during a batched owner call stamps nothing on any ticket', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'fine')], { sleep: '5' });
  const store = new Store(':memory:');
  try {
    const tasks = [parked(store).task, parked(store).task];
    const ac = new AbortController();
    const pending = ownerGateBatch({ items: batchItems(store, tasks), store, signal: ac.signal });
    // Abort once the call is really out, not on a timer that can beat the spawn under load.
    for (let i = 0; i < 500 && stub.count() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const decisions = await pending;
    assert.equal(stub.count(), 1, 'the batched call was made, then cut off');
    for (const t of tasks) {
      assert.equal(decisions.get(t.id), 'hold');
      assert.equal(store.gateDecision(t.id), null, 'asked again after the restart');
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the owner gate, single or batched, never signs off reviewers who disagreed with no chair ruling', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'fine')]);
  const store = new Store(':memory:');
  try {
    const unruled = (): Task => {
      const { task, run } = parked(store);
      store.addVerdict({
        runId: run.id, taskId: task.id, verdict: 'pass', disagreement: true, source: 'crew', chairSummary: null,
        council: [{ model: 'm', provider: 'claude-cli', local: false, verdict: 'pass', confidence: 0.8, critique: 'ok', costUsd: 0, latencyMs: 1 }],
      });
      return store.getTask(task.id)!;
    };
    const single = unruled();
    assert.equal(await ownerGate({ task: single, run: store.latestRun(single.id), store }), 'hold');
    const batch = [unruled(), unruled()];
    const decisions = await ownerGateBatch({ items: batchItems(store, batch), store });
    for (const t of batch) assert.equal(decisions.get(t.id), 'hold');
    assert.equal(stub.count(), 0, 'held before the owner was ever asked');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the run\'s own state is the reason given before an unruled split', () => {
  const store = new Store(':memory:');
  try {
    const { task } = parked(store, {}, { status: 'failed' });
    assert.match(hardHumanReason(task, store.latestRun(task.id), { unruled: true }) ?? '', /the run ended 'failed'/);
  } finally {
    store.close();
  }
});

test('an owner hold that arrives after a person already decided stamps nothing', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'a person should look')], { sleep: '0.5' });
  const store = new Store(':memory:');
  try {
    const judged = parked(store);
    const pending = ownerGate({ ...judged, store });
    await new Promise((r) => setTimeout(r, 150));
    await applyApproval(store, judged.task.id, { note: 'looks right' });
    assert.equal(await pending, 'hold');
    assert.equal(stub.count(), 1);
    assert.equal(store.gateDecision(judged.task.id), null);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('an owner hold about a review that has since been redone stamps nothing', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('hold', 'a person should look')], { sleep: '0.5' });
  const store = new Store(':memory:');
  try {
    const judged = parked(store);
    const pending = ownerGate({ ...judged, store });
    await new Promise((r) => setTimeout(r, 150));
    store.addVerdict({ runId: judged.run.id, taskId: judged.task.id, verdict: 'pass', disagreement: false, council: [], critique: 're-checked' });
    assert.equal(await pending, 'hold');
    assert.equal(stub.count(), 1);
    assert.equal(store.gateDecision(judged.task.id), null, 'the new review is shown to the owner in its turn');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a run that parks while the owner is still reading an older one is gated in its turn', { timeout: 60_000 }, async () => {
  // Eligible only through the at-park trigger (FOREMAN_GATE=owner, no playbook,
  // no house default): nothing but that trigger, kept for run B, gets B gated.
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  process.env['FOREMAN_GATE'] = 'owner';
  const stub = stubClaude([gateReply('approve', 'about run A'), gateReply('approve', 'run B is right')], { sleep: '1' });
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'gated\\n' >> README.md", kind: 'code', runner: 'shell',
      // Not a landing: FOREMAN_GATE alone no longer decides work that merges into a repo.
      repo, mergeOnApprove: false, acceptance: 'the readme mentions the gate',
    });
    await settle(sched, () => stub.count() >= 1); // the owner is reading run A
    const runA = store.latestRun(t.id)!.id;
    applyRejection(store, t.id, 'not this one');
    store.retry(t.id);
    await settle(sched, () => store.latestRun(t.id)!.id !== runA && store.getTask(t.id)!.status === 'awaiting-approval');
    // The answer about A is held as stale; then run B gets its own owner call.
    await settle(sched, () => store.getTask(t.id)!.status === 'done', 20_000);
    assert.equal(stub.count(), 2, 'one call about A, one about B');
    assert.ok(gateEvents(store, t.id).some((m) => /the ruling was about an earlier run|task moved/.test(m)), gateEvents(store, t.id).join('\n'));
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test("the board's house switch, flipped while the owner is deciding, holds the ticket (single and batched)", { timeout: 60_000 }, async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  let stub = stubClaude([gateReply('approve', 'fine')], { sleep: '1' });
  try {
    // Eligible only through the house default: no playbook, no per-ticket gate.
    store.setDefaultGate('owner');
    const solo = parked(store, { playbook: null as never });
    await sched.tick(); // the sweep asks the owner
    await new Promise((r) => setTimeout(r, 300));
    store.setDefaultGate(null); // the operator takes the gate back mid-call
    await settle(sched, () => gateEvents(store, solo.task.id).length > 0);
    assert.equal(stub.count(), 1);
    assert.equal(store.getTask(solo.task.id)!.status, 'awaiting-approval', 'not approved after the switch');
    assert.equal(store.gateDecision(solo.task.id), null);
    cleanup([stub.dir]);

    // The same for a batched call: two tickets under one epic.
    store.setDefaultGate('owner');
    const epic = store.addTask({ title: 'ship', prompt: 'ship it', runner: 'echo', isEpic: true });
    const pair = [0, 1].map((i) => parked(store, { playbook: null as never, parentId: epic.id, title: `ticket ${i}` }).task);
    stub = stubClaude([batchReply(pair.map((t) => ({ id: t.id, decision: 'approve', rationale: 'fine' })))], { sleep: '1' });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 300));
    store.setDefaultGate(null);
    await settle(sched, () => pair.every((t) => gateEvents(store, t.id).length > 0));
    assert.equal(stub.count(), 1, 'one batched call');
    for (const t of pair) assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
  } finally {
    await sched.stop();
    store.close();
    cleanup([stub.dir]);
  }
});

test('approval holds dependents until the merge has settled, even against a tick that lands right after decide', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  try {
    const dep = parked(store);
    const child = store.addTask({ title: 'next', prompt: 'build on it', runner: 'echo', deps: [dep.task.id] });
    // Simulate the scheduler tick that runs while mergeApproved is awaited.
    const decide = store.decide.bind(store);
    let duringMerge: string | null = null;
    store.decide = ((...args: Parameters<Store['decide']>) => {
      const out = decide(...args);
      store.reconcileBlocked();
      duringMerge = store.getTask(child.id)!.status;
      return out;
    }) as Store['decide'];
    await applyApproval(store, dep.task.id, {});
    assert.equal(duringMerge, 'blocked', 'released before its dependency landed, it is cut from a stale HEAD');
    store.reconcileBlocked();
    assert.equal(store.getTask(child.id)!.status, 'queued', 'and released once the merge settled');
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

/** A dropped-issue warning on the ticket's latest run, the way crewReview records one. */
function drop(store: Store, task: Task, title: string, why: string): void {
  store.record({ taskId: task.id, runId: store.latestRun(task.id)!.id, type: 'warning', stage: 'verify', message: `${DROPPED_ISSUE_PREFIX} [normal] ${title} (${why})\nbody of ${title}` });
}

test('unfiled review issues (depth or epic cap) hold the ticket for a person; a duplicate-only drop does not', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  const store = new Store(':memory:');
  try {
    const deep = parked(store, { title: 'deep' }).task;
    drop(store, deep, 'folder changes apply out of order', '3 parents deep, max 3');
    const capped = parked(store, { title: 'capped' }).task;
    drop(store, capped, 'rename helper', 'epic already carries 8 review-filed tickets');
    const dup = parked(store, { title: 'dup' }).task;
    drop(store, dup, 'same defect again', 'duplicate of t_abc');

    assert.equal(await ownerGate({ task: store.getTask(deep.id)!, run: store.latestRun(deep.id), store }), 'hold');
    assert.equal(await ownerGate({ task: store.getTask(capped.id)!, run: store.latestRun(capped.id), store }), 'hold');
    assert.match(gateEvents(store, deep.id).join('\n'), /hard-human: review issues could not be filed \(epic depth\/cap\) — a person decides/);
    assert.equal(stub.count(), 0, 'no owner call for a ticket a person must decide');
    assert.equal(await ownerGate({ task: store.getTask(dup.id)!, run: store.latestRun(dup.id), store }), 'approved');
    assert.equal(store.getTask(dup.id)!.status, 'done', 'a duplicate of an open ticket is not a reason to hold');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the batch gate holds a ticket with unfiled review issues for a person too', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  const { tasks } = parkedEpic(store, 3);
  const [deep, b, c] = tasks as [Task, Task, Task];
  drop(store, deep, 'folder changes apply out of order', '3 parents deep, max 3');
  const stub = stubClaude([batchReply([
    { id: deep.id, decision: 'approve', rationale: 'never asked' },
    { id: b.id, decision: 'approve', rationale: 'B is in scope' },
    { id: c.id, decision: 'approve', rationale: 'C is in scope' },
  ])]);
  try {
    const out = await ownerGateBatch({ items: batchItems(store, tasks), store });
    assert.equal(out.get(deep.id), 'hold');
    assert.ok(!stub.prompt(0).includes(deep.id), 'never shown to the owner');
    assert.equal(store.getTask(deep.id)!.status, 'awaiting-approval');
    assert.equal(store.getTask(b.id)!.status, 'done');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------- work that lands in a repo (FA2)

const NO_OPT_IN = /work that lands in a repo is approved by a person unless the ticket or its playbook opted in/;

const diffOf = (...files: string[]): string =>
  files.map((f) => [`diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1,2 @@', ' base', '+more'].join('\n')).join('\n');

/**
 * A code ticket parked green on a repo it will merge into, with the diff its
 * run recorded (`files: null` records none). The owner stub in these tests
 * answers `hold`, so "the model was asked" is read off the stub's call count
 * and nothing tries to merge a branch the fixture never cut.
 */
function landing(
  store: Store,
  repo: string,
  over: Partial<NewTask> = {},
  opts: { files?: string[] | null; testsPassed?: boolean | null } = {},
): { task: Task; run: Run } {
  const { task, run } = parked(store, { repo, playbook: null as never, ...over }, { testsPassed: opts.testsPassed });
  if (opts.files !== null) {
    const diffPath = path.join(repo, `.${run.id}.diff`);
    fs.writeFileSync(diffPath, diffOf(...(opts.files ?? ['docs/a.md'])));
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: 'diff' });
  }
  return { task, run };
}

/** The owner gate's outcome for one parked ticket: the decision, whether the model was asked, and the line it logged. */
async function gated(store: Store, item: { task: Task; run: Run }): Promise<{ decision: string; asked: boolean; line: string }> {
  const stub = stubClaude([gateReply('hold', 'the owner was asked')]);
  try {
    const decision = await ownerGate({ ...item, store });
    return { decision, asked: stub.count() === 1, line: gateEvents(store, item.task.id).join('\n') };
  } finally {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
}

test('a repo ticket with no playbook and no --gate is not the owner model\'s on the house default alone', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    store.setDefaultGate('owner');
    const item = landing(store, repo);
    assert.equal(item.task.mergeOnApprove, true, 'precondition: a code ticket merges on approval');
    assert.equal(gateOptIn(item.task, store.defaultGate()), true, 'precondition: the sweep would hand it to the owner');

    const out = await gated(store, item);
    assert.equal(out.decision, 'hold');
    assert.equal(out.asked, false, 'the owner model is never called');
    assert.match(out.line, /^owner-gate: hold — hard-human: /);
    assert.match(out.line, NO_OPT_IN);
    assert.equal(store.getTask(item.task.id)!.status, 'awaiting-approval');
    assert.match(hardHumanReason(item.task, item.run, reviewHolds(store, item.task.id)) ?? '', NO_OPT_IN);

    // A ticket marked for the human has not opted in, whatever its playbook says.
    const optedOut = landing(store, repo, { playbook: 'auto', gate: 'human' });
    assert.match(hardHumanReason(optedOut.task, optedOut.run, reviewHolds(store, optedOut.task.id)) ?? '', NO_OPT_IN);
    // A human-gated playbook is no opt-in either.
    const manual = await gated(store, landing(store, repo, { playbook: 'manual' }));
    assert.deepEqual([manual.decision, manual.asked], ['hold', false]);
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('a repo ticket that opted in, by --gate owner or by its playbook, still reaches the owner model', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO, 'manual.md': MANUAL });
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    store.setDefaultGate('owner');
    for (const over of [{ gate: 'owner' }, { playbook: 'auto' }, { playbook: 'manual', gate: 'owner' }] as Array<Partial<NewTask>>) {
      const item = landing(store, repo, over);
      assert.equal(hardHumanReason(item.task, item.run, reviewHolds(store, item.task.id)), null, JSON.stringify(over));
      const out = await gated(store, item);
      assert.equal(out.asked, true, `${JSON.stringify(over)} is the owner's to decide`);
      assert.equal(out.line, 'owner-gate: hold — the owner was asked');
    }
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('an opted-in landing with no passing test run is held for a person', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    const out = await gated(store, landing(store, repo, { gate: 'owner' }, { testsPassed: null }));
    assert.equal(out.decision, 'hold');
    assert.equal(out.asked, false);
    assert.match(out.line, /hard-human: no test run passed for this work/);
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('an opted-in landing with no diff, or an empty one, is held for a person', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    for (const files of [null, []]) {
      const item = landing(store, repo, { gate: 'owner' }, { files });
      assert.deepEqual(reviewHolds(store, item.task.id).changed, files, 'null without an artifact, empty for an empty one');
      const out = await gated(store, item);
      assert.equal(out.decision, 'hold');
      assert.equal(out.asked, false);
      assert.match(out.line, /hard-human: the run produced no diff to sign off/);
    }
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('an opted-in landing whose diff touches a human-only path is held, naming the path', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    const script = await gated(store, landing(store, repo, { gate: 'owner' }, { files: ['docs/a.md', 'scripts/build.sh'] }));
    assert.equal(script.decision, 'hold');
    assert.equal(script.asked, false);
    assert.match(script.line, /hard-human: the diff touches scripts\/build\.sh, which a person approves/);

    const docs = await gated(store, landing(store, repo, { gate: 'owner' }, { files: ['docs/a.md'] }));
    assert.equal(docs.asked, true, 'a docs-only diff is still the owner\'s to decide');
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('the human-only paths: manifests, shell, scripts, CI, git plumbing and anything named for a security boundary', () => {
  const held = [
    'package.json', 'packages/app/package.json', 'package-lock.json', 'run.sh', 'tools/dev/run.sh', 'scripts/a.mjs',
    'pkg/scripts/a.mjs', '.github/workflows/ci.yml', 'Makefile', 'native/Makefile', '.gitattributes', '.gitmodules',
    'src/security/guard.ts', 'src/auth.ts', 'src/Authz/roles.ts', 'lib/trustStore.ts', 'src/sandbox/jail.ts', 'crypto-utils/a.ts',
  ];
  for (const p of held) assert.equal(humanOnlyPath(['docs/a.md', p]), p, `${p} is a person's`);
  const free = ['docs/a.md', 'src/app.ts', 'src/package.json.ts', 'src/description.ts', 'test/oauth.test.ts', 'src/shell.ts', 'README.md'];
  assert.equal(humanOnlyPath(free), null, 'ordinary source and docs stay the owner\'s');
});

test('gate.humanPaths adds per-repo prefixes; a bad value adds nothing and never removes a built-in', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const other = fixtureRepo();
  const store = new Store(':memory:');
  try {
    const item = landing(store, repo, { gate: 'owner' }, { files: ['src/main/ipc.ts'] });
    const builtin = landing(store, repo, { gate: 'owner' }, { files: ['package.json'] });
    const reason = (it: { task: Task; run: Run }): string | null => hardHumanReason(it.task, it.run, reviewHolds(store, it.task.id));
    assert.equal(reason(item), null, 'precondition: not human-only until the repo says so');

    for (const bad of ['not json', '[]', '"src/"', JSON.stringify({ [repo]: 'src/' }), JSON.stringify({ [repo]: [7, '', null] })]) {
      store.setSetting('gate.humanPaths', bad);
      assert.equal(reason(item), null, `${bad} adds nothing`);
      assert.match(reason(builtin) ?? '', /the diff touches package\.json/, `${bad} removes no built-in`);
    }

    store.setSetting('gate.humanPaths', JSON.stringify({ [other]: ['src/main/'] }));
    assert.equal(reason(item), null, 'another repo\'s prefixes are not this repo\'s');

    store.setSetting('gate.humanPaths', JSON.stringify({ [repo]: ['src/main/'] }));
    assert.match(reason(item) ?? '', /the diff touches src\/main\/ipc\.ts, which a person approves/);
    assert.match(reason(builtin) ?? '', /the diff touches package\.json/);
    const out = await gated(store, item);
    assert.deepEqual([out.decision, out.asked], ['hold', false]);
  } finally {
    store.close();
    cleanup([pbDir, repo, other]);
  }
});

test('work that lands nowhere is gated exactly as before: no test run and no diff do not hold it', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    // A publishing ticket: it has a repo, but approving it merges nothing.
    const publish = landing(store, repo, { kind: 'writing', mergeOnApprove: false, gate: 'owner' }, { files: null, testsPassed: null });
    assert.equal(reviewHolds(store, publish.task.id).landing, false);
    assert.equal((await gated(store, publish)).asked, true);

    // No repo at all, and only the house default saying 'owner'.
    store.setDefaultGate('owner');
    const loose = parked(store, { playbook: null as never }, { testsPassed: null });
    assert.equal(reviewHolds(store, loose.task.id).landing, false);
    assert.equal((await gated(store, loose)).asked, true, 'the house default still decides work that lands nowhere');
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('the batch gate leaves a landing ticket out for the same reasons the single gate holds it', async () => {
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const epic = store.addTask({ title: 'ship', prompt: 'ship it', runner: 'echo', isEpic: true });
  const child = (over: Partial<NewTask>, files: string[]): Task =>
    landing(store, repo, { parentId: epic.id, ...over }, { files }).task;
  const bare = child({}, ['docs/a.md']);
  const manifest = child({ gate: 'owner' }, ['package.json']);
  const b = child({ gate: 'owner' }, ['docs/b.md']);
  const c = child({ playbook: 'auto' }, ['docs/c.md']);
  const stub = stubClaude([batchReply([bare, manifest, b, c].map((t) => ({ id: t.id, decision: 'hold', rationale: 'asked' })))]);
  try {
    store.setDefaultGate('owner');
    const out = await ownerGateBatch({ items: batchItems(store, [bare, manifest, b, c]), store });
    assert.equal(stub.count(), 1, 'one call, for the two that opted in');
    const prompt = stub.prompt(0);
    assert.ok(!prompt.includes(bare.id) && !prompt.includes(manifest.id), 'neither held ticket is shown to the owner');
    assert.ok(prompt.includes(b.id) && prompt.includes(c.id));
    assert.equal(out.get(bare.id), 'hold');
    assert.match(gateEvents(store, bare.id).join('\n'), NO_OPT_IN);
    assert.match(gateEvents(store, manifest.id).join('\n'), /the diff touches package\.json/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('the scheduler parks a playbook-less repo ticket for a person under a house default of owner, and merges nothing', async () => {
  // The shape that was merged 15 seconds after it parked: queued with no
  // playbook and no --gate, tests green, crew pass, house gate set to owner.
  const pbDir = withPlaybooks({});
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    store.setDefaultGate('owner');
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'house-gated\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, testCmd: 'grep -q house-gated README.md',
    });
    await settle(sched, () => gateEvents(store, t.id).length > 0);

    assert.equal(store.latestRun(t.id)!.testsPassed, true, 'precondition: the tests ran and passed');
    assert.match(gateEvents(store, t.id).join('\n'), NO_OPT_IN);
    assert.equal(stub.count(), 0, 'the owner model was never asked');
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /house-gated/, 'nothing landed');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

// ---- tests the fix list asks for (reviewer prototypes) ----
import { quotedPathsInDiff } from '../src/gate.ts';

test('FIX1: a human-only path git had to quote in the patch header is still held', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    // What `git diff` prints for .github/workflows/dé.yml, scripts/a<TAB>b.sh and a rename to a quoted name.
    const body = [
      'diff --git a/docs/a.md b/docs/a.md', '--- a/docs/a.md', '+++ b/docs/a.md', '@@ -1 +1,2 @@', ' base', '+more',
      'diff --git "a/.github/workflows/d\\303\\251.yml" "b/.github/workflows/d\\303\\251.yml"', 'new file mode 100644',
      '--- /dev/null', '+++ "b/.github/workflows/d\\303\\251.yml"', '@@ -0,0 +1 @@', '+on: push',
    ].join('\n');
    assert.deepEqual(quotedPathsInDiff(body), ['.github/workflows/dé.yml']);
    assert.deepEqual(quotedPathsInDiff('+++ "b/scripts/a\\tb.sh"\nrename to "auth/\\"x\\".ts"'), ['scripts/a\tb.sh', 'auth/"x".ts']);
    const item = parked(store, { repo, playbook: null as never, gate: 'owner' });
    const diffPath = path.join(repo, `.${item.run.id}.diff`);
    fs.writeFileSync(diffPath, body);
    store.addArtifact({ runId: item.run.id, taskId: item.task.id, type: 'diff', path: diffPath, summary: 'diff' });
    assert.match(hardHumanReason(item.task, item.run, reviewHolds(store, item.task.id)) ?? '', /the diff touches \.github\/workflows\/dé\.yml, which a person approves/);
    // An entry named exactly `scripts` or `.github` (a symlink standing in for the directory).
    assert.equal(humanOnlyPath(['docs/a.md', 'pkg/scripts']), 'pkg/scripts');
    assert.equal(humanOnlyPath(['.github']), '.github');
    assert.equal(humanOnlyPath(['src/scripts.ts', 'docs/scriptsmanual.md']), null);
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

test('FIX3: the diff read is the LATEST run\'s; an earlier run\'s artifact, or one that cannot be read, is no diff', () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    const item = parked(store, { repo, playbook: null as never, gate: 'owner' });
    const diffPath = path.join(repo, `.${item.run.id}.diff`);
    fs.writeFileSync(diffPath, 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n');
    store.addArtifact({ runId: item.run.id, taskId: item.task.id, type: 'diff', path: diffPath, summary: 'diff' });
    assert.deepEqual(reviewHolds(store, item.task.id).changed, ['docs/a.md']);
    // unreadable: the path is now a directory
    fs.rmSync(diffPath); fs.mkdirSync(diffPath);
    assert.equal(reviewHolds(store, item.task.id).changed, null);
    assert.match(hardHumanReason(item.task, item.run, reviewHolds(store, item.task.id)) ?? '', /no diff to sign off/);
    fs.rmSync(diffPath, { recursive: true }); fs.writeFileSync(diffPath, 'diff --git a/docs/a.md b/docs/a.md\n');
    // a second run that recorded nothing
    const r2 = store.startRun(item.task.id);
    store.setTestsPassed(r2.id, true);
    store.addVerdict({ runId: r2.id, taskId: item.task.id, verdict: 'pass', disagreement: false, council: [] });
    store.endRun(r2.id, 'succeeded', { exitCode: 0, summary: 's' });
    store.setStatus(item.task.id, 'awaiting-approval');
    assert.equal(reviewHolds(store, item.task.id).changed, null, 'run 1\'s diff is not run 2\'s');
    assert.match(hardHumanReason(store.getTask(item.task.id)!, store.latestRun(item.task.id), reviewHolds(store, item.task.id)) ?? '', /no diff to sign off/);
  } finally {
    store.close();
    cleanup([pbDir, repo]);
  }
});

// ------------------------------------------------ FA2 review, round 2

test('FIX4: a name the filesystem folds onto a human-only one is held, and so is every name outside plain ASCII', () => {
  // KELVIN SIGN, LONG S and the fi/st ligatures: a case-insensitive APFS volume opens each as the ASCII name.
  for (const p of ['pac\u212Aage.json', 'tools/pac\u212Aage-lock.json', '\u017Fcripts/check.js', 'Ma\u212Ae\uFB01le', 'src/tru\uFB06/keys.ts', '.gitattribute\u017F', 'run.\u017Fh', 'scr\u200Bipts/x.js']) {
    assert.equal(humanOnlyPath([p]), p, `${JSON.stringify(p)} resolves to a human-only path on disk`);
  }
  // No look-alike list is complete, so any name outside printable ASCII is a person's: accents, Cyrillic, control bytes, DEL.
  for (const p of ['docs/cap\u00EDtulo.md', '\u0455cripts/x.js', 'docs/\u212Aelvin.md', 'docs/a\tb.md', 'docs/a\u007Fb.md', 'docs/\u{1F600}.md']) {
    assert.equal(humanOnlyPath([p]), p, `${JSON.stringify(p)} is outside plain ASCII`);
  }
  for (const p of ['docs/chapter one.md', 'src/app.ts', 'docs/a~b (1).md']) {
    assert.equal(humanOnlyPath([p]), null, `${JSON.stringify(p)} is plain ASCII and nobody's human-only path`);
  }
  assert.equal(humanOnlyPath(['\u017Fecrets/key.txt'], ['secrets/']), '\u017Fecrets/key.txt', 'the repo\'s own prefixes are folded the same way');
});

test('FIX5: a diff artifact that is not git\'s plain patch (colour forced through the repo config) is no diff', () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  const record = (text: string): { task: Task; run: Run } => {
    const item = parked(store, { repo, playbook: null as never, gate: 'owner' });
    const diffPath = path.join(os.tmpdir(), `fa2-${item.run.id}.diff`);
    fs.writeFileSync(diffPath, text);
    store.addArtifact({ runId: item.run.id, taskId: item.task.id, type: 'diff', path: diffPath, summary: 'diff' });
    made.push(diffPath);
    return item;
  };
  const made: string[] = [];
  try {
    const base = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"test":"true"}}\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), '++ b/docs/ok.md\n');
    git('add', '-A', '-N');
    const diffJail = (): string => git('diff', '--no-ext-diff', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', base);

    const plain = record(diffJail());
    assert.match(hardHumanReason(plain.task, plain.run, reviewHolds(store, plain.task.id)) ?? '', /the diff touches package\.json/, 'control: the plain patch names it');

    git('config', 'color.ui', 'always');
    const variants: Record<string, string[][]> = {
      // The one that reads as a harmless diff: the only header left is the forged one.
      'new=normal: an added line prints as a +++ header': [['color.diff.new', 'normal'], ['diff.wsErrorHighlight', 'none']],
      'default colours: no header is readable': [['color.diff.new', 'green'], ['diff.wsErrorHighlight', 'default']],
      'meta=normal: the b/ side of every header gains a trailing escape': [['color.diff.meta', 'normal']],
      // No line STARTS with an escape here; every header only ends in one.
      'every slot normal: each header ends in a reset and nothing else is coloured': ['context', 'meta', 'frag', 'func', 'old', 'new', 'commit', 'whitespace'].map((s) => [`color.diff.${s}`, 'normal']),
    };
    for (const [label, cfg] of Object.entries(variants)) {
      for (const c of cfg) git('config', ...c);
      const text = diffJail();
      assert.ok(text.includes('\x1b['), `fixture: ${label} is coloured`);
      const item = record(text);
      // Held, and never on a path read out of the escapes (the third variant reads `docs/ok.md\x1b[m` and nothing else).
      assert.match(hardHumanReason(item.task, item.run, reviewHolds(store, item.task.id)) ?? '', /no diff to sign off/, label);
      assert.equal(reviewHolds(store, item.task.id).changed, null, label);
    }

    // An escape inside file CONTENT is still a plain patch: it sits behind the + sign.
    const content = record('diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+\x1b[31mred\x1b[m\n');
    assert.deepEqual(reviewHolds(store, content.task.id).changed, ['docs/a.md']);

    // A header line too long to be one is refused, and quickly: the header patterns are quadratic on it.
    const long = record(`diff --git a/docs/a.md b/docs/a.md\n--- "${'\\"'.repeat(60_000)}\n`);
    const t0 = Date.now();
    assert.equal(reviewHolds(store, long.task.id).changed, null);
    assert.ok(Date.now() - t0 < 2_000, `read in ${Date.now() - t0}ms`);
  } finally {
    store.close();
    for (const p of made) fs.rmSync(p, { force: true });
    cleanup([pbDir, repo]);
  }
});

test('FIX6: a header the path patterns cannot read (U+2028/U+2029 printed bare under core.quotePath=false) is no diff', () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  const made: string[] = [];
  const record = (text: string): { task: Task; run: Run } => {
    const item = parked(store, { repo, playbook: null as never, gate: 'owner' });
    const diffPath = path.join(os.tmpdir(), `fa2-${item.run.id}.diff`);
    fs.writeFileSync(diffPath, text);
    store.addArtifact({ runId: item.run.id, taskId: item.task.id, type: 'diff', path: diffPath, summary: 'diff' });
    made.push(diffPath);
    return item;
  };
  try {
    const base = git('rev-parse', 'HEAD').trim();
    const diffJail = (): string => git('diff', '--no-ext-diff', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', base);
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs/ok.md'), 'ok\n');
    git('config', 'core.quotePath', 'false');
    for (const sep of [' ', ' ']) {
      for (const rel of [`.github/workflows/ci${sep}x.yml`, `scripts/post${sep}install.sh`, `pkg${sep}/package.json`]) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), 'on: push\n');
        git('add', '-A', '-N');
        const text = diffJail();
        assert.ok(text.includes(`diff --git a/${rel} b/${rel}`), `fixture: git printed ${JSON.stringify(rel)} bare`);
        const item = record(text);
        const holds = reviewHolds(store, item.task.id);
        assert.notDeepEqual(holds.changed, ['docs/ok.md'], `${JSON.stringify(rel)} is in the diff and not in the paths read from it`);
        assert.match(hardHumanReason(item.task, item.run, holds) ?? '', /no diff to sign off|which a person approves/, JSON.stringify(rel));
        fs.rmSync(path.join(repo, rel.split('/')[0]!), { recursive: true, force: true });
      }
    }
    // The same characters in file CONTENT are still a plain patch.
    const content = record('diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+one two\n');
    assert.deepEqual(reviewHolds(store, content.task.id).changed, ['docs/a.md']);
  } finally {
    store.close();
    for (const p of made) fs.rmSync(p, { force: true });
    cleanup([pbDir, repo]);
  }
});

// ------------------------------------- the owner lands the reviewed tree (FA1)
import { config } from '../src/config.ts';

/** A scheduler whose tickets park green, and one shell ticket run to the gate by it. */
function reviewingSched(store: Store): Scheduler {
  return new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
}

async function runToGate(store: Store, sched: Scheduler, repo: string, over: Partial<NewTask>): Promise<{ task: Task; run: Run }> {
  const t = store.addTask({ title: 'touch a file', prompt: "printf 'gated\\n' >> README.md", kind: 'code', runner: 'shell', repo, testCmd: 'grep -q gated README.md', ...over });
  await settle(sched, () => ['awaiting-approval', 'done', 'failed'].includes(store.getTask(t.id)!.status) && !sched.activeCount);
  return { task: store.getTask(t.id)!, run: store.latestRun(t.id)! };
}

const headOf = (repo: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

test('the owner gate does not land work that changed after its review: a file the test run wrote holds it for a person, unasked', async () => {
  const pbDir = withPlaybooks({});
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = reviewingSched(store);
  try {
    const head = headOf(repo);
    // The diff the owner would read is README.md alone; the test run then writes a file nobody is shown.
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'gated\\n' >> README.md", kind: 'code', runner: 'shell', repo, gate: 'owner',
      testCmd: "grep -q gated README.md && printf 'late\\n' > late.txt",
    });
    await settle(sched, () => gateEvents(store, t.id).length > 0);

    assert.match(gateEvents(store, t.id).join('\n'), /^owner-gate: hold — work changed after review: late\.txt \(added since review\)/);
    assert.equal(stub.count(), 0, 'the owner model is not asked about a diff that is not what would land');
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.equal(headOf(repo), head, 'nothing merged');
    assert.equal(fs.existsSync(path.join(repo, 'late.txt')), false);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('a file written while the owner is deciding is not landed on its approval: the ticket is held for a person', async () => {
  const pbDir = withPlaybooks({});
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  // The stand-in writes into every jail before it answers: the work changes after the owner was asked.
  const bin = path.join(stub.dir, 'claude');
  fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace('#!/bin/sh\n', `#!/bin/sh\nfor d in "${config.workRoot}"/*/; do printf 'late\\n' > "$d/late.txt"; done\n`));
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = reviewingSched(store);
  try {
    const head = headOf(repo);
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'gated\\n' >> README.md", kind: 'code', runner: 'shell', repo, gate: 'owner',
      testCmd: 'grep -q gated README.md',
    });
    await settle(sched, () => gateEvents(store, t.id).length > 0);

    assert.equal(stub.count(), 1, 'precondition: the owner was asked, and approved');
    assert.match(gateEvents(store, t.id).join('\n'), /^owner-gate: hold — work changed after review: late\.txt \(added since review\)/);
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.equal(headOf(repo), head, 'nothing merged');
    const row = store.db.prepare('SELECT decision FROM runs WHERE id = ?').get(store.latestRun(t.id)!.id) as Record<string, unknown>;
    assert.equal(row['decision'] ?? null, null, 'no owner approval is recorded for work that did not land');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('the owner gate holds a run with no reviewed tree for a person, whose approval lands it with a note', async () => {
  const pbDir = withPlaybooks({});
  const stub = stubClaude([gateReply('approve', 'green and in scope')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = reviewingSched(store);
  try {
    const head = headOf(repo);
    // Parked for a person, then handed to the owner: as a ticket parked before trees were recorded would be.
    const { task, run } = await runToGate(store, sched, repo, { gate: 'human' });
    assert.equal(task.status, 'awaiting-approval', task.error ?? '');
    store.setRunMeta(run.id, { reviewedTree: null });
    store.gateWaiting('owner');
    const item = { task: store.getTask(task.id)!, run: store.getRun(run.id)! };
    assert.equal(hardHumanReason(item.task, item.run, reviewHolds(store, task.id)), null, 'precondition: nothing else holds it');

    assert.equal(await ownerGate({ ...item, store }), 'hold');
    assert.match(gateEvents(store, task.id).join('\n'), /^owner-gate: hold — no reviewed tree was recorded for this run \(parked before this check existed\), so the owner gate does not land it: a person approves it/);
    assert.equal(stub.count(), 0);
    assert.equal(headOf(repo), head);
    // Not through the approve path either, whoever calls it in the owner's name.
    const forced = await applyApproval(store, task.id, { source: 'owner-gate' });
    assert.equal(forced.merge.merged, false);
    assert.equal(store.getTask(task.id)!.status, 'awaiting-approval');
    assert.equal(headOf(repo), head);

    const person = await applyApproval(store, task.id, {});
    assert.equal(person.merge.merged, true, person.merge.reason);
    assert.equal(store.getTask(task.id)!.status, 'done');
    assert.ok(events(store, task.id).includes("no reviewed tree recorded for this run (parked before this check existed); landed on a person's approval"));
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('the batch gate drops a ticket whose work changed after review, and lands the rest', async () => {
  const pbDir = withPlaybooks({});
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = reviewingSched(store);
  let stub: Stub | null = null;
  try {
    const parkedOnes: Array<{ task: Task; run: Run }> = [];
    for (const name of ['one', 'two', 'three']) {
      parkedOnes.push(await runToGate(store, sched, repo, { gate: 'human', prompt: `printf '${name}\\n' > ${name}.txt`, testCmd: `test -f ${name}.txt` }));
    }
    for (const it of parkedOnes) assert.equal(it.task.status, 'awaiting-approval', it.task.error ?? '');
    store.gateWaiting('owner');
    const items = parkedOnes.map((it) => ({ task: store.getTask(it.task.id)!, run: store.getRun(it.run.id)! }));
    fs.writeFileSync(path.join(items[1]!.run.worktreePath!, 'late.txt'), 'late\n');
    stub = stubClaude([batchReply(items.map((it) => ({ id: it.task.id, decision: 'approve', rationale: 'fine' })))]);

    const out = await ownerGateBatch({ items, store });
    assert.deepEqual(items.map((it) => out.get(it.task.id)), ['approved', 'hold', 'approved']);
    assert.equal(stub.count(), 1);
    assert.equal(stub.prompt(0).includes(items[1]!.task.id), false, 'the changed ticket was never put to the owner');
    assert.match(gateEvents(store, items[1]!.task.id).join('\n'), /^owner-gate: hold — work changed after review: late\.txt/);
    assert.equal(store.getTask(items[1]!.task.id)!.status, 'awaiting-approval');
    assert.deepEqual(['one.txt', 'two.txt', 'three.txt', 'late.txt'].map((f) => fs.existsSync(path.join(repo, f))), [true, false, true, false]);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, repo, ...(stub ? [stub.dir] : [])]);
  }
});

// ------------------------------------------------------------------ review-inputs r2: the report the owner model reads

test('the owner gate, alone and in a batch, reads the run\'s stored report: its end is in the prompt', async () => {
  const { storeReport } = await import('../src/verify/report.ts');
  const pbDir = withPlaybooks({ 'auto.md': AUTO });
  const store = new Store(':memory:');
  // The run row keeps a short copy ("added the middleware"); the whole report is the stored artifact.
  const report = `DONE: the middleware.\n${Array.from({ length: 400 }, (_, i) => `claim ${i}: src/f${i}.ts`).join('\n')}\n\nACCEPTANCE MAP\n1. test/auth.test.ts :: a request without a token gets 401\nKNOWN GAPS: the rate limit is not covered`;
  const solo = parked(store, { gate: 'owner' });
  storeReport(store, solo.run.id, solo.task.id, report);
  const { tasks } = parkedEpic(store, 2, [{ gate: 'owner' }, { gate: 'owner' }]);
  for (const t of tasks) storeReport(store, store.latestRun(t.id)!.id, t.id, report);
  const stub = stubClaude([gateReply('approve', 'in scope'), batchReply(tasks.map((t) => ({ id: t.id, decision: 'approve', rationale: 'in scope' })))]);
  try {
    await ownerGate({ ...solo, store });
    await ownerGateBatch({ items: batchItems(store, tasks), store });
    assert.equal(stub.count(), 2);
    for (const [i, times] of [[0, 1], [1, 2]] as const) {
      const prompt = stub.prompt(i);
      assert.equal(prompt.split('ACCEPTANCE MAP\n1. test/auth.test.ts :: a request without a token gets 401\nKNOWN GAPS: the rate limit is not covered').length - 1, times, `call ${i}: the end of the report`);
      assert.match(prompt, /WHAT THE WORKER REPORTED:\nDONE: the middleware\.\nclaim 0: src\/f0\.ts/);
      assert.match(prompt, /\[FOREMAN cut \d+ characters from the middle of this report here; the acceptance map at its end is kept\]/);
      assert.doesNotMatch(prompt, /WHAT THE WORKER REPORTED:\nadded the middleware/);
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

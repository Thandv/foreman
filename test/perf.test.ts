import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { claudeCodeRunner, resetPreflightCache } from '../src/runners/cliRunners.ts';
import { crewReview } from '../src/verify/crewReview.ts';
import { probeTask } from '../src/types.ts';
import type { Task } from '../src/types.ts';

// --------------------------------------------------------------- fixtures

function scratch(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `foreman-perf-${tag}-`));
}

/** A `claude` stand-in that records every invocation, so execs can be counted. */
function countingBin(dir: string, name: string, body: string): { bin: string; calls: () => number } {
  const bin = path.join(dir, name);
  const log = path.join(dir, `${name}.calls`);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf 'x\\n' >> "${log}"\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
  };
}

// ------------------------------------------------------ preflight memoization

test('preflight execs <bin> --version once per binary, not once per task run', async () => {
  const dir = scratch('preflight');
  const { bin, calls } = countingBin(dir, 'claude', `printf '1.2.3\\n'\nexit 0`);
  const before = process.env['FOREMAN_CLAUDE_BIN'];
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  resetPreflightCache();
  try {
    const task = probeTask({ runner: 'claude-code' });
    assert.equal(await claudeCodeRunner.preflight(task), null);
    assert.equal(calls(), 1, 'the first task proves the CLI is there');

    assert.equal(await claudeCodeRunner.preflight(task), null);
    assert.equal(await claudeCodeRunner.preflight(task), null);
    assert.equal(calls(), 1, 'every later task reads the memo instead of spawning');

    // The memo is keyed on the binary PATH, so pointing at a different one is
    // a different question and is asked again.
    const other = countingBin(dir, 'claude2', `printf '1.2.3\\n'\nexit 0`);
    process.env['FOREMAN_CLAUDE_BIN'] = other.bin;
    assert.equal(await claudeCodeRunner.preflight(task), null);
    assert.equal(other.calls(), 1);
    assert.equal(calls(), 1, 'the first binary was not re-probed');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
    else process.env['FOREMAN_CLAUDE_BIN'] = before;
    resetPreflightCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a preflight FAILURE is never cached: installing the CLI mid-session recovers at once', async () => {
  const dir = scratch('preflight-fail');
  const bin = path.join(dir, 'claude');
  const before = process.env['FOREMAN_CLAUDE_BIN'];
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  resetPreflightCache();
  try {
    const task = probeTask({ runner: 'claude-code' });
    assert.match((await claudeCodeRunner.preflight(task)) ?? '', /not runnable/);
    assert.match((await claudeCodeRunner.preflight(task)) ?? '', /not runnable/, 'still failing, still asked');

    // The operator installs it while the daemon is up.
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '1.2.3\\n'\n`);
    fs.chmodSync(bin, 0o755);
    assert.equal(await claudeCodeRunner.preflight(task), null, 'the very next task picks it up');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
    else process.env['FOREMAN_CLAUDE_BIN'] = before;
    resetPreflightCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S2 is still refused before the memo is ever consulted', async () => {
  const dir = scratch('preflight-s2');
  const { bin, calls } = countingBin(dir, 'claude', `printf '1.2.3\\n'\nexit 0`);
  const before = process.env['FOREMAN_CLAUDE_BIN'];
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  resetPreflightCache();
  try {
    const blocked = await claudeCodeRunner.preflight(probeTask({ runner: 'claude-code', sensitivity: 'S2' }));
    assert.match(blocked ?? '', /S2 task cannot use claude-code/);
    assert.equal(calls(), 0, 'a refused task spawns nothing, memo or no memo');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
    else process.env['FOREMAN_CLAUDE_BIN'] = before;
    resetPreflightCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------- reviewer fan-out

const TWO_REVIEWERS = `---\n${JSON.stringify({
  id: 'pair',
  description: 'Two reviewers, no chair in the happy path.',
  triggers: ['pair'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }, { role: 'planner', style: 'devils-advocate' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, null, 2)}\n---\n
## role: planner

You chair the crew.

## role: senior

You review what you did not write.

## role: dev

You implement the ticket.
`;

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,2 +1,3 @@',
  ' export function auth(token) {',
  '+  if (!token) return null;',
  '   return verify(token);',
].join('\n');

/** ~300ms of latency per reviewer: sequential is ~600ms, concurrent is ~300ms. */
const REVIEWER_MS = 300;

test('reviewers fan out concurrently, and the persisted order is still the playbook order', async () => {
  const pbDir = scratch('pb');
  fs.writeFileSync(path.join(pbDir, 'pair.md'), TWO_REVIEWERS);
  const binDir = scratch('slow-cli');
  const bin = path.join(binDir, 'claude');
  const windowFile = path.join(binDir, 'windows');
  // The reply names the style that asked for it, so the aggregation can be
  // checked against the reviewer that produced it rather than against a
  // settle order the test does not control.
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      // Each reviewer brackets its own run. Sequential execution can only ever
      // write start,end,start,end; an overlap writes both starts before either
      // end. That ordering is what "fan-out" means, and unlike a wall-clock
      // bound it stays true on a loaded machine (and needs no sub-second date,
      // which BSD /bin/sh does not have).
      `printf 'start\\n' >> "${windowFile}"\n` +
      `sleep ${(REVIEWER_MS / 1000).toFixed(2)}\n` +
      `printf 'end\\n' >> "${windowFile}"\n` +
      `style=other\n` +
      `for a in "$@"; do case "$a" in *"REVIEW STYLE (code-review)"*) style=code-review;; ` +
      `*"REVIEW STYLE (devils-advocate)"*) style=devils-advocate;; esac; done\n` +
      // The inner verdict is JSON *inside* a JSON string, so the quotes have to
      // survive printf as backslash-escaped: a format string carrying \" emits a
      // bare ", which makes the envelope unparseable and every reviewer read as
      // unavailable — the fixture failing, not the chain.
      `printf '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,` +
      `"result":"{\\\\"verdict\\\\":\\\\"pass\\\\",\\\\"critique\\\\":\\\\"%s said fine\\\\",\\\\"issues\\\\":[]}"}\\n' "$style"\n`,
  );
  fs.chmodSync(bin, 0o755);

  const prevPb = process.env['FOREMAN_PLAYBOOKS_DIR'];
  const prevBin = process.env['FOREMAN_CLAUDE_BIN'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const store = new Store(':memory:');
  try {
    const created = store.addTask({
      title: 'Implement token auth',
      prompt: 'Add bearer-token auth to the API.',
      kind: 'code',
      runner: 'claude-code',
      role: 'dev',
      playbook: 'pair',
      acceptance: 'requests without a token get 401',
    });
    const task = store.getTask(created.id)!;
    const runId = store.startRun(task.id).id;

    const started = Date.now();
    const notes: string[] = [];
    const out = (await crewReview({ task, runId, store, diff: DIFF, onNote: (n) => notes.push(n) }))!;
    assert.ok(out, `crew review produced nothing; notes: ${notes.join(' | ')}`);
    const elapsed = Date.now() - started;

    assert.equal(out.verdict, 'pass');
    assert.equal(out.reviews.length, 2);
    // The point of the change: the two reviewers must have been in flight at the
    // same time. Asserted from the windows they stamped themselves, so a slow or
    // loaded machine makes the test slower, never red.
    const marks = fs.readFileSync(windowFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(
      marks.filter((m) => m === 'start').length,
      2,
      `expected two reviewer spawns, saw ${marks.join(',')}`,
    );
    assert.deepEqual(
      marks.slice(0, 2),
      ['start', 'start'],
      `both reviewers must be in flight before either finishes; saw ${marks.join(',')} (${elapsed}ms total)`,
    );

    // Whatever order they answered in, the record reads in playbook order.
    assert.deepEqual(out.reviews.map((r) => r.style), ['code-review', 'devils-advocate']);
    assert.deepEqual(out.reviews.map((r) => r.role), ['senior', 'planner']);
    assert.match(out.reviews[0]!.critique, /code-review said fine/);
    assert.match(out.reviews[1]!.critique, /devils-advocate said fine/);
    assert.deepEqual(out.record.council.map((o) => o.style), ['code-review', 'devils-advocate']);
  } finally {
    store.close();
    if (prevPb === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = prevPb;
    if (prevBin === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
    else process.env['FOREMAN_CLAUDE_BIN'] = prevBin;
    fs.rmSync(pbDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('a cached reviewer costs no process at all, even inside the fan-out', async () => {
  const pbDir = scratch('pb-cache');
  fs.writeFileSync(path.join(pbDir, 'pair.md'), TWO_REVIEWERS);
  const binDir = scratch('cli-cache');
  const { bin, calls } = countingBin(
    binDir,
    'claude',
    `printf '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,` +
      `"result":"{\\\\"verdict\\\\":\\\\"pass\\\\",\\\\"critique\\\\":\\\\"fine\\\\",\\\\"issues\\\\":[]}"}\\n'`,
  );
  const prevPb = process.env['FOREMAN_PLAYBOOKS_DIR'];
  const prevBin = process.env['FOREMAN_CLAUDE_BIN'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const store = new Store(':memory:');
  try {
    const created = store.addTask({
      title: 'Implement token auth',
      prompt: 'Add bearer-token auth to the API.',
      kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'pair',
      acceptance: 'requests without a token get 401',
    });
    const task = store.getTask(created.id)!;
    const first = (await crewReview({ task, runId: store.startRun(task.id).id, store, diff: DIFF }))!;
    assert.equal(first.verdict, 'pass');
    assert.equal(calls(), 2, 'both reviewers were paid for once');

    const second = (await crewReview({ task, runId: store.startRun(task.id).id, store, diff: DIFF }))!;
    assert.equal(calls(), 2, 'the second round spawned nothing: both hits are cache lookups');
    assert.deepEqual(second.reviews.map((r) => r.cached), [true, true]);
  } finally {
    store.close();
    if (prevPb === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = prevPb;
    if (prevBin === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
    else process.env['FOREMAN_CLAUDE_BIN'] = prevBin;
    fs.rmSync(pbDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- sanity guard

test('probeTask still describes a non-crew task, so the no-role assertions mean something', () => {
  const t: Task = probeTask();
  assert.equal(t.role, null);
  assert.equal(t.playbook, null);
});

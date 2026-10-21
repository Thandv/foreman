import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { abortFor } from '../src/abort.ts';
import { droppedNote, Scheduler } from '../src/scheduler.ts';
import { OPERATOR_CHECKS, reportLine, boundBody, buildChairPrompt, buildReviewPrompt, crewAdvisories, crewLeadsVerify, crewReview, formatDroppedIssues, DROPPED_ISSUE_PREFIX, titlesSimilar } from '../src/verify/crewReview.ts';
import { verdictChain } from '../src/gate.ts';
import { tierModel } from '../src/roles.ts';
import { getPlaybook } from '../src/playbooks.ts';
import type { Task, Verdict } from '../src/types.ts';
import { HandFiredDeadline } from './fakeclock.ts';

// --------------------------------------------------------------- fixtures

const pbText = (fm: Record<string, unknown>, body: string): string =>
  `---\n${JSON.stringify(fm, null, 2)}\n---\n${body}`;

/** Two reviewers in order (code-review then devil's advocate), chair = planner. */
const SOFTWARE = pbText({
  id: 'soft',
  description: 'Software delivery, scrum-style.',
  triggers: ['code', 'bug', 'refactor', 'api'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' }, qa: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }, { role: 'planner', style: 'devils-advocate' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: ['Keep diffs minimal.'],
}, `
## pipeline

plan → implement → review

## role: planner

You decompose the ask.

## role: senior

You review what you did not write.

## role: dev

You implement the ticket.

## role: qa

You verify the claim.
`);

/** One reviewer, so single-review behaviour is asserted without chain noise. */
const SOLO = pbText({
  id: 'solo',
  description: 'One reviewer, one chair.',
  triggers: ['solo'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: [],
}, `
## role: planner

You chair the crew.

## role: senior

You review what you did not write.

## role: dev

You implement the ticket.
`);

/** The two prose/analysis styles, so every template is exercised somewhere. */
const PRESS = pbText({
  id: 'press',
  description: 'Publishing house: manuscripts and papers.',
  triggers: ['manuscript'],
  roles: { publisher: { tier: 'owner' }, editor: { tier: 'senior' }, author: { tier: 'worker' } },
  reviewers: [{ role: 'editor', style: 'editorial-letter' }, { role: 'editor', style: 'peer-review' }],
  escalation: { chair: 'publisher', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: ['Preserve the author voice.'],
}, `
## role: publisher

You gate the release.

## role: editor

You edit what you did not write.

## role: author

You write the draft.
`);

function withPlaybooks(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-pb-'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** The claude --output-format json envelope, with `result` carrying the reply text. */
const envelope = (result: string, costUsd = 0.03): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, result });

const reviewReply = (
  verdict: 'pass' | 'fail',
  critique: string,
  issues: Array<Record<string, unknown>> = [],
): string => envelope(JSON.stringify({ verdict, critique, issues }));

const chairReply = (verdict: 'pass' | 'fail', rationale: string): string =>
  envelope(JSON.stringify({ verdict, rationale }));

interface Stub {
  dir: string;
  /** Every argv the stub was invoked with, one invocation per entry. */
  invocations(): string[][];
  /** The whole prompt of invocation `i`, reassembled from its argv lines. */
  prompt(i: number): string;
  count(): number;
  /** Queue the replies for the next calls; the last one repeats. Resets the counter. */
  setBodies(bodies: string[]): void;
  /** The argv of the invocation carrying `needle` — order-free, for the fan-out. */
  argvFor(needle: string): string[];
  /** The whole prompt of the invocation carrying `needle`. */
  promptFor(needle: string): string;
}

/**
 * A stand-in for the claude CLI, extended from the crewplan fixture with a
 * per-invocation reply queue: a review chain calls it once per reviewer (plus
 * once for the chair), and each of those turns needs its own canned answer.
 *
 * The reviewers fan out concurrently, so several copies of this script can be
 * live at once. Two things follow. (1) The argv record and the queue counter
 * are claimed under a directory lock — an unlocked read-modify-write handed two
 * reviewers the same reply, and unlocked appends interleaved two argv chunks
 * into one unparseable blob. (2) `keys` pins a reply to the reviewer that asked
 * for it: pass one substring per body (the style marker is the obvious choice)
 * and the settle order stops mattering at all. Without `keys` the queue is
 * positional, which is still right for a single-reviewer chain (reviewer, then
 * chair) where the calls are genuinely sequential.
 */
function stubClaude(bodies: string[], keys: string[] = []): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-cli-'));
  const bin = path.join(dir, 'claude');
  const logFile = path.join(dir, 'argv.log');
  const countFile = path.join(dir, 'count');
  const keyFile = path.join(dir, 'keys');
  const write = (list: string[]): void => {
    for (const old of fs.readdirSync(dir)) {
      if (old.startsWith('body.')) fs.rmSync(path.join(dir, old), { force: true });
    }
    list.forEach((body, i) => fs.writeFileSync(path.join(dir, `body.${i}`), body));
    fs.writeFileSync(path.join(dir, 'body.last'), list[list.length - 1] ?? envelope('{}'));
    fs.rmSync(countFile, { force: true });
  };
  write(bodies);
  // Trailing newline is load-bearing: POSIX `read` fails at an unterminated
  // last line, so without it the final key is never even tested.
  fs.writeFileSync(keyFile, keys.length ? `${keys.join('\n')}\n` : '');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `tmp=$(mktemp "${dir}/argv.XXXXXX")\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "$tmp"; done\n` +
      `printf '<<<END>>>\\n' >> "$tmp"\n` +
      // Pick the reply by key first, while the argv is still in our own file.
      `sel=""\n` +
      `i=0\n` +
      `while IFS= read -r k; do\n` +
      `  if [ -n "$k" ] && grep -qF -- "$k" "$tmp"; then sel=$i; break; fi\n` +
      `  i=$((i+1))\n` +
      `done < "${keyFile}"\n` +
      // Claim the log slot and the positional counter atomically. Bounded spin:
      // a stub that died holding the lock must not hang the suite.
      `w=0\n` +
      `while [ $w -lt 10000 ] && ! mkdir "${dir}/lock" 2>/dev/null; do w=$((w+1)); done\n` +
      `n=0\n[ -f "${countFile}" ] && n=$(cat "${countFile}")\n` +
      `printf '%s' "$((n+1))" > "${countFile}"\n` +
      `cat "$tmp" >> "${logFile}"\n` +
      `rmdir "${dir}/lock" 2>/dev/null\n` +
      `rm -f "$tmp"\n` +
      `[ -z "$sel" ] && sel=$n\n` +
      `if [ -f "${dir}/body.$sel" ]; then cat "${dir}/body.$sel"; else cat "${dir}/body.last"; fi\n`,
  );
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const invocations = (): string[][] =>
    (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      .split('<<<END>>>\n')
      .filter((chunk) => chunk.trim())
      .map((chunk) => chunk.split('\n').filter(Boolean));
  const find = (needle: string): string[] => {
    const hit = invocations().find((argv) => argv.some((a) => a.includes(needle)));
    assert.ok(hit, `no invocation carried ${JSON.stringify(needle)}`);
    return hit!;
  };
  return {
    dir,
    invocations,
    prompt: (i: number) => (invocations()[i] ?? []).join('\n'),
    count: () => invocations().length,
    setBodies: write,
    argvFor: find,
    promptFor: (needle: string) => find(needle).join('\n'),
  };
}

/**
 * Reply keys for the two-reviewer SOFTWARE chain: body `i` answers reviewer
 * `i`, whichever of the two concurrent calls happens to land first.
 */
const SOFT_KEYS = ['REVIEW STYLE (code-review)', 'REVIEW STYLE (devils-advocate)'];

function cleanup(dirs: string[]): void {
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
  delete process.env['FOREMAN_CLAUDE_BIN'];
  delete process.env['FOREMAN_CREW_REVIEW'];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,2 +1,3 @@',
  ' export function auth(token) {',
  '+  if (!token) return null;',
  '   return verify(token);',
].join('\n');

/** A crew ticket plus a live run, the two things a review needs. */
function ticket(store: Store, over: Partial<Task> = {}): { task: Task; runId: string } {
  const task = store.addTask({
    title: 'Implement token auth',
    prompt: 'Add bearer-token auth to the API.',
    kind: 'code',
    runner: 'claude-code',
    role: over.role ?? 'dev',
    playbook: over.playbook ?? 'soft',
    acceptance: over.acceptance === undefined ? 'requests without a token get 401' : over.acceptance,
    parentId: over.parentId ?? null,
    sensitivity: over.sensitivity ?? 'S1',
    ...(over.maxRepairs !== undefined ? { maxRepairs: over.maxRepairs } : {}),
    ...(over.testCmd !== undefined ? { testCmd: over.testCmd } : {}),
    ...(over.repo !== undefined ? { repo: over.repo } : {}),
  });
  if (over.repairNotes !== undefined) store.db.prepare('UPDATE tasks SET repair_notes = ? WHERE id = ?').run(over.repairNotes, task.id);
  return { task: store.getTask(task.id)!, runId: store.startRun(task.id).id };
}

/** A council verdict row shaped like the real thing: `pass` with N agreeing advisors. */
function council(store: Store, runId: string, taskId: string, verdict: 'pass' | 'fail', advisors = 2): Verdict {
  return store.addVerdict({
    runId,
    taskId,
    verdict,
    disagreement: false,
    council: Array.from({ length: advisors }, (_, i) => ({
      model: `local-${i}`, provider: 'ollama', local: true, verdict,
      confidence: 0.9, critique: verdict === 'fail' ? 'the local council disliked it' : '',
      costUsd: 0, latencyMs: 5,
    })),
    critique: verdict === 'fail' ? 'the local council disliked it' : null,
  });
}

async function settle(sched: Scheduler, until: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    await sched.tick();
    if (Date.now() > deadline) throw new Error('settle timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Poll a condition (a marker file, a recorded receipt) rather than guess how long the machine needs. */
async function waitUntil(until: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-repo-'));
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

// ------------------------------------------------------------ style prompts

test('each reviewer style reaches the CLI with the ticket, the acceptance criteria and the diff', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'reads fine')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = await crewReview({ task, runId, store, diff: DIFF, council: null });
    assert.ok(out, 'a playbook with reviewers produces a crew verdict');
    assert.equal(stub.count(), 2, 'every reviewer in the chain was called');

    const first = stub.promptFor('REVIEW STYLE (code-review)');
    assert.match(first, /REVIEW STYLE \(code-review\)/);
    assert.match(first, /Implement token auth/);
    assert.match(first, /requests without a token get 401/, 'acceptance criteria reach the reviewer');
    assert.match(first, /if \(!token\) return null;/, 'the diff reaches the reviewer');
    assert.match(first, /Keep diffs minimal\./, "the playbook's definition of done reaches the reviewer");
    assert.ok(!/rowToTask|Scheduler/.test(first), 'the reviewer sees the diff, never the repo');

    const second = stub.promptFor('REVIEW STYLE (devils-advocate)');
    assert.match(second, /argue AGAINST/);
    assert.match(second, /PRE-MORTEM/);

    // The reviewer's own tier decides the model, and a review is turn-capped.
    const argv = stub.argvFor('REVIEW STYLE (code-review)');
    assert.equal(argv[argv.indexOf('--model') + 1], tierModel('senior'));
    assert.ok(argv.includes('--max-turns'));
    const plannerArgv = stub.argvFor('REVIEW STYLE (devils-advocate)');
    assert.equal(
      plannerArgv[plannerArgv.indexOf('--model') + 1],
      tierModel('owner'),
      'the planner reviewer is owner-tier',
    );
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the prose styles carry their own instructions: an editorial letter, then a peer review', async () => {
  const pbDir = withPlaybooks({ 'press.md': PRESS });
  const stub = stubClaude([reviewReply('pass', 'the structure holds'), reviewReply('pass', 'claims match evidence')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'press', role: 'author' });
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'pass');

    const letter = stub.promptFor('REVIEW STYLE (editorial-letter)');
    assert.match(letter, /developmental editor/);
    assert.match(letter, /prose the author revises against/);
    assert.match(letter, /Preserve the author voice\./, 'the definition of done travels with every style');

    const peer = stub.promptFor('REVIEW STYLE (peer-review)');
    assert.match(peer, /Spot-check citations/);
    assert.match(peer, /Overclaiming/);
    // Both reviewers are the same role, so the same tier pays for both.
    for (const argv of stub.invocations()) {
      assert.equal(argv[argv.indexOf('--model') + 1], tierModel('senior'));
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('no playbook, or a playbook with no reviewers, falls through to council-only', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('fail', 'should never be called')]);
  const store = new Store(':memory:');
  try {
    const plain = store.addTask({ title: 'no crew', prompt: 'do a thing', kind: 'general', runner: 'echo' });
    const runId = store.startRun(plain.id).id;
    assert.equal(await crewReview({ task: store.getTask(plain.id)!, runId, store, diff: DIFF }), null);

    // And S2 never reaches the hosted reviewer at all.
    const secret = ticket(store, { sensitivity: 'S2' });
    const notes: string[] = [];
    assert.equal(
      await crewReview({ ...secret, store, diff: DIFF, onNote: (l) => notes.push(l) }),
      null,
    );
    assert.match(notes.join('\n'), /S2/);
    assert.equal(stub.count(), 0, 'nothing was sent off the machine');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- aggregation

test('all reviewers passing is a pass; a receipt of kind review is written per call', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'clean'), reviewReply('pass', 'the case against it fails')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'pass');
    assert.equal(out.record.verdict, 'pass');
    assert.equal(out.record.source, 'crew', 'the row says which review wrote it');
    assert.equal(out.chair, null, 'a clean pass never pays for a chair');

    const kinds = store.receiptsForTask(task.id).map((r) => String(r['kind']));
    assert.deepEqual(kinds, ['review', 'review'], 'every reviewer call is billed as a review');
    assert.ok(store.spentOnTask(task.id) > 0, 'review spend lands in the ledger');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('one reviewer failing fails the chain, and every critique is carried', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([
    reviewReply('pass', 'the code itself is fine'),
    reviewReply('fail', 'the token is never revoked; assume it shipped and leaked'),
  ], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'fail');
    assert.match(out.critique, /the token is never revoked/);
    assert.match(out.critique, /the code itself is fine/, 'a passing reviewer is still on the record');
    assert.match(out.critique, /devils-advocate/, 'critiques are attributed to the style that raised them');
    assert.equal(store.verdictsForTask(task.id).filter((v) => v.source === 'crew').length, 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a malformed reply makes that reviewer unavailable, not a fail — it never rejects working code', async () => {
  // It does not let the survivor pass the chain alone either (see 'a chain that
  // lost a reviewer…' below): a split, held for a person.
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([envelope('I am afraid I cannot do that'), reviewReply('pass', 'looks right')], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store);
    const out = await crewReview({ task, runId, store, diff: DIFF, onNote: (l) => notes.push(l) });
    assert.equal(out?.verdict, 'split', 'an unusable reply must not reject working code, and one PASS is not the chain');
    assert.deepEqual(store.verdictsForTask(task.id).map((v) => v.verdict), ['split']);
    assert.match(notes.join('\n'), /unusable reply, skipping/);
    assert.match(notes.join('\n'), /gave no usable answer and the rest passed/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('every reviewer unavailable returns null, so the council verdict stands', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([envelope('nonsense'), envelope('also nonsense')]);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store);
    const passed = council(store, runId, task.id, 'pass');
    // 'always', because the council pass would otherwise skip the chain: this
    // asserts the unreachable-reviewer fallback, not the skip rule.
    process.env['FOREMAN_CREW_REVIEW'] = 'always';
    const out = await crewReview({
      task, runId, store, diff: DIFF, council: passed, onNote: (l) => notes.push(l),
    });
    assert.equal(out, null);
    assert.match(notes.join('\n'), /no reviewer .* could be reached|keeping the council verdict/);
    assert.equal(store.verdictsForTask(task.id).filter((v) => v.source === 'crew').length, 0);

    // Degrading is allowed; degrading silently is not. The ledger and the
    // timeline both have to show that the review did not happen.
    const receipts = store.receiptsForTask(task.id);
    const missed = receipts.find((r) => String(r['kind']) === 'review:unavailable');
    assert.ok(missed, 'a $0 receipt marks the review that never happened');
    assert.equal(Number(missed!['cost_usd']), 0);
    const errors = store.eventsForTask(task.id).filter((e) => e.type === 'error');
    assert.ok(
      errors.some((e) => /no reviewer in the .* chain could be reached/.test(e.message)),
      'the board sees an error event, not a clean ticket',
    );
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------------ issues

test('issues are filed as child tickets with provenance, a remapped role and a per-reviewer cap of three', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const issues = Array.from({ length: 7 }, (_, i) => ({
    title: `follow-up ${i}`, prompt: `do follow-up ${i}`, severity: 'normal', role: i === 0 ? 'qa' : 'nonexistent',
  }));
  const stub = stubClaude([
    reviewReply('pass', 'fine, but', issues),
    // The second reviewer still gets its slots: one reviewer's flood cannot
    // spend them, because the per-reviewer cap bites before the global one.
    reviewReply('pass', 'also fine', [{ title: 'eighth', prompt: 'and another', severity: 'normal', role: 'qa' }]),
  ], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'pass');
    assert.equal(out.filed.length, 4, 'three from the chatty reviewer, one from the second');

    const children = store.childrenOf(task.id);
    assert.equal(children.length, 4);
    assert.match(children[0]!.prompt, new RegExp(`^Filed by code-review review of ${task.id}: Implement token auth`));
    assert.match(children[0]!.prompt, /do follow-up 0/);
    assert.equal(children[0]!.role, 'qa', 'a role the playbook defines is kept');
    assert.equal(children[1]!.role, 'dev', 'an invented role is remapped to the first worker-tier role');
    assert.equal(children[0]!.playbook, 'soft');
    assert.equal(children[0]!.kind, task.kind);
    assert.equal(children[0]!.sensitivity, task.sensitivity);
    assert.ok(children.some((c) => c.title === 'eighth'), 'the later reviewer was still heard');
    assert.ok(
      children.every((c) => !/follow-up [3-6]/.test(c.title)),
      'the fourth issue onward from one reviewer is dropped',
    );
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the per-verdict cap of five still bites across the whole chain', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const three = (tag: string): Array<Record<string, unknown>> =>
    Array.from({ length: 3 }, (_, i) => ({
      title: `${tag} ${i}`, prompt: `do ${tag} ${i}`, severity: 'normal', role: 'qa',
    }));
  const stub = stubClaude([reviewReply('pass', 'ok', three('a')), reviewReply('pass', 'ok', three('b'))], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.filed.length, 5, 'six raised, five filed');
    assert.equal(store.childrenOf(task.id).length, 5);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a blocker behind a flood of normals still downgrades the verdict', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const normals = Array.from({ length: 5 }, (_, i) => ({
    title: `nit ${i}`, prompt: `tidy nit ${i}`, severity: 'normal', role: 'qa',
  }));
  const stub = stubClaude([
    reviewReply('pass', 'a pile of nits', normals),
    reviewReply('pass', 'one real problem', [
      { title: 'nit x', prompt: 'tidy that too', severity: 'normal', role: 'qa' },
      { title: 'nit y', prompt: 'and that', severity: 'normal', role: 'qa' },
      // Sixth in raise order: the global slice of five drops it from FILING,
      // and it must still be heard by the downgrade.
      { title: 'token is logged in cleartext', prompt: 'redact it', severity: 'blocker', role: 'dev' },
    ]),
  ], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store);
    const out = (await crewReview({ task, runId, store, diff: DIFF, onNote: (l) => notes.push(l) }))!;
    assert.equal(out.verdict, 'fail', 'the cap decides what is filed, never what is heard');
    assert.match(out.critique, /token is logged in cleartext/);
    assert.match(notes.join('\n'), /downgraded to fail/);
    assert.equal(out.filed.length, 5, 'the filing cap is untouched by the downgrade');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a blocker-severity issue cannot ride a pass', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'mostly good', [
      { title: 'secret in the log line', prompt: 'redact the token before logging', severity: 'blocker', role: 'dev' },
    ]),
    chairReply('fail', 'a blocker is a blocker'),
  ]);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const out = (await crewReview({ task, runId, store, diff: DIFF, onNote: (l) => notes.push(l) }))!;
    assert.equal(out.verdict, 'fail');
    assert.match(out.critique, /redact the token before logging/);
    assert.match(notes.join('\n'), /downgraded to fail/);
    // The blocker is fixed by this ticket's own repair round, so it is in the
    // repair critique and NOT filed: a duplicate child found nothing to do once
    // the repair landed and failed for it (first Kiln epic, t_5d3566ede7).
    assert.match(out.critique, /BLOCKERS TO FIX IN THIS REPAIR/);
    assert.equal(store.childrenOf(task.id).length, 0);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the epic depth cap stops a review from filing work nobody is watching', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [{ title: 'follow-up', prompt: 'do it later', severity: 'normal', role: 'dev' }]),
  ]);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    const out = (await crewReview({ ...deep, store, diff: DIFF, onNote: (l) => notes.push(l) }))!;
    assert.equal(out.verdict, 'pass');
    assert.deepEqual(out.filed, [], 'nothing is filed at the depth cap');
    assert.equal(store.childrenOf(deep.task.id).length, 0);
    assert.match(notes.join('\n'), /not filing 1 review issue\(s\)/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('issues dropped at the depth cap are recorded whole as warnings, and nothing is filed', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [
      { title: 'scope guard fails open', prompt: 'an unparsable scope lets every path through', severity: 'normal', role: 'dev' },
      { title: 'rename helper', prompt: 'call it scopeAllows', severity: 'normal', role: 'dev' },
    ]),
  ]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    const out = (await crewReview({ ...deep, store, diff: DIFF }))!;
    assert.deepEqual(out.filed, []);
    assert.equal(store.childrenOf(deep.task.id).length, 0);
    const warnings = store.eventsForTask(deep.task.id).filter((e) => e.type === 'warning');
    assert.equal(warnings.length, 2);
    const text = warnings.map((w) => w.message).join('\n');
    assert.match(text, /\[normal\] scope guard fails open/);
    assert.match(text, /an unparsable scope lets every path through/);
    assert.match(text, /\[normal\] rename helper/);
    assert.match(text, /call it scopeAllows/);
    assert.match(verdictChain(store, deep.task, null), /scope guard fails open[\s\S]*rename helper/, 'the gate summary lists them');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a review issue too deep to file leaves a pass a pass, and is dropped on the record', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [{ title: 'folder changes apply out of order', prompt: 'a later change can land before an earlier one', severity: 'normal', role: 'dev' }]),
  ]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    const out = (await crewReview({ ...deep, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'pass', 'never flipped');
    assert.deepEqual(out.filed, []);
    const drops = store.eventsForTask(deep.task.id).filter((e) => e.message.startsWith(DROPPED_ISSUE_PREFIX));
    assert.equal(drops.length, 1);
    assert.match(drops[0]!.message, /a later change can land before an earlier one/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a filed follow-up inherits the reviewed ticket\'s test command', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [{ title: 'cover the empty-token case', prompt: 'add a test', severity: 'normal', role: 'dev' }]),
  ]);
  const store = new Store(':memory:');
  try {
    const t = ticket(store, { playbook: 'solo', testCmd: 'npm run verify --silent' });
    const out = (await crewReview({ ...t, store, diff: DIFF }))!;
    assert.equal(out.filed.length, 1);
    assert.equal(store.getTask(out.filed[0]!)!.testCmd, 'npm run verify --silent');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a follow-up near-identical to an open one along the parent chain is not filed twice; a distinct one on the same file is', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [
      { title: 'Overlapping projectsBase changes release the settings hold too early', prompt: 'same defect, reworded', severity: 'normal', role: 'dev' },
      { title: 'settings.ts: theme toggle is not persisted', prompt: 'a different defect in the same file', severity: 'normal', role: 'dev' },
    ]),
  ]);
  const store = new Store(':memory:');
  try {
    const epic = store.addTask({ title: 'settings epic', prompt: 'x', runner: 'echo' });
    // Filed by an earlier review round, elsewhere under the same epic, still open.
    const earlier = store.addTask({ title: 'Overlapping projectsBase changes release the settings-save hold early', prompt: 'x', runner: 'echo', parentId: epic.id });
    store.addTask({ title: 'settings.ts: save button ignores validation errors', prompt: 'x', runner: 'echo', parentId: epic.id });
    const t = ticket(store, { playbook: 'solo', parentId: epic.id });
    const out = (await crewReview({ ...t, store, diff: DIFF }))!;
    const titles = out.filed.map((id) => store.getTask(id)!.title);
    assert.deepEqual(titles, ['settings.ts: theme toggle is not persisted']);
    assert.ok(
      store.eventsForTask(t.task.id).some((e) => e.message.startsWith(DROPPED_ISSUE_PREFIX) && e.message.includes(`duplicate of ${earlier.id}`)),
      'the skip is recorded like any unfiled issue, so the gate names it',
    );
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('titlesSimilar: short or differently-numbered/identified titles are distinct; the projectsBase pair is one defect', () => {
  assert.equal(titlesSimilar('Overlapping projectsBase changes release the settings-save hold early', 'Overlapping projectsBase changes release the settings hold too early'), true);
  for (const [a, b] of [
    ['Chapter 12: fix timeline', 'Chapter 14: fix timeline'],
    ['Handle empty input in parse()', 'Handle null input in parse()'],
    ['Missing test for parser error path', 'Missing test for lexer error path'],
    ['Add settings page', 'Add settings page validation'],
    // Same words, a different chapter or file: still distinct, however long the title.
    ['Chapter 12: fix the broken timeline ordering bug', 'Chapter 14: fix the broken timeline ordering bug'],
    ['settings.ts: theme toggle state not persisted', 'prefs.ts: theme toggle state not persisted'],
  ]) assert.equal(titlesSimilar(a!, b!), false, `${a} / ${b}`);
});

test('dedupe never matches the epic itself, nor a failed or rejected follow-up', async () => {
  const title = 'Overlapping projectsBase changes release the settings hold too early';
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'fine', [{ title, prompt: 'p', severity: 'normal', role: 'dev' }])]);
  const store = new Store(':memory:');
  try {
    // The epic's own title resembles the issue; earlier attempts at it failed or were rejected.
    const epic = store.addTask({ title: 'Overlapping projectsBase changes release the settings-save hold early', prompt: 'x', runner: 'echo' });
    for (const status of ['failed', 'rejected'] as const) {
      const old = store.addTask({ title: 'Overlapping projectsBase changes release the settings-save hold early', prompt: 'x', runner: 'echo', parentId: epic.id });
      store.setStatus(old.id, status);
    }
    const t = ticket(store, { playbook: 'solo', parentId: epic.id });
    const out = (await crewReview({ ...t, store, diff: DIFF }))!;
    assert.deepEqual(out.filed.map((id) => store.getTask(id)!.title), [title], 'filed: nothing open duplicates it');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a genuine fail at depth still counts in the crew failure streak', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', 'broken', [{ title: 'rename a local variable', prompt: 'nit', severity: 'normal', role: 'dev' }])]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    const out = (await crewReview({ ...deep, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'fail');
    assert.equal(store.crewFailureStreak(deep.task.id), 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('at depth, a same-diff retry served from the cache still drops (and so surfaces) its issues', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'fine', [{ title: 'folder changes apply out of order', prompt: 'p', severity: 'normal', role: 'dev' }])]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    await crewReview({ ...deep, store, diff: DIFF });
    const retryRun = store.startRun(deep.task.id).id;
    const retry = (await crewReview({ task: deep.task, runId: retryRun, store, diff: DIFF }))!;
    assert.equal(stub.count(), 1, 'precondition: the retry was served from the cache');
    assert.equal(retry.verdict, 'pass');
    // The park note reads this run's drops, so the retry needs its own.
    assert.ok(store.eventsForTask(deep.task.id).some((e) => e.runId === retryRun && e.message.startsWith(DROPPED_ISSUE_PREFIX)), 'dropped on the retry too');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('one review raising the same issue twice records one drop; dedupe ignores tickets in another repo', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const issue = { title: 'folder changes apply out of order', prompt: 'p', severity: 'normal' as const, role: 'dev' };
  const stub = stubClaude([reviewReply('pass', 'fine', [issue, { ...issue }])]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    await crewReview({ ...deep, store, diff: DIFF });
    assert.equal(store.eventsForTask(deep.task.id).filter((e) => e.message.startsWith(DROPPED_ISSUE_PREFIX)).length, 1);

    const title = 'Overlapping projectsBase changes release the settings hold too early';
    stub.setBodies([reviewReply('pass', 'fine', [{ title, prompt: 'p', severity: 'normal', role: 'dev' }])]);
    const epic = store.addTask({ title: 'epic', prompt: 'x', runner: 'echo' });
    store.addTask({ title: 'Overlapping projectsBase changes release the settings-save hold early', prompt: 'x', runner: 'echo', parentId: epic.id, repo: '/elsewhere' });
    const t = ticket(store, { playbook: 'solo', parentId: epic.id });
    const out = (await crewReview({ ...t, store, diff: `${DIFF}\n+// other` }))!;
    assert.deepEqual(out.filed.map((id) => store.getTask(id)!.title), [title], 'a like-named ticket in another repo is not a duplicate');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the same issue dropped by two reviews of one task is listed once, with a count', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const issue = (title: string) => reviewReply('pass', 'fine', [
    { title, prompt: 'an unparsable scope lets every path through', severity: 'normal', role: 'dev' },
  ]);
  const stub = stubClaude([issue('scope guard fails open')]);
  const store = new Store(':memory:');
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    const deep = ticket(store, { playbook: 'solo', parentId: t2.id });
    await crewReview({ ...deep, store, diff: DIFF });
    stub.setBodies([issue('scope  guard fails OPEN')]);
    // A retry's diff differs, so the reviewer is asked afresh rather than served from cache.
    await crewReview({ task: deep.task, runId: store.startRun(deep.task.id).id, store, diff: `${DIFF}\n+// retry` });
    const events = store.eventsForTask(deep.task.id);
    assert.equal(events.filter((e) => e.message.startsWith(DROPPED_ISSUE_PREFIX)).length, 2, 'both drops were recorded');
    const shown = formatDroppedIssues(events);
    assert.match(shown, /Review issues NOT filed \(1\)/);
    assert.equal(shown.split('- ').length - 1, 1, 'listed once');
    assert.match(shown, /\[dropped 2 times\]/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('boundDroppedIssues keeps the latest entry per title, ignoring case and spacing', async () => {
  const { boundDroppedIssues } = await import('../src/verify/crewReview.ts');
  const ev = (id: number, message: string) => ({ id, taskId: 't', runId: null, ts: 0, type: 'warning' as const, stage: null, message });
  const out = boundDroppedIssues([
    ev(1, `${DROPPED_ISSUE_PREFIX} [normal] scope guard fails open (2 parents deep)\nold body`),
    ev(2, `${DROPPED_ISSUE_PREFIX} [blocker] scope  Guard fails OPEN (2 parents deep)\nnew body`),
  ], 1_000);
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /\[blocker\]/);
  assert.match(out[0]!.message, /new body/);
  assert.doesNotMatch(out[0]!.message, /old body/);
});

test('issues dropped at the per-epic ceiling are recorded whole as warnings', async () => {
  const { MAX_ISSUES_PER_EPIC } = await import('../src/verify/crewReview.ts');
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const two = [
    { title: 'late 0', prompt: 'body of late 0', severity: 'normal', role: 'qa' },
    { title: 'late 1', prompt: 'body of late 1', severity: 'normal', role: 'qa' },
  ];
  const stub = stubClaude([reviewReply('pass', 'ok', two), reviewReply('pass', 'ok', [])], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const epic = store.addTask({ title: 'epic', prompt: 'the ask', runner: 'echo' });
    for (let i = 0; i < MAX_ISSUES_PER_EPIC - 1; i++) {
      store.addTask({ title: `earlier ${i}`, prompt: `Filed by code-review review of ${epic.id}: e\n\nold ${i}`, runner: 'echo', parentId: epic.id });
    }
    const { task, runId } = ticket(store, { parentId: epic.id });
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.filed.length, 1);
    const warnings = store.eventsForTask(task.id).filter((e) => e.type === 'warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /\[normal\] late 1/);
    assert.match(warnings[0]!.message, /body of late 1/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('dropped issues survive 900 later log events: gate summary and show/board data still list them', async () => {
  const { withDroppedIssues } = await import('../src/verify/crewReview.ts');
  const store = new Store(':memory:');
  try {
    const task = store.addTask({ title: 'reviewed', prompt: 'x', runner: 'echo' });
    const body = 'B'.repeat(5_000);
    for (let i = 0; i < 2; i++) {
      store.record({ taskId: task.id, type: 'warning', stage: 'verify', message: `${DROPPED_ISSUE_PREFIX} [blocker] scope guard fails open (2 parents deep, max 2)\n${body}` });
    }
    for (let i = 0; i < 900; i++) store.record({ taskId: task.id, type: 'log', stage: 'work', message: `line ${i}` });
    assert.ok(!store.eventsForTask(task.id, 800).some((e) => e.message.startsWith(DROPPED_ISSUE_PREFIX)), 'pushed out of the tail window');
    const chain = verdictChain(store, task, null);
    assert.match(chain, /scope guard fails open/);
    assert.equal(chain.split('scope guard fails open').length - 1, 1, 'deduped by title');
    assert.ok(chain.length < 3_000, 'body is bounded');
    const shown = formatDroppedIssues(withDroppedIssues(store, task.id, store.eventsForTask(task.id, 800)));
    assert.match(shown, /Review issues NOT filed \(1\)/);
    assert.match(shown, /\[blocker\] scope guard fails open/);
  } finally {
    store.close();
  }
});

test('foreman show lists dropped review issues under a heading', () => {
  const ev = (message: string, type: 'warning' | 'log' = 'warning') =>
    ({ id: 1, taskId: 't', runId: null, ts: 0, type, stage: null, message });
  assert.equal(formatDroppedIssues([ev('something else', 'log')]), '');
  const out = formatDroppedIssues([ev(`${DROPPED_ISSUE_PREFIX} [blocker] fail-open (2 parents deep)\nfull body here`)]);
  assert.match(out, /^Review issues NOT filed \(1\).*foreman add/);
  assert.match(out, /\[blocker\] fail-open/);
  assert.match(out, /full body here/);
});

test('foreman show collapses re-dropped issues by title, keeping the latest body and the count', () => {
  const ev = (id: number, message: string) => ({ id, taskId: 't', runId: null, ts: 0, type: 'warning' as const, stage: null, message });
  const out = formatDroppedIssues([
    ev(1, `${DROPPED_ISSUE_PREFIX} [blocker] fail-open (2 parents deep, max 2)\nbody v1`),
    ev(2, `${DROPPED_ISSUE_PREFIX} [blocker] fail-open (2 parents deep, max 2)\nbody v2`),
    ev(3, `${DROPPED_ISSUE_PREFIX} [normal] other thing (epic cap)\nother body`),
    ev(4, `${DROPPED_ISSUE_PREFIX} [blocker] fail-open (2 parents deep, max 2)\nbody v3`),
  ]);
  assert.match(out, /^Review issues NOT filed \(2\)/);
  assert.equal(out.split('- ').length - 1, 2);
  assert.match(out, /body v3/);
  assert.doesNotMatch(out, /body v1|body v2/);
  assert.match(out, /fail-open \(2 parents deep, max 2\) \[dropped 3 times\]/);
  assert.match(out, /other body/);
  assert.doesNotMatch(out, /other thing.*dropped/);
});

test('an epic stops accepting review-filed tickets at its ceiling; planned tickets do not count', async () => {
  // The first real book run: six tickets each filing five, children filing
  // more — 33 descendants chasing one imagined file. The per-verdict and depth
  // caps both held; the TOTAL was what nothing bounded.
  const { MAX_ISSUES_PER_EPIC } = await import('../src/verify/crewReview.ts');
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const three = Array.from({ length: 3 }, (_, i) => ({
    title: `late ${i}`, prompt: `do late ${i}`, severity: 'normal', role: 'qa',
  }));
  const stub = stubClaude([reviewReply('pass', 'ok', three), reviewReply('pass', 'ok', [])], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const epic = store.addTask({ title: 'epic', prompt: 'the ask', runner: 'echo' });
    // Planned tickets: plenty of them, none review-filed.
    for (let i = 0; i < 4; i++) store.addTask({ title: `planned ${i}`, prompt: `plan ${i}`, runner: 'echo', parentId: epic.id });
    const sibling = store.addTask({ title: 'sibling', prompt: 'x', runner: 'echo', parentId: epic.id });
    // Already-filed issues, spread across two levels of the epic.
    for (let i = 0; i < MAX_ISSUES_PER_EPIC - 1; i++) {
      store.addTask({
        title: `earlier ${i}`, prompt: `Filed by code-review review of ${sibling.id}: sibling\n\nold ${i}`,
        runner: 'echo', parentId: i % 2 ? sibling.id : epic.id,
      });
    }
    const notes: string[] = [];
    const { task, runId } = ticket(store, { parentId: epic.id });
    const out = (await crewReview({ task, runId, store, diff: DIFF, onNote: (l) => notes.push(l) }))!;
    assert.equal(out.filed.length, 1, 'one slot was left under the ceiling, and only one is used');
    assert.equal(store.childrenOf(task.id).length, 1);
    assert.match(notes.join('\n'), new RegExp(`already carries ${MAX_ISSUES_PER_EPIC} review-filed tickets`));
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('reviewers are told not to file tickets chasing files they never saw', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'ok'), reviewReply('pass', 'ok')], SOFT_KEYS);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    await crewReview({ task, runId, store, diff: DIFF });
    for (const style of ['code-review', 'devils-advocate']) {
      assert.match(stub.promptFor(`REVIEW STYLE (${style})`), /never file an issue about a file/);
    }
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- memoization

test('an identical review is replayed from cache without calling the CLI again', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'the null path is handled')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const first = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(first.verdict, 'pass');
    const calls = stub.count();
    assert.equal(calls, 1);

    // Same diff, same acceptance, same reviewer, same model — a retry re-verifies for free.
    const secondRun = store.startRun(task.id).id;
    const second = (await crewReview({ task, runId: secondRun, store, diff: DIFF }))!;
    assert.equal(stub.count(), calls, 'the cached reviewer was not paid for twice');
    assert.equal(second.verdict, 'pass');
    assert.match(second.critique, /the null path is handled/);
    assert.equal(second.reviews[0]!.cached, true);
    assert.equal(second.costUsd, 0);
    assert.ok(
      store.receiptsForTask(task.id).some((r) => String(r['kind']) === 'review:cache'),
      'the $0 replay is still on the ledger',
    );

    // A different diff is a different review, and is paid for.
    await crewReview({ task, runId: secondRun, store, diff: `${DIFF}\n+  log(token);` });
    assert.equal(stub.count(), calls + 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('two tickets with the same diff do not replay each other: the key covers ticket identity', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'right for the auth ticket'),
    reviewReply('fail', 'wrong for the billing ticket'),
  ]);
  const store = new Store(':memory:');
  try {
    // Same diff, same acceptance, same reviewer, same model — everything the
    // old key hashed. Only the title and the brief differ.
    const shared = { kind: 'code' as const, runner: 'claude-code' as const, role: 'dev', playbook: 'solo', acceptance: 'same criteria' };
    const a = store.addTask({ ...shared, title: 'Add bearer-token auth', prompt: 'Add bearer-token auth to the API.' });
    const b = store.addTask({ ...shared, title: 'Add usage billing', prompt: 'Meter API calls and bill for them.' });

    const first = (await crewReview({ task: store.getTask(a.id)!, runId: store.startRun(a.id).id, store, diff: DIFF }))!;
    const second = (await crewReview({ task: store.getTask(b.id)!, runId: store.startRun(b.id).id, store, diff: DIFF }))!;

    assert.equal(stub.count(), 2, 'the second ticket was really reviewed, not replayed');
    assert.equal(second.reviews[0]!.cached, false);
    assert.equal(first.verdict, 'pass');
    assert.equal(second.verdict, 'fail', "the second ticket got its own verdict, not the first's");

    // The title is what the reviewer was asked about, so it is in the key.
    assert.match(stub.prompt(1), /Add usage billing/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a cached replay never re-files its issues, and a re-raised issue is deduped by title', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const issue = { title: 'Add a revocation test', prompt: 'cover the revoked-token path', severity: 'normal', role: 'dev' };
  const stub = stubClaude([reviewReply('pass', 'fine, but', [issue])]);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const first = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(first.filed.length, 1);

    // The repair round re-reviews the same work: the reply is replayed from
    // cache, and the follow-up it already filed must not be filed again.
    const second = (await crewReview({ task, runId: store.startRun(task.id).id, store, diff: DIFF, onNote: (l) => notes.push(l) }))!;
    assert.equal(second.reviews[0]!.cached, true);
    assert.deepEqual(second.filed, [], 'a cached outcome files nothing');
    assert.equal(store.childrenOf(task.id).length, 1, 'still exactly one child ticket');

    // Belt and braces: a fresh, paid review that raises the same issue under a
    // different spelling is deduped against the children that already exist.
    stub.setBodies([reviewReply('pass', 'still fine', [{ ...issue, title: '  add a REVOCATION   test ' }])]);
    const third = (await crewReview({
      task, runId: store.startRun(task.id).id, store, diff: `${DIFF}\n+  // tweak`, onNote: (l) => notes.push(l),
    }))!;
    assert.equal(third.reviews[0]!.cached, false, 'this one was actually paid for');
    assert.deepEqual(third.filed, []);
    assert.equal(store.childrenOf(task.id).length, 1);
    assert.match(notes.join('\n'), /already filed under/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------ abort and deadline

test('a canceled task gains no verdict row and no child tickets', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'fine', [{ title: 'follow-up', prompt: 'later', severity: 'normal', role: 'dev' }]),
  ]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    // Warm the cache so the second pass reaches the abort check with a full set
    // of usable reviews rather than dying inside the CLI call.
    await crewReview({ task, runId, store, diff: DIFF });
    const verdictsBefore = store.verdictsForTask(task.id).length;
    const childrenBefore = store.childrenOf(task.id).length;

    const ac = new AbortController();
    ac.abort();
    const notes: string[] = [];
    const out = await crewReview({
      task, runId: store.startRun(task.id).id, store, diff: DIFF, signal: ac.signal, onNote: (l) => notes.push(l),
    });
    assert.equal(out, null, 'a canceled review keeps the council semantics the caller already had');
    assert.equal(store.verdictsForTask(task.id).length, verdictsBefore, 'no verdict was written');
    assert.equal(store.childrenOf(task.id).length, childrenBefore, 'no work was spawned');
    assert.match(notes.join('\n'), /canceled/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the time budget is divided across the chain, not handed whole to each call', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'never gets to say this')]);
  // One reviewer plus a chair = two shares, so a 4s budget gives each 2s. A
  // reviewer that takes 3s must be killed; an undivided budget would let it by.
  fs.writeFileSync(path.join(stub.dir, 'slow'), `#!/bin/sh\nsleep 3\ncat "${path.join(stub.dir, 'body.last')}"\n`);
  fs.chmodSync(path.join(stub.dir, 'slow'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'slow');
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const out = await crewReview({
      task, runId, store, diff: DIFF, timeoutMs: 4_000, onNote: (l) => notes.push(l),
    });
    assert.equal(out, null, 'a reviewer that outran its share is unavailable, never a fail');
    assert.match(notes.join('\n'), /unavailable — owner call timed out after 2000ms/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// --------------------------------------------------------------- skip rule

test('under escalate a unanimous council pass on a small diff skips the chain; always runs it', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  // The reviewer agrees with the council, so nothing here escalates to a chair.
  const stub = stubClaude([reviewReply('pass', 'ran anyway')]);
  const store = new Store(':memory:');
  try {
    const notes: string[] = [];
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const passed = council(store, runId, task.id, 'pass');
    assert.equal(
      await crewReview({ task, runId, store, diff: DIFF, council: passed, onNote: (l) => notes.push(l) }),
      null,
    );
    assert.equal(stub.count(), 0, 'the cheap layer settled it; no hosted review was paid for');
    assert.match(notes.join('\n'), /crew review skipped: council passed unanimously/);

    // A big diff is never skipped, even on a unanimous pass.
    const big = `${DIFF}\n${Array.from({ length: 220 }, (_, i) => `+  line${i}`).join('\n')}`;
    await crewReview({ task, runId, store, diff: big, council: passed });
    assert.equal(stub.count(), 1, 'a 200+ line diff still gets the chain');

    // And 'always' means always.
    process.env['FOREMAN_CREW_REVIEW'] = 'always';
    const out = await crewReview({ task, runId, store, diff: DIFF, council: passed });
    assert.equal(stub.count(), 2);
    assert.equal(out?.verdict, 'pass');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a council fail is not a unanimous pass, so the chain runs', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', 'agreed, this is broken'), chairReply('fail', 'both agree')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const failed = council(store, runId, task.id, 'fail');
    const out = (await crewReview({ task, runId, store, diff: DIFF, council: failed }))!;
    assert.equal(out.verdict, 'fail');
    assert.equal(out.chair, null, 'agreement on a first failure needs no chair');
    assert.equal(stub.count(), 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

// ------------------------------------------------------------- escalation

test('a crew/council disagreement calls the chair, and the chair decides', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('pass', 'the diff does what the ticket asked'),
    chairReply('fail', 'the council caught a real regression the reviewer waved through'),
  ]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const failed = council(store, runId, task.id, 'fail');
    const out = (await crewReview({ task, runId, store, diff: DIFF, council: failed }))!;
    assert.equal(stub.count(), 2, 'reviewer, then chair');

    const chairPrompt = stub.prompt(1);
    assert.match(chairPrompt, /LOCAL COUNCIL VERDICT: fail/);
    assert.match(chairPrompt, /CREW REVIEW VERDICT: pass/);
    assert.match(chairPrompt, /the local council disliked it/);
    assert.match(chairPrompt, /src\/auth\.ts/, 'the chair gets a diff summary, not the diff');

    assert.equal(out.verdict, 'fail', 'the chair verdict is final');
    assert.equal(out.chair?.role, 'planner');
    assert.equal(out.chair?.model, tierModel('owner'));
    assert.equal(out.record.verdict, 'fail');
    assert.equal(out.record.disagreement, true);
    assert.equal(out.record.chairModel, tierModel('owner'));
    assert.match(out.record.chairSummary ?? '', /real regression/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('consecutive crew failures escalate at the playbook threshold, and an unreachable chair never wedges the task', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', 'round one is wrong')]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const first = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(first.chair, null, 'one failure is under the threshold of 2');
    assert.equal(store.crewFailureStreak(task.id), 1);

    // Second failure on a fresh diff: the streak reaches afterFailures, so the
    // chair is called — and here it is unreachable.
    stub.setBodies([reviewReply('fail', 'round two is still wrong')]);
    process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'gone-chair');
    const notes: string[] = [];
    const second = await crewReview({
      task, runId, store, diff: `${DIFF}\n+  second round`, onNote: (l) => notes.push(l),
    });
    // Every reviewer unreachable degrades to council-only; put the CLI back and
    // fail only the chair, which is the case under test.
    assert.equal(second, null);
    assert.match(notes.join('\n'), /keeping the council verdict/);

    process.env['FOREMAN_CLAUDE_BIN'] = path.join(stub.dir, 'claude');
    stub.setBodies([reviewReply('fail', 'round three is wrong too'), envelope('the chair mumbles')]);
    const before = stub.count();
    const chairNotes: string[] = [];
    const third = (await crewReview({
      task, runId, store, diff: `${DIFF}\n+  third round`, onNote: (l) => chairNotes.push(l),
    }))!;
    assert.match(chairNotes.join('\n'), /chair reply unusable/, 'the failure stays in the log');
    assert.equal(stub.count() - before, 2, 'reviewer plus the chair the threshold demanded');
    assert.equal(third.verdict, 'fail', 'an unusable chair reply leaves the chain verdict standing');
    assert.equal(third.chair, null);
    assert.equal(
      third.record.chairSummary,
      null,
      'no chair ruled, so nothing poses as a chair rationale on the row the align dataset reads',
    );
    assert.equal(third.record.chairModel, null);
    assert.equal(store.crewFailureStreak(task.id), 2);

    // A pass resets the streak, so an old bad round cannot escalate a later one.
    stub.setBodies([reviewReply('pass', 'fixed')]);
    await crewReview({ task, runId, store, diff: `${DIFF}\n+  fourth round` });
    assert.equal(store.crewFailureStreak(task.id), 0);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('verdicts written in the same millisecond still read newest-first', () => {
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'x', prompt: 'do x', runner: 'echo' });
    const runId = store.startRun(t.id).id;
    const first = store.addVerdict({ runId, taskId: t.id, verdict: 'pass', disagreement: false, council: [], source: 'council' });
    const second = store.addVerdict({ runId, taskId: t.id, verdict: 'fail', disagreement: false, council: [], source: 'crew' });
    // A council verdict and the crew chain that follows it can land in the same
    // millisecond; without the rowid tiebreak the newer one is not first.
    store.db.prepare('UPDATE verdicts SET created_at = 1000 WHERE task_id = ?').run(t.id);
    const rows = store.verdictsForTask(t.id);
    assert.deepEqual(rows.map((v) => v.id), [second.id, first.id]);
    assert.equal(rows[0]!.source, 'crew');
  } finally {
    store.close();
  }
});

// ------------------------------------------------------------- integration

const OUT_OF_ORDER = { title: 'folder changes apply out of order', prompt: 'a later change can land before an earlier one', severity: 'normal', role: 'dev' };

async function deepTicketThroughScheduler(
  until: (t: Task, store: Store) => boolean,
  opts: { replies?: string[]; gate?: 'owner'; inspect?: (store: Store, t: Task, calls: number) => void } = {},
): Promise<Task> {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude(opts.replies ?? [reviewReply('pass', 'fine', [OUT_OF_ORDER])]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t1 = store.addTask({ title: 'top', prompt: 'x', runner: 'echo' });
    store.setStatus(t1.id, 'blocked');
    const t2 = store.addTask({ title: 'mid', prompt: 'x', runner: 'echo', parentId: t1.id });
    store.setStatus(t2.id, 'blocked');
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'crew\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'solo', parentId: t2.id, maxRepairs: 1, ...(opts.gate ? { gate: opts.gate } : {}),
    });
    await settle(sched, () => until(store.getTask(t.id)!, store));
    opts.inspect?.(store, store.getTask(t.id)!, stub.count());
    return store.getTask(t.id)!;
  } finally {
    delete process.env['FOREMAN_CREW_REVIEW'];
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
}

test('a depth-3 ticket whose review passes with a normal issue parks as a pass, the issue named on the gate item', async () => {
  const after = await deepTicketThroughScheduler((t) => t.status === 'awaiting-approval' || t.repairs > 0);
  assert.equal(after.status, 'awaiting-approval', 'not sent to a repair round');
  assert.equal(after.repairs, 0);
  assert.match(after.error ?? '', /REVIEW ISSUES NOT FILED \(1\) \(epic depth limit\) — decide at approval: .*folder changes apply out of order.*a later change can land before an earlier one/);
});

test('under the owner gate, a depth-3 pass with an unfiled issue is held for a person, its note intact', async () => {
  const ownerApproves = envelope(JSON.stringify({ decision: 'approve', rationale: 'looks fine' }));
  let calls = 0;
  let gateLines = '';
  const after = await deepTicketThroughScheduler(
    (t, store) => t.status === 'done' || store.eventsForTask(t.id).some((e) => e.message.startsWith('owner-gate:')),
    {
      gate: 'owner',
      replies: [reviewReply('pass', 'fine', [OUT_OF_ORDER]), ownerApproves],
      inspect: (store, t, n) => {
        calls = n;
        gateLines = store.eventsForTask(t.id).map((e) => e.message).filter((m) => m.startsWith('owner-gate:')).join('\n');
      },
    },
  );
  assert.equal(after.status, 'awaiting-approval', 'the owner did not sign it off');
  assert.match(gateLines, /hard-human: review issues could not be filed \(epic depth\/cap\) — a person decides/);
  assert.match(after.error ?? '', /REVIEW ISSUES NOT FILED .*folder changes apply out of order/, 'the note a person reads is still there');
  assert.equal(calls, 1, 'only the reviewer was called; the owner never was');
});

test('a fail-at-depth round\'s unfiled issues still reach the gate note of the pass that follows', async () => {
  const after = await deepTicketThroughScheduler((t) => t.status === 'awaiting-approval' || t.status === 'failed', {
    replies: [reviewReply('fail', 'the readme line is wrong', [OUT_OF_ORDER]), reviewReply('pass', 'fixed')],
  });
  assert.equal(after.status, 'awaiting-approval');
  assert.equal(after.repairs, 1, 'precondition: one fail round, then the pass');
  assert.match(after.error ?? '', /REVIEW ISSUES NOT FILED .*folder changes apply out of order/);
});

test('same-repo dedupe compares resolved paths: a relative spelling of the same checkout is the same repo', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const title = 'Overlapping projectsBase changes release the settings hold too early';
  const stub = stubClaude([reviewReply('pass', 'fine', [{ title, prompt: 'p', severity: 'normal', role: 'dev' }])]);
  const store = new Store(':memory:');
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-samerepo-'));
  try {
    const epic = store.addTask({ title: 'epic', prompt: 'x', runner: 'echo' });
    const earlier = store.addTask({ title: 'Overlapping projectsBase changes release the settings-save hold early', prompt: 'x', runner: 'echo', parentId: epic.id, repo: path.relative(process.cwd(), abs) });
    const t = ticket(store, { playbook: 'solo', parentId: epic.id, repo: abs });
    const out = (await crewReview({ ...t, store, diff: DIFF }))!;
    assert.deepEqual(out.filed, [], `deduped against ${earlier.id}`);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, abs]);
  }
});

test('a re-check settling a parked ticket keeps the unfiled-issue note alongside its own', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verifyEnabled: false });
  try {
    const t = store.addTask({ title: 't', prompt: 'x', runner: 'echo' });
    const run = store.startRun(t.id);
    store.record({ taskId: t.id, runId: run.id, type: 'warning', message: `${DROPPED_ISSUE_PREFIX} [normal] folder changes apply out of order (3 parents deep, max 3)\nbody` });
    store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
    store.setStatus(t.id, 'awaiting-approval', 'provisional pass from stepped-down models');
    const split = store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'split', disagreement: true, council: [], chairSummary: 'two views' });
    sched['settleRecheck'](t.id, split);
    const note = store.getTask(t.id)!.error ?? '';
    assert.match(note, /^council split — two views \| REVIEW ISSUES NOT FILED \(1\) \(epic depth limit\)/, 'appended, not replaced');
  } finally {
    await sched.stop();
    store.close();
  }
});

test('droppedNote lists every title before any body, and says what it cut', () => {
  const events = Array.from({ length: 6 }, (_, i) => ({
    message: `${DROPPED_ISSUE_PREFIX} [normal] issue number ${i} (3 parents deep, max 3)\n${'body text '.repeat(30)}${i}`,
  }));
  const note = droppedNote(events, 't_abc')!;
  assert.ok(note.length <= 1000);
  assert.match(note, /^REVIEW ISSUES NOT FILED \(6\) \(epic depth limit\) — decide at approval: /);
  for (let i = 0; i < 6; i++) assert.match(note, new RegExp(`issue number ${i}`), `title ${i} is there`);
  // Too little room for all six titles: the tail counts what was cut and says where to look.
  const tight = droppedNote(events, 't_abc', 260)!;
  assert.ok(tight.length <= 260, tight);
  const shown = (tight.match(/issue number \d/g) ?? []).length;
  assert.ok(shown >= 1 && shown < 6);
  assert.match(tight, new RegExp(`… \\+${6 - shown} more — foreman show t_abc$`));
  assert.doesNotMatch(tight, /body text/, 'no body while a title is missing');
});

test('a crew fail in the verify lane queues a repair round carrying the critique', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', 'the README line says nothing the ticket asked for')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  let councilCalls = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    // Stubbed to a pass, and under 'always' never called at all: the chain runs
    // first and its verdict is the one the run carries.
    verify: async ({ task, runId }) => {
      councilCalls++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme',
      prompt: "printf 'crew\\n' >> README.md",
      kind: 'code',
      runner: 'shell',
      repo,
      role: 'dev',
      playbook: 'solo',
      acceptance: 'the readme documents the auth flow',
    });
    await settle(sched, () => store.getTask(t.id)!.repairs > 0);
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'queued', 'a crew fail goes back through the existing repair loop');
    assert.match(after.repairNotes ?? '', /the README line says nothing the ticket asked for/);
    assert.match(after.repairNotes ?? '', /code-review/);

    const verdicts = store.verdictsForTask(t.id);
    assert.equal(verdicts.find((v) => v.source === 'crew')?.verdict, 'fail');
    assert.equal(councilCalls, 0, "under 'always' the council is skipped: the chain overrides it either way");
    assert.equal(verdicts.filter((v) => v.source === 'council').length, 0);
    assert.equal(store.latestRun(t.id)!.verdict, 'fail', 'the crew verdict is the run verdict');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('a crew pass in the verify lane parks the ticket at the gate like any other', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'does exactly what the ticket asked')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme',
      prompt: "printf 'crew\\n' >> README.md",
      kind: 'code',
      runner: 'shell',
      repo,
      role: 'dev',
      playbook: 'solo',
      acceptance: 'the readme mentions the crew',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
    assert.equal(store.getTask(t.id)!.repairs, 0);
    assert.ok(stub.count() >= 1, 'the crew chain really ran');
    assert.equal(store.verdictsForTask(t.id).find((v) => v.source === 'crew')?.verdict, 'pass');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

// ------------------------------------------- council skip under 'always'

test('the council leads under escalate and follows under always', () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE, 'solo.md': SOLO });
  try {
    delete process.env['FOREMAN_CREW_REVIEW'];
    assert.equal(crewLeadsVerify({ playbook: 'soft' }), false, 'escalate keeps the council as the cheap gate');

    process.env['FOREMAN_CREW_REVIEW'] = 'always';
    assert.equal(crewLeadsVerify({ playbook: 'soft' }), true);
    assert.equal(crewLeadsVerify({ playbook: 'solo' }), true);
    assert.equal(crewLeadsVerify({ playbook: null }), false, 'a task with no playbook has no chain to lead with');
    assert.equal(crewLeadsVerify({ playbook: 'nonexistent' }), false);
  } finally {
    cleanup([pbDir]);
  }
});

test('a chain that lost a reviewer does not pass on the survivors alone — it is recorded as a split', async () => {
  // Same renormalising the council refuses (council.ts lost-seat split): one
  // usable PASS is not the chain passing. Returning null left the council's
  // verdict to stand, and a council pass would merge unread work.
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(
    [
      reviewReply('pass', 'reads fine', [
        { title: 'log the rejected token', prompt: 'add a structured log line on every 401', severity: 'normal', role: 'dev' },
      ]),
      envelope('I would rather not review this today'),
    ],
    ['REVIEW STYLE (code-review)', 'REVIEW STYLE (devils-advocate)'],
  );
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const notes: string[] = [];
    const out = await crewReview({ task, runId, store, diff: DIFF, council: null, onNote: (l) => notes.push(l) });
    assert.equal(stub.count(), 2, 'both reviewers were asked');
    assert.equal(out?.verdict, 'split', 'held for a person, not a pass');
    assert.deepEqual(store.verdictsForTask(task.id).map((v) => v.verdict), ['split'], 'the crew row says split');
    assert.ok(notes.some((n) => /gave no usable answer and the rest passed/.test(n)), notes.join('\n'));

    // Not silent: the ledger and the timeline show the review that did not finish.
    const missed = store.receiptsForTask(task.id).find((r) => String(r['kind']) === 'review:incomplete');
    assert.ok(missed, 'a $0 receipt marks the incomplete review');
    assert.equal(Number(missed!['cost_usd']), 0);
    assert.ok(
      store.eventsForTask(task.id).some((e) => e.type === 'error' && /crew review incomplete: planner \(devils-advocate\)/.test(e.message)),
      'the board sees an error event naming the lost reviewer',
    );
    // The survivor's follow-up is still the chain's point: filed now, or never
    // (its cached review would replay the issue as already filed).
    assert.deepEqual(store.childrenOf(task.id).map((c) => c.title), ['log the rejected token']);

    // The repair round re-reviews the same work: the survivor replays from
    // cache, and its issue — filed the round it was paid for — is not offered
    // for filing again (so it never even reaches the title dedupe).
    const again: string[] = [];
    const second = await crewReview({
      task, runId: store.startRun(task.id).id, store, diff: DIFF, council: null, onNote: (l) => again.push(l),
    });
    assert.equal(second?.verdict, 'split');
    assert.ok(again.some((n) => /\[cached, \$0\]/.test(n)), again.join('\n'));
    assert.ok(!again.some((n) => /already filed under/.test(n)), again.join('\n'));
    assert.equal(store.childrenOf(task.id).length, 1);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a chain that lost a reviewer still fails on a surviving FAIL — failing closed is the safe direction', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(
    [reviewReply('fail', 'the token check is inverted'), envelope('I would rather not review this today')],
    ['REVIEW STYLE (code-review)', 'REVIEW STYLE (devils-advocate)'],
  );
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = await crewReview({ task, runId, store, diff: DIFF, council: null });
    assert.equal(out?.verdict, 'fail');
    assert.ok(out!.reviews[1]!.error, 'the skipped reviewer is recorded as unavailable');
    assert.equal(out!.record.council.length, 1, 'only reviewers that answered are on the verdict row');
    // A FAIL that stands is still a partial review, and says so.
    assert.ok(store.receiptsForTask(task.id).some((r) => String(r['kind']) === 'review:incomplete'));
    assert.ok(
      store.eventsForTask(task.id).some((e) => e.type === 'error' && /the rest found a reason to fail it, so the chain goes on as a FAIL/.test(e.message)),
    );
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a chain that lost a reviewer still fails on a blocker raised on a surviving pass', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude(
    [
      reviewReply('pass', 'fine apart from one thing', [
        { title: 'secret in the log line', prompt: 'redact the token before logging', severity: 'blocker', role: 'dev' },
      ]),
      envelope('I would rather not review this today'),
    ],
    ['REVIEW STYLE (code-review)', 'REVIEW STYLE (devils-advocate)'],
  );
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = await crewReview({ task, runId, store, diff: DIFF, council: null });
    assert.equal(out?.verdict, 'fail', 'a blocker cannot ride a pass, lost reviewer or not');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a three-reviewer chain that lost one and split the rest fails — one PASS among the survivors is not enough', async () => {
  const TRIO = SOFTWARE.replace(
    '"reviewers": [',
    '"reviewers": [\n    {\n      "role": "senior",\n      "style": "peer-review"\n    },',
  );
  assert.notEqual(TRIO, SOFTWARE, 'the fixture really has a third reviewer');
  const pbDir = withPlaybooks({ 'soft.md': TRIO });
  const stub = stubClaude(
    [
      reviewReply('pass', 'reads fine'),
      envelope('I would rather not review this today'),
      reviewReply('fail', 'the 401 path never runs: the guard returns null first'),
    ],
    ['REVIEW STYLE (code-review)', 'REVIEW STYLE (devils-advocate)', 'REVIEW STYLE (peer-review)'],
  );
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const out = await crewReview({ task, runId, store, diff: DIFF, council: null });
    assert.equal(stub.count(), 3, 'all three reviewers were asked');
    assert.equal(out?.verdict, 'fail', 'a surviving FAIL decides even beside a surviving PASS');
    assert.equal(out!.record.council.length, 2);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a cancel landing while one reviewer is still out is not a lost reviewer', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  // The devil's advocate never answers on its own; the task is canceled once its call is open.
  const { dir, started } = slowAdvocate();
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const ac = new AbortController();
    const notes: string[] = [];
    const review = crewReview({ task, runId, store, diff: DIFF, council: null, signal: ac.signal, onNote: (l) => notes.push(l) });
    await waitUntil(() => fs.existsSync(started));
    abortFor(ac, 'cancel');
    const out = await review;
    assert.equal(out, null);
    const kinds = store.receiptsForTask(task.id).map((r) => String(r['kind']));
    assert.ok(!kinds.includes('review:incomplete') && !kinds.includes('review:unavailable'), kinds.join(','));
    assert.ok(!store.eventsForTask(task.id).some((e) => e.type === 'error'), 'a cancel is not an error on the timeline');
    assert.match(notes.join('\n'), /the run was canceled before every reviewer answered/);
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test('work the council could not reach parks saying a crew reviewer passed it, not that nothing read it', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'reads fine'), envelope('I would rather not review this today')], SOFT_KEYS);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const down = { provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0, critique: '', costUsd: 0, latencyMs: 0, error: 'connect ECONNREFUSED' };
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'split', disagreement: false,
      council: [{ model: 'local-a', ...down }, { model: 'local-b', ...down }],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'partial\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
    const note = store.getTask(t.id)!.error ?? '';
    // The chain now gives its own verdict (a split), so the gate is not told nothing was reviewed.
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval');
    assert.equal(store.verdictsForTask(t.id)[0]?.verdict, 'split');
    assert.match(store.verdictsForTask(t.id)[0]?.critique ?? '', /planner \(devils-advocate\) gave no usable answer/, 'the gate names the lost reviewer');
    assert.doesNotMatch(note, /^UNREVIEWED/);
    assert.doesNotMatch(note, /nothing has read this work/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

/** Escalate mode, a council stub with the given verdict, and a crew chain whose devil's advocate gives no usable answer. */
async function lostReviewerUnderCouncil(councilVerdict: 'pass' | 'fail'): Promise<{ task: Task; store: Store; calls: number }> {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  // A chair asked here would rule PASS: the council's FAIL must stand without asking one.
  const stub = stubClaude(
    [reviewReply('pass', 'reads fine'), envelope('I would rather not review this today'), chairReply('pass', 'fine by me')],
    SOFT_KEYS,
  );
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'escalate';
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => council(store, runId, task.id, councilVerdict),
  });
  try {
    // Past SMALL_DIFF_LINES, so a unanimous council pass does not skip the chain.
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\\n');
    const t = store.addTask({
      title: 'touch the readme', prompt: `printf '${lines}\\n' >> README.md`, kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval' || store.getTask(t.id)!.repairs > 0);
    return { task: store.getTask(t.id)!, store, calls: stub.count() };
  } finally {
    await sched.stop();
    cleanup([pbDir, stub.dir, repo]);
  }
}

test("a crew chain that lost a reviewer while the rest passed cannot soften a council FAIL: the repair round runs", async () => {
  const { task, store, calls } = await lostReviewerUnderCouncil('fail');
  try {
    assert.equal(task.repairs, 1, 'the council FAIL path: one repair round');
    assert.equal(task.status, 'queued');
    assert.match(task.repairNotes ?? '', /the local council disliked it/);
    assert.equal(calls, 2, 'no chair was asked to overrule the council on a partial chain');
    assert.deepEqual(store.verdictsForTask(task.id).map((v) => [v.source, v.verdict]), [['council', 'fail']], 'no crew row over the FAIL');
    assert.ok(store.eventsForTask(task.id).some((e) => e.type === 'error' && /devils-advocate\) gave no usable answer.*the council's FAIL stands/.test(e.message)));
  } finally {
    store.close();
  }
});

test('a crew chain that lost a reviewer while the rest passed parks a council PASS as a split naming the lost reviewer', async () => {
  const { task, store } = await lostReviewerUnderCouncil('pass');
  try {
    assert.equal(task.status, 'awaiting-approval');
    assert.equal(task.repairs, 0);
    const crew = store.verdictsForTask(task.id).find((v) => v.source === 'crew');
    assert.equal(crew?.verdict, 'split', "the crew split, not the council's pass, is the verdict at the gate");
    assert.equal(store.latestRun(task.id)!.verdict, 'split');
    assert.match(crew?.critique ?? '', /planner \(devils-advocate\) gave no usable answer/, 'the person at the gate sees which reviewer was lost');
  } finally {
    store.close();
  }
});

test("the chair's share of a two-reviewer chain is a third of the chain's budget", async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  // Both reviewers pass; the chair (the one call that is no reviewer) never answers and is killed at its share.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-chair-'));
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'pass.json'), reviewReply('pass', 'fine'));
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\necho x >> "${calls}"\ncase "$*" in *'REVIEW STYLE ('*) cat "${dir}/pass.json";; *) exec sleep 30;; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const spawned = (): number => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    // First the reviewers answer with no budget and no council, so no chair: their replies go into the review cache.
    // On the timed run below they come from that cache and never spawn, so however loaded the machine, no reviewer
    // can run past its share; the chair's own timer is all that is left, and a late timer still names its share.
    const warm = await crewReview({ task, runId, store, diff: DIFF, council: null });
    assert.equal(warm?.verdict, 'pass');
    assert.equal(spawned(), 2, 'the two reviewers were asked, and no chair');
    const notes: string[] = [];
    // The council's FAIL against the chain's PASS is a disagreement, so the chair is asked.
    await crewReview({ task, runId, store, diff: DIFF, council: council(store, runId, task.id, 'fail'), timeoutMs: 4_500, onNote: (l) => notes.push(l) });
    assert.equal(spawned(), 3, 'only the chair was spawned on the timed run');
    assert.equal(store.receiptsForTask(task.id).filter((r) => r['kind'] === 'review:cache').length, 2, 'both reviewers came from the cache');
    assert.match(notes.join('\n'), /chair unavailable, chain verdict stands: owner call timed out after 1500ms/, notes.join('\n'));
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test('a chain stopped after its survivor FAILED the work never parks saying a crew reviewer passed it', { timeout: 60_000 }, async () => {
  // Escalate mode, the council unreachable: the chain runs, loses its devil's
  // advocate, and its survivor FAILs — then the daemon stops while the chair
  // (called for the consecutive failure) is still thinking. The chain comes
  // back null, but the one reviewer who read the work said it was wrong.
  const chairAfterOne = SOFTWARE.replace('"afterFailures": 2', '"afterFailures": 1');
  assert.notEqual(chairAfterOne, SOFTWARE);
  const pbDir = withPlaybooks({ 'soft.md': chairAfterOne });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-stop-'));
  fs.writeFileSync(path.join(dir, 'fail.json'), reviewReply('fail', 'the guard is inverted'));
  fs.writeFileSync(path.join(dir, 'junk.json'), envelope('I would rather not'));
  fs.writeFileSync(path.join(dir, 'chair.json'), chairReply('fail', 'agree'));
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$*" in *"You chair the"*) touch "${dir}/chair-started"; sleep 30; cat "${dir}/chair.json";; *devils-advocate*) cat "${dir}/junk.json";; *) cat "${dir}/fail.json";; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const down = { provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0, critique: '', costUsd: 0, latencyMs: 0, error: 'connect ECONNREFUSED' };
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'split', disagreement: false,
      council: [{ model: 'local-a', ...down }, { model: 'local-b', ...down }],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.eventsForTask(t.id).some((e) => /crew review incomplete/.test(e.message)));
    await settle(sched, () => fs.existsSync(path.join(dir, 'chair-started'))); // the chair is out
    await sched.stop();
    assert.doesNotMatch(store.getTask(t.id)!.error ?? '', /a crew reviewer passed it/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

/**
 * A claude stand-in whose devil's advocate sleeps past any test (only an abort ends it), so a run can be stopped
 * mid-chain. `started` appears once the advocate's call is really open: gate a stop, cancel or deadline on it, not on
 * a timer.
 */
function slowAdvocate(): { dir: string; started: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-slowadv-'));
  const started = path.join(dir, 'advocate-started');
  fs.writeFileSync(path.join(dir, 'pass.json'), reviewReply('pass', 'fine'));
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ncase "$*" in *devils-advocate*) touch "${started}"; sleep 30;; esac\ncat "${dir}/pass.json"\n`);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  return { dir, started };
}

test('a cancel during the crew chain, after a council FAIL, is not undone by a repair round', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = { provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0.8, critique: 'off by one', costUsd: 0, latencyMs: 1 };
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    // Escalate mode: the council FAILs, so the chain runs after it.
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'fail', disagreement: false, critique: 'off by one',
      council: [{ model: 'a', ...op }, { model: 'b', ...op }],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    assert.ok(store.getTask(t.id)!.maxRepairs >= 1, 'a repair round is available, so only the guard can stop one');
    await settle(sched, () => store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'));
    await settle(sched, () => fs.existsSync(path.join(dir, 'advocate-started'))); // the devil's advocate is out
    store.cancel(t.id);
    // Wait for the run itself to end — not activeCount, which counts only the
    // work lane — and without ticking, so a wrongly requeued task cannot start.
    const until = Date.now() + 15_000;
    while (store.latestRun(t.id)!.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'canceled', 'the operator canceled it');
    assert.equal(after.repairs, 0, 'no repair round was queued');
    assert.equal(store.latestRun(t.id)!.status, 'canceled');
    await sched.stop(); // the run's cleanup (and any jail removal) has finished once this returns
    assert.ok(fs.existsSync(store.latestRun(t.id)!.worktreePath!), 'the jail is left for inspection');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a daemon stop during the crew chain requeues the ticket for when the daemon is back', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'ollama', local: true, verdict, confidence: 0.8, critique: verdict, costUsd: 0, latencyMs: 1 });
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    // A chair-ruled council PASS is not unanimous, so the chain runs (escalate).
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'pass', disagreement: true, chairSummary: 'the FAIL misread the diff', critique: 'ok',
      council: [op('pass'), op('fail')],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'));
    await settle(sched, () => fs.existsSync(path.join(dir, 'advocate-started')));
    await sched.stop(); // a launchd restart, an upgrade
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'queued', 'half a review is not parked as a review; the task runs again');
    assert.match(after.error ?? '', /daemon stopped mid-run/);
    assert.equal(store.latestRun(t.id)!.status, 'canceled');
    assert.ok(fs.existsSync(store.latestRun(t.id)!.worktreePath!), 'the finished work is kept, not deleted');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a cancel then an immediate retry: the canceled run neither parks nor repairs on top of the retry', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = { provider: 'ollama', local: true, verdict: 'fail' as const, confidence: 0.8, critique: 'off by one', costUsd: 0, latencyMs: 1 };
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'fail', disagreement: false, critique: 'off by one',
      council: [{ model: 'a', ...op }, { model: 'b', ...op }],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'));
    await settle(sched, () => fs.existsSync(path.join(dir, 'advocate-started')));
    const canceledRun = store.latestRun(t.id)!.id;
    store.cancel(t.id);
    store.retry(t.id); // back-to-back: the task is `queued` before the old run reaches the gate
    const until = Date.now() + 15_000;
    while (store.getRun(canceledRun)!.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getRun(canceledRun)!.status, 'canceled');
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'queued', 'the retry stands');
    assert.equal(after.repairs, 0, 'no repair round on top of it');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a daemon stop during the non-binding shadow review interrupts nothing: the crew verdict parks as usual', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'reads fine'), reviewReply('pass', 'no objections')], SOFT_KEYS);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  process.env['FOREMAN_SHADOW_LOCAL'] = '1';
  let shadowStarted = false;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    // Only the shadow reaches the local council here (the crew leads); it takes its time.
    verify: async ({ task, runId }) => {
      shadowStarted = true;
      await new Promise((r) => setTimeout(r, 3_000));
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => shadowStarted);
    await sched.stop();
    const after = store.getTask(t.id)!;
    assert.equal(after.status, 'awaiting-approval');
    assert.doesNotMatch(after.error ?? '', /interrupted/, 'the binding review had finished');
    assert.equal(store.latestRun(t.id)!.status, 'succeeded');
    assert.equal(store.latestRun(t.id)!.verdict, 'pass');
    assert.ok(fs.existsSync(store.latestRun(t.id)!.worktreePath!), 'the worktree is kept');
  } finally {
    delete process.env['FOREMAN_SHADOW_LOCAL'];
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test("a reviewer cut off by the run's own deadline is recorded as missing, not passed over in silence", { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  // The deadline is fired by what the chain is doing, not by a timer: the advocate's call is open (the stub says so)
  // and the other reviewer's answer is on record — its 'review' receipt is written as its call returns, so from then
  // on it is a survivor whatever the deadline does. A marker the stub writes after its reply is not enough: the abort
  // can beat the parent reading that reply, and then no reviewer survives and the split is never reached.
  // The advocate sleeps far past the test's own timeout.
  const started = path.join(dir, 'advocate-started');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ncase "$*" in *devils-advocate*) touch "${started}"; sleep 120;; esac\ncat "${dir}/pass.json"\n`);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const ac = new AbortController();
    const review = crewReview({ task, runId, store, diff: DIFF, council: null, signal: ac.signal });
    const answered = (): boolean => store.receiptsForTask(task.id).some((r) => String(r['kind']) === 'review');
    while (!(fs.existsSync(started) && answered())) await new Promise((r) => setTimeout(r, 10));
    abortFor(ac, 'deadline');
    const out = await review;
    // The absence is recorded, and the chain does not pass: the survivor passed, which is not the chain passing.
    const kinds = store.receiptsForTask(task.id).map((r) => String(r['kind']));
    assert.ok(kinds.includes('review:incomplete'), kinds.join(','));
    assert.equal(out?.verdict, 'split', 'the survivor passed, which is not the chain passing');
    assert.ok(store.eventsForTask(task.id).some((e) => e.type === 'error' && /crew review incomplete/.test(e.message)));
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test('a cancel while the chair is deciding writes no crew verdict', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-slowchair-'));
  fs.writeFileSync(path.join(dir, 'fail.json'), reviewReply('fail', 'the guard is inverted'));
  fs.writeFileSync(path.join(dir, 'chair.json'), chairReply('fail', 'agree'));
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$*" in *"You chair the"*) touch "${dir}/chair-started"; sleep 30; cat "${dir}/chair.json";; *) cat "${dir}/fail.json";; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    // 'always', or a unanimous council pass on a small diff skips the chain outright.
    process.env['FOREMAN_CREW_REVIEW'] = 'always';
    const passed = council(store, runId, task.id, 'pass'); // the crew will disagree, so the chair is called
    const before = store.verdictsForTask(task.id).length;
    const ac = new AbortController();
    const review = crewReview({ task, runId, store, diff: DIFF, council: passed, signal: ac.signal });
    await waitUntil(() => fs.existsSync(path.join(dir, 'chair-started')));
    abortFor(ac, 'cancel');
    const out = await review;
    assert.equal(out, null);
    assert.equal(store.verdictsForTask(task.id).length, before, 'no crew row for a canceled task');
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test("a deadline while the chair is deciding keeps the chain's FAIL: out of time is not withdrawn", { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-deadchair-'));
  fs.writeFileSync(path.join(dir, 'fail.json'), reviewReply('fail', 'the guard is inverted'));
  fs.writeFileSync(path.join(dir, 'chair.json'), chairReply('pass', 'fine'));
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$*" in *"You chair the"*) touch "${dir}/chair-started"; sleep 30; cat "${dir}/chair.json";; *) cat "${dir}/fail.json";; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    process.env['FOREMAN_CREW_REVIEW'] = 'always'; // or the unanimous council pass skips the chain
    const passed = council(store, runId, task.id, 'pass');
    const ac = new AbortController();
    const review = crewReview({ task, runId, store, diff: DIFF, council: passed, signal: ac.signal });
    await waitUntil(() => fs.existsSync(path.join(dir, 'chair-started')));
    abortFor(ac, 'deadline');
    const out = await review;
    assert.equal(out?.verdict, 'fail', 'the chain said FAIL; the chair never ruled');
    assert.equal(store.verdictsForTask(task.id)[0]!.source, 'crew', 'and that is the newest row the gate reads');
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test('a daemon stop mid-fan-out is not a lost reviewer either', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    const ac = new AbortController();
    const review = crewReview({ task, runId, store, diff: DIFF, council: null, signal: ac.signal });
    await waitUntil(() => fs.existsSync(path.join(dir, 'advocate-started')));
    abortFor(ac, 'stop');
    const out = await review;
    assert.equal(out, null);
    const kinds = store.receiptsForTask(task.id).map((r) => String(r['kind']));
    assert.ok(!kinds.includes('review:incomplete') && !kinds.includes('review:unavailable'), kinds.join(','));
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test("a run that reaches its own deadline mid-review parks with the verdict it has — it is not requeued", { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir, started } = slowAdvocate();
  // Both reviewers sleep far past the test; the deadline is hand-fired once both calls are open (test/fakeclock.ts),
  // so the review has not settled when it comes: the case where a deadline must not be read as a daemon stop.
  const seniorStarted = path.join(dir, 'senior-started');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ncase "$*" in *devils-advocate*) touch "${started}"; sleep 120;; *) touch "${seniorStarted}"; sleep 120;; esac\n`);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'ollama', local: true, verdict, confidence: 0.8, critique: verdict, costUsd: 0, latencyMs: 1 });
  const deadline = new HandFiredDeadline();
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    taskTimeoutMs: 600_000,
    runClock: deadline.clock,
    verify: async ({ task, runId }) => store.addVerdict({
      runId, taskId: task.id, verdict: 'pass', disagreement: true, chairSummary: 'the FAIL misread the diff', critique: 'ok',
      council: [op('pass'), op('fail')],
    }),
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => fs.existsSync(started) && fs.existsSync(seniorStarted));
    deadline.expire();
    await settle(sched, () => {
      const run = store.latestRun(t.id);
      return Boolean(run) && run!.status !== 'running';
    });
    assert.equal(store.getTask(t.id)!.status, 'awaiting-approval', 'out of time is the degrade path, not a daemon stop');
    const kinds = store.receiptsForTask(t.id).map((r) => String(r['kind']));
    assert.ok(kinds.includes('review:unavailable'), `the cut-off review is on record: ${kinds.join(',')}`);
    assert.ok(store.eventsForTask(t.id).some((e) => /crew review unusable/.test(e.message)), 'and it parks with the council verdict it has');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a daemon stop requeues without spending an attempt; a ticket stopped again and again goes to the operator', { timeout: 60_000 }, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  let sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
  try {
    // One attempt only: a stop that spent it would fail the ticket (and its dependents and epic).
    const t = store.addTask({ title: 'slow', prompt: 'sleep 5', kind: 'code', runner: 'shell', repo, maxAttempts: 1 });
    for (let stop = 1; stop <= 4; stop++) {
      sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
      await settle(sched, () => store.getTask(t.id)!.status === 'running');
      await new Promise((r) => setTimeout(r, 200));
      await sched.stop();
      const after = store.getTask(t.id)!;
      assert.equal(after.attempts, 0, `stop ${stop}: the attempt is given back`);
      if (stop <= 3) {
        assert.equal(after.status, 'queued', `stop ${stop}: requeued`);
      } else {
        assert.equal(after.status, 'awaiting-human', 'stopped mid-run a fourth time: the operator decides, nothing fails');
        assert.match(after.error ?? '', /interrupted by 4 daemon stops/);
      }
    }
  } finally {
    await sched.stop();
    store.close();
    cleanup([repo]);
  }
});

test('a stopping daemon claims nothing: a tick during shutdown starts no run', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1 });
  try {
    await sched.stop();
    const t = store.addTask({ title: 'late', prompt: 'x', runner: 'echo' });
    await sched.tick();
    assert.equal(store.getTask(t.id)!.status, 'queued');
    assert.equal(store.latestRun(t.id), null);
  } finally {
    store.close();
  }
});

test('a cancel that lands after the deadline still reads as a cancel: no verdict, no follow-up tickets', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-lateCancel-'));
  fs.writeFileSync(path.join(dir, 'fail.json'), reviewReply('fail', 'the guard is inverted', [
    { title: 'Invert the guard', prompt: 'the token check is backwards', severity: 'normal', role: 'dev' },
  ]));
  fs.writeFileSync(path.join(dir, 'chair.json'), chairReply('fail', 'agree'));
  // A chair that shrugs off SIGTERM, so the chain is still settling when the cancel lands.
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$*" in *"You chair the"*) trap '' TERM; touch "${dir}/chair-started"; sleep 30; cat "${dir}/chair.json";; *) cat "${dir}/fail.json";; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    process.env['FOREMAN_CREW_REVIEW'] = 'always';
    const passed = council(store, runId, task.id, 'pass');
    const before = store.verdictsForTask(task.id).length;
    const ac = new AbortController();
    const review = crewReview({ task, runId, store, diff: DIFF, council: passed, signal: ac.signal });
    let reviewSettled = false;
    void review.then(() => { reviewSettled = true; }, () => { reviewSettled = true; });
    await waitUntil(() => fs.existsSync(path.join(dir, 'chair-started')));
    abortFor(ac, 'deadline');
    // Let the deadline's abort run its course first (listeners, the SIGTERM the chair shrugs off), then cancel. The
    // chair only ends at the SIGKILL escalation, seconds later, so the chain is provably still settling here.
    await new Promise((r) => setImmediate(r));
    assert.equal(reviewSettled, false, 'the cancel lands while the deadline-cut chain is still settling');
    abortFor(ac, 'cancel');
    const out = await review;
    assert.equal(out, null);
    assert.equal(store.verdictsForTask(task.id).length, before, 'no crew row for a canceled task');
    assert.equal(store.childrenOf(task.id).length, 0, 'no follow-up ticket escapes the cancel');
  } finally {
    store.close();
    cleanup([pbDir, dir]);
  }
});

test('a stop and a cancel together end as a cancel, whichever came first', { timeout: 60_000 }, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
  try {
    const t = store.addTask({ title: 'slow', prompt: 'sleep 5', kind: 'code', runner: 'shell', repo });
    await settle(sched, () => store.latestRun(t.id)?.status === 'running');
    const stopping = sched.stop();
    store.cancel(t.id);
    await stopping;
    assert.equal(store.getTask(t.id)!.status, 'canceled', 'the operator canceled it; it is not requeued');
  } finally {
    await sched.stop();
    store.close();
    cleanup([repo]);
  }
});

test('cancel then Retry while the run is still dying: the retry stands', { timeout: 60_000 }, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
  try {
    const t = store.addTask({ title: 'slow', prompt: 'sleep 5', kind: 'code', runner: 'shell', repo });
    await settle(sched, () => store.latestRun(t.id)?.status === 'running');
    const dying = store.latestRun(t.id)!.id;
    store.cancel(t.id);
    store.retry(t.id);
    const until = Date.now() + 15_000;
    while (store.getRun(dying)!.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getRun(dying)!.status, 'canceled');
    assert.equal(store.getTask(t.id)!.status, 'queued', 'the old run does not re-cancel a task the operator retried');
  } finally {
    await sched.stop();
    store.close();
    cleanup([repo]);
  }
});

test('a daemon stop while the crew chain leads asks no fallback council either', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  let councilCalls = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => {
      councilCalls++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'));
    await settle(sched, () => fs.existsSync(path.join(dir, 'advocate-started')));
    await sched.stop();
    assert.equal(councilCalls, 0);
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a daemon stop while the crew chair is deciding writes no crew verdict, and the task is requeued', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE.replace('"afterFailures": 2', '"afterFailures": 1') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrev-stopchair-'));
  fs.writeFileSync(path.join(dir, 'fail.json'), reviewReply('fail', 'the guard is inverted'));
  fs.writeFileSync(path.join(dir, 'chair.json'), chairReply('fail', 'agree'));
  fs.writeFileSync(
    path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$*" in *"You chair the"*) touch "${dir}/chair-started"; sleep 30; cat "${dir}/chair.json";; *) cat "${dir}/fail.json";; esac\n`,
  );
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = path.join(dir, 'claude');
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.receiptsForTask(t.id).filter((r) => String(r['kind']) === 'review').length >= 2);
    await settle(sched, () => fs.existsSync(path.join(dir, 'chair-started'))); // the chair (called on the first failure) is out
    await sched.stop();
    assert.equal(store.verdictsForTask(t.id).filter((v) => v.source === 'crew').length, 0);
    assert.equal(store.getTask(t.id)!.status, 'queued');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a run canceled while the crew chain leads asks no fallback council', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  let councilCalls = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => {
      councilCalls++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'));
    await settle(sched, () => fs.existsSync(path.join(dir, 'advocate-started')));
    store.cancel(t.id);
    await sched.stop();
    assert.equal(councilCalls, 0, 'nobody would act on what a fallback council said');
    assert.equal(store.verdictsForTask(t.id).length, 0);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('a run canceled while the council was reviewing does not go on to the crew chain', { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([reviewReply('pass', 'fine'), reviewReply('pass', 'fine')], SOFT_KEYS);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'ollama', local: true, verdict, confidence: 0.8, critique: verdict, costUsd: 0, latencyMs: 1 });
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    // The operator cancels while the (escalate-mode) council is still answering.
    verify: async ({ task, runId }) => {
      store.cancel(task.id);
      return store.addVerdict({
        runId, taskId: task.id, verdict: 'pass', disagreement: true, chairSummary: 'the FAIL misread the diff', critique: 'ok',
        council: [op('pass'), op('fail')],
      });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'canceled' && store.latestRun(t.id)?.status !== 'running');
    await sched.stop();
    assert.equal(stub.count(), 0, 'no reviewer was spawned for a canceled run');
    assert.ok(!store.eventsForTask(t.id).some((e) => e.type === 'stage' && e.message === 'crew review'), 'the chain never started');
    assert.deepEqual(store.receiptsForTask(t.id).map((r) => String(r['kind'])).filter((k) => k.startsWith('review')), []);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('cancel, Retry, Give to me — then a daemon stop: the ticket stays with the operator', { timeout: 60_000 }, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, maxWorkers: 1, verify: async () => null as never });
  try {
    const t = store.addTask({ title: 'slow', prompt: 'sleep 5', kind: 'code', runner: 'shell', repo });
    await settle(sched, () => store.latestRun(t.id)?.status === 'running');
    store.cancel(t.id);
    store.retry(t.id);
    store.reassign(t.id, 'human');
    await sched.stop(); // the old run is still dying when the daemon stops
    assert.equal(store.getTask(t.id)!.status, 'awaiting-human', 'not bounced back into the AI queue');
  } finally {
    await sched.stop();
    store.close();
    cleanup([repo]);
  }
});

test('a council aborted by a cancel writes no verdict on the run it belonged to', { timeout: 60_000 }, async () => {
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task }) => {
      store.cancel(task.id);
      throw new Error('council aborted before it reached a verdict');
    },
  });
  try {
    const t = store.addTask({ title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell', repo });
    await settle(sched, () => store.getTask(t.id)!.status === 'canceled' && store.latestRun(t.id)?.status !== 'running');
    await sched.stop();
    assert.equal(store.verdictsForTask(t.id).length, 0);
    assert.equal(store.latestRun(t.id)!.verdict, null);
  } finally {
    await sched.stop();
    store.close();
    cleanup([repo]);
  }
});

test("the run's own deadline cutting the chain mid-call is recorded like any absence (the timer names its cause)", { timeout: 60_000 }, async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const { dir } = slowAdvocate();
  // The advocate says when its call has begun, so the deadline can be made to come while that call is open.
  const started = path.join(dir, 'advocate-started');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ncase "$*" in *devils-advocate*) touch "${started}"; sleep 120;; esac\ncat "${dir}/pass.json"\n`);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const op = (verdict: 'pass' | 'fail') => ({ model: verdict, provider: 'ollama', local: true, verdict, confidence: 0.8, critique: verdict, costUsd: 0, latencyMs: 1 });
  // The run's deadline is hand-fired (test/fakeclock.ts): the budget is long, so the chain's calls' own timeouts
  // outlive it and it is the run's deadline, whenever the test fires it, that cuts the open call.
  const deadline = new HandFiredDeadline();
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    taskTimeoutMs: 600_000,
    runClock: deadline.clock,
    verify: async ({ task, runId }) => {
      return store.addVerdict({
        runId, taskId: task.id, verdict: 'pass', disagreement: true, chairSummary: 'the FAIL misread the diff', critique: 'ok',
        council: [op('pass'), op('fail')],
      });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'soft', acceptance: 'the readme mentions it',
    });
    await settle(sched, () => fs.existsSync(started));
    deadline.expire();
    await settle(sched, () => {
      const run = store.latestRun(t.id);
      return Boolean(run) && run!.status !== 'running';
    });
    const kinds = store.receiptsForTask(t.id).map((r) => String(r['kind']));
    assert.ok(kinds.includes('review:incomplete') || kinds.includes('review:unavailable'), `the cut-off review is on record: ${kinds.join(',')}`);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, dir, repo]);
  }
});

test('only the survivors-passed note reads as a partial PASS', async () => {
  const { isPartialPassNote } = await import('../src/verify/crewReview.ts');
  assert.equal(isPartialPassNote('crew review incomplete: planner (devils-advocate) gave no usable answer and the rest passed — keeping the council verdict'), true);
  assert.equal(isPartialPassNote('crew review incomplete: planner (devils-advocate) gave no usable answer — the rest found a reason to fail it, so the chain goes on as a FAIL'), false);
  assert.equal(isPartialPassNote('crew review unusable: no reviewer in the soft chain could be reached'), false);
});

test("an unavailable crew chain under 'always' falls back to the council, which still produces the verdict", async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  // The reviewer answers, but not the contract: unparseable is unavailable.
  const stub = stubClaude([envelope('I would rather not review this today')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  let councilCalls = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) => {
      councilCalls++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  try {
    const t = store.addTask({
      title: 'touch the readme',
      prompt: "printf 'fallback\\n' >> README.md",
      kind: 'code',
      runner: 'shell',
      repo,
      role: 'dev',
      playbook: 'solo',
      acceptance: 'the readme mentions the fallback',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');

    assert.ok(stub.count() >= 1, 'the chain was tried first');
    assert.equal(councilCalls, 1, 'a chain that cannot answer is exactly what the council is still there for');
    const verdicts = store.verdictsForTask(t.id);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.source, 'council');
    assert.equal(verdicts[0]!.verdict, 'pass');
    assert.equal(store.latestRun(t.id)!.verdict, 'pass', 'the run carries the fallback verdict');
    assert.match(
      store.eventsForTask(t.id).map((e) => e.message).join('\n'),
      /falling back to the local council/,
      'the timeline says which review actually decided',
    );
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

// ------------------------------------------------------------ crew report

test('the crew report scores each role on first-review pass rate, repairs and spend', () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const store = new Store(':memory:');
  try {
    // One ticket: a run (and a crew verdict) per review round, then closed.
    const seed = (role: string, rounds: Array<'pass' | 'fail'>, costUsd = 0.1): string => {
      const t = store.addTask({ title: `${role} ticket`, prompt: 'do the thing', runner: 'echo', role, playbook: 'soft' });
      for (const verdict of rounds) {
        const run = store.startRun(t.id);
        store.addVerdict({ runId: run.id, taskId: t.id, verdict, disagreement: false, council: [], source: 'crew' });
        store.endRun(run.id, 'succeeded', {});
      }
      store.addReceipt({ taskId: t.id, kind: 'review', provider: 'claude-cli', model: 'm', local: false, costUsd });
      store.setStatus(t.id, 'done');
      return t.id;
    };

    // dev (worker): 2 of 6 pass first time, the other 4 need a repair round.
    for (let i = 0; i < 2; i++) seed('dev', ['pass']);
    for (let i = 0; i < 4; i++) seed('dev', ['fail', 'pass']);
    // senior (senior tier): ten tickets, never a first-round failure.
    for (let i = 0; i < 10; i++) seed('senior', ['pass'], 0.5);
    // qa (worker): failing badly, but on three tickets — not evidence yet.
    for (let i = 0; i < 3; i++) seed('qa', ['fail', 'pass']);

    const rows = store.crewReport();
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    const dev = rows.find((r) => r.role === 'dev')!;
    assert.equal(dev.playbook, 'soft');
    assert.equal(dev.tickets, 6);
    assert.equal(dev.firstReviewed, 6);
    assert.ok(near(dev.firstPassRate!, 2 / 6), `first-review pass rate reads the FIRST verdict only: ${dev.firstPassRate}`);
    assert.ok(near(dev.avgRepairs, 4 / 6), `a second run on a ticket is a repair round: ${dev.avgRepairs}`);
    assert.ok(near(dev.costUsd, 0.6));
    assert.ok(near(dev.avgCostUsd, 0.1));

    const senior = rows.find((r) => r.role === 'senior')!;
    assert.equal(senior.tickets, 10);
    assert.equal(senior.firstPassRate, 1);
    assert.equal(senior.avgRepairs, 0);
    assert.ok(near(senior.avgCostUsd, 0.5));

    const advisories = crewAdvisories(rows);
    assert.equal(advisories.length, 2, `advisory lines: ${advisories.join(' | ')}`);
    assert.ok(
      advisories.some((l) => /^consider senior tier for dev in soft \(edit the playbook role tier\)/.test(l)),
      'a worker failing most first reviews is buying a repair round it could have skipped',
    );
    assert.ok(
      advisories.some((l) => /^consider worker tier for senior in soft \(edit the playbook role tier\)/.test(l)),
      'a senior that never fails one is paying for headroom nobody used',
    );
    assert.ok(!advisories.some((l) => l.includes(' qa ')), 'three tickets is not a sample');

    // Advisory only: the playbook on disk is untouched.
    assert.match(fs.readFileSync(path.join(pbDir, 'soft.md'), 'utf8'), /"dev": \{\s*"tier": "worker"/);
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

test('the crew report leaves a first round that lost a reviewer out of the pass rate, whichever way it went', () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const store = new Store(':memory:');
  try {
    let clock = 1_000;
    // rounds: 'pass'/'fail' is a complete crew verdict; 'lost+fail' is a crew
    // FAIL from a chain that lost a reviewer; 'lost' lost one and the rest
    // passed (no crew verdict); 'pass,lost-later' puts the receipt AFTER the
    // first verdict, in a later run.
    const seed = (rounds: string[]): void => {
      const t = store.addTask({ title: 'dev ticket', prompt: 'do the thing', runner: 'echo', role: 'dev', playbook: 'soft' });
      for (const round of rounds) {
        const run = store.startRun(t.id);
        if (round.startsWith('lost')) {
          store.addReceipt({ taskId: t.id, runId: run.id, kind: 'review:incomplete', provider: 'claude-cli', model: 'm', local: false, costUsd: 0 });
          store.db.prepare(`UPDATE receipts SET created_at = ? WHERE run_id = ?`).run(clock++, run.id);
        }
        const verdict = round === 'lost' ? null : round.endsWith('fail') ? 'fail' : 'pass';
        if (verdict) {
          store.addVerdict({ runId: run.id, taskId: t.id, verdict, disagreement: false, council: [], source: 'crew' });
          // Same run, but stamped BEFORE the receipt: only the run match can catch it.
          const at = round === 'lost+fail' ? clock - 10 : clock++;
          store.db.prepare(`UPDATE verdicts SET created_at = ? WHERE run_id = ?`).run(at, run.id);
        }
        store.endRun(run.id, 'succeeded', {});
      }
      store.setStatus(t.id, 'done');
    };
    seed(['pass']); // counted: pass
    seed(['fail', 'pass']); // counted: fail
    seed(['pass', 'lost']); // counted: pass (the lost round came after the first verdict)
    seed(['lost+fail', 'pass']); // out: the first verdict's own run lost a reviewer
    seed(['lost', 'fail']); // out: the round before the first verdict lost a reviewer
    seed(['lost']); // out: never got a crew verdict at all

    const dev = store.crewReport().find((r) => r.role === 'dev')!;
    // Counting the partial FAIL and the later complete verdicts would read 2/5.
    assert.equal(dev.firstReviewed, 3, 'only complete first rounds are in the sample');
    assert.ok(Math.abs(dev.firstPassRate! - 2 / 3) < 1e-9, `rate over complete first rounds: ${dev.firstPassRate}`);
    assert.equal(dev.firstIncomplete, 3);
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

test('the right-sizing thresholds hold their fire on thin or unremarkable evidence', () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const store = new Store(':memory:');
  try {
    const seed = (role: string, verdict: 'pass' | 'fail'): void => {
      const t = store.addTask({ title: `${role} ticket`, prompt: 'do the thing', runner: 'echo', role, playbook: 'soft' });
      const run = store.startRun(t.id);
      store.addVerdict({ runId: run.id, taskId: t.id, verdict, disagreement: false, council: [], source: 'crew' });
      store.endRun(run.id, 'succeeded', {});
      store.setStatus(t.id, 'done');
    };
    // dev: 4 of 5 pass — 80%, comfortably above the upgrade line.
    for (let i = 0; i < 4; i++) seed('dev', 'pass');
    seed('dev', 'fail');
    // senior: a perfect record, but only nine tickets of it.
    for (let i = 0; i < 9; i++) seed('senior', 'pass');
    // qa: never reviewed at all, so there is no rate to judge.
    const unreviewed = store.addTask({ title: 'qa ticket', prompt: 'do it', runner: 'echo', role: 'qa', playbook: 'soft' });
    store.setStatus(unreviewed.id, 'done');

    const rows = store.crewReport();
    assert.equal(rows.find((r) => r.role === 'qa')!.firstPassRate, null, 'no review is not a 0% pass rate');
    assert.deepEqual(crewAdvisories(rows), [], 'nothing here is one-sided enough to move a tier');
  } finally {
    store.close();
    cleanup([pbDir]);
  }
});

test('CLI: foreman crew report renders the table and the advisory, without a daemon', () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewrep-home-'));
  const dbPath = path.join(home, 'foreman.db');
  const store = new Store(dbPath);
  try {
    for (let i = 0; i < 6; i++) {
      const t = store.addTask({ title: `dev ticket ${i}`, prompt: 'do the thing', runner: 'echo', role: 'dev', playbook: 'soft' });
      const run = store.startRun(t.id);
      store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'fail', disagreement: false, council: [], source: 'crew' });
      store.endRun(run.id, 'succeeded', {});
      store.addReceipt({ taskId: t.id, kind: 'review', provider: 'claude-cli', model: 'm', local: false, costUsd: 0.25 });
      store.setStatus(t.id, 'done');
    }
    // A qa ticket whose only review round lost a reviewer: out of the rate, but said.
    const partial = store.addTask({ title: 'qa ticket', prompt: 'check it', runner: 'echo', role: 'qa', playbook: 'soft' });
    store.addReceipt({ taskId: partial.id, runId: store.startRun(partial.id).id, kind: 'review:incomplete', provider: 'claude-cli', model: 'm', local: false, costUsd: 0 });
    store.close();

    const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = execFileSync(process.execPath, [cli, 'crew', 'report'], {
      encoding: 'utf8',
      env: { ...process.env, FOREMAN_HOME: home, FOREMAN_DB: dbPath, FOREMAN_PLAYBOOKS_DIR: pbDir },
    });
    assert.match(run, /playbook.*role.*1st-pass/);
    assert.match(run, /soft\s+dev\s+6\s+0% \(6\)/);
    assert.match(run, /\$\s*1\.5000/, 'total spend for the role');
    assert.match(run, /consider senior tier for dev in soft \(edit the playbook role tier\)/);
    assert.match(run, /\(1 ticket\(s\) left out of 1st-pass: their first review lost a reviewer\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    cleanup([pbDir]);
  }
});

test('a non-crew task keeps the council-only path, and never calls the reviewer CLI', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', 'should never be reached')]);
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
      title: 'touch the readme', prompt: "printf 'plain\\n' >> README.md", kind: 'code', runner: 'shell', repo,
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
    assert.equal(stub.count(), 0);
    assert.equal(store.verdictsForTask(t.id).length, 1);
    assert.equal(store.verdictsForTask(t.id)[0]!.source, 'council');
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

// ------------------------------------------------- prose reviews read whole

/** One chapter of a novel: a single file, ~3,700 words, as a jail diff. */
function chapterDiff(words = 3_700): string {
  const line = 'The queue moved at the pace of the slowest clerk and every wagon in it was counted twice.';
  const body = Array.from({ length: Math.ceil(words / 16) }, (_, i) => `+${line} (${i})`).join('\n');
  return `diff --git a/Chapters/ch01.md b/Chapters/ch01.md\n--- a/Chapters/ch01.md\n+++ b/Chapters/ch01.md\n@@ -0,0 +1,500 @@\n${body}\n`;
}

test('an editorial reviewer receives a whole chapter, not the first two-thirds of one', () => {
  const diff = chapterDiff();
  assert.ok(diff.length > 12_000, 'fixture must be big enough to trip the code-review cap');

  const prose = boundBody(diff, 'editorial-letter');
  assert.equal(prose.truncated, false);
  assert.equal(prose.body, diff, 'the draft reaches the developmental editor byte-for-byte');
  // The last line of the chapter is the one a capped read never sees.
  assert.ok(prose.body.includes(`(${Math.ceil(3_700 / 16) - 1})`), 'the end of the chapter survives');

  // A code reviewer is still bounded — at the crew chain's own ceiling.
  const huge = chapterDiff(40_000);
  assert.ok(huge.length > 96_000);
  const code = boundBody(huge, 'code-review');
  assert.equal(code.truncated, true);
  assert.ok(code.body.length < huge.length);
});

test('a hosted code reviewer reads a mid-sized diff whole, not the local council\'s 12 KB excerpt', () => {
  // The first Kiln epic: a 14 KB security module + tests reached Opus cut.
  const diff = chapterDiff(2_600);
  assert.ok(diff.length > 14_000 && diff.length < 96_000);
  const code = boundBody(diff, 'code-review');
  assert.equal(code.truncated, false);
  assert.ok(code.body.includes(`(${Math.ceil(2_600 / 16) - 1})`), 'the end of the diff survives');
});

test('a reviewer reading an excerpt is told so before it reads the excerpt', () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft');
  assert.ok(pb, 'fixture playbook loads');
  const task = { id: 't1', title: 'Draft', prompt: 'draft it', acceptance: null } as unknown as Task;

  const whole = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'body', false);
  assert.ok(!whole.includes('INCOMPLETE MATERIAL'));

  const partial = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'body', true);
  assert.ok(partial.startsWith('INCOMPLETE MATERIAL'), 'the notice leads the prompt');
  assert.match(partial, /Do NOT fail the work/);
});

test('a ticket filed by a reviewer waits for the work it reviews to land, then starts from main', async () => {
  const pbDir = withPlaybooks({ 'soft.md': SOFTWARE });
  const stub = stubClaude([
    reviewReply('fail', 'the lock article contradicts the premise', [
      { title: 'Fix the lock article', prompt: 'Article six contradicts the theater line.', severity: 'normal' },
    ]),
    reviewReply('pass', 'reads fine'),
  ]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store);
    await crewReview({ task, runId, store, diff: DIFF, council: null, branch: 'foreman/t1-r1' });
    const children = store.childrenOf(task.id);
    assert.equal(children.length, 1, 'the follow-up is filed');
    // It waits for the reviewed work to land and is then cut from main, never
    // from the reviewed run's branch: that branch is empty until approval, and
    // may belong to a run a later retry replaced.
    assert.ok(!children[0]!.baseRef, 'no branch pin: it starts from main once the work has landed');
    assert.deepEqual(children[0]!.deps, [task.id]);
    assert.equal(children[0]!.status, 'blocked');
    store.setStatus(task.id, 'done');
    store.reconcileBlocked();
    assert.equal(store.getTask(children[0]!.id)!.status, 'queued', 'released once the reviewed work has landed');
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('the crew reviewer is told what the test stage did, so it never asks for a run it cannot see', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'fine')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const withTests = store.addTask({
      title: 'touch the readme', prompt: "printf 'crew\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'solo', testCmd: 'true',
    });
    await settle(sched, () => store.getTask(withTests.id)!.status === 'awaiting-approval');
    assert.match(stub.argvFor('touch the readme').join('\n'), /TEST GATE: Foreman ran `true` on exactly this work and it PASSED/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('the test-gate line: passed, failed, and none ran', () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  const task = { id: 't1', title: 'T', prompt: 'p', acceptance: null } as unknown as Task;
  const r = pb.reviewers[0]!;
  assert.doesNotMatch(buildReviewPrompt(pb, r, task, 'body'), /TEST GATE/, 'no stage info, no claim');
  assert.match(buildReviewPrompt(pb, r, task, 'body', false, { ran: true, passed: true, cmd: 'npm run verify' }), /`npm run verify` .*PASSED/);
  assert.match(buildReviewPrompt(pb, r, task, 'body', false, { ran: true, passed: false, cmd: 'npm test' }), /`npm test` .*FAILED/);
  assert.match(buildReviewPrompt(pb, r, task, 'body', false, { ran: false, passed: false, cmd: null }), /no test command ran/);
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
});

test('on a fail, blockers drive the repair and only normal follow-ups become tickets', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([
    reviewReply('fail', 'helpers are untested', [
      { title: 'Add helper tests', prompt: 'cover isolate() and makeRepo()', severity: 'blocker', role: 'dev' },
      { title: 'Tidy tmp fixtures', prompt: 'remove leaked tmp dirs', severity: 'normal', role: 'dev' },
    ]),
  ]);
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const out = (await crewReview({ task, runId, store, diff: DIFF }))!;
    assert.equal(out.verdict, 'fail');
    assert.match(out.critique, /Add helper tests: cover isolate\(\) and makeRepo\(\)/);
    assert.deepEqual(store.childrenOf(task.id).map((c) => c.title), ['Tidy tmp fixtures']);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir]);
  }
});

test('a repair round is reviewed against the demands it was sent back with', () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  const r = pb.reviewers[0]!;
  const first = { id: 't1', title: 'T', prompt: 'p', acceptance: null, repairNotes: null } as unknown as Task;
  assert.doesNotMatch(buildReviewPrompt(pb, r, first, 'body'), /REPAIR ROUND/);
  const repair = { ...first, repairNotes: 'reset SIGPIPE to SIG_DFL in the child; add a 256 KiB paste test' } as Task;
  const prompt = buildReviewPrompt(pb, r, repair, 'body');
  assert.match(prompt, /THIS IS A REPAIR ROUND/);
  assert.match(prompt, /reset SIGPIPE to SIG_DFL/);
  assert.ok(prompt.indexOf('REPAIR ROUND') < prompt.indexOf('WORK UNDER REVIEW'), 'the demands come before the diff');
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
});

test("the operator's demands reach every reviewer as acceptance, even after the repair notes moved on", () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  const r = pb.reviewers[0]!;
  const base = { id: 't1', title: 'T', prompt: 'p', acceptance: 'Learn opens from Welcome', repairNotes: 'reviewer: add a test' } as unknown as Task;
  assert.doesNotMatch(buildReviewPrompt(pb, r, base, 'body'), /OPERATOR DEMANDS/);
  const owed = { ...base, operatorDemands: 'rank the project language first in Learn' } as Task;
  const prompt = buildReviewPrompt(pb, r, owed, 'body');
  assert.match(prompt, /OPERATOR DEMANDS[^\n]*\n?[\s\S]*rank the project language first/);
  assert.match(prompt, /only the operator can waive/);
  assert.ok(prompt.indexOf('ACCEPTANCE CRITERIA') < prompt.indexOf('OPERATOR DEMANDS'), 'it extends the acceptance');
  assert.ok(prompt.indexOf('OPERATOR DEMANDS') < prompt.indexOf('WORK UNDER REVIEW'), 'and is read before the diff');
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
});

test('the chair judges against the operator demands too, and is told it may not rule one out of scope', () => {
  const args = {
    crew: 'soft', reason: '2 consecutive crew review failure(s)', councilVerdict: 'pass', councilCritique: null,
    verdict: 'fail', critiques: ['senior says FAIL: demand 4 unmet'], acceptance: 'Learn opens from Welcome',
    change: '3 files',
  };
  const plain = buildChairPrompt({ ...args, task: { title: 'T', operatorDemands: null } });
  assert.doesNotMatch(plain, /OPERATOR DEMANDS/);
  assert.match(plain, /ACCEPTANCE: Learn opens from Welcome/);
  const owed = buildChairPrompt({ ...args, task: { title: 'T', operatorDemands: '4. rank the project language first' } });
  assert.match(owed, /OPERATOR DEMANDS[\s\S]*rank the project language first/);
  assert.match(owed, /may not pass the work while one is unmet/);
  assert.ok(owed.indexOf('ACCEPTANCE:') < owed.indexOf('OPERATOR DEMANDS'));
  assert.ok(owed.indexOf('OPERATOR DEMANDS') < owed.indexOf('CHANGE UNDER REVIEW'));
});

test('the crew reviewer sees what the tree already tracks, so absent-from-the-diff is not absent', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'fine')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t = store.addTask({
      title: 'tracked listing probe', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'solo',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
    const prompt = stub.argvFor('tracked listing probe').join('\n');
    assert.match(prompt, /FILES ALREADY TRACKED IN THIS TREE/);
    assert.match(prompt, /README\.md/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('reviewers and the chair are told that checks only a person can run belong to the operator, never the worker', () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  const task = { id: 't1', title: 'T', prompt: 'p', acceptance: '1. (operator) live: Apply is visible', repairNotes: null } as unknown as Task;
  for (const r of pb.reviewers) assert.ok(buildReviewPrompt(pb, r, task, 'body').includes(OPERATOR_CHECKS), r.style);
  assert.match(OPERATOR_CHECKS, /never FAIL work for not running, reporting or evidencing such a check/);
  const chair = buildChairPrompt({
    crew: 'soft', reason: 'r', councilVerdict: null, councilCritique: null, verdict: 'fail', critiques: [],
    task: { title: 'T', operatorDemands: null }, acceptance: 'a', change: 'c',
  });
  assert.ok(chair.includes(OPERATOR_CHECKS));
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
});

test("the worker's final report reaches the reviewer as claims, and reviewers may not invent source text to scan for", () => {
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  const r = pb.reviewers[0]!;
  const task = { id: 't1', title: 'T', prompt: 'p', acceptance: 'a', repairNotes: 'demand X' } as unknown as Task;
  assert.doesNotMatch(buildReviewPrompt(pb, r, task, 'body'), /WORKER'S REPORT/);
  const prompt = buildReviewPrompt(pb, r, task, 'body', false, null, '', 'Demand X names code that does not exist; I asserted the real handler instead.');
  assert.match(prompt, /WORKER'S REPORT \(the worker's own final message: claims, not evidence/);
  assert.match(prompt, /I asserted the real handler instead/);
  assert.ok(prompt.indexOf("WORKER'S REPORT") < prompt.indexOf('WORK UNDER REVIEW'));
  assert.match(prompt, /never invent the text the code should contain/);
  assert.equal(reportLine('   '), '');
  assert.ok(reportLine('x'.repeat(5_000) + 'END').endsWith('END'), 'the tail of a long report is what is kept');
  delete process.env['FOREMAN_PLAYBOOKS_DIR'];
});

test('a FAIL demanding a scan for text the tree does not contain carries a FOREMAN CHECK into its critique', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('fail', "Tighten the scan to `includes(\"closest('[data-card]')\")`.")]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    const out = (await crewReview({ task, runId, store, diff: DIFF, treeDir: repo }))!;
    assert.equal(out.verdict, 'fail');
    assert.match(out.critique, /FOREMAN CHECK \(deterministic\)[\s\S]*closest\('\[data-card\]'\)/);
  } finally {
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test("the scheduler hands the worker's own summary to the crew reviewer", async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'fine')]);
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const t = store.addTask({
      title: 'worker report probe', prompt: "printf 'x\\n' >> README.md", kind: 'code', runner: 'shell',
      repo, role: 'dev', playbook: 'solo',
    });
    await settle(sched, () => store.getTask(t.id)!.status === 'awaiting-approval');
    const prompt = stub.argvFor('worker report probe').join('\n');
    assert.match(prompt, /WORKER'S REPORT[^\n]*\nshell command succeeded/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, repo]);
  }
});

test('re-reviewing a crew ticket asks its crew chain, not the local council', async () => {
  const pbDir = withPlaybooks({ 'solo.md': SOLO });
  const stub = stubClaude([reviewReply('pass', 'the stored diff meets the ticket')]);
  const store = new Store(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crew-rv-'));
  process.env['FOREMAN_CREW_REVIEW'] = 'always';
  let councilCalls = 0;
  const sched = new Scheduler(store, {
    verifyEnabled: false,
    verify: async ({ task, runId }) => {
      councilCalls++;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'split', disagreement: true, council: [] });
    },
  });
  try {
    const { task, runId } = ticket(store, { playbook: 'solo' });
    store.endRun(runId, 'succeeded', { summary: 'implemented token auth' });
    const diffPath = path.join(dir, 'diff.patch');
    fs.writeFileSync(diffPath, DIFF);
    store.addArtifact({ runId, taskId: task.id, type: 'diff', path: diffPath, summary: null });
    store.setStatus(task.id, 'awaiting-approval', 'UNREVIEWED — no reviewer could be reached');
    const verdict = await sched.reverify(task.id);
    assert.equal(councilCalls, 0, 'the local council is not the reviewer of a crew ticket');
    assert.equal(verdict?.verdict, 'pass');
    assert.match(stub.argvFor('Implement token auth').join('\n'), /WORK UNDER REVIEW/);
    assert.match(stub.argvFor('Implement token auth').join('\n'), /WORKER'S REPORT[^\n]*\nimplemented token auth/);
  } finally {
    await sched.stop();
    store.close();
    cleanup([pbDir, stub.dir, dir]);
  }
});

test('a long acceptance list reaches the plan, the worker, the gate council and the crew review whole', async () => {
  const { parseCrewPlan } = await import('../src/assistant/crewPlan.ts');
  const { buildGatePrompt } = await import('../src/gate.ts');
  const { acceptanceBrief } = await import('../src/scheduler.ts');
  // Kiln phase 4b: ten tickets' acceptance was cut at 2,000 chars at parse and again by every reader.
  const items = Array.from({ length: 50 }, (_, i) => `${i + 1}. item ${i + 1} must hold for the registry and each of its six group stubs.`);
  items.push('51. LAST-ITEM-SENTINEL npm run verify passes.');
  const acceptance = items.join('\n');
  assert.ok(acceptance.length > 2_500);
  const plan = parseCrewPlan({ ask: 'build it', tickets: [{ title: 'reg', prompt: 'build the registry', acceptance }] });
  assert.equal(plan.tickets[0]!.acceptance, acceptance, 'the plan stores it whole');
  assert.match(acceptanceBrief({ acceptance }), /LAST-ITEM-SENTINEL/, 'the worker brief');
  const task = { id: 't1', title: 'reg', prompt: 'build the registry', acceptance } as unknown as Task;
  assert.match(buildGatePrompt(task, null, 'diff', ''), /LAST-ITEM-SENTINEL/, 'the gate council');
  withPlaybooks({ 'soft.md': SOFTWARE });
  const pb = getPlaybook('soft')!;
  assert.match(buildReviewPrompt(pb, pb.reviewers[0]!, task, 'body', false), /LAST-ITEM-SENTINEL/, 'the crew reviewer');
  // Past the budget the cut is announced, never silent.
  const huge = 'x'.repeat(30_000);
  assert.match(buildGatePrompt({ ...task, acceptance: huge } as Task, null, 'diff', ''), /FOREMAN cut this section/);
});

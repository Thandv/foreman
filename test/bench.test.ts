import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/queue.ts';
import { mergedToVerifiedMs, namedInRed, outcome, parseSuiteLog, perLanded, whyNotLanded } from '../scripts/bench/outcome.ts';
import { assertIsolated, LIVE_PORT } from '../scripts/bench/isolation.ts';

// The benchmarks in scripts/bench are too slow for the suite at their real sizes. These runs are the smallest sizes
// that still exercise every path: each script runs from the checkout, with no network, and writes nothing to the
// caller's home. scripts/bench/env.ts drops any FOREMAN_HOME it inherits and sets a temp home of its own; without that
// line src/config.ts would fall back to <HOME>/.foreman, the operator's (and a running daemon's) home. So each run gets
// a scratch HOME, and the test asserts it, and the FOREMAN_HOME passed in, are both still empty when the bench exits.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function bench(script: string, args: string[]): Promise<unknown> {
  // The caller's homes: the bench must write to neither (nor anywhere but its own temp dirs).
  const userHome = scratchDir('foreman-bench-caller-home-');
  const foremanHome = scratchDir('foreman-bench-caller-foreman-');
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'bench', script), ...args, '--json'], {
    cwd: root,
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, FOREMAN_HOME: foremanHome },
    timeout: 120_000,
  });
  assert.deepEqual(fs.readdirSync(userHome), [], 'the caller\'s HOME is untouched');
  assert.deepEqual(fs.readdirSync(foremanHome), [], 'the caller\'s FOREMAN_HOME is untouched');
  return JSON.parse(stdout) as unknown;
}

test('the ledger bench reports p50 and p99 of each operation at each size, and writes nothing to the caller\'s home', async () => {
  const out = await bench('ledger.ts', ['--sizes', '50,100', '--iterations', '3']);
  const rows = out as Array<{ tasks: number; op: string; p50Ms: number; p99Ms: number; samples: number }>;
  for (const tasks of [50, 100]) {
    assert.deepEqual(
      rows.filter((r) => r.tasks === tasks).map((r) => r.op),
      ['reconcileBlocked', 'claimable', 'snapshot', 'record'],
      `every operation is measured at ${tasks} tasks`,
    );
  }
  for (const r of rows) {
    assert.equal(r.samples, 3);
    assert.ok(r.p50Ms >= 0 && r.p99Ms >= r.p50Ms, JSON.stringify(r));
  }
});

test('the pipeline bench lands every ticket with gate batching on and off, and batching makes fewer model calls', async () => {
  // --model-ms widens the window in which the second and third tickets park while the first ticket's gate call (which
  // it gets alone, being first) is still running, so they share one batched call: at most 2 calls with batching on.
  const out = await bench('pipeline.ts', ['--tickets', '3', '--suite-ms', '10', '--model-ms', '300']);
  const runs = out as Array<{
    gateBatch: 'on' | 'off'; tickets: number; landed: number; modelCalls: number; ticketsPerHour: number;
    suiteRunsPerLanded: number; unlanded: unknown[]; dispatchMs: { p50: number }; gateMs: { p50: number }; landingMs: { p50: number };
    workerSuite: string; workerLeasesPerLanded: number;
  }>;
  assert.deepEqual(runs.map((r) => r.gateBatch), ['on', 'off']);
  // The default, FOREMAN_WORKER_SUITE=full: each worker runs the suite through the slot wrapper, which leases a slot. At
  // least once per landed ticket, not exactly: a transient failure retries, and the retried worker leases again.
  for (const r of runs) {
    assert.equal(r.workerSuite, 'full');
    assert.ok(r.workerLeasesPerLanded >= 1, `${r.gateBatch}: ${r.workerLeasesPerLanded} worker leases per landed ticket`);
  }
  for (const r of runs) {
    assert.equal(r.landed, 3, `${r.gateBatch}: every ticket landed; not landed: ${JSON.stringify(r.unlanded)}`);
    assert.ok(r.ticketsPerHour > 0);
    // Each landing runs the suite at least twice: the ticket's own check, then the post-merge check on main.
    assert.ok(r.suiteRunsPerLanded >= 2, `${r.gateBatch}: ${r.suiteRunsPerLanded} suite runs per landed ticket`);
    for (const ms of [r.dispatchMs.p50, r.gateMs.p50, r.landingMs.p50]) assert.ok(ms >= 0);
  }
  const [on, off] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(off.modelCalls, 3, 'batching off: one owner-gate call per ticket');
  assert.ok(on.modelCalls < off.modelCalls, `batching on made ${on.modelCalls} calls`);
});

test('under FOREMAN_WORKER_SUITE=targeted the pipeline bench\'s workers take no verify slot, and every ticket still lands', async () => {
  const out = await bench('pipeline.ts', ['--tickets', '2', '--suite-ms', '10', '--model-ms', '10', '--worker-suite', 'targeted']);
  const runs = out as Array<{ workerSuite: string; tickets: number; landed: number; suiteRunsPerLanded: number; workerLeasesPerLanded: number; unlanded: unknown[] }>;
  for (const r of runs) {
    assert.equal(r.workerSuite, 'targeted');
    assert.equal(r.landed, r.tickets, `every ticket landed; not landed: ${JSON.stringify(r.unlanded)}`);
    assert.equal(r.workerLeasesPerLanded, 0, 'a worker that follows the targeted brief never runs the wrapper');
    assert.ok(r.suiteRunsPerLanded >= 2, 'the gate still runs the suite on every ticket');
  }
});

test('the pipeline bench waits for the owner gate to finish a landing before it counts the ticket', () => {
  // An approval's post-merge check can end its landing hold (the ticket is done, nothing is landing) before the
  // approval has written its decision row and the gate its verdict: both wait on git after the merge. Counted then,
  // a ticket that does land was reported as not landed when the machine was loaded.
  const store = new Store(path.join(scratchDir('foreman-bench-outcome-'), 'foreman.db'));
  try {
    const id = store.addTask({ title: 'bench ticket', prompt: 'true', runner: 'shell' }).id;
    assert.equal(outcome(store, id), 'pending', 'queued');
    store.setStatus(id, 'done');
    assert.equal(outcome(store, id), 'pending', 'done, but the gate has not spoken');
    store.noteDecision({ taskId: id, runId: null, action: 'approve', actor: 'owner-model', actorId: 'owner-model', note: null, statusAfter: 'done', merged: true });
    assert.equal(outcome(store, id), 'pending', 'the decision row, but not yet the gate\'s verdict');
    store.markGateDecision(id, 'approved');
    assert.equal(outcome(store, id), 'landed');
    // The gate logs 'approved' whether or not the merge happened (merge disabled, conflict, nothing ahead, core
    // refused): only an approval that merged has landed, and a verdict with no approve row has not either.
    const unmerged = store.addTask({ title: 'bench ticket unmerged', prompt: 'true', runner: 'shell' }).id;
    store.setStatus(unmerged, 'done');
    store.markGateDecision(unmerged, 'approved');
    assert.equal(outcome(store, unmerged), 'not-landed', 'the gate approved, but there is no approve row');
    store.noteDecision({ taskId: unmerged, runId: null, action: 'approve', actor: 'owner-model', actorId: 'owner-model', note: null, statusAfter: 'done', merged: false });
    assert.equal(outcome(store, unmerged), 'not-landed', 'approved, but nothing merged');
    const failed = store.addTask({ title: 'bench ticket 2', prompt: 'true', runner: 'shell' }).id;
    store.setStatus(failed, 'failed');
    assert.equal(outcome(store, failed), 'not-landed');
  } finally {
    store.close();
  }
});

test('the pipeline bench keeps the end of a not-landed ticket\'s events, where the error says why', () => {
  // A failed git command's message starts with the long pinned `-c` argument list (src/gitExec.ts) and ends with git's
  // stderr, the cause; the start alone cannot say why the ticket did not land.
  const store = new Store(path.join(scratchDir('foreman-bench-why-'), 'foreman.db'));
  try {
    const id = store.addTask({ title: 'bench ticket', prompt: 'true', runner: 'shell' }).id;
    store.record({ taskId: id, type: 'error', message: `Command failed: git ${'-c core.x=y '.repeat(40)}worktree add\nfatal: the cause` });
    store.setStatus(id, 'failed');
    const why = whyNotLanded(store, id);
    assert.equal(why.status, 'failed');
    assert.equal(why.gate, null);
    assert.ok(why.events.some((e) => e.startsWith('error: ') && e.endsWith('fatal: the cause')), JSON.stringify(why.events));
  } finally {
    store.close();
  }
});

test('the landing bench reads suite runs per landed ticket, merged-to-verified and the red\'s culprits from fixed logs', () => {
  // The fake suite logs one line per run when it ends: the epoch ms, then the ticket files its checkout held. A
  // post-merge check holds every ticket merged so far; a ticket's own check holds only its file, and ends before it merges.
  const runs = parseSuiteLog('1000 ticket-0.txt\n1500 ticket-0.txt,ticket-1.txt\n2400 ticket-0.txt,ticket-1.txt,ticket-2.txt\n\n');
  assert.deepEqual(runs.map((r) => [r.endedAt, r.files.length]), [[1000, 1], [1500, 2], [2400, 3]]);
  assert.equal(perLanded(7, 4), 1.75);
  assert.equal(perLanded(3, 0), 0, 'nothing landed');
  // ticket-1 merged at 1200 and the first run that ended after it and held its file ended at 1500.
  assert.equal(mergedToVerifiedMs(runs, 'ticket-1.txt', 1200), 300);
  // ticket-0 holds in the run at 1000 too, but that run ended before it merged: it verified nothing.
  assert.equal(mergedToVerifiedMs(runs, 'ticket-0.txt', 1200), 300);
  assert.equal(mergedToVerifiedMs(runs, 'ticket-2.txt', 3000), undefined, 'no check has covered it yet');
  assert.deepEqual(namedInRed(['MAIN IS RED after merging t-1, t-2 (cmd): new work for this repo is held', 'status: merged']), ['t-1', 't-2']);
  assert.deepEqual(namedInRed(['status: merged']), []);
});

test('the landing bench lands a burst under before and after, counts the suite runs from the suite\'s own log and attributes the red', async () => {
  const out = scratchDir('foreman-bench-landing-out-');
  const cells = await bench('landing.ts', ['--scenarios', 'burst', '--tickets', '3', '--suite-ms', '100', '--out', out]) as Array<{
    scenario: string; mode: string; tickets: number; landed: number; suiteRunsPerLanded: number; unverified: number;
    red: { culprit: string; named: string[]; attributed: boolean }; errors: string[];
  }>;
  assert.deepEqual(cells.map((c) => `${c.scenario}/${c.mode}`), ['burst/before', 'burst/after']);
  for (const c of cells) {
    assert.deepEqual(c.errors, []);
    assert.equal(c.landed, 3, `${c.mode}: every ticket landed`);
    assert.ok(c.suiteRunsPerLanded >= 1, `${c.mode}: ${c.suiteRunsPerLanded} suite runs per landed ticket`);
    assert.equal(c.unverified, 0);
    assert.ok(c.red.attributed && c.red.named.length >= 1, `${c.mode}: the red names the last ticket: ${JSON.stringify(c.red)}`);
  }
  assert.deepEqual(fs.readdirSync(out), ['raw.json']);
});

test('the identity bench refuses a home that is the operator\'s ~/.foreman or sits under it, and the live daemon\'s port', () => {
  const live = path.join(os.homedir(), '.foreman');
  assert.throws(() => assertIsolated(live, 40_000), /~\/\.foreman/);
  assert.throws(() => assertIsolated(path.join(live, 'nested'), 40_000), /~\/\.foreman/);
  assert.throws(() => assertIsolated(scratchDir('foreman-bench-iso-'), LIVE_PORT), new RegExp(String(LIVE_PORT)));
  assert.doesNotThrow(() => assertIsolated(scratchDir('foreman-bench-iso-'), 40_000));
});

test('the identity bench measures a throwaway daemon with and without a bearer, lands through the fake GitLab, and writes its results', async () => {
  const out = scratchDir('foreman-bench-identity-out-');
  const result = await bench('identity.ts', ['--requests', '5', '--out', out]) as {
    comparable: { requests: number; rows: Array<{ daemon: string; auth: string; op: string; samples: number; p50Ms: number; p95Ms: number }> };
    newCapability: { landings: Array<{ mode: string; approveToMergedMs: number }>; refusal: { status: number } };
    isolation: { daemons: Array<{ name: string; home: string; port: number }> };
  };
  // Without --base there is only the branch's daemon: its two operations with auth off, then with a bearer.
  const keys = result.comparable.rows.map((r) => `${r.daemon}/${r.auth}/${r.op}`);
  assert.deepEqual(keys, [
    'branch/off/GET /api/state', 'branch/off/POST /api/tasks', 'branch/bearer/GET /api/state', 'branch/bearer/POST /api/tasks',
  ]);
  for (const r of result.comparable.rows) assert.ok(r.samples === 5 && r.p50Ms >= 0 && r.p95Ms >= r.p50Ms, JSON.stringify(r));
  assert.deepEqual(result.newCapability.landings.map((l) => l.mode), ['single-principal', 'four-eyes']);
  for (const l of result.newCapability.landings) assert.ok(l.approveToMergedMs > 0, JSON.stringify(l));
  assert.equal(result.newCapability.refusal.status, 403, 'the author\'s own approval is refused once a second person exists');
  for (const d of result.isolation.daemons) {
    assert.notEqual(d.port, LIVE_PORT);
    assert.ok(!d.home.startsWith(path.join(os.homedir(), '.foreman')), d.home);
  }
  assert.deepEqual(fs.readdirSync(out).sort(), ['demo-transcript.txt', 'raw.json', 'summary.md']);
  const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.ok(summary.indexOf('## A. ') !== -1 && summary.indexOf('## B. ') > summary.indexOf('## A. '), 'A and B are separate sections');
  assert.match(summary, /NEW CAPABILITY/);
  const transcript = fs.readFileSync(path.join(out, 'demo-transcript.txt'), 'utf8');
  assert.match(transcript, /alice approves .*403/);
  assert.match(transcript, /bob approves .*mr-opened/);
  assert.match(transcript, /Foreman-Approved-By: bob/);
  assert.match(transcript, /principal-minted.*alice/);
});

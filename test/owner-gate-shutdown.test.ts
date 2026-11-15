// Its own file: it shuts down the process-wide approval tracker, which no other test in this process may then use.
import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { approvals, ownerGate } from '../src/gate.ts';
import { mergeSectionsPending, withRepoMergeSection } from '../src/landing/queue.ts';
import { clearPlaybookCache } from '../src/playbooks.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function fixtureRepo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-ogshutdown-repo-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A claude CLI stand-in that answers every owner call with an approval. */
function stubOwnerApproves(): void {
  const dir = scratchDir('foreman-ogshutdown-cli-');
  const reply = JSON.stringify({ decision: 'approve', rationale: 'green and in scope' });
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: reply });
  fs.writeFileSync(path.join(dir, 'body'), envelope);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(dir, 'body')}"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
}

/** Resolves once `cond` holds, running `step` (a scheduler tick, say) between checks. */
async function until(cond: () => boolean, step: () => Promise<unknown> = async () => {}, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await step();
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('an owner-gate approval queued behind a landing when shutdown begins is a hold: nothing decided, the ticket stays parked', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = scratchDir('foreman-ogshutdown-pb-');
  clearPlaybookCache();
  stubOwnerApproves();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    // Two tickets in one repo run to the gate and park for a person; then the scheduler is out of the way.
    const add = (title: string) => store.addTask({
      title, prompt: "printf 'gated\\n' >> README.md", kind: 'code', runner: 'shell', repo, gate: 'human', testCmd: 'grep -q gated README.md',
    });
    const a = add('first');
    const b = add('second');
    await until(() => [a, b].every((t) => store.getTask(t.id)!.status === 'awaiting-approval') && !sched.activeCount, () => sched.tick());
    await sched.stop();
    store.gateWaiting('owner');

    // An earlier landing holds the repo's merge section until released.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const landing = withRepoMergeSection(repo, () => released);

    // The owner approves B, whose approval queues behind that landing; then the daemon begins to shut down, and
    // the landing ahead of B settles.
    const decided = ownerGate({ task: store.getTask(b.id)!, run: store.latestRun(b.id), store });
    await until(() => mergeSectionsPending(repo) === 2);
    const drained = approvals.shutdown(30_000);
    release();
    assert.equal(await drained, 0);
    await landing;

    assert.equal(await decided, 'hold');
    const owner = store.eventsForTask(b.id).map((e) => e.message).filter((m) => m.startsWith('owner-gate:'));
    assert.deepEqual(owner, ['owner-gate: hold — the daemon is shutting down; the ticket stays parked for the next start']);
    assert.equal(store.gateDecision(b.id), null, 'no durable decision: the owner gate asks again after the restart');
    assert.equal(store.getTask(b.id)!.status, 'awaiting-approval');
    assert.equal(store.decisionsForTask(b.id).length, 0, 'no approval is on record for it');
  } finally {
    await sched.stop();
    store.close();
    delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    delete process.env['FOREMAN_CLAUDE_BIN'];
    clearPlaybookCache();
  }
});

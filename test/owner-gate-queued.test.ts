import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { applyApproval, ownerGate } from '../src/gate.ts';
import { mergeSectionsPending } from '../src/landing/queue.ts';
import { clearPlaybookCache } from '../src/playbooks.ts';
import type { MainCheck } from '../src/postMerge.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function fixtureRepo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-ogqueued-repo-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A claude CLI stand-in that answers every owner call with an approval. */
function stubOwnerApproves(): void {
  const dir = scratchDir('foreman-ogqueued-cli-');
  const reply = JSON.stringify({ decision: 'approve', rationale: 'green and in scope' });
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: reply });
  fs.writeFileSync(path.join(dir, 'body'), envelope);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(dir, 'body')}"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
}

async function until(cond: () => boolean, step: () => Promise<unknown> = async () => {}, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await step();
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('an owner-gate approval queued behind a landing is a hold if the ticket is handed to a person while it waits', async () => {
  delete process.env['FOREMAN_POSTMERGE_CHECK'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = scratchDir('foreman-ogqueued-pb-');
  clearPlaybookCache();
  stubOwnerApproves();
  const repo = fixtureRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    tickMs: 5, maxWorkers: 1,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  try {
    const add = (title: string, file: string) => store.addTask({
      title, prompt: `printf 'gated\\n' > ${file}`, kind: 'code', runner: 'shell', repo, gate: 'human', testCmd: `grep -q gated ${file}`,
    });
    const a = add('first', 'a.txt');
    const b = add('second', 'b.txt');
    await until(() => [a, b].every((t) => store.getTask(t.id)!.status === 'awaiting-approval') && !sched.activeCount, () => sched.tick());
    await sched.stop();
    store.gateWaiting('owner');

    // A person approves A; its main check stays open until released.
    let inCheck!: () => void;
    const entered = new Promise<void>((r) => { inCheck = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const landing = applyApproval(store, a.id, {
      mainCheck: async (dir) => {
        inCheck();
        await released;
        return { ok: true, head: git(dir, 'rev-parse', 'HEAD'), cmd: null, tail: '', firstTail: '' } satisfies MainCheck;
      },
    });
    await entered;

    // The owner approves B, whose approval queues behind A's landing; then a person takes the ticket back.
    const decided = ownerGate({ task: store.getTask(b.id)!, run: store.latestRun(b.id), store });
    await until(() => mergeSectionsPending(repo) === 2);
    store.setGate(b.id, 'human');
    release();

    assert.equal((await landing).merge.code, 'merged');
    assert.equal(await decided, 'hold');
    assert.equal(fs.existsSync(path.join(repo, 'b.txt')), false, 'nothing of B landed');
    const owner = store.eventsForTask(b.id).map((e) => e.message).filter((m) => m.startsWith('owner-gate:'));
    assert.deepEqual(owner, ['owner-gate: hold — the review or the gate changed while the owner was deciding']);
    assert.equal(store.gateDecision(b.id), null, 'no durable decision');
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

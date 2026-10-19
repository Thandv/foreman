import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

test('HTTP: retry carries the operator note; reopen returns a review failure to the gate and refuses the rest', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 60_000, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-reopen-http-'));
  const failedReview = (title: string): string => {
    const t = store.addTask({ title, prompt: title, runner: 'echo' });
    const run = store.startRun(t.id).id;
    store.setRunMeta(run, { worktreePath: wt });
    store.addVerdict({ runId: run, taskId: t.id, verdict: 'fail', disagreement: false, council: [], critique: 'report the live checks' });
    store.setStatus(t.id, 'failed', 'review said no');
    return t.id;
  };
  try {
    const r = failedReview('retry me');
    const retried = await post(`/api/tasks/${r}/retry`, { note: 'operator ran the live checks: pass' });
    assert.equal(retried.status, 200);
    assert.match(store.getTask(r)!.operatorDemands ?? '', /operator ran the live checks: pass/);
    assert.match(store.getTask(r)!.repairNotes ?? '', /^OPERATOR NOTE/);

    const bare = failedReview('retry bare');
    assert.equal((await fetch(`${base}/api/tasks/${bare}/retry`, { method: 'POST' })).status, 200, 'no body is still a retry');
    assert.equal(store.getTask(bare)!.operatorDemands, null);

    const o = failedReview('reopen me');
    const reopened = await post(`/api/tasks/${o}/reopen`, { note: 'verified live' });
    assert.equal(reopened.status, 200);
    assert.equal((await reopened.json()).status, 'awaiting-approval');

    const again = await post(`/api/tasks/${o}/reopen`);
    assert.equal(again.status, 409, 'it is at the gate now, not failed');
    assert.match((await again.json()).error, /only a failed task can be reopened/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

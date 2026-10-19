import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

// PR #1 review: a resumed round (scheduler.ts reuseJail) records the SAME branch
// and worktree on a second run row. POST /api/prune marks the earlier row
// latest:false, and pruneJails then force-removes the worktree and -D's the
// branch that the latest row was just kept for.
test('POST /api/prune keeps approved, unlanded work when an earlier run row names the same branch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pr1-'));
  const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' });
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.st'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');

  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  const t = store.addTask({ title: 'by hand', prompt: "printf 'hand\\n' > hand.txt", kind: 'code', runner: 'shell', repo: dir, mergeOnApprove: false });
  await sched.drain(60_000);
  const run = store.latestRun(t.id)!;
  // The earlier round of a resumed session: same jail, same branch, an older row.
  const cols = (store.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((c) => c.name);
  const row = store.db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id) as Record<string, unknown>;
  row['id'] = 'r_earlier'; row['started_at'] = Number(row['started_at']) - 1000;
  store.db.prepare(`INSERT INTO runs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never));
  assert.equal(store.latestRun(t.id)!.id, run.id);
  store.decide(t.id, true, 'ok');
  assert.equal(store.getTask(t.id)!.status, 'done');

  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/prune`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = (await res.json()) as { removed: string[]; kept: string[] };
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await sched.stop();

  assert.deepEqual(body.removed, [], `removed ${body.removed.join(',')}`);
  assert.ok(fs.existsSync(path.join(run.worktreePath!, 'hand.txt')), 'the approved, unlanded change is still in its worktree');
  assert.ok(git(dir, 'branch', '--list', run.branch!).includes(run.branch!), 'its branch is still there');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

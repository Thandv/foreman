import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

// Admission at launch runs `frisk-scan` (up to 20 s) when it is installed. It must not hold the event loop while it
// does: every API call, the board and every other run wait on the loop.

/** A `frisk-scan` stand-in on PATH running `body` (sh) after it has read its input. */
function friskStub(t: test.TestContext, body: string): string {
  const dir = scratchDir('foreman-admit-frisk-');
  const bin = path.join(dir, 'frisk-scan');
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  const before = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${before ?? ''}`;
  t.after(() => { process.env['PATH'] = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('GET /api/state answers while a launch waits on a slow frisk-scan', async (t) => {
  // The stub marks when it starts and when it is done. The answer must arrive in between: causal, not a timing bound.
  const marks = scratchDir('foreman-admit-marks-');
  const started = path.join(marks, 'started');
  const done = path.join(marks, 'done');
  friskStub(t, `touch "${started}"\nsleep 3\ntouch "${done}"\necho '{"findings":[{"severity":"warn","rule":"slow-frisk","message":"scanned slowly"}]}'`);

  const repo = scratchDir('foreman-admit-repo-');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@e.x'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git('add', 'README.md'); git('commit', '-qm', 'base');

  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, selfRoot: scratchDir('foreman-admit-self-'), verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let drained: Promise<void> = Promise.resolve();
  t.after(async () => {
    await Promise.allSettled([drained]); // the run writes to the store until it settles, failed assertion or not
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });

  const task = store.addTask({ title: 'ordinary', prompt: "printf 'more\\n' >> README.md", kind: 'code', runner: 'shell', repo });
  drained = sched.drain(60_000);
  for (const deadline = Date.now() + 30_000; !fs.existsSync(started);) {
    assert.ok(Date.now() < deadline, 'the stub frisk-scan never started');
    await new Promise((r) => setTimeout(r, 10));
  }
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(fs.existsSync(done), false, 'GET /api/state was answered only after the scan had finished');

  await drained;
  const after = store.getTask(task.id)!;
  assert.equal(after.status, 'awaiting-approval', after.error ?? '');
  const log = store.eventsForTask(task.id).map((e) => e.message).join('\n');
  assert.match(log, /admission warn: scanned slowly/, 'the slow scan\'s finding still reaches the run');
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { previousTail } from '../src/prose/contextPack.ts';
import { acquireLocalModelLock, localModelLockHolder, releaseLocalModelLock } from '../src/align/localLock.ts';
import { ownerCall, OwnerCallError } from '../src/assistant/ownerCall.ts';

/**
 * Regressions for what a red team found. Each case fails without its fix.
 */

// ------------------------------------------------- wrong chapter's tail

test('chapter 1 is not handed chapter 10 as its predecessor', () => {
  // `0*N\.md$` had no left boundary, so chapter 1 asked for chapter 0 and
  // matched Chapter_10.md. Being handed the WRONG tail is worse than none: the
  // prompt tells the drafter its first page must ANSWER it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-tail-'));
  try {
    fs.mkdirSync(path.join(dir, 'Chapters'));
    for (const n of ['01', '02', '10', '12', '20']) {
      fs.writeFileSync(path.join(dir, 'Chapters', `Book_Chapter_${n}.md`), `body of chapter ${Number(n)}`);
    }
    assert.equal(previousTail(dir, 1, 500), null, 'chapter 1 has no predecessor at all');
    assert.match(previousTail(dir, 3, 500)!.text, /chapter 2$/);
    assert.match(previousTail(dir, 11, 500)!.text, /chapter 10$/);
    assert.match(previousTail(dir, 21, 500)!.text, /chapter 20$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The decisive case, and the one a full directory hides: with the old regex
  // the right file merely happened to sort first. Remove it and the wrong
  // chapter is served with no warning at all.
  const sparse = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-tail2-'));
  try {
    fs.mkdirSync(path.join(sparse, 'Chapters'));
    fs.writeFileSync(path.join(sparse, 'Chapters', 'Book_Chapter_12.md'), 'body of chapter 12');
    assert.equal(
      previousTail(sparse, 3, 500), null,
      'chapter 3 has no chapter 2 on disk, and must be handed nothing rather than chapter 12',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- the local-model lock

test('the local-model lock excludes a second holder and reclaims a dead one', () => {
  // Honest about what this covers: mutual exclusion and stale reclaim, which
  // are observable in one process. It does NOT prove the O_EXCL fix, because
  // the window that fix closes is between the holder check and the write in
  // two SEPARATE processes, and this suite cannot interleave those. The fix
  // stands on matching lock.ts, which already does it correctly; a mutation
  // test confirmed this case passes either way, so it is not evidence for it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-ll-'));
  const prev = process.env['FOREMAN_LOCAL_LOCK'];
  process.env['FOREMAN_LOCAL_LOCK'] = path.join(dir, 'lock');
  try {
    assert.equal(acquireLocalModelLock('first', process.pid), null, 'first acquires');
    const second = acquireLocalModelLock('second', process.pid);
    assert.ok(second, 'the second must be told who holds it, not handed the lock');
    assert.equal(second!.label, 'first');
    releaseLocalModelLock(process.pid);
    assert.equal(localModelLockHolder(), null);
    // A crashed holder still yields: a stale pid is cleared, not waited on.
    fs.writeFileSync(process.env['FOREMAN_LOCAL_LOCK']!, JSON.stringify({ pid: 2147483000, label: 'dead', since: 0 }));
    assert.equal(acquireLocalModelLock('after-a-crash', process.pid), null);
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_LOCAL_LOCK'];
    else process.env['FOREMAN_LOCAL_LOCK'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- local-only really means local

test('the owner CLI lane is refused under local-only, not just the gate', () => {
  // ownerCall spawns the hosted CLI directly and never passes through the
  // broker's assertAllowed — the choke point everything else relies on. So the
  // crew review chain, the planner, the plan critic and the playbook forge all
  // still sent prompts off the machine while the flag promised nothing would.
  process.env['FOREMAN_LOCAL_ONLY'] = '1';
  try {
    return ownerCall('judge this diff').then(
      () => assert.fail('local-only must refuse the hosted owner CLI'),
      (err: Error) => {
        assert.ok(err instanceof OwnerCallError);
        assert.match(err.message, /FOREMAN_LOCAL_ONLY/);
      },
    );
  } finally {
    delete process.env['FOREMAN_LOCAL_ONLY'];
  }
});

// ------------------------------------------------- a cancel is not undone

test('a cancel landing during verify is not overwritten by the park', async () => {
  // The success path parked unconditionally while the catch branch checked. So
  // a cancel arriving mid-review became `awaiting-approval`, and the owner gate
  // a few lines later could approve and MERGE work the operator had stopped.
  const store = new Store(':memory:');
  // `shell` because the echo runner is `verifiable: false` and never reaches
  // the council at all — the first cut of this test asserted against a path it
  // was not exercising, and "passed" for the wrong reason.
  const task = store.addTask({ title: 'a', prompt: 'true', runner: 'shell' });
  const sched = new Scheduler(store, {
    verifyEnabled: true,
    // Cancel while the "council" is answering — the exact interleaving.
    verify: async () => {
      store.cancel(task.id);
      return store.addVerdict({
        runId: store.latestRun(task.id)!.id, taskId: task.id,
        verdict: 'pass', disagreement: false, council: [],
      });
    },
  });
  await sched.drain(20_000);
  assert.equal(store.getTask(task.id)!.status, 'canceled', 'a canceled task must stay canceled');
  await sched.stop();
  store.close();
});

// ------------------------------------------------- DNS rebinding

test('a Host header we do not serve is refused, on every method', async () => {
  // The CSRF check compared Origin against the attacker-controlled Host, so
  // rebinding evil.com to 127.0.0.1 made a drive-by POST read as same-origin.
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const call = (host: string, method = 'GET'): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/state', method, headers: { host } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end();
    });

  try {
    assert.equal(await call(`127.0.0.1:${port}`), 200, 'loopback still works');
    assert.equal(await call(`localhost:${port}`), 200);
    assert.equal(await call(`evil.com:${port}`), 403, 'a rebound name must be refused');
    assert.equal(await call(`evil.com:${port}`, 'POST'), 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  }
});

// ------------------------------------------------- the newest evidence, not the oldest

test('the agreement window follows the newest pairs', () => {
  // ORDER BY created_at ASC LIMIT n froze the report on the OLDEST evidence
  // once the ledger passed the limit — the opposite of what a "is it catching
  // up?" number is for, and it would have frozen on the worst data there was.
  const store = new Store(':memory:');
  for (let i = 0; i < 10; i++) {
    store.addShadowVerdict({
      taskId: `t${i}`, runId: 'r', playbook: 'p', role: 'r',
      authoritative: 'pass', shadow: i < 5 ? 'fail' : 'pass',
    });
    store.db.prepare('UPDATE shadow_verdicts SET created_at = ? WHERE task_id = ?').run(i, `t${i}`);
  }
  const recent = store.shadowPairs(5);
  assert.deepEqual(recent.map((p) => p.at), [5, 6, 7, 8, 9], 'newest five, oldest-first');
  assert.ok(recent.every((p) => p.shadow === 'pass'), 'and they are the recent, improved ones');
  store.close();
});

// ------------------------------------------------- the cache must not replay blind verdicts

test('an opinion cached under a different window is not served for a wider one', async () => {
  // The window and the output ceiling are decoding parameters: a verdict
  // reached with no num_ctx set was reached with the rubric silently dropped
  // off the front. Raising num_ctx fixes new calls and does nothing about the
  // cache, which would keep serving those blind verdicts under a key claiming
  // temperature 0.
  const { buildPrompt, councilNumCtx } = await import('../src/verify/council.ts');
  const { probeTask } = await import('../src/types.ts');
  const short = buildPrompt(probeTask({ kind: 'writing', title: 'Draft Chapter 12' }), {
    body: 'x'.repeat(1000), bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '',
  });
  const long = buildPrompt(probeTask({ kind: 'writing', title: 'Draft Chapter 12' }), {
    body: 'x'.repeat(200_000), bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '',
  });
  assert.notEqual(councilNumCtx(short), councilNumCtx(long), 'different evidence asks for different windows');
});

test('the evidence never exceeds the window the call asks for', async () => {
  // The prose cap is 160 KB (~40k tokens) while the window clamps at 16k, so a
  // long chapter overflowed and Ollama dropped the FRONT — where the rubric
  // lives. The trailing "reply with JSON" survives, so the reply is
  // schema-valid: a well-formed verdict about a brief the model never saw.
  const { buildPrompt, councilNumCtx } = await import('../src/verify/council.ts');
  const { probeTask } = await import('../src/types.ts');
  const prompt = buildPrompt(probeTask({ kind: 'writing', title: 'Draft Chapter 12' }), {
    body: 'The clerk did not look up. '.repeat(20_000), bodyLabel: 'output', testsPassed: null, testOutput: '', logTail: '',
  });
  const asked = councilNumCtx(prompt);
  assert.ok(
    Math.ceil(prompt.length / 4) <= asked,
    `prompt is ~${Math.ceil(prompt.length / 4)} tokens but the call asks for only ${asked}`,
  );
  assert.match(prompt, /FOREMAN cut this here/, 'and it says so, rather than letting the window drop it');
});

// ------------------------------------------------- two silences are not agreement

test('a shadow pair where neither reviewer decided is not recorded as agreement', async () => {
  const { scorePairs } = await import('../src/agreement.ts');
  // split vs split reads as "they agreed" to a naive comparison, when in fact
  // nothing judged anything. Those pairs are no longer written at all, so the
  // arithmetic never sees them; this pins the reason.
  const bothSilent = scorePairs(
    [{ taskId: 't', playbook: 'p', role: 'r', authoritative: 'split', shadow: 'split', at: 0 }],
    'p', 'r',
  );
  assert.equal(bothSilent.agreed, 1, 'the raw comparison does treat it as agreement');
  assert.equal(bothSilent.ready, false, 'which is exactly why it must never be recorded');
});

// ------------------------------------------------- the pack reports what it used

test('the pack reports the style sheet only when an entry of it was selected', async () => {
  const { buildContextPack } = await import('../src/prose/contextPack.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-pk-'));
  try {
    // A style sheet whose entries no brief will match.
    fs.writeFileSync(path.join(dir, 'STYLE_SHEET.md'), '## Zzyzx Conventions\n- always: false\nNothing relevant.\n');
    const pack = buildContextPack({ dir: dir, repo: dir, brief: 'Oswin counts the wagons.' } as never);
    assert.equal(
      pack.included.styleSheet, false,
      'reporting the style sheet merely because the file exists flatters the pack: the first question when a draft breaks it is whether it ever saw it',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

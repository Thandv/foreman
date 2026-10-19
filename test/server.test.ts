import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer, isCrossOriginWrite } from '../src/server.ts';
import { daemonUrl } from '../src/config.ts';
import http from 'node:http';

async function harness(): Promise<{ base: string; store: Store; close: () => Promise<void> }> {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sched.stop();
      store.close();
    },
  };
}

test('POST /api/tasks validates and GET /api/state reflects it', async () => {
  const h = await harness();
  const bad = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '', prompt: '' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /title is required/);

  const ok = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hello', prompt: 'world', runner: 'echo' }),
  });
  assert.equal(ok.status, 201);
  const task = await ok.json();

  const state = await (await fetch(`${h.base}/api/state`)).json();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, task.id);
  assert.equal(state.workers.max, 1);
  await h.close();
});

test('a mismatched Origin on a write is refused; a matching or absent Origin is not', async () => {
  const h = await harness();

  // A cross-origin page posting text/plain (no preflight, no cookies needed —
  // the whole point of the finding this guards) must be refused, and refused
  // before the task is ever created.
  const evil = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ title: 'from evil', prompt: 'x', runner: 'echo' }),
  });
  assert.equal(evil.status, 403);
  assert.deepEqual(await evil.json(), { error: 'cross-origin write refused' });

  // Same origin as the request itself — the normal board making the request
  // from the page the daemon served it — must still work.
  const same = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base },
    body: JSON.stringify({ title: 'same origin', prompt: 'x', runner: 'echo' }),
  });
  assert.equal(same.status, 201);

  // No Origin header at all — curl, the CLI, any server-to-server caller —
  // is not a browser request and must not be caught by a browser-only guard.
  const noOrigin = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'no origin', prompt: 'x', runner: 'echo' }),
  });
  assert.equal(noOrigin.status, 201);

  const state = await (await fetch(`${h.base}/api/state`)).json();
  assert.deepEqual(
    state.tasks.map((t: { title: string }) => t.title).sort(),
    ['no origin', 'same origin'],
    'the cross-origin request must not have created a task',
  );

  // localhost and 127.0.0.1 name the same daemon even though they are
  // different hostnames, so an Origin spelled the other way must also pass.
  const altHost = h.base.replace('127.0.0.1', 'localhost');
  const localhostOrigin = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: altHost },
    body: JSON.stringify({ title: 'localhost origin', prompt: 'x', runner: 'echo' }),
  });
  assert.equal(localhostOrigin.status, 201);

  // GET is never blocked by this guard, no matter the Origin — only writes are.
  const getWithOrigin = await fetch(`${h.base}/api/state`, { headers: { origin: 'https://evil.example' } });
  assert.equal(getWithOrigin.status, 200);

  await h.close();
});

test('a write from the board served on [::1] is same-origin, not refused', async () => {
  // URL.hostname keeps an IPv6 literal's brackets and the Host split did not,
  // so "[::1]" never equalled "::1" and the board's own writes read as cross-origin.
  const h = await harness();
  const port = new URL(h.base).port;
  const status = await new Promise<number>((resolve, reject) => {
    const payload = JSON.stringify({ title: 'v6', prompt: 'x', runner: 'echo' });
    const req = http.request(`${h.base}/api/tasks`, {
      method: 'POST',
      headers: { host: `[::1]:${port}`, origin: `http://[::1]:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(status, 201);
  assert.equal(isCrossOriginProbe(`http://[::1]:${port}`, `127.0.0.1:${port}`), false, '[::1] and 127.0.0.1 are both loopback');
  await h.close();
});

/** What the CSRF guard decides for one Origin/Host pair, via a request that never needs a socket. */
function isCrossOriginProbe(origin: string, host: string): boolean {
  return isCrossOriginWrite({ headers: { origin, host } } as never);
}

test('daemonUrl brackets an IPv6 host and reaches a wildcard bind on loopback', () => {
  assert.equal(daemonUrl('127.0.0.1', 4100), 'http://127.0.0.1:4100');
  assert.equal(daemonUrl('0.0.0.0', 4100), 'http://127.0.0.1:4100');
  assert.equal(daemonUrl('::1', 4100), 'http://[::1]:4100');
  assert.equal(daemonUrl('::', 4100), 'http://[::1]:4100');
  assert.equal(daemonUrl('localhost', 9), 'http://localhost:9');
  assert.doesNotThrow(() => new URL(daemonUrl('::1', 4100)));
});

test('GET /api/state resolves and serializes a model per task', async () => {
  const h = await harness();
  // No role/playbook: modelForTask falls through to null (runner default).
  const plain = h.store.addTask({ title: 'plain', prompt: 'x', runner: 'echo' });
  // A bare role with no playbook resolves through the generic tierForRole
  // fallback ('dev' isn't an owner/senior role, so it's worker tier).
  const withRole = h.store.addTask({ title: 'has role', prompt: 'x', runner: 'echo', role: 'dev' });

  const state = (await (await fetch(`${h.base}/api/state`)).json()) as { tasks: Array<Record<string, unknown>> };
  const byId = new Map(state.tasks.map((t) => [t['id'], t]));
  assert.equal(byId.get(plain.id)?.['model'], null);
  assert.equal(byId.get(withRole.id)?.['model'], 'sonnet');
  await h.close();
});

test('the approval gate is enforced over HTTP', async () => {
  const h = await harness();
  const t = h.store.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const early = await fetch(`${h.base}/api/tasks/${t.id}/approve`, { method: 'POST' });
  assert.equal(early.status, 400);

  h.store.setStatus(t.id, 'awaiting-approval');
  const good = await fetch(`${h.base}/api/tasks/${t.id}/approve`, { method: 'POST' });
  assert.equal((await good.json()).status, 'done');

  const retryDone = await fetch(`${h.base}/api/tasks/${t.id}/retry`, { method: 'POST' });
  assert.equal(retryDone.status, 409, 'an approved task must not be retryable');
  await h.close();
});

test('unknown task, unknown action and unknown route all 404', async () => {
  const h = await harness();
  assert.equal((await fetch(`${h.base}/api/tasks/t_missing`)).status, 404);
  assert.equal((await fetch(`${h.base}/api/nope`)).status, 404);
  const t = h.store.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  assert.equal((await fetch(`${h.base}/api/tasks/${t.id}/frobnicate`, { method: 'POST' })).status, 404);
  await h.close();
});

test('static board is served and path traversal is blocked', async () => {
  const h = await harness();
  const index = await fetch(`${h.base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Foreman/);
  const escape = await fetch(`${h.base}/..%2f..%2fetc%2fpasswd`);
  assert.ok([403, 404].includes(escape.status), `traversal returned ${escape.status}`);
  await h.close();
});

test('artifact content is served only for recorded artifacts', async () => {
  const h = await harness();
  const t = h.store.addTask({ title: 'a', prompt: 'a', runner: 'echo' });
  const run = h.store.startRun(t.id);
  const art = h.store.addArtifact({ runId: run.id, taskId: t.id, type: 'log', path: '/etc/hosts', summary: null });
  assert.equal((await fetch(`${h.base}/api/artifacts/a_bogus/content`)).status, 404);
  assert.equal((await fetch(`${h.base}/api/artifacts/${art.id}/content`)).status, 200);
  await h.close();
});

test('GET /api/receipts summarises today, groups it, and windows on ?day=all', async () => {
  const h = await harness();
  const t = h.store.addTask({ title: 'billed', prompt: 'x', runner: 'echo' });
  h.store.addReceipt({ taskId: t.id, kind: 'work', provider: 'anthropic', model: 'sonnet', local: false, tokensIn: 100, tokensOut: 40, costUsd: 0.02, latencyMs: 900 });
  h.store.addReceipt({ taskId: t.id, kind: 'verify', provider: 'anthropic', model: 'haiku', local: false, tokensIn: 50, tokensOut: 10, costUsd: 0.005, latencyMs: 300 });
  h.store.addReceipt({ taskId: null, kind: 'work', provider: 'ollama', model: 'qwen', local: true, tokensIn: 10, tokensOut: 5, costUsd: 0, latencyMs: 40 });

  const d = await (await fetch(`${h.base}/api/receipts`)).json();
  assert.equal(d.day, 'today');
  assert.equal(d.totals.calls, 3);
  assert.equal(d.totals.localCalls, 1);
  assert.ok(Math.abs(d.totals.costUsd - 0.025) < 1e-9, `cost was ${d.totals.costUsd}`);
  assert.equal(d.totals.tokensIn, 160);
  assert.equal(d.totals.tokensOut, 55);

  // Ordered by spend, so the cloud provider that actually cost money leads.
  assert.deepEqual(d.byProvider.map((g: { name: string }) => g.name), ['anthropic', 'ollama']);
  assert.equal(d.byProvider[0].calls, 2);
  assert.deepEqual(d.byKind.map((g: { name: string }) => g.name), ['work', 'verify']);

  // Newest first, and the row shape is the raw ledger the drawer already renders.
  assert.equal(d.recent.length, 3);
  assert.equal(d.recent[0].model, 'qwen');
  assert.equal(typeof d.recent[0].cost_usd, 'number');

  const capped = await (await fetch(`${h.base}/api/receipts?limit=1`)).json();
  assert.equal(capped.recent.length, 1);

  // A receipt dated before today is out of the 'today' window but in 'all'.
  h.store.db.prepare("UPDATE receipts SET day = '2000-01-01' WHERE model = ?").run('qwen');
  const today = await (await fetch(`${h.base}/api/receipts?day=today`)).json();
  assert.equal(today.totals.calls, 2, 'the backdated receipt must fall out of today');
  const all = await (await fetch(`${h.base}/api/receipts?day=all`)).json();
  assert.equal(all.day, 'all');
  assert.equal(all.totals.calls, 3);
  await h.close();
});

test('GET /api/memory honours scope and limit, and DELETE retires a fact', async () => {
  const h = await harness();
  h.store.rememberFact({ scope: 'global', key: 'style', value: 'terse', confidence: 0.9 });
  h.store.rememberFact({ scope: '/repo/a', key: 'test-cmd', value: 'npm test', confidence: 0.8 });
  h.store.rememberFact({ scope: '/repo/b', key: 'test-cmd', value: 'make check', confidence: 0.7 });

  const scoped = await (await fetch(`${h.base}/api/memory?scope=${encodeURIComponent('/repo/a')}`)).json();
  assert.equal(scoped.scope, '/repo/a');
  // recallFacts always folds 'global' in alongside the asked-for scope.
  assert.deepEqual(scoped.facts.map((f: { key: string }) => f.key).sort(), ['style', 'test-cmd']);
  assert.ok(scoped.facts.every((f: { scope: string }) => ['global', '/repo/a'].includes(f.scope)));
  assert.deepEqual(scoped.scopes, ['/repo/a', '/repo/b', 'global']);
  const fact = scoped.facts.find((f: { scope: string }) => f.scope === '/repo/a');
  for (const field of ['id', 'scope', 'key', 'value', 'confidence', 'createdAt']) {
    assert.ok(field in fact, `fact is missing ${field}`);
  }

  const limited = await (await fetch(`${h.base}/api/memory?scope=${encodeURIComponent('/repo/a')}&limit=1`)).json();
  assert.equal(limited.facts.length, 1);

  const del = await fetch(`${h.base}/api/memory/${fact.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${h.base}/api/memory?scope=${encodeURIComponent('/repo/a')}`)).json();
  assert.deepEqual(after.facts.map((f: { key: string }) => f.key), ['style']);
  assert.ok(!after.scopes.includes('/repo/a'), 'a scope with no live facts must drop out of the picker');
  await h.close();
});

test('POST /api/prose/audit audits a directory and 400s on anything else', async () => {
  const h = await harness();
  const post = (body: unknown): Promise<Response> =>
    fetch(`${h.base}/api/prose/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await post({})).status, 400);
  const missing = await post({ dir: path.join(os.tmpdir(), 'foreman-no-such-manuscript') });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /no such directory/);

  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-prose-')), 'one.md');
  fs.writeFileSync(filePath, 'a file, not a directory');
  const notDir = await post({ dir: filePath });
  assert.equal(notDir.status, 400);
  assert.match((await notDir.json()).error, /not a directory/);

  const dir = path.dirname(filePath);
  fs.copyFileSync(new URL('./fixtures/tic-heavy.md', import.meta.url), path.join(dir, 'chapter-01.md'));
  const ok = await post({ dir });
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.equal(d.report.dir, dir);
  assert.ok(d.report.files.includes('chapter-01.md'));
  assert.ok(d.report.findings.length > 0, 'the tic-heavy fixture must produce findings');
  assert.equal(d.hasBans, d.report.findings.some((f: { level: string }) => f.level === 'ban'));
  // The formatted text is the same report the CLI prints, not a second render.
  assert.equal(typeof d.text, 'string');
  assert.match(d.text, /finding\(s\)/);
  fs.rmSync(dir, { recursive: true, force: true });
  await h.close();
});

test('GET /api/state stubs long task text; GET /api/tasks/:id returns it in full', async () => {
  const h = await harness();
  const longPrompt = 'p'.repeat(9000);
  const longAcceptance = 'a'.repeat(400);
  const longError = 'e'.repeat(2000);
  const shortPrompt = 'short prompt, well under the stub length';

  const big = h.store.addTask({
    title: 'crew ticket', prompt: longPrompt, runner: 'echo', acceptance: longAcceptance,
  });
  h.store.db.prepare('UPDATE tasks SET error = ? WHERE id = ?').run(longError, big.id);
  const small = h.store.addTask({ title: 'plain ticket', prompt: shortPrompt, runner: 'echo' });

  const state = (await (await fetch(`${h.base}/api/state`)).json()) as {
    tasks: Array<Record<string, unknown>>;
  };
  const byId = new Map(state.tasks.map((t) => [t['id'], t]));
  const bigSnap = byId.get(big.id)!;
  assert.equal((bigSnap['prompt'] as string).length, 200, 'snapshot prompt must be stubbed to the cap');
  assert.equal(bigSnap['promptTruncated'], true);
  assert.equal((bigSnap['acceptance'] as string).length, 200);
  assert.equal(bigSnap['acceptanceTruncated'], true);
  assert.equal((bigSnap['error'] as string).length, 500, 'snapshot error must be capped at 500');

  const smallSnap = byId.get(small.id)!;
  assert.equal(smallSnap['prompt'], shortPrompt, 'a prompt under the cap must not be altered');
  assert.equal(smallSnap['promptTruncated'], false);

  // The detail endpoint is the one place the board can read the full text.
  const detail = (await (await fetch(`${h.base}/api/tasks/${big.id}`)).json()) as {
    task: Record<string, unknown>;
  };
  assert.equal(detail.task['prompt'], longPrompt, '/api/tasks/:id must not stub the prompt');
  assert.equal(detail.task['acceptance'], longAcceptance);
  assert.equal(detail.task['error'], longError, '/api/tasks/:id must not stub the error either');
  await h.close();
});

test('GET /api/state combines callsToday/nonLocalCallsToday into one grouped receipts read', async () => {
  const h = await harness();
  h.store.addReceipt({ taskId: null, kind: 'work', provider: 'anthropic', model: 'sonnet', local: false, tokensIn: 10, tokensOut: 5, costUsd: 0.01, latencyMs: 100 });
  h.store.addReceipt({ taskId: null, kind: 'work', provider: 'anthropic', model: 'sonnet', local: false, tokensIn: 10, tokensOut: 5, costUsd: 0.01, latencyMs: 100 });
  h.store.addReceipt({ taskId: null, kind: 'work', provider: 'ollama', model: 'qwen', local: true, tokensIn: 5, tokensOut: 2, costUsd: 0, latencyMs: 40 });

  const state = (await (await fetch(`${h.base}/api/state`)).json()) as {
    budget: { callsToday: number; nonLocalCallsToday: number };
  };
  assert.equal(state.budget.callsToday, 3);
  assert.equal(state.budget.nonLocalCallsToday, 2);

  // The Store helper backing it groups in one query rather than running two
  // separate COUNT(*) scans.
  const counts = h.store.receiptCallCountsByLocal(new Date().toISOString().slice(0, 10));
  assert.deepEqual(counts, { total: 3, nonLocal: 2 });
  await h.close();
});

test('SSE streams live events', async () => {
  const h = await harness();
  const res = await fetch(`${h.base}/api/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const t = h.store.addTask({ title: 'streamed', prompt: 'x', runner: 'echo' });
  const chunk = new TextDecoder().decode((await reader.read()).value!);
  assert.match(chunk, /"type":"status"/);
  assert.match(chunk, new RegExp(t.id));
  await reader.cancel();
  await h.close();
});

test('GET /api/crew/report serves the same rows the CLI renders, and no advisory it cannot back', async () => {
  const h = await harness();
  const t = h.store.addTask({ title: 'crew ticket', prompt: 'do the thing', runner: 'echo', role: 'dev', playbook: 'soft' });
  const run = h.store.startRun(t.id);
  h.store.addVerdict({ runId: run.id, taskId: t.id, verdict: 'fail', disagreement: false, council: [], source: 'crew' });
  h.store.endRun(run.id, 'succeeded', {});
  h.store.setStatus(t.id, 'done');

  const body = (await (await fetch(`${h.base}/api/crew/report`)).json()) as {
    rows: Array<Record<string, unknown>>;
    advisories: string[];
  };
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0]!['playbook'], 'soft');
  assert.equal(body.rows[0]!['role'], 'dev');
  assert.equal(body.rows[0]!['tickets'], 1);
  assert.equal(body.rows[0]!['firstPassRate'], 0);
  // One ticket is not a sample, and the playbook is not even installed here:
  // an advisory this thin would be a guess with a tier attached.
  assert.deepEqual(body.advisories, []);
  await h.close();
});

test('GET /api/tasks/:id says a re-review is still running, so the CLI waits past the first rung', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-srv-rv-'));
  const store = new Store(':memory:');
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5, verifyEnabled: false,
    // A climbing council: rung 0's row lands first, the deciding rung's later.
    verify: async ({ task, runId }) => {
      store.addVerdict({ runId, taskId: task.id, verdict: 'split', disagreement: false, council: [] });
      await held;
      return store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
    },
  });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = store.addTask({ title: 'Draft Chapter 12', prompt: 'write it', kind: 'writing' });
    const run = store.startRun(task.id);
    store.endRun(run.id, 'succeeded', { summary: 'drafted' });
    const diffPath = path.join(dir, 'diff.patch');
    fs.writeFileSync(diffPath, '+++ a chapter of prose\n');
    store.addArtifact({ runId: run.id, taskId: task.id, type: 'diff', path: diffPath, summary: null });
    store.setStatus(task.id, 'awaiting-approval');

    const started = await fetch(`${base}/api/tasks/${task.id}/reverify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    const mid = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
    assert.equal(mid.verdicts[0].verdict, 'split', 'the first rung has landed');
    assert.equal(mid.reverifying, true, 'but the re-review is not over');

    release();
    let done = mid;
    for (let i = 0; i < 200 && done.reverifying; i++) {
      await new Promise((r) => setTimeout(r, 10));
      done = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
    }
    assert.equal(done.reverifying, false);
    assert.equal(done.verdicts[0].verdict, 'pass', 'the row the CLI reports once it is over');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

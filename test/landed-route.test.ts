import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { hermeticGitEnv } from './helpers/git.ts';

process.env['FOREMAN_PREWARM'] = 'off';
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

interface Fixture {
  store: Store;
  repo: string;
  base: string;
  landed: string;
  port: number;
  close: () => Promise<void>;
}

/** A repo with a base commit and one commit "landed by hand" after it, and a daemon on port 0 over an in-memory store. */
async function fixture(t: test.TestContext): Promise<Fixture> {
  const env = hermeticGitEnv(t);
  const repo = scratchDir('foreman-landed-route-');
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'by hand');
  const landed = git('rev-parse', 'HEAD');
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  };
  t.after(close);
  return { store, repo, base, landed, port, close };
}

/** A failed ticket with a run cut from `base`, and a queued dependent that waits on it. */
function failedWithDependent(f: Fixture): { id: string; dependent: string } {
  const task = f.store.addTask({ title: 'first', prompt: 'p', repo: f.repo });
  const run = f.store.startRun(task.id);
  f.store.setRunMeta(run.id, { baseCommit: f.base });
  f.store.setStatus(task.id, 'failed', 'boom');
  const dep = f.store.addTask({ title: 'second', prompt: 'p', repo: f.repo, deps: [task.id] });
  return { id: task.id, dependent: dep.id };
}

function snapshot(store: Store): string {
  return ['tasks', 'decisions', 'events', 'runs', 'artifacts', 'task_deps']
    .map((tb) => JSON.stringify(store.db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()))
    .join('\n');
}

/** A raw POST, so Host and Origin can be set to anything. */
function post(port: number, urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function cli(port: number, argv: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { stdout, stderr, code };
}

test('the landed route refuses a foreign Origin and a rebinding Host, and the rows stay byte-equal', async (t) => {
  const f = await fixture(t);
  const { id } = failedWithDependent(f);
  const before = snapshot(f.store);
  const url = `/api/tasks/${id}/landed`;
  const body = { commit: f.landed };

  const foreign = await post(f.port, url, body, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error, /cross-origin/);

  const rebound = await post(f.port, url, body, { host: 'evil.example', origin: 'http://evil.example' });
  assert.equal(rebound.status, 403);
  assert.match(rebound.json.error, /Host/);

  // The one guard is Origin against Host: a page on another port of the same host is foreign too.
  const otherPort = await post(f.port, url, body, { origin: `http://127.0.0.1:${f.port + 1}` });
  assert.equal(otherPort.status, 403);

  assert.equal(snapshot(f.store), before);
  assert.equal(f.store.getTask(id)!.status, 'failed');
});

test('a valid POST lands the ticket, revives its dependent, and the CLI gives the same result', async (t) => {
  const f = await fixture(t);
  const a = failedWithDependent(f);
  const ok = await post(f.port, `/api/tasks/${a.id}/landed`, { commit: f.landed, by: 't_0123456789', note: 'by hand' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'done');
  assert.equal(ok.json.decision.action, 'landed');
  assert.equal(ok.json.decision.actor, 'human');
  assert.equal(ok.json.decision.extra.commit, f.landed);
  assert.equal(ok.json.decision.extra.by, 't_0123456789');
  assert.match(ok.json.decision.note, /by hand/);
  assert.ok(
    ['queued', 'running', 'verifying', 'awaiting-approval', 'done'].includes(f.store.getTask(a.dependent)!.status),
    'the dependent is revived (the scheduler may already have started it), not held or failed',
  );

  const b = failedWithDependent(f);
  const run = await cli(f.port, ['landed', b.id, '--commit', f.landed, '--by', 't_0123456789', '--note', 'by hand']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`${b.id} → done`));
  assert.match(run.stdout, /recorded d_?\w*: landed by human/);
  const viaCli = f.store.decisionsForTask(b.id).find((d) => d.action === 'landed')!;
  const viaRoute = f.store.decisionsForTask(a.id).find((d) => d.action === 'landed')!;
  for (const key of ['action', 'actor', 'statusAfter', 'landedTree'] as const) assert.equal(viaCli[key], viaRoute[key], key);
  assert.deepEqual(viaCli.extra, viaRoute.extra);
  assert.equal(f.store.getTask(b.id)!.status, f.store.getTask(a.id)!.status);
});

test('the landed route checks its inputs at the boundary and writes nothing when one is wrong', async (t) => {
  const f = await fixture(t);
  const { id } = failedWithDependent(f);
  const before = snapshot(f.store);
  const url = `/api/tasks/${id}/landed`;
  for (const [what, body] of [
    ['no commit', {}],
    ['non-hex', { commit: 'zzzzzzz' }],
    ['too short', { commit: 'abc123' }],
    ['too long', { commit: 'a'.repeat(41) }],
    ['an option', { commit: '--all' }],
    ['by not a ticket id', { commit: f.landed, by: 'gokul' }],
    ['by not text', { commit: f.landed, by: 7 }],
    ['note too long', { commit: f.landed, note: 'x'.repeat(2001) }],
  ] as Array<[string, unknown]>) {
    const r = await post(f.port, url, body);
    assert.equal(r.status, 400, what);
  }
  assert.equal(snapshot(f.store), before);
  assert.equal((await post(f.port, '/api/tasks/t_nosuchtask/landed', { commit: f.landed })).status, 404);
});

test('a Store refusal reaches the route as a 409 and the CLI as a non-zero exit with the same reason', async (t) => {
  const f = await fixture(t);
  const { id } = failedWithDependent(f);
  const before = snapshot(f.store);
  // f.base is an ancestor of the run's base_commit: not work from this ticket.
  const r = await post(f.port, `/api/tasks/${id}/landed`, { commit: f.base });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /cannot mark .* landed: .* is an ancestor of the run's base/);

  const run = await cli(f.port, ['landed', id, '--commit', f.base]);
  assert.notEqual(run.code, 0);
  assert.ok((run.stdout + run.stderr).includes(r.json.error), run.stdout + run.stderr);

  const queued = f.store.addTask({ title: 'q', prompt: 'p', repo: f.repo });
  const wrongState = await cli(f.port, ['landed', queued.id, '--commit', f.landed]);
  assert.notEqual(wrongState.code, 0);
  assert.match(wrongState.stdout + wrongState.stderr, /it is queued/);

  const noCommit = await cli(f.port, ['landed', id]);
  assert.notEqual(noCommit.code, 0);
  assert.match(noCommit.stdout + noCommit.stderr, /--commit/);
  assert.equal(f.store.getTask(id)!.status, 'failed');
  assert.equal(snapshot(f.store).includes('"landed"'), false);
  assert.notEqual(before, '');
});

test('foreman show prints the landed decision and /api/state carries it', async (t) => {
  const f = await fixture(t);
  const { id } = failedWithDependent(f);
  const ok = await post(f.port, `/api/tasks/${id}/landed`, { commit: f.landed, by: 't_0123456789', note: 'by hand' });
  assert.equal(ok.status, 200);
  const tree = execFileSync('git', ['rev-parse', `${f.landed}^{tree}`], { cwd: f.repo, encoding: 'utf8' }).trim();

  const shown = await cli(f.port, ['show', id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /decisions:/);
  const row = shown.stdout.split('\n').find((l) => /landed by human/.test(l));
  assert.ok(row, shown.stdout);
  assert.ok(row.includes(`commit ${f.landed}`), row);
  assert.ok(row.includes(`landed_tree ${tree.slice(0, 12)}`), row);
  assert.ok(row.includes('by ticket t_0123456789'), row);
  assert.ok(row.includes('by hand'), row);

  const state = await (await fetch(`http://127.0.0.1:${f.port}/api/state`)).json();
  const card = state.tasks.find((x: { id: string }) => x.id === id);
  assert.deepEqual(
    { commit: card.landed.commit, landedTree: card.landed.landedTree, by: card.landed.by },
    { commit: f.landed, landedTree: tree, by: 't_0123456789' },
  );
  const other = state.tasks.find((x: { id: string }) => x.id !== id);
  assert.equal(other.landed, null);
});

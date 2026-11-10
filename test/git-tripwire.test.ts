import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { applyApproval } from '../src/gate.ts';
import { pinnedGit } from '../src/gitExec.ts';
import { createJail } from '../src/isolate.ts';
import { createServer } from '../src/server.ts';
import { baselinePath, checkRepo, recordBaseline } from '../src/gitTripwire.ts';
import type { Task } from '../src/types.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function repo(): string {
  const dir = fs.realpathSync(scratchDir('foreman-tripwire-'));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@e.x'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-qam', 'second');
  return dir;
}

const taskFor = (dir: string): Task => ({ id: 't_trip', title: 't', prompt: 'p', kind: 'code', repo: dir } as unknown as Task);

/** Every file under `root` with its bytes, to prove a read left them alone. */
function bytesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = path.join(root, rel);
    if (fs.lstatSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n)); return; }
    out[rel] = fs.lstatSync(abs).isSymbolicLink() ? `link:${fs.readlinkSync(abs)}` : fs.readFileSync(abs).toString('base64');
  };
  walk('');
  return out;
}

/** The ways a worker can reach the real repo by path (each is a shell fragment run with REAL set). */
const TAMPER: Record<string, { sh: string; names: RegExp }> = {
  'config': { sh: `printf '[alias]\\n\\tx = !true\\n' >> "$REAL/.git/config"`, names: /\.git\/config was changed/ },
  'a hook': { sh: `printf '#!/bin/sh\\n' > "$REAL/.git/hooks/post-commit"`, names: /\.git\/hooks\/post-commit was added/ },
  'a file under info/': { sh: `printf 'x\\n' > "$REAL/.git/info/attributes"`, names: /\.git\/info\/attributes was added/ },
  'refs/replace': { sh: `git -C "$REAL" replace main~1 main`, names: /ref refs\/replace\/[0-9a-f]+ was created/ },
  'refs/notes': { sh: `git -C "$REAL" notes add -m hi main`, names: /ref refs\/notes\/commits was created/ },
};

function setup() {
  process.env['FOREMAN_POSTMERGE_CHECK'] = 'off';
  const dir = repo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  return { dir, store, sched };
}

async function toGate(store: Store, sched: Scheduler, dir: string, script: string) {
  const t = store.addTask({
    title: 'ticket', prompt: `REAL='${dir}'; ${script}; printf 'new\\n' > new.txt`, kind: 'code', runner: 'shell', repo: dir,
    maxRepairs: 0, testCmd: 'test -f new.txt',
  });
  await sched.drain(30_000);
  return store.getTask(t.id)!;
}

for (const [what, { sh, names }] of Object.entries(TAMPER)) {
  test(`a worker that writes ${what} in the real repo is held at collection, the reason naming it`, async () => {
    const { dir, store, sched } = setup();
    try {
      const held = await toGate(store, sched, dir, sh);
      assert.equal(held.status, 'awaiting-approval');
      assert.match(held.error ?? '', /git tripwire/);
      assert.match(held.error ?? '', names);
      assert.ok(!store.eventsForTask(held.id).some((e) => /tests passed|TESTS FAILED|GATE TIMED OUT/.test(e.message)), 'the tests did not run');
    } finally {
      store.close();
    }
  });
}

test('a clean worker passes the tripwire at collection and is not held by it', async () => {
  const { dir, store, sched } = setup();
  try {
    const parked = await toGate(store, sched, dir, 'true');
    assert.doesNotMatch(parked.error ?? '', /git tripwire/);
  } finally {
    store.close();
  }
});

test('a change made after collection: approve refuses before mergeApproved and holds', async () => {
  const { dir, store, sched } = setup();
  try {
    const parked = await toGate(store, sched, dir, 'true');
    assert.equal(parked.status, 'awaiting-approval');
    assert.doesNotMatch(parked.error ?? '', /git tripwire/);
    const head = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
    const out = await applyApproval(store, parked.id, { principal: 'operator' });
    assert.equal(out.merge.merged, false);
    assert.match(out.merge.reason, /\.git\/hooks\/pre-push was added/);
    const now = store.getTask(parked.id)!;
    assert.equal(now.status, 'awaiting-approval', 'held for a person, not done');
    assert.match(now.error ?? '', /not landed: git tripwire/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'mergeApproved did not run');
  } finally {
    store.close();
  }
});

function post(port: number, urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
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

test('a change made after collection: foreman landed refuses with the reason', async (t) => {
  const dir = repo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const port = (server.address() as AddressInfo).port;
  const task = store.addTask({ title: 'by hand', prompt: 'p', repo: dir });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { baseCommit: git(dir, 'rev-parse', 'HEAD~1') });
  await createJail({ ...taskFor(dir), id: task.id }, run.id);
  store.setStatus(task.id, 'failed', 'boom');
  git(dir, 'replace', 'HEAD~1', 'HEAD');
  const res = await post(port, `/api/tasks/${task.id}/landed`, { commit: git(dir, 'rev-parse', 'HEAD') });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /ref refs\/replace\/[0-9a-f]+ was created/);
  assert.equal(store.getTask(task.id)!.status, 'failed', 'nothing was marked landed');
});

test('operator work is not flagged: commits, another branch, a tag, a stash, pack-refs and gc', async () => {
  const dir = repo();
  await createJail(taskFor(dir), 'r_operator');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  git(dir, 'commit', '-qam', 'operator on main');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'f\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'other branch');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'tag', 'v1');
  git(dir, 'tag', '-a', 'v2', '-m', 'annotated');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  git(dir, 'stash');
  git(dir, 'pack-refs', '--all');
  git(dir, 'gc', '-q');
  const v = await checkRepo(dir, 'r_operator', { requireBaseline: true, git: pinnedGit });
  assert.deepEqual(v, { ok: true, note: null });
});

test('refs from the operator\'s git bisect and git maintenance prefetch are not flagged', async () => {
  const dir = repo();
  await recordBaseline(dir, 'r_bisect', pinnedGit);
  git(dir, 'update-ref', 'refs/bisect/bad', 'HEAD');
  git(dir, 'update-ref', 'refs/prefetch/remotes/origin/main', 'HEAD~1');
  const v = await checkRepo(dir, 'r_bisect', { requireBaseline: true, git: pinnedGit });
  assert.deepEqual(v, { ok: true, note: null });
});

test('refs next to the excluded ones are still flagged: no prefix bleed, notes and replace', async () => {
  const dir = repo();
  await recordBaseline(dir, 'r_bleed', pinnedGit);
  git(dir, 'update-ref', 'refs/bisectx/a', 'HEAD');
  git(dir, 'update-ref', 'refs/prefetchx/a', 'HEAD');
  git(dir, 'notes', 'add', '-m', 'hi', 'HEAD');
  const replaced = git(dir, 'rev-parse', 'HEAD~1');
  git(dir, 'replace', replaced, 'HEAD');
  const v = await checkRepo(dir, 'r_bleed', { requireBaseline: true, git: pinnedGit });
  assert.equal(v.ok, false);
  const reason = (v as { reason: string }).reason;
  for (const ref of ['refs/bisectx/a', 'refs/prefetchx/a', 'refs/notes/commits', `refs/replace/${replaced}`]) {
    assert.ok(reason.includes(`ref ${ref} was created`), `${ref} is flagged: ${reason}`);
  }
});

test('a refs/replace ref that exists only in packed-refs is still detected', async () => {
  const dir = repo();
  await createJail(taskFor(dir), 'r_packed');
  git(dir, 'replace', 'HEAD~1', 'HEAD');
  git(dir, 'pack-refs', '--all');
  const loose = path.join(dir, '.git', 'refs', 'replace');
  assert.ok(!fs.existsSync(loose) || fs.readdirSync(loose).length === 0, 'only packed now');
  const v = await checkRepo(dir, 'r_packed', { requireBaseline: true, git: pinnedGit });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /ref refs\/replace\/[0-9a-f]+ was created/);
});

test('with per-worktree config on, a worker writing .git/config.worktree is detected', async () => {
  const dir = repo();
  git(dir, 'config', 'extensions.worktreeConfig', 'true'); // what `git sparse-checkout init` sets
  await recordBaseline(dir, 'r_wtconfig', pinnedGit);
  fs.writeFileSync(path.join(dir, '.git', 'config.worktree'), '[core]\n\thooksPath = /elsewhere\n');
  assert.equal(git(dir, 'config', 'core.hooksPath'), '/elsewhere', 'git reads it');
  const v = await checkRepo(dir, 'r_wtconfig', { requireBaseline: true, git: pinnedGit });
  assert.match((v as { reason?: string }).reason ?? '', /\.git\/config\.worktree was added/);
});

test('hashing and comparing leave the real .git byte-identical', async () => {
  const dir = repo();
  git(dir, 'gc', '-q'); // settle anything git itself would rewrite on its first housekeeping
  const before = bytesOf(path.join(dir, '.git'));
  await recordBaseline(dir, 'r_bytes', pinnedGit);
  const v = await checkRepo(dir, 'r_bytes', { requireBaseline: true, git: pinnedGit });
  assert.equal(v.ok, true);
  assert.deepEqual(bytesOf(path.join(dir, '.git')), before);
});

test('an unreadable hooks dir holds the run with a reason instead of crashing it', { skip: isRoot ? 'root reads any directory' : false }, async () => {
  const { dir, store, sched } = setup();
  const hooks = path.join(dir, '.git', 'hooks');
  try {
    const held = await toGate(store, sched, dir, `chmod 000 "$REAL/.git/hooks"`);
    assert.equal(held.status, 'awaiting-approval');
    assert.match(held.error ?? '', /git tripwire: the repo's \.git could not be hashed \(EACCES/);
  } finally {
    fs.chmodSync(hooks, 0o755);
    store.close();
  }
});

test('a worker that writes a hook and then fails is caught: no repair round takes the hook into a fresh baseline', async () => {
  const { dir, store, sched } = setup();
  const hook = `"${dir}/.git/hooks/post-checkout"`;
  try {
    const t = store.addTask({
      title: 'ticket', kind: 'code', runner: 'shell', repo: dir, maxRepairs: 1, testCmd: 'test -f new.txt',
      // Round one plants the hook and fails; a repair round would find it there and do clean work.
      prompt: `if [ ! -f ${hook} ]; then printf '#!/bin/sh\\n' > ${hook}; exit 1; fi; printf 'new\\n' > new.txt`,
    });
    await sched.drain(30_000);
    const now = store.getTask(t.id)!;
    assert.equal(now.status, 'failed');
    assert.match(now.error ?? '', /git tripwire: .*\.git\/hooks\/post-checkout was added/);
    assert.equal(store.runsForTask(t.id).length, 1, 'no repair round');
  } finally {
    store.close();
  }
});

test('a baseline that could not be taken at creation holds with its reason, and never throws', { skip: isRoot ? 'root reads any directory' : false }, async () => {
  const dir = repo();
  const hooks = path.join(dir, '.git', 'hooks');
  fs.chmodSync(hooks, 0o000);
  try {
    await createJail(taskFor(dir), 'r_unreadable');
    fs.chmodSync(hooks, 0o755);
    const v = await checkRepo(dir, 'r_unreadable', { requireBaseline: false, git: pinnedGit });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /could not be hashed when the run began \(EACCES/);
  } finally {
    fs.chmodSync(hooks, 0o755);
  }
});

test('the baseline is a 0600 file under the artifacts dir, outside the jail, and survives a restart', async () => {
  const dir = repo();
  const dbFile = path.join(scratchDir('foreman-tripwire-db-'), 'f.db');
  let store = new Store(dbFile);
  const task = store.addTask({ title: 't', prompt: 'p', repo: dir });
  const run = store.startRun(task.id);
  const jail = await createJail({ ...taskFor(dir), id: task.id }, run.id);
  const file = baselinePath(run.id);
  assert.ok(file.endsWith(path.join('artifacts', run.id, 'git-tripwire.json')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['git-tripwire.json'], 'no temp file is left');
  assert.ok(!file.startsWith(jail.dir + path.sep), 'outside the jail');
  store.close();

  fs.appendFileSync(path.join(dir, '.git', 'config'), '[alias]\n\ty = !true\n');
  store = new Store(dbFile); // the daemon restarted between creation and collection
  try {
    const again = store.latestRun(task.id)!;
    const v = await checkRepo(dir, again.id, { requireBaseline: true, git: pinnedGit });
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /\.git\/config was changed/);
  } finally {
    store.close();
  }
});

test('a repo run with no baseline is held at collection, but not refused at landing', async () => {
  const dir = repo();
  const held = await checkRepo(dir, 'r_none', { requireBaseline: true, git: pinnedGit });
  assert.equal(held.ok, false);
  assert.match((held as { reason: string }).reason, /no baseline/);
  assert.deepEqual(await checkRepo(dir, 'r_none', { requireBaseline: false, git: pinnedGit }), { ok: true, note: null });
});

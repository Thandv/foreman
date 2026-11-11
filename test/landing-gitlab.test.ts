import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startFakeGitlab, type FakeGitlab, type FakeGitlabOptions } from '../scripts/forge/fakeGitlab.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';
import { ForgeError } from '../src/landing/forge.ts';

// The GitLab merge-request adapter (src/landing/gitlab.ts) against the local fake GitLab (scripts/forge/fakeGitlab.ts):
// no network, a real bare repo behind it.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A bare repo with main (one commit), and `push` to put a new commit on a branch. */
function fixture(): { bare: string; push: (branch: string, file: string) => string } {
  const bare = scratchDir('landing-gitlab-bare-');
  git(bare, 'init', '--bare', '-b', 'main');
  const work = scratchDir('landing-gitlab-work-');
  git(work, 'clone', bare, '.');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'HEAD:refs/heads/main');
  const push = (branch: string, file: string): string => {
    const exists = git(work, 'ls-remote', 'origin', `refs/heads/${branch}`) !== '';
    git(work, 'checkout', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
    fs.writeFileSync(path.join(work, file), `${file}\n`);
    git(work, 'add', file);
    git(work, 'commit', '-m', `add ${file}`);
    git(work, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  };
  return { bare, push };
}

async function withFake(extra: Partial<FakeGitlabOptions>, run: (s: FakeGitlab, f: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
  const f = fixture();
  const server = await startFakeGitlab({ projects: { 'group/app': f.bare }, ...extra });
  try {
    await run(server, f);
  } finally {
    await server.close();
  }
}

const NEW_MR = { sourceBranch: 'foreman/t1', targetBranch: 'main', title: 'T1', description: 'the ticket' };

test('openMr then getMr returns the pushed head sha and a null-or-running pipeline', async () => {
  await withFake({ pipeline: 'manual' }, async (s, f) => {
    const head = f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    assert.equal(opened.headSha, head);
    const mr = await forge.getMr('group/app', opened.iid);
    assert.equal(mr.state, 'opened');
    assert.equal(mr.headSha, head);
    assert.ok(mr.pipeline === null || mr.pipeline.status === 'running', `pipeline: ${JSON.stringify(mr.pipeline)}`);
    assert.equal(mr.mergeCommitSha, null);
  });
});

test('project, findOpenMr, openMr, getMr and merge work against the fake; the merge commit\'s second parent is the reviewed sha', async () => {
  await withFake({}, async (s, f) => {
    const forge = new GitlabForge({ baseUrl: s.url });
    assert.deepEqual(await forge.project('group/app'), { defaultBranch: 'main', mergeMethod: 'merge' });
    const head = f.push('foreman/t1', 'b.txt');
    assert.equal(await forge.findOpenMr('group/app', 'foreman/t1'), null);
    const opened = await forge.openMr('group/app', NEW_MR);
    const found = await forge.findOpenMr('group/app', 'foreman/t1');
    assert.equal(found?.iid, opened.iid);
    assert.match(found.webUrl, /\/group\/app\/-\/merge_requests\/1$/);
    assert.deepEqual(found.pipeline && { sha: found.pipeline.sha, status: found.pipeline.status }, { sha: head, status: 'success' });
    const mr = await forge.getMr('group/app', opened.iid);
    assert.equal(mr.mergeStatus, 'mergeable');
    assert.deepEqual(mr.pipeline && { sha: mr.pipeline.sha, status: mr.pipeline.status }, { sha: head, status: 'success' });
    const outcome = await forge.merge('group/app', opened.iid, head);
    assert.ok(outcome.merged);
    assert.equal(git(f.bare, 'rev-parse', 'refs/heads/main'), outcome.mergeCommitSha);
    assert.equal(git(f.bare, 'rev-parse', `${outcome.mergeCommitSha}^2`), head);
    assert.equal((await forge.getMr('group/app', opened.iid)).state, 'merged');
    assert.equal(await forge.findOpenMr('group/app', 'foreman/t1'), null);
  });
});

test('openMr sends squash=false and remove_source_branch=true; merge sends the reviewed sha', async () => {
  await withFake({}, async (s, f) => {
    const head = f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    await forge.merge('group/app', opened.iid, head);
    const post = s.requests.find((r) => r.method === 'POST');
    assert.deepEqual(JSON.parse(post?.body ?? '{}'), {
      source_branch: 'foreman/t1', target_branch: 'main', title: 'T1', description: 'the ticket', remove_source_branch: true, squash: false,
    });
    const put = s.requests.find((r) => r.method === 'PUT');
    assert.deepEqual(put?.query, { sha: head });
  });
});

test('addNote posts the body as a note on the merge request', async () => {
  await withFake({}, async (s, f) => {
    f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    await forge.addNote('group/app', opened.iid, 'Foreman-Decision: d1');
    const post = s.requests.at(-1)!;
    assert.equal(post.path, `/api/v4/projects/group%2Fapp/merge_requests/${opened.iid}/notes`);
    assert.deepEqual(JSON.parse(post.body!), { body: 'Foreman-Decision: d1' });
    await assert.rejects(forge.addNote('group/app', 99, 'x'), (e: unknown) => e instanceof ForgeError && e.status === 404);
  });
});

test('merge with a stale sha is head-moved and leaves the target branch unchanged', async () => {
  await withFake({}, async (s, f) => {
    const stale = f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    f.push('foreman/t1', 'c.txt');
    const mainBefore = git(f.bare, 'rev-parse', 'refs/heads/main');
    const outcome = await forge.merge('group/app', opened.iid, stale);
    assert.deepEqual(outcome, { merged: false, reason: 'head-moved', detail: 'SHA does not match HEAD of source branch' });
    assert.equal(git(f.bare, 'rev-parse', 'refs/heads/main'), mainBefore);
  });
});

test('a failed pipeline makes the merge not-mergeable', async () => {
  await withFake({ pipeline: 'failed' }, async (s, f) => {
    const head = f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    assert.equal((await forge.getMr('group/app', opened.iid)).pipeline?.status, 'failed');
    const outcome = await forge.merge('group/app', opened.iid, head);
    assert.equal(outcome.merged, false);
    assert.equal(!outcome.merged && outcome.reason, 'not-mergeable');
  });
});

test('getMr during the checking window reports mergeStatus checking', async () => {
  await withFake({ checkingMs: 600_000 }, async (s, f) => {
    f.push('foreman/t1', 'b.txt');
    const forge = new GitlabForge({ baseUrl: s.url });
    const opened = await forge.openMr('group/app', NEW_MR);
    assert.equal((await forge.getMr('group/app', opened.iid)).mergeStatus, 'checking');
  });
});

test('a 401 from the fake is a ForgeError with the status and without the token', async () => {
  await withFake({ token: 'the-right-token' }, async (s) => {
    const forge = new GitlabForge({ baseUrl: s.url, token: 'wrong-token-value' });
    const err = await forge.project('group/app').then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ForgeError);
    assert.equal(err.status, 401);
    assert.match(err.message, /401/);
    assert.ok(!`${err.message} ${err.stack}`.includes('wrong-token-value'));
    assert.deepEqual(await new GitlabForge({ baseUrl: s.url, token: 'the-right-token' }).project('group/app'), { defaultBranch: 'main', mergeMethod: 'merge' });
  });
});

/** A loopback server that answers every request with `handle`. */
async function withStub(handle: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SHA = 'a'.repeat(40);

test('a server that echoes the token back has it redacted from the error and from a merge detail', async () => {
  const echo: http.RequestListener = (req, res) => {
    const status = req.method === 'PUT' ? 405 : 401;
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `bad token ${String(req.headers['private-token'])}` }));
  };
  await withStub(echo, async (url) => {
    const forge = new GitlabForge({ baseUrl: url, token: 'echoed-secret' });
    await assert.rejects(forge.getMr('group/app', 1), (e: Error) => e instanceof ForgeError && e.message.includes('bad token [redacted]') && !e.message.includes('echoed-secret'));
    assert.deepEqual(await forge.merge('group/app', 1, SHA), { merged: false, reason: 'not-mergeable', detail: 'bad token [redacted]' });
  });
});

test('a 403 on merge is refused', async () => {
  await withStub((_req, res) => res.writeHead(403).end(JSON.stringify({ message: '403 Forbidden' })), async (url) => {
    assert.deepEqual(await new GitlabForge({ baseUrl: url }).merge('group/app', 1, SHA), { merged: false, reason: 'refused', detail: '403 Forbidden' });
  });
});

test('a server that never answers is cut at the timeout', async () => {
  await withStub(() => undefined, async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url, timeoutMs: 50 }).project('group/app'), (e: Error) => e instanceof ForgeError && /no answer within 50 ms/.test(e.message));
  });
});

test('an oversized, malformed or unexpected body is an error', async () => {
  const big = JSON.stringify({ default_branch: 'main', merge_method: 'merge', pad: 'x'.repeat(1024 * 1024) });
  await withStub((_req, res) => res.writeHead(200).end(big), async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url }).project('group/app'), /over 1 MB/);
  });
  await withStub((_req, res) => { res.writeHead(200); res.write(big.slice(0, 600_000)); res.end(big.slice(600_000)); }, async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url }).project('group/app'), /over 1 MB/);
  });
  await withStub((_req, res) => res.writeHead(200).end('{"default_branch": "ma'), async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url }).project('group/app'), /not JSON/);
  });
  await withStub((_req, res) => res.writeHead(200).end(JSON.stringify({ iid: 1, state: 'opened', sha: 'not-a-sha' })), async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url }).getMr('group/app', 1), /unexpected merge request\.sha: expected a commit sha/);
  });
  await withStub((_req, res) => res.writeHead(200).end(JSON.stringify({ default_branch: null, merge_method: 'merge' })), async (url) => {
    await assert.rejects(new GitlabForge({ baseUrl: url }).project('group/app'), /unexpected project\.default_branch/);
  });
});

test('the base URL must be https, or http on a loopback host, with no credentials', () => {
  assert.throws(() => new GitlabForge({ baseUrl: 'http://gitlab.example.com' }), /https/);
  assert.throws(() => new GitlabForge({ baseUrl: 'ftp://127.0.0.1' }), /https/);
  assert.throws(() => new GitlabForge({ baseUrl: 'https://user:pw@gitlab.example.com' }), /credentials/);
  assert.throws(() => new GitlabForge({ baseUrl: 'not a url' }), ForgeError);
  assert.doesNotThrow(() => new GitlabForge({ baseUrl: 'https://gitlab.example.com/gitlab/' }));
  assert.doesNotThrow(() => new GitlabForge({ baseUrl: 'http://[::1]:8080' }));
});

import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGitlab, type FakeGitlab, type FakeGitlabOptions } from '../scripts/forge/fakeGitlab.ts';

// The fake GitLab (scripts/forge/fakeGitlab.ts) is the forge the merge-request landing tests and the demo run against:
// no network, a real bare repo behind it. These tests pin the REST subset it serves and GitLab's real status codes.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('GET a project returns its default branch from the bare repo', async () => {
  const bare = scratchDir('fake-gitlab-bare-');
  git(bare, 'init', '--bare', '-b', 'main');
  const server = await startFakeGitlab({ projects: { 'group/app': bare }, port: 0 });
  try {
    const res = await fetch(`${server.url}/api/v4/projects/group%2Fapp`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path_with_namespace: string; default_branch: string };
    assert.equal(body.path_with_namespace, 'group/app');
    assert.equal(body.default_branch, 'main');
  } finally {
    await server.close();
  }
});

interface Mr { iid: number; state: string; sha: string; detailed_merge_status: string; head_pipeline: { sha: string; status: string }; merge_commit_sha: string | null }

/** A bare repo with main (one commit) and a feature branch one commit ahead, plus a work clone to push more with. */
function fixture(): { bare: string; work: string; commitOn: (branch: string, file: string) => string } {
  const bare = scratchDir('fake-gitlab-bare-');
  git(bare, 'init', '--bare', '-b', 'main');
  const work = scratchDir('fake-gitlab-work-');
  git(work, 'clone', bare, '.');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'HEAD:refs/heads/main');
  const commitOn = (branch: string, file: string): string => {
    const exists = git(work, 'ls-remote', 'origin', `refs/heads/${branch}`) !== '';
    git(work, 'checkout', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
    fs.writeFileSync(path.join(work, file), `${file}\n`);
    git(work, 'add', file);
    git(work, 'commit', '-m', `add ${file}`);
    git(work, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  };
  return { bare, work, commitOn };
}

async function withServer(extra: Partial<FakeGitlabOptions>, run: (s: FakeGitlab, f: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
  const f = fixture();
  const server = await startFakeGitlab({ projects: { 'group/app': f.bare }, ...extra });
  try {
    await run(server, f);
  } finally {
    await server.close();
  }
}

const api = (s: FakeGitlab, p: string): string => `${s.url}/api/v4/projects/group%2Fapp${p}`;
const json = { 'content-type': 'application/json' };
async function open(s: FakeGitlab, source: string, extra: Record<string, unknown> = {}): Promise<Mr> {
  const res = await fetch(api(s, '/merge_requests'), { method: 'POST', headers: json, body: JSON.stringify({ source_branch: source, target_branch: 'main', title: 'T', ...extra }) });
  assert.equal(res.status, 200);
  return (await res.json()) as Mr;
}
const getMr = async (s: FakeGitlab, iid: number): Promise<Mr> => (await (await fetch(api(s, `/merge_requests/${iid}`))).json()) as Mr;
const mergeMr = (s: FakeGitlab, iid: number, sha: string): Promise<Response> => fetch(api(s, `/merge_requests/${iid}/merge?sha=${sha}`), { method: 'PUT' });
const flip = (s: FakeGitlab, sha: string, status: string): Promise<Response> => fetch(`${s.url}/__fake/pipelines/${sha}`, { method: 'POST', headers: json, body: JSON.stringify({ status }) });

test('opening a merge request returns its iid and the source branch head; the list filters by source branch and state', async () => {
  await withServer({}, async (s, f) => {
    const head = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    assert.equal(mr.iid, 1);
    assert.equal(mr.sha, head);
    const listed = (await (await fetch(api(s, '/merge_requests?source_branch=feat&state=opened'))).json()) as Mr[];
    assert.deepEqual(listed.map((m) => m.iid), [1]);
    assert.deepEqual(await (await fetch(api(s, '/merge_requests?source_branch=other&state=opened'))).json(), []);
  });
});

test('pushing to the source branch changes sha on the next GET', async () => {
  await withServer({}, async (s, f) => {
    const first = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    const second = f.commitOn('feat', 'c.txt');
    assert.notEqual(first, second);
    const after = await getMr(s, mr.iid);
    assert.equal(after.sha, second);
    assert.equal(after.head_pipeline.sha, second);
  });
});

test('merge with the head sha makes a merge commit whose second parent is that sha, and advances the target', async () => {
  await withServer({}, async (s, f) => {
    const head = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    const res = await mergeMr(s, mr.iid, head);
    assert.equal(res.status, 200);
    const merged = (await res.json()) as Mr;
    assert.equal(merged.state, 'merged');
    const parents = git(f.bare, 'rev-list', '--parents', '-n1', merged.merge_commit_sha as string).split(' ');
    assert.equal(parents.length, 3);
    assert.equal(parents[2], head);
    assert.equal(git(f.bare, 'rev-parse', 'refs/heads/main'), merged.merge_commit_sha);
    const worktrees = git(f.bare, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    assert.equal(worktrees.length, 1, 'no temp worktree is left behind: only the bare repo itself is listed');
  });
});

test('merge with a stale sha gets 409 and changes nothing', async () => {
  await withServer({}, async (s, f) => {
    const stale = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    f.commitOn('feat', 'c.txt');
    const mainBefore = git(f.bare, 'rev-parse', 'refs/heads/main');
    assert.equal((await mergeMr(s, mr.iid, stale)).status, 409);
    assert.equal(git(f.bare, 'rev-parse', 'refs/heads/main'), mainBefore);
    assert.equal((await getMr(s, mr.iid)).state, 'opened');
  });
});

test('a failed pipeline blocks the merge with 405 and ci_must_pass; flipping it to success unblocks', async () => {
  await withServer({ pipeline: 'failed' }, async (s, f) => {
    const head = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    assert.equal((await getMr(s, mr.iid)).detailed_merge_status, 'ci_must_pass');
    assert.equal((await mergeMr(s, mr.iid, head)).status, 405);
    assert.equal((await flip(s, head, 'success')).status, 200);
    assert.equal((await mergeMr(s, mr.iid, head)).status, 200);
  });
});

test('a manual pipeline is left running until flipped', async () => {
  await withServer({ pipeline: 'manual' }, async (s, f) => {
    const head = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    const got = await getMr(s, mr.iid);
    assert.equal(got.head_pipeline.status, 'running');
    assert.equal(got.detailed_merge_status, 'ci_still_running');
    assert.equal((await mergeMr(s, mr.iid, head)).status, 405);
  });
});

test('during the checking window merge gets 405 and the status reads checking', async () => {
  await withServer({ checkingMs: 600_000 }, async (s, f) => {
    const head = f.commitOn('feat', 'b.txt');
    const mr = await open(s, 'feat');
    assert.equal((await getMr(s, mr.iid)).detailed_merge_status, 'checking');
    assert.equal((await mergeMr(s, mr.iid, head)).status, 405);
  });
});

test('squash=true is recorded and merges as a single-parent commit', async () => {
  await withServer({}, async (s, f) => {
    f.commitOn('feat', 'b.txt');
    const head = f.commitOn('feat', 'c.txt');
    const mr = await open(s, 'feat', { squash: true });
    const merged = (await (await mergeMr(s, mr.iid, head)).json()) as Mr;
    const parents = git(f.bare, 'rev-list', '--parents', '-n1', merged.merge_commit_sha as string).split(' ');
    assert.equal(parents.length, 2, 'one parent');
    assert.equal(git(f.bare, 'show', `${merged.merge_commit_sha}:c.txt`), 'c.txt');
  });
});

test('a missing or wrong token gets 401; the right one works; the request log never holds the token', async () => {
  await withServer({ token: 'sekret-token-value' }, async (s) => {
    assert.equal((await fetch(api(s, ''))).status, 401);
    assert.equal((await fetch(api(s, ''), { headers: { 'PRIVATE-TOKEN': 'wrong' } })).status, 401);
    assert.equal((await fetch(api(s, ''), { headers: { 'PRIVATE-TOKEN': 'sekret-token-value' } })).status, 200);
    assert.equal(s.requests.length, 3);
    assert.deepEqual(s.requests[0], { method: 'GET', path: '/api/v4/projects/group%2Fapp', query: {} });
    assert.ok(!JSON.stringify(s.requests).includes('sekret-token-value'));
  });
});

test('an unknown project is 404 and a missing source branch is 400', async () => {
  await withServer({}, async (s) => {
    assert.equal((await fetch(`${s.url}/api/v4/projects/nope%2Fnone`)).status, 404);
    const res = await fetch(api(s, '/merge_requests'), { method: 'POST', headers: json, body: JSON.stringify({ source_branch: 'ghost', target_branch: 'main' }) });
    assert.equal(res.status, 400);
  });
});

test('the server starts on a port of its own and closes cleanly', async () => {
  const f = fixture();
  const server = await startFakeGitlab({ projects: { 'group/app': f.bare } });
  const port = new URL(server.url).port;
  assert.notEqual(port, '0');
  await server.close();
  await assert.rejects(fetch(`${server.url}/api/v4/projects/group%2Fapp`));
});

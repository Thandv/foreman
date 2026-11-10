import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGitlab, type FakeGitlab, type FakeGitlabOptions } from '../scripts/forge/fakeGitlab.ts';
import { GitlabForge } from '../src/landing/gitlab.ts';

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

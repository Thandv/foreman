import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startFakeGitlab } from '../scripts/forge/fakeGitlab.ts';

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

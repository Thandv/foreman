import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChangedFile } from '../src/isolate.ts';
import { appliesOnMain, revertCheck } from '../src/verify/revertCheck.ts';
import { hermeticGitEnv } from './helpers/git.ts';

/**
 * The revert check's own git calls run in the daemon, against a git directory and a config a worker can write.
 * A program either of them names (a hook, a hooks path) must not be started by them: no test command is run in
 * these tests (the runner is a stand-in), so anything that leaves the marker was started by git itself.
 */

/** The running test's git environment (no system config, a scratch global one); tests in a file run one at a time. */
let genv: NodeJS.ProcessEnv = process.env;
const sh = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: genv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function fixture(t: TestContext): { root: string; repo: string; jail: string; workRoot: string; base: string; marker: string; payload: string } {
  genv = hermeticGitEnv(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revert-pins-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const jail = path.join(root, 'jail');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'));
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'src/x.js'), "export const greet = () => 'hello';\n");
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  fs.writeFileSync(path.join(jail, 'src/x.js'), "export const greet = () => 'hello, world';\n");
  fs.mkdirSync(path.join(jail, 'test'), { recursive: true });
  fs.writeFileSync(path.join(jail, 'test/x.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
  const marker = path.join(root, 'ran-in-the-daemon');
  return { root, repo, jail, workRoot: path.join(root, 'work'), base: sh(repo, 'rev-parse', 'HEAD').trim(), marker, payload: `#!/bin/sh\necho "$0" >> '${marker}'\n` };
}

const CHANGED: ChangedFile[] = [
  { path: 'src/x.js', from: null, status: 'modified' },
  { path: 'test/x.test.js', from: null, status: 'added' },
];
const HOOKS = ['post-checkout', 'post-index-change', 'reference-transaction', 'pre-commit', 'post-commit', 'post-merge', 'pre-merge-commit'];

for (const where of ['the repo\'s .git/hooks', 'a core.hooksPath written from the jail'] as const) {
  test(`revertCheck and appliesOnMain start no hook from ${where}`, async (t) => {
    const f = fixture(t);
    // What a worker can do from its jail: the jail shares the repo's git directory and config.
    const dir = where.startsWith('the repo') ? path.join(f.repo, '.git', 'hooks') : path.join(f.root, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of HOOKS) fs.writeFileSync(path.join(dir, name), f.payload, { mode: 0o755 });
    if (!where.startsWith('the repo')) sh(f.jail, 'config', 'core.hooksPath', dir);

    // The fixture's hooks do run for a plain git call: without this the test could pass on a hook that never fires.
    const probe = path.join(f.root, 'probe');
    sh(f.repo, 'worktree', 'add', '-q', '--detach', probe, f.base);
    assert.equal(fs.existsSync(f.marker), true, 'a plain `git worktree add` runs the planted hook');
    sh(f.repo, 'worktree', 'remove', '--force', probe);
    fs.rmSync(f.marker);

    let ran = 0;
    const res = await revertCheck({
      repo: f.repo, jailDir: f.jail, base: f.base, changed: CHANGED, workRoot: f.workRoot, runId: 'r1',
      run: async () => { ran++; return { passed: false, timedOut: false, output: 'ℹ tests 1\nℹ fail 1\n' }; },
    });
    assert.equal(ran, 1, 'the check got as far as running the changed test file');
    assert.equal(res.status, 'pass');
    assert.equal(fs.existsSync(f.marker), false, `revertCheck started a hook: ${fs.existsSync(f.marker) ? fs.readFileSync(f.marker, 'utf8') : ''}`);

    // Main moves, so appliesOnMain goes past its same-base shortcut to commit-tree and merge-tree.
    fs.writeFileSync(path.join(f.repo, 'README.md'), '# moved\n');
    sh(f.repo, '-c', 'core.hooksPath=/dev/null', 'add', '-A');
    sh(f.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'main moved');
    fs.rmSync(f.marker, { force: true });
    sh(f.jail, '-c', 'core.hooksPath=/dev/null', 'add', '-A');
    const tree = sh(f.jail, '-c', 'core.hooksPath=/dev/null', 'write-tree').trim();
    fs.rmSync(f.marker, { force: true });
    const applies = await appliesOnMain({ repo: f.repo, base: f.base, tree });
    assert.equal(applies.status, 'clean');
    assert.equal(fs.existsSync(f.marker), false, 'appliesOnMain started a hook');
  });
}

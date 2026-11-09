import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneMainWorktrees } from '../src/gate.ts';

// pruneMainWorktrees runs on the daemon's behalf, at startup and after an interrupted check. Its git is the
// pinned git (src/gitExec.ts): an inherited GIT_DIR must not turn `worktree list` and `worktree remove` onto
// another repository, and the repo's hooks and fsmonitor program must not run.

const git = (cwd: string, ...a: string[]): string => {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  return execFileSync('git', a, { cwd, encoding: 'utf8', env });
};

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prune-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@e.st'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

async function deadPid(): Promise<number> {
  const dead = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  return dead.pid!;
}

function addMainWorktree(dir: string, pid: number, tag: string): string {
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prune-wt-'))), `foreman-main-${pid}-${tag}`);
  git(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  return wt;
}

const worktrees = (dir: string): string => git(dir, 'worktree', 'list', '--porcelain');

test('an inherited GIT_DIR does not turn the prune onto another repository', async () => {
  const a = repo();
  const b = repo();
  const pid = await deadPid();
  const ours = addMainWorktree(a, pid, 'ours');
  const theirs = addMainWorktree(b, pid, 'theirs');
  const saved = process.env['GIT_DIR'];
  process.env['GIT_DIR'] = path.join(b, '.git');
  let removed: string[];
  try {
    removed = await pruneMainWorktrees(a);
  } finally {
    if (saved === undefined) delete process.env['GIT_DIR'];
    else process.env['GIT_DIR'] = saved;
  }
  assert.deepEqual(removed, [ours], 'only the asked repository\'s stale check is removed');
  assert.ok(fs.existsSync(theirs), 'the other repository\'s worktree is still on disk');
  assert.ok(worktrees(b).includes(theirs), 'and still registered there');
  assert.ok(!worktrees(a).includes(ours));
});

// Regression check, passes before and after: worktree remove/prune run no hook, and the pins keep it so.
test('the prune runs none of the repo\'s hooks or its fsmonitor program (passes before and after)', async () => {
  const a = repo();
  const stale = addMainWorktree(a, await deadPid(), 'hooked');
  const marker = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prune-mark-'))), 'ran');
  const hooks = path.join(a, 'hooks-here');
  fs.mkdirSync(hooks);
  const script = `#!/bin/sh\necho "$0" >> '${marker}'\n`;
  for (const name of ['post-checkout', 'post-index-change', 'reference-transaction', 'fsmonitor']) {
    fs.writeFileSync(path.join(hooks, name), script, { mode: 0o755 });
  }
  git(a, 'config', 'core.hooksPath', hooks);
  git(a, 'config', 'core.fsmonitor', path.join(hooks, 'fsmonitor'));

  assert.deepEqual(await pruneMainWorktrees(a), [stale]);
  assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
});

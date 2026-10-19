import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedListing } from '../src/assistant/repoBrief.ts';
import { ungroundedLiterals } from '../src/verify/literals.ts';
import { provisionDeps } from '../src/deps.ts';
import { hermeticGitEnv } from './helpers/git.ts';

// The three daemon-side git calls outside isolate.ts that read a jail's index (or the repo's, whose config every jail
// can write): unpinned, each ran the worker's core.fsmonitor once.
test('a core.fsmonitor planted in the shared config does not run from repoBrief, literals or deps', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fsmonitor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = hermeticGitEnv(t);
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', ...a], { cwd, env, encoding: 'utf8' });
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), '{}'); fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1;\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'b');
  const jail = path.join(root, 'jail'); g(repo, 'worktree', 'add', '-q', '--detach', jail, 'HEAD');
  const marks = path.join(root, 'marks'); const prog = path.join(root, 'fsm.sh');
  fs.writeFileSync(prog, `#!/bin/sh\necho "$*" >> '${marks}'\n`, { mode: 0o755 });
  g(jail, 'config', 'core.fsmonitor', prog);
  const fired = () => fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0;
  trackedListing(jail); const a = fired();
  ungroundedLiterals('assert src.includes("someVeryUniqueLiteral")', jail); const b = fired();
  await provisionDeps(jail, repo, { allowInstall: false }).catch(() => {}); const c = fired();
  assert.deepEqual({ repoBrief: a, literals: b - a, deps: c - b }, { repoBrief: 0, literals: 0, deps: 0 });
});

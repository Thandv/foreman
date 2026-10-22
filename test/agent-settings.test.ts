import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJail, diffJail, restoreAgentSettings, type Jail } from '../src/isolate.ts';
import type { Task } from '../src/types.ts';
import { hermeticGitEnv } from './helpers/git.ts';

/**
 * A claude-code worker reads its permission rules from the jail's `.claude/settings.json` at the start of every
 * round, and it can write that file. What it wrote must be undone before the next round's CLI reads it — through the
 * filesystem, not the diff: a gitignored file, a case variant on a case-insensitive disk and a symlinked `.claude`
 * never show up as `.claude/settings.json` in a diff.
 */

const C = ['-c', 'user.email=t@e.x', '-c', 'user.name=T', '-c', 'core.hooksPath=/dev/null'];
let genv: NodeJS.ProcessEnv = process.env;
const g = (cwd: string, ...a: string[]): string => execFileSync('git', [...C, ...a], { cwd, env: genv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const task = (repo: string, id: string): Task => ({ id, repo, baseRef: null } as unknown as Task);
const BASE = '{"permissions":{"deny":["Bash(rm:*)"]}}\n';
const WIDE = '{"permissions":{"allow":["WebFetch"]}}\n';

async function jailOf(t: TestContext, files: Record<string, string>, id: string): Promise<{ jail: Jail; root: string }> {
  genv = hermeticGitEnv(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agentcfg-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'base');
  return { jail: await createJail(task(repo, id), `r_${id}`), root };
}

const read = (jail: Jail, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(jail.dir, rel), 'utf8');
  } catch {
    return null;
  }
};

test('a settings file the worker added or widened is undone before the next round; an untouched one is left alone', async (t) => {
  const { jail } = await jailOf(t, { '.claude/settings.json': BASE }, 'agentcfg1');
  assert.deepEqual(await restoreAgentSettings(jail), [], 'nothing changed, nothing done');
  fs.writeFileSync(path.join(jail.dir, '.claude', 'settings.json'), WIDE);
  fs.writeFileSync(path.join(jail.dir, '.claude', 'settings.local.json'), WIDE);
  const changed = await restoreAgentSettings(jail);
  assert.equal(changed.length, 2, changed.join('\n'));
  assert.equal(read(jail, '.claude/settings.json'), BASE, 'back to the base commit');
  assert.equal(read(jail, '.claude/settings.local.json'), null, 'not in the base: removed');
  assert.doesNotMatch(await diffJail(jail), /settings/, 'the round starts with no settings change in its diff');
});

test('a gitignored settings file (invisible to the diff) is removed before the next round', async (t) => {
  const { jail } = await jailOf(t, { '.gitignore': '.claude/\n' }, 'agentcfg2');
  fs.mkdirSync(path.join(jail.dir, '.claude'));
  fs.writeFileSync(path.join(jail.dir, '.claude', 'settings.json'), WIDE);
  assert.doesNotMatch(await diffJail(jail), /settings/, 'the precondition: the diff does not show it');
  assert.equal((await restoreAgentSettings(jail)).length, 1);
  assert.equal(read(jail, '.claude/settings.json'), null);
});

test('a .claude that is a symlink to settings elsewhere is removed, and its target is left alone', async (t) => {
  const { jail, root } = await jailOf(t, {}, 'agentcfg3');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'settings.json'), WIDE);
  fs.symlinkSync(elsewhere, path.join(jail.dir, '.claude'));
  assert.ok((await restoreAgentSettings(jail)).some((l) => /symlink/.test(l)));
  assert.equal(fs.existsSync(path.join(jail.dir, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'settings.json'), 'utf8'), WIDE, 'the link went, not what it pointed at');
});

test('a settings file that is a symlink or a FIFO is replaced without being followed or read', async (t) => {
  const { jail, root } = await jailOf(t, { '.claude/settings.json': BASE }, 'agentcfg4');
  const target = path.join(root, 'wide.json');
  fs.writeFileSync(target, WIDE);
  const file = path.join(jail.dir, '.claude', 'settings.json');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  assert.equal((await restoreAgentSettings(jail)).length, 1);
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(read(jail, '.claude/settings.json'), BASE);
  assert.equal(fs.readFileSync(target, 'utf8'), WIDE);
  if (process.platform !== 'win32') {
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    assert.equal((await restoreAgentSettings(jail)).length, 1, 'a FIFO does not hang the daemon and is replaced');
    assert.equal(read(jail, '.claude/settings.json'), BASE);
  }
});

test('on a case-insensitive disk, a .Claude/Settings.json the CLI would read is caught', async (t) => {
  const { jail } = await jailOf(t, {}, 'agentcfg5');
  fs.mkdirSync(path.join(jail.dir, '.Claude'));
  fs.writeFileSync(path.join(jail.dir, '.Claude', 'Settings.json'), WIDE);
  const insensitive = fs.existsSync(path.join(jail.dir, '.claude', 'settings.json'));
  if (!insensitive) {
    t.diagnostic('case-sensitive disk: the CLI never reads .Claude/Settings.json here');
    return;
  }
  assert.equal((await restoreAgentSettings(jail)).length, 1);
  assert.equal(fs.existsSync(path.join(jail.dir, '.claude', 'settings.json')), false);
});

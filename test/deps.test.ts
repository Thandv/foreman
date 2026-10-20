import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { copyTree, depsCacheRoot, installIsCurrent, lockHash, provisionDeps, pruneDepsCache } from '../src/deps.ts';

/**
 * A repo whose tests only pass when node_modules is present — the exact case
 * that silently failed the gate before dependency provisioning existed.
 */
function npmRepo(opts: { ignoreModules?: boolean; withModules?: boolean; lock?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-npm-'));
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 't@e.st');
  git('config', 'user.name', 'T');

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', type: 'module',
    scripts: { test: 'node -e "import(\'dep\').then(m => process.exit(m.ok ? 0 : 1))"' },
  }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), opts.lock ?? JSON.stringify({ lockfileVersion: 3, name: 'demo' }));
  if (opts.ignoreModules !== false) fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  if (opts.withModules !== false) {
    const dep = path.join(dir, 'node_modules', 'dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(dep, 'index.js'), 'export const ok = true;\n');
    // npm's hidden lockfile: what marks the tree as matching the lockfile.
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  }
  return dir;
}

function jailFrom(repo: string): string {
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-'));
  execFileSync('git', ['worktree', 'add', '-q', '--detach', jail, 'HEAD'], { cwd: repo, stdio: 'ignore' });
  return jail;
}

// ------------------------------------------------------- staleness detection

test('an install is current only when it is at least as new as its lockfile', () => {
  const repo = npmRepo();
  assert.equal(installIsCurrent(repo), true);

  // Touch the lockfile so the installed tree is older than it.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(repo, 'package-lock.json'), later, later);
  assert.equal(installIsCurrent(repo), false, 'a lockfile newer than the install means the tree is stale');

  fs.rmSync(path.join(repo, 'node_modules'), { recursive: true, force: true });
  assert.equal(installIsCurrent(repo), false, 'no tree at all is not current');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a repo with no lockfile has nothing to be stale against', () => {
  const repo = npmRepo();
  fs.rmSync(path.join(repo, 'package-lock.json'));
  assert.equal(installIsCurrent(repo), true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('lockfile hashing is stable and content-sensitive', () => {
  const a = npmRepo();
  const first = lockHash(path.join(a, 'package-lock.json'));
  assert.equal(first, lockHash(path.join(a, 'package-lock.json')));
  fs.writeFileSync(path.join(a, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, changed: true }));
  assert.notEqual(first, lockHash(path.join(a, 'package-lock.json')));
  fs.rmSync(a, { recursive: true, force: true });
});

// ----------------------------------------------------------- provisioning

test("a jail gets the repo's dependencies, and its tests then pass", async () => {
  const repo = npmRepo();
  const jail = jailFrom(repo);
  assert.equal(fs.existsSync(path.join(jail, 'node_modules')), false, 'a worktree never carries node_modules');

  const result = await provisionDeps(jail, repo);
  assert.equal(result.provisioned, true, result.reason);
  assert.equal(result.source, 'repo');
  assert.equal(fs.existsSync(path.join(jail, 'node_modules', 'dep', 'index.js')), true);

  // The whole point: the test command now resolves its dependency.
  execFileSync('npm', ['test', '--silent'], { cwd: jail, stdio: 'ignore' });
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('cloning isolates the jail: writing there never touches the operator tree', async () => {
  const repo = npmRepo();
  const jail = jailFrom(repo);
  await provisionDeps(jail, repo);

  fs.writeFileSync(path.join(jail, 'node_modules', 'dep', 'index.js'), 'export const ok = false; // vandalised\n');
  fs.writeFileSync(path.join(jail, 'node_modules', 'INTRUDER'), 'x');

  assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'utf8'), 'export const ok = true;\n',
    'a runner must not be able to edit the operator’s dependencies');
  assert.equal(fs.existsSync(path.join(repo, 'node_modules', 'INTRUDER')), false);
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('symlink mode is opt-in, and is honest that it shares the tree', async () => {
  const repo = npmRepo();
  const jail = jailFrom(repo);
  process.env['FOREMAN_DEPS_MODE'] = 'symlink';
  const result = await provisionDeps(jail, repo);
  delete process.env['FOREMAN_DEPS_MODE'];

  assert.equal(result.mode, 'symlink');
  assert.equal(fs.lstatSync(path.join(jail, 'node_modules')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(jail, 'node_modules', 'dep', 'index.js')), true, 'reads work through the link');
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('provisioning is skipped when it would be wrong to do it', async () => {
  process.env['FOREMAN_DEPS_MODE'] = 'off';
  const off = npmRepo();
  assert.match((await provisionDeps(jailFrom(off), off)).reason, /disabled/);
  delete process.env['FOREMAN_DEPS_MODE'];

  // node_modules tracked by git: the worktree already has whatever is committed.
  const tracked = npmRepo({ ignoreModules: false, withModules: false });
  fs.mkdirSync(path.join(tracked, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(tracked, 'node_modules', 'dep', 'index.js'), 'export const ok = true;\n');
  execFileSync('git', ['add', '-A'], { cwd: tracked, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'track modules'], { cwd: tracked, stdio: 'ignore' });
  const trackedJail = jailFrom(tracked);
  assert.match((await provisionDeps(trackedJail, tracked)).reason, /tracked by git/);

  // A non-npm project.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-plain-'));
  assert.match((await provisionDeps(plain, plain)).reason, /not an npm project/);

  // A jail that already has a tree is left alone.
  const has = npmRepo();
  const hasJail = jailFrom(has);
  fs.mkdirSync(path.join(hasJail, 'node_modules'), { recursive: true });
  assert.match((await provisionDeps(hasJail, has)).reason, /already has node_modules/);
});

test('a stale repo install falls through to the cache, and a miss is reported not installed', async () => {
  const repo = npmRepo();
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(repo, 'package-lock.json'), later, later); // make the tree stale
  const jail = jailFrom(repo);

  const miss = await provisionDeps(jail, repo, { allowInstall: false });
  assert.equal(miss.provisioned, false);
  assert.match(miss.reason, /no cached install/);

  // Seed the cache for this lockfile and try again: now it is a clone, not an install.
  const key = lockHash(path.join(jail, 'package-lock.json'));
  const cached = path.join(depsCacheRoot(), key, 'node_modules', 'dep');
  fs.mkdirSync(cached, { recursive: true });
  fs.writeFileSync(path.join(cached, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(cached, 'index.js'), 'export const ok = true;\n');

  const hit = await provisionDeps(jail, repo, { allowInstall: false });
  assert.equal(hit.provisioned, true, hit.reason);
  assert.equal(hit.source, 'cache');
  execFileSync('npm', ['test', '--silent'], { cwd: jail, stdio: 'ignore' });

  fs.rmSync(path.join(depsCacheRoot(), key), { recursive: true, force: true });
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('the deps cache is prunable, newest kept', () => {
  const root = depsCacheRoot();
  fs.rmSync(root, { recursive: true, force: true });
  for (const [i, name] of ['aaa', 'bbb', 'ccc'].entries()) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    const when = new Date(Date.now() + i * 10_000);
    fs.utimesSync(path.join(root, name), when, when);
  }
  const dropped = pruneDepsCache(1);
  assert.deepEqual(dropped.sort(), ['aaa', 'bbb']);
  assert.deepEqual(fs.readdirSync(root), ['ccc']);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------- links inside a provisioned tree

/** A package with a command, linked from `.bin` the way npm does it: `.bin/tool -> ../tool/bin/tool`. */
function addTool(modules: string, says = 'TOOL-RAN'): void {
  fs.mkdirSync(path.join(modules, 'tool', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'tool', 'bin', 'tool'), `#!/bin/sh\necho ${says}\n`, { mode: 0o755 });
  fs.symlinkSync('../tool/bin/tool', path.join(modules, '.bin', 'tool'));
}

/** A repo whose own install is stale, with a cached install for its lockfile: provisioning comes from the cache. */
function cachedRepo(): { repo: string; jail: string; cached: string; key: string; done: () => void } {
  const repo = npmRepo({ lock: JSON.stringify({ lockfileVersion: 3, name: 'demo', nonce: `${process.pid}-${Math.random()}` }) });
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(repo, 'package-lock.json'), later, later);
  const jail = jailFrom(repo);
  const key = lockHash(path.join(jail, 'package-lock.json'));
  const cached = path.join(depsCacheRoot(), key, 'node_modules');
  fs.mkdirSync(cached, { recursive: true });
  addTool(cached);
  const done = (): void => {
    for (const d of [path.join(depsCacheRoot(), key), jail, repo]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { repo, jail, cached, key, done };
}

const isInside = (child: string, parent: string): boolean => child.startsWith(`${fs.realpathSync(parent)}${path.sep}`);
const lexists = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

test("a cached install's .bin link stays relative in the jail: it resolves inside the jail, runs, and is not the cache's file", async () => {
  const f = cachedRepo();
  const result = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.equal(result.source, 'cache', result.reason);

  const link = path.join(f.jail, 'node_modules', '.bin', 'tool');
  assert.equal(fs.readlinkSync(link), '../tool/bin/tool', 'the link is copied as written');
  assert.ok(isInside(fs.realpathSync(link), f.jail), `the tool resolves inside the jail, got ${fs.realpathSync(link)}`);
  assert.equal(execFileSync(link, { encoding: 'utf8' }), 'TOOL-RAN\n');

  // What the absolute link cost: every jail ran the ONE file in the cache, so a change there changed them all.
  fs.writeFileSync(path.join(f.cached, 'tool', 'bin', 'tool'), '#!/bin/sh\necho CACHE-CHANGED\n');
  assert.equal(execFileSync(link, { encoding: 'utf8' }), 'TOOL-RAN\n', 'the jail runs its own copy');
  f.done();
});

test("the repo's own tree is placed the same way: its .bin link is relative and resolves inside the jail", async () => {
  const repo = npmRepo();
  addTool(path.join(repo, 'node_modules'));
  const jail = jailFrom(repo);
  const result = await provisionDeps(jail, repo);
  assert.equal(result.source, 'repo', result.reason);

  const link = path.join(jail, 'node_modules', '.bin', 'tool');
  assert.equal(fs.readlinkSync(link), '../tool/bin/tool');
  assert.ok(isInside(fs.realpathSync(link), jail), `got ${fs.realpathSync(link)}`);
  fs.writeFileSync(path.join(repo, 'node_modules', 'tool', 'bin', 'tool'), '#!/bin/sh\necho REPO-CHANGED\n');
  assert.equal(execFileSync(link, { encoding: 'utf8' }), 'TOOL-RAN\n', "the jail runs its own copy, not the operator's");
  fs.rmSync(jail, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a link that leads out of the jail is dropped and named, never recreated or followed; one that stays inside the jail is kept', async () => {
  const f = cachedRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'OUTSIDE-CONTENT\n');
  const bin = path.join(f.cached, '.bin');
  // Absolute into the cache itself (what an older Foreman's copy made), absolute elsewhere, and relative but climbing out.
  fs.symlinkSync(path.join(f.cached, 'tool', 'bin', 'tool'), path.join(bin, 'abs-cache'));
  fs.symlinkSync(path.join(outside, 'secret'), path.join(bin, 'abs-outside'));
  fs.symlinkSync(outside, path.join(f.cached, 'abs-dir'));
  fs.symlinkSync(path.join('..', '..', '..', path.basename(outside), 'secret'), path.join(bin, 'climbs-out'));
  // Stays inside the jail, though outside node_modules: an npm workspace's link to the jail's own package.
  fs.symlinkSync('../src.js', path.join(f.cached, 'ws'));
  // Dangling, inside: nothing to object to.
  fs.symlinkSync('../tool/bin/absent', path.join(bin, 'dangling'));

  const lines: string[] = [];
  const result = await provisionDeps(f.jail, f.repo, { allowInstall: false, onLine: (l) => lines.push(l) });
  assert.equal(result.provisioned, true, result.reason);
  const modules = path.join(f.jail, 'node_modules');

  for (const gone of ['.bin/abs-cache', '.bin/abs-outside', 'abs-dir', '.bin/climbs-out']) {
    assert.equal(lexists(path.join(modules, gone)), false, `${gone} must not exist in the jail in any form`);
    assert.ok(lines.some((l) => l.startsWith('deps: dropped a link that leads out of the jail: ') && l.includes(`node_modules/${gone} -> `)), `${gone} is named in the log: ${lines.join(' | ')}`);
  }
  assert.equal(lines.length, 4, `only the four are reported: ${lines.join(' | ')}`);
  // Nothing from outside was copied in, and nothing outside was touched.
  const files = (fs.readdirSync(modules, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile());
  assert.ok(files.length >= 1 && files.every((e) => !fs.readFileSync(path.join(e.parentPath, e.name), 'utf8').includes('OUTSIDE-CONTENT')), 'no outside content in the jail');
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'OUTSIDE-CONTENT\n');
  assert.equal(lexists(path.join(f.cached, '.bin', 'abs-outside')), true, 'the cache is not edited');

  assert.equal(fs.readlinkSync(path.join(modules, '.bin', 'tool')), '../tool/bin/tool');
  assert.equal(fs.readlinkSync(path.join(modules, 'ws')), '../src.js', "a link to the jail's own tree is kept");
  assert.equal(fs.realpathSync(path.join(modules, 'ws')), path.join(fs.realpathSync(f.jail), 'src.js'));
  assert.equal(fs.readlinkSync(path.join(modules, '.bin', 'dangling')), '../tool/bin/absent');
  fs.rmSync(outside, { recursive: true, force: true });
  f.done();
});

test("dropping links never reaches outside the jail or the jail's own files: a directory a dropped link pointed at keeps its own links, a link that leaves through the jail's own link is dropped, and past twenty the rest are counted", async () => {
  const f = cachedRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-outside-'));
  fs.mkdirSync(path.join(outside, 'deep'));
  fs.writeFileSync(path.join(outside, 'secret'), 'OUTSIDE-CONTENT\n');
  // The outside directory has links of its own that lead out of the jail: a walk that went THROUGH a link would remove them.
  fs.symlinkSync('/usr/bin/true', path.join(outside, 'its-own-link'));
  fs.symlinkSync(path.join(outside, 'secret'), path.join(outside, 'deep', 'its-own-link'));
  fs.symlinkSync(outside, path.join(f.cached, 'abs-dir'));
  // The ticket's own link out of the jail (a repo may track one: docs -> ../shared-docs). Not Foreman's to remove.
  fs.symlinkSync(outside, path.join(f.jail, 'own-link'));
  // Reads as inside the jail, ends up outside it, through that link.
  fs.symlinkSync('../own-link/secret', path.join(f.cached, 'through'));
  for (let i = 0; i < 23; i++) fs.symlinkSync('/usr/bin/true', path.join(f.cached, `many-${i}`));

  const lines: string[] = [];
  const result = await provisionDeps(f.jail, f.repo, { allowInstall: false, onLine: (l) => lines.push(l) });
  assert.equal(result.provisioned, true, result.reason);
  const modules = path.join(f.jail, 'node_modules');

  assert.equal(fs.readlinkSync(path.join(outside, 'its-own-link')), '/usr/bin/true', 'a link inside the directory a dropped link pointed at is not touched');
  assert.equal(fs.readlinkSync(path.join(outside, 'deep', 'its-own-link')), path.join(outside, 'secret'));
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'OUTSIDE-CONTENT\n');
  assert.equal(fs.readlinkSync(path.join(f.jail, 'own-link')), outside, "the jail's own link, outside node_modules, is not Foreman's to drop");
  assert.equal(lexists(path.join(modules, 'abs-dir')), false);
  assert.equal(lexists(path.join(modules, 'through')), false, 'a link that reads as inside but resolves outside is dropped');
  // 25 dropped: 20 named one by one, the rest counted in one line.
  assert.equal(lines.filter((l) => l.startsWith('deps: dropped a link that leads out of the jail: ')).length, 20, lines.join(' | '));
  assert.deepEqual(lines.filter((l) => !l.startsWith('deps: dropped a link that leads out of the jail: ')), ['deps: dropped 5 more links that lead out of the jail']);
  assert.equal(fs.readlinkSync(path.join(modules, '.bin', 'tool')), '../tool/bin/tool');
  fs.rmSync(outside, { recursive: true, force: true });
  f.done();
});

test('a jail whose .bin links lead out of it (placed by an older Foreman) is re-placed; a healthy tree, and a stale one with nothing to replace it, are left alone', async () => {
  const f = cachedRepo();
  // What the old copy left: a real tree whose .bin link is the absolute path of the cache's file.
  const modules = path.join(f.jail, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.symlinkSync(path.join(f.cached, 'tool', 'bin', 'tool'), path.join(modules, '.bin', 'tool'));
  fs.writeFileSync(path.join(modules, 'OLD-TREE'), 'x');

  const again = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.equal(again.provisioned, true, again.reason);
  assert.match(again.reason, /^cloned the cached install .* replacing a tree whose \.bin links led out of the jail$/);
  assert.equal(fs.readlinkSync(path.join(modules, '.bin', 'tool')), '../tool/bin/tool');
  assert.ok(isInside(fs.realpathSync(path.join(modules, '.bin', 'tool')), f.jail));
  assert.equal(fs.existsSync(path.join(modules, 'OLD-TREE')), false, 'the old tree is gone, not merged into');

  // The other direction: a tree with healthy links is not touched on the next round.
  fs.writeFileSync(path.join(modules, 'MINE'), 'x');
  assert.match((await provisionDeps(f.jail, f.repo, { allowInstall: false })).reason, /already has node_modules/);
  assert.equal(fs.existsSync(path.join(modules, 'MINE')), true);

  // And a stale tree is not removed when there is nothing to put in its place.
  fs.rmSync(path.join(modules, '.bin', 'tool'));
  fs.symlinkSync(path.join(f.cached, 'tool', 'bin', 'tool'), path.join(modules, '.bin', 'tool'));
  fs.rmSync(path.join(depsCacheRoot(), f.key), { recursive: true, force: true });
  const none = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.equal(none.provisioned, false);
  assert.match(none.reason, /no cached install/);
  assert.equal(fs.existsSync(path.join(modules, 'MINE')), true, 'the tree it has is better than none');
  f.done();
});

test('copyTree, the copy an install takes into the cache across devices, keeps links as written', async () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-staging-'));
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cachecopy-')), 'node_modules');
  addTool(path.join(from, 'node_modules'));
  await copyTree(path.join(from, 'node_modules'), to);
  assert.equal(fs.readlinkSync(path.join(to, '.bin', 'tool')), '../tool/bin/tool');
  // The staging dir is removed after an install: a link back into it would be dead in the cache and in every jail.
  fs.rmSync(from, { recursive: true, force: true });
  assert.equal(execFileSync(path.join(to, '.bin', 'tool'), { encoding: 'utf8' }), 'TOOL-RAN\n');
  fs.rmSync(path.dirname(to), { recursive: true, force: true });
});

// ------------------------------------------------------- whole or not at all

/** The staging directory a jail's tree is built in: beside the jail, dot-named after it. */
const stagingOf = (jail: string): string => path.join(path.dirname(jail), `.${path.basename(jail)}.deps-tmp`);
const gitStatus = (jail: string): string => execFileSync('git', ['status', '--porcelain', '--ignored=no'], { cwd: jail, encoding: 'utf8' });

/** A cached tree with enough in it to be half-copied, one file of which cannot be read until `heal()`. */
function unreadableIn(cached: string): { heal: () => void } {
  for (const name of ['aa', 'mm', 'zz']) {
    fs.mkdirSync(path.join(cached, name), { recursive: true });
    fs.writeFileSync(path.join(cached, name, 'index.js'), `export const name = '${name}';\n`);
  }
  const locked = path.join(cached, 'mm', 'locked.js');
  fs.writeFileSync(locked, 'export const locked = true;\n');
  fs.chmodSync(locked, 0o000);
  return { heal: () => fs.chmodSync(locked, 0o644) };
}

test('a copy that fails half-way leaves the jail no node_modules and nothing beside it, and the next run places the whole tree', async () => {
  const f = cachedRepo();
  const { heal } = unreadableIn(f.cached);
  const target = path.join(f.jail, 'node_modules');
  try {
    await assert.rejects(provisionDeps(f.jail, f.repo, { allowInstall: false }));
    assert.equal(lexists(target), false, 'no partial tree: the next run would take it for a whole one');
    assert.equal(lexists(stagingOf(f.jail)), false, 'the half-built tree is removed');
    assert.equal(gitStatus(f.jail), '', 'and nothing of it is in the ticket\'s diff');
  } finally {
    heal();
  }
  const again = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.equal(again.provisioned, true, again.reason);
  for (const rel of ['aa/index.js', 'mm/index.js', 'mm/locked.js', 'zz/index.js', 'tool/bin/tool']) {
    assert.equal(fs.existsSync(path.join(target, rel)), true, `${rel} is in the placed tree`);
  }
  assert.equal(fs.readlinkSync(path.join(target, '.bin', 'tool')), '../tool/bin/tool');
  assert.equal(lexists(stagingOf(f.jail)), false);
  assert.equal(gitStatus(f.jail), '');
  f.done();
});

test('a failed re-place keeps the tree the jail had', async () => {
  const f = cachedRepo();
  const modules = path.join(f.jail, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.symlinkSync(path.join(f.cached, 'tool', 'bin', 'tool'), path.join(modules, '.bin', 'tool'));
  fs.writeFileSync(path.join(modules, 'OLD-TREE'), 'x');
  const { heal } = unreadableIn(f.cached);
  try {
    await assert.rejects(provisionDeps(f.jail, f.repo, { allowInstall: false }));
  } finally {
    heal();
  }
  assert.equal(fs.existsSync(path.join(modules, 'OLD-TREE')), true, 'a stale tree is better than a partial one or none');
  assert.equal(fs.existsSync(path.join(modules, 'aa')), false, 'nothing of the failed copy was merged into it');
  assert.equal(lexists(stagingOf(f.jail)), false);
  f.done();
});

test("what a run that died mid-copy left beside the jail is removed on the next provisioning; another live jail's is not", async () => {
  const f = cachedRepo();
  const other = jailFrom(f.repo);
  const gone = path.join(path.dirname(f.jail), `.foreman-jail-gone-${process.pid}.deps-tmp`);
  for (const dir of [stagingOf(f.jail), stagingOf(other), gone]) {
    fs.mkdirSync(path.join(dir, 'new', 'half'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'new', 'half', 'index.js'), 'x');
  }
  const result = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.equal(result.provisioned, true, result.reason);
  assert.equal(lexists(stagingOf(f.jail)), false, "this jail's leftover is gone");
  assert.equal(lexists(gone), false, 'so is one whose jail no longer exists');
  assert.equal(lexists(stagingOf(other)), true, "another jail's may be a copy in progress");
  assert.equal(fs.existsSync(path.join(f.jail, 'node_modules', 'half')), false, 'the leftover is not what was placed');
  assert.equal(gitStatus(f.jail), '');
  fs.rmSync(stagingOf(other), { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
  f.done();
});

/** A stand-in for /bin/cp that copies part of the tree and then fails, the way a clone across volumes might. */
function halfClone(): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-halfclone-'));
  const bin = path.join(dir, 'cp');
  fs.writeFileSync(bin, '#!/bin/sh\n# argv: -c -R <from> <to>\nmkdir -p "$4/HALF-CLONED"\nexit 1\n', { mode: 0o755 });
  return { bin, dir };
}

test('when the clone command fails, what it left is removed and the plain copy places the whole tree, links as written, and says so', async () => {
  for (const make of [(): { bin: string; dir: string | null } => ({ bin: '/usr/bin/false', dir: null }), halfClone, (): { bin: string; dir: string | null } => ({ bin: '/nonexistent/cp', dir: null })]) {
    const f = cachedRepo();
    const clone = make();
    const result = await provisionDeps(f.jail, f.repo, { allowInstall: false, cloneBin: clone.bin });
    assert.equal(result.provisioned, true, result.reason);
    assert.match(result.reason, /^cloned the cached install for lockfile \w+ by plain copy \(no copy-on-write here\)$/, clone.bin);
    const modules = path.join(f.jail, 'node_modules');
    assert.equal(lexists(path.join(modules, 'HALF-CLONED')), false, 'nothing the failed clone left is in the tree');
    assert.equal(fs.readlinkSync(path.join(modules, '.bin', 'tool')), '../tool/bin/tool');
    assert.ok(isInside(fs.realpathSync(path.join(modules, '.bin', 'tool')), f.jail));
    assert.equal(execFileSync(path.join(modules, '.bin', 'tool'), { encoding: 'utf8' }), 'TOOL-RAN\n');
    assert.equal(lexists(stagingOf(f.jail)), false);
    if (clone.dir) fs.rmSync(clone.dir, { recursive: true, force: true });
    f.done();
  }
});

test('on macOS the tree is placed by the clone command, and the reason does not call it a plain copy', { skip: process.platform !== 'darwin' && 'no /bin/cp -c here' }, async () => {
  const f = cachedRepo();
  const result = await provisionDeps(f.jail, f.repo, { allowInstall: false });
  assert.match(result.reason, /^cloned the cached install for lockfile \w+$/);
  const from = path.join(f.cached, 'tool');
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-clonecopy-')), 'tool');
  assert.equal(await copyTree(from, to), 'clone');
  assert.equal(await copyTree(from, `${to}-plain`, null), 'copy');
  // A clone is still a copy: writing to it does not reach the tree it was cloned from.
  fs.appendFileSync(path.join(f.jail, 'node_modules', 'tool', 'bin', 'tool'), '# mine\n');
  assert.doesNotMatch(fs.readFileSync(path.join(f.cached, 'tool', 'bin', 'tool'), 'utf8'), /# mine/);
  fs.rmSync(path.dirname(to), { recursive: true, force: true });
  f.done();
});

test("a repo whose node_modules is a link to a tree elsewhere: the jail gets the tree itself, and the tree it points at loses nothing", async () => {
  const repo = npmRepo({ withModules: false });
  const real = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-realmods-')), 'node_modules');
  fs.mkdirSync(real, { recursive: true });
  addTool(real);
  fs.writeFileSync(path.join(real, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  // `node_modules/` ignores a directory only; a checkout that links its tree ignores the name.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  execFileSync('git', ['commit', '-qam', 'ignore the name'], { cwd: repo, stdio: 'ignore' });
  fs.symlinkSync(real, path.join(repo, 'node_modules'));
  const jail = jailFrom(repo);
  const result = await provisionDeps(jail, repo);
  assert.equal(result.source, 'repo', result.reason);
  assert.equal(fs.lstatSync(path.join(jail, 'node_modules')).isDirectory(), true, 'a tree of its own, not a link out of the jail');
  assert.equal(fs.readlinkSync(path.join(real, '.bin', 'tool')), '../tool/bin/tool', "the operator's tree still has its link");
  assert.ok(isInside(fs.realpathSync(path.join(jail, 'node_modules', '.bin', 'tool')), jail));
  for (const d of [jail, repo, path.dirname(real)]) fs.rmSync(d, { recursive: true, force: true });
});

test('symlink mode with the sandbox on says in the run log that the tree cannot be read; with it off it says nothing', async () => {
  const run = async (sandbox: string): Promise<{ lines: string[]; mode: string; linked: boolean }> => {
    const repo = npmRepo();
    const jail = jailFrom(repo);
    const lines: string[] = [];
    const before = { deps: process.env['FOREMAN_DEPS_MODE'], box: process.env['FOREMAN_SANDBOX'] };
    process.env['FOREMAN_DEPS_MODE'] = 'symlink';
    process.env['FOREMAN_SANDBOX'] = sandbox;
    try {
      const result = await provisionDeps(jail, repo, { onLine: (l) => lines.push(l) });
      return { lines, mode: result.mode, linked: fs.lstatSync(path.join(jail, 'node_modules')).isSymbolicLink() };
    } finally {
      if (before.deps === undefined) delete process.env['FOREMAN_DEPS_MODE'];
      else process.env['FOREMAN_DEPS_MODE'] = before.deps;
      if (before.box === undefined) delete process.env['FOREMAN_SANDBOX'];
      else process.env['FOREMAN_SANDBOX'] = before.box;
      fs.rmSync(jail, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  };
  const on = await run('tests');
  assert.deepEqual([on.mode, on.linked], ['symlink', true], 'the mode is not changed behind the operator');
  assert.equal(on.lines.length, 1, on.lines.join(' | '));
  assert.match(on.lines[0]!, /^deps: FOREMAN_DEPS_MODE=symlink with the sandbox on \(FOREMAN_SANDBOX=tests\): node_modules is a link out of the jail .* a sandboxed command cannot read/);
  const off = await run('off');
  assert.deepEqual([off.mode, off.linked, off.lines], ['symlink', true, []]);
});

// ------------------------------------------------------------- regression

test('a code task on a repo with dependencies passes its test gate', async () => {
  const repo = npmRepo();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5,
    verify: async ({ task, runId }) =>
      store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  const t = store.addTask({
    title: 'edit a file', prompt: "printf '// touched\\n' >> src.js", kind: 'code', runner: 'shell', repo,
  });
  await sched.drain(90_000);

  const after = store.getTask(t.id)!;
  assert.equal(after.status, 'awaiting-approval', after.error ?? '');
  assert.equal(store.latestRun(t.id)!.testsPassed, true, 'the gate must not fail for want of an install');
  const events = store.eventsForTask(t.id).map((e) => e.message).join('\n');
  assert.match(events, /deps: cloned/);

  // And the provisioned tree must not appear as a change the operator made.
  const diff = store.artifactsForTask(t.id).find((a) => a.type === 'diff');
  assert.ok(diff, 'the real edit is still diffed');
  assert.ok(!fs.readFileSync(diff.path, 'utf8').includes('node_modules'), 'node_modules leaked into the diff');
  store.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ------------------------------------------------------- the clone command is macOS's alone (review r1 on-top)

test('off macOS /bin/cp is never run: `cp -c` is another command there, and the tree is placed by plain copy and said so', async () => {
  const { cloneBinFor, CLONE_BIN } = await import('../src/deps.ts');
  assert.equal(CLONE_BIN, '/bin/cp');
  assert.equal(cloneBinFor('darwin'), '/bin/cp');
  for (const p of ['linux', 'freebsd', 'win32'] as const) assert.equal(cloneBinFor(p), null, p);
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const f = cachedRepo();
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  try {
    const result = await provisionDeps(f.jail, f.repo, { allowInstall: false });
    assert.match(result.reason, /^cloned the cached install for lockfile \w+ by plain copy \(no copy-on-write here\)$/);
    const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-nolinuxclone-')), 'tool');
    assert.equal(await copyTree(path.join(f.cached, 'tool'), to), 'copy');
    fs.rmSync(path.dirname(to), { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.equal(fs.readlinkSync(path.join(f.jail, 'node_modules', '.bin', 'tool')), '../tool/bin/tool');
  f.done();
});

// ------------------------------------------- tracked / ignored / not ignored

const porcelain = (dir: string): string => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });

test('node_modules tracked by git is left alone, and the reason says tracked', async () => {
  const repo = npmRepo({ ignoreModules: false });
  execFileSync('git', ['add', '-f', 'node_modules'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'track modules'], { cwd: repo, stdio: 'ignore' });
  const result = await provisionDeps(jailFrom(repo), repo);
  assert.equal(result.provisioned, false);
  assert.match(result.reason, /tracked by git/);
});

test('node_modules ignored by git is provisioned without mention of tracking or the diff', async () => {
  const repo = npmRepo();
  const result = await provisionDeps(jailFrom(repo), repo);
  assert.equal(result.provisioned, true, result.reason);
  assert.doesNotMatch(result.reason, /tracked|diff/);
});

test('node_modules neither tracked nor ignored is provisioned, said so, and kept out of the jail diff', async () => {
  const repo = npmRepo({ ignoreModules: false });
  const jail = jailFrom(repo);
  const result = await provisionDeps(jail, repo);
  assert.equal(result.provisioned, true, result.reason);
  assert.doesNotMatch(result.reason, /tracked by git/);
  assert.match(result.reason, /not ignored by git.*excluded from the diff/);
  assert.equal(fs.existsSync(path.join(jail, 'node_modules', 'dep', 'index.js')), true);
  assert.equal(porcelain(jail), '', 'the placed tree is not an untracked change in the jail');
});

test('a repo with no node_modules at all and none ignored is not reported as tracked', async () => {
  const repo = npmRepo({ ignoreModules: false, withModules: false });
  const result = await provisionDeps(jailFrom(repo), repo);
  assert.equal(result.provisioned, false);
  assert.match(result.reason, /no cached install for lockfile/);
});

test('when git cannot say whether node_modules is tracked, it is left alone and the reason says so', async () => {
  const repo = npmRepo({ ignoreModules: false });
  const jail = jailFrom(repo);
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'not an index');
  const result = await provisionDeps(jail, repo);
  assert.equal(result.provisioned, false);
  assert.match(result.reason, /could not determine whether node_modules is tracked/);
  assert.equal(fs.existsSync(path.join(jail, 'node_modules')), false);
});

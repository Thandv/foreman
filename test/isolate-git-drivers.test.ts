import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  carryDiff, changedFiles, createJail, diffJail, driverlessEnv, jailTree, leftoverMarkers, removeJail, unmergedPaths, type Jail,
} from '../src/isolate.ts';
import type { Task } from '../src/types.ts';
import { hermeticGitEnv } from './helpers/git.ts';

/**
 * A worker can write the repo's `.git/config` and `.git/info/attributes` (and a submodule's, and a repo of its own
 * inside the jail). A filter or merge driver named there must not run in the daemon when Foreman's own git calls
 * (isolate.ts) check out, snapshot, diff or carry a jail. Each planted program appends its label to a marker file.
 */

const T = { timeout: 120_000 };
const C = ['-c', 'user.email=t@e.x', '-c', 'user.name=T', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always'];
/** The running test's git environment (no system config, a scratch global one); tests in a file run one at a time. */
let genv: NodeJS.ProcessEnv = process.env;
/** A plain git for building fixtures; it never runs with a planted driver in place. */
const g = (cwd: string, ...a: string[]): string => execFileSync('git', [...C, ...a], { cwd, env: genv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Fx { root: string; repo: string; marks: string; prog: string }

function fixture(t: TestContext): Fx {
  genv = hermeticGitEnv(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-drivers-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'base');
  const marks = path.join(root, 'marks');
  const prog = path.join(root, 'evil.sh');
  // Leaves a mark. As a clean or smudge filter it passes its input through, so only the marker tells it ran; as
  // anything else it reads nothing (a merge driver given git's stdin waited on it for good: the unfixed carry hung).
  fs.writeFileSync(prog, `#!/bin/sh\necho "$1" >> '${marks}'\ncase "$1" in clean*|smudge*) cat ;; esac\n`, { mode: 0o755 });
  return { root, repo, marks, prog };
}

const fired = (f: Fx): string[] => (fs.existsSync(f.marks) ? fs.readFileSync(f.marks, 'utf8').split('\n').filter(Boolean) : []);
const task = (r: string, id = 't_drv'): Task => ({ id, repo: r, baseRef: null } as unknown as Task);
const plant = (f: Fx, config: string, attributes: string, gitDir = path.join(f.repo, '.git')): void => {
  fs.appendFileSync(path.join(gitDir, 'config'), config);
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.appendFileSync(path.join(gitDir, 'info', 'attributes'), attributes);
};
/** A same-size edit with an old timestamp: git cannot tell it from the index by size or time, so it hashes the file (through a clean filter). */
const touchEdit = (file: string, content: string): void => {
  fs.writeFileSync(file, content);
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
};

test('a smudge, clean or process filter planted before the jail is cut does not run when createJail checks it out', T, async (t) => {
  const f = fixture(t);
  plant(f,
    `[filter "evil"]\n\tsmudge = ${f.prog} smudge\n\tclean = ${f.prog} clean\n\trequired = true\n` +
    `[filter "x=y"]\n\tsmudge = ${f.prog} smudge-eq-name\n[filter "proc"]\n\tprocess = ${f.prog} process\n`,
    'a.txt filter=evil\nb.txt filter=x=y\n*.md filter=proc\n');
  touchEdit(path.join(f.repo, 'a.txt'), 'one\ntwo\nthree\n'); // the dirty check (`status`) re-reads it
  const jail = await createJail(task(f.repo), 'r_cut');
  assert.deepEqual(fired(f), []);
  assert.equal(fs.readFileSync(path.join(jail.dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n', 'the checkout holds what the repo stores');
});

test('a filter pulled in by an include only the new worktree matches (onbranch:foreman/**) does not run on the checkout', T, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git', 'evil.inc'), `[filter "sneaky"]\n\tsmudge = ${f.prog} smudge-onbranch\n`);
  plant(f, '[includeIf "onbranch:foreman/**"]\n\tpath = evil.inc\n', '* filter=sneaky\n');
  await createJail(task(f.repo), 'r_inc');
  assert.deepEqual(fired(f), []);
});

test('a clean filter the worker plants does not run when jailTree snapshots the jail, nor when diffJail, changedFiles or leftoverMarkers read it', T, async (t) => {
  const f = fixture(t);
  const jail = await createJail(task(f.repo), 'r_clean');
  plant(f, `[filter "evil"]\n\tclean = ${f.prog} clean\n[filter "x=y"]\n\tclean = ${f.prog} clean-eq-name\n[filter "proc"]\n\tprocess = ${f.prog} process\n`,
    'a.txt filter=evil\nb.txt filter=x=y\nc.txt filter=proc\n');
  touchEdit(path.join(jail.dir, 'a.txt'), 'one\nTWO\nthree\n');
  touchEdit(path.join(jail.dir, 'b.txt'), 'BEE\n');
  fs.writeFileSync(path.join(jail.dir, 'c.txt'), 'new\n');
  const tree = await jailTree(jail.dir);
  assert.deepEqual(fired(f), [], 'jailTree');
  assert.equal(g(f.repo, 'cat-file', 'blob', `${tree}:a.txt`), 'one\nTWO\nthree\n', 'the snapshot stores the bytes on disk');
  const patch = await diffJail(jail);
  assert.match(patch, /\+TWO/);
  assert.deepEqual(fired(f), [], 'diffJail');
  assert.deepEqual((await changedFiles(jail)).map((c) => c.path).sort(), ['a.txt', 'b.txt', 'c.txt']);
  await leftoverMarkers(jail);
  assert.deepEqual(fired(f), [], 'changedFiles, leftoverMarkers');
});

test('a merge driver and a smudge filter the worker plants do not run when carryDiff three-way applies a patch, nor when it puts the tree back', T, async (t) => {
  const f = fixture(t);
  const first = await createJail(task(f.repo), 'r_one');
  fs.writeFileSync(path.join(first.dir, 'a.txt'), 'one\nTWO\nthree\n');
  const diffPath = path.join(f.root, 'carry.diff');
  fs.writeFileSync(diffPath, await diffJail(first));
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'one\nDIFFERENT\nthree\n');
  g(f.repo, 'commit', '-qam', 'conflicting');
  const second = await createJail(task(f.repo), 'r_two');
  plant(f, `[merge "evm"]\n\tdriver = ${f.prog} merge-driver %O %A %B\n[filter "evil"]\n\tsmudge = ${f.prog} smudge\n\tclean = ${f.prog} clean\n`,
    'a.txt merge=evm filter=evil\n');
  const out = await carryDiff(second, diffPath);
  await unmergedPaths(second.dir);
  assert.deepEqual(fired(f), []);
  // In the driver's place git's own line merge, which finds the conflict it is.
  assert.equal(out.ok, false);
  assert.equal(fs.readFileSync(path.join(second.dir, 'a.txt'), 'utf8'), 'one\nDIFFERENT\nthree\n', 'a refused carry leaves the jail as cut');
});

test('a filter in the config of a repo the worker made inside the jail does not run when diffJail asks whether it is dirty', T, async (t) => {
  const f = fixture(t);
  const jail = await createJail(task(f.repo), 'r_nested');
  const emb = path.join(jail.dir, 'vendor', 'emb');
  fs.mkdirSync(emb, { recursive: true });
  g(emb, 'init', '-q');
  fs.writeFileSync(path.join(emb, 'e.txt'), 'e\n');
  g(emb, 'add', 'e.txt');
  g(emb, 'commit', '-qm', 'e');
  plant(f, `[filter "nest"]\n\tclean = ${f.prog} clean-nested\n`, '* filter=nest\n', path.join(emb, '.git'));
  touchEdit(path.join(emb, 'e.txt'), 'f\n');
  await jailTree(jail.dir);
  await diffJail(jail); // `add -N` makes it a gitlink; the diff then starts a git inside it
  await diffJail(jail);
  assert.deepEqual(fired(f), []);
});

test('a filter in a registered submodule\'s own config does not run when jailTree snapshots the jail', T, async (t) => {
  const f = fixture(t);
  const lib = path.join(f.root, 'lib');
  fs.mkdirSync(lib);
  g(lib, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(lib, 'l.txt'), 'l\n');
  g(lib, 'add', '-A');
  g(lib, 'commit', '-qm', 'l');
  g(f.repo, 'submodule', '-q', 'add', lib, 'lib');
  g(f.repo, 'commit', '-qm', 'sub');
  const jail = await createJail(task(f.repo), 'r_sub');
  g(jail.dir, 'submodule', '-q', 'update', '--init');
  const subGitDir = g(path.join(jail.dir, 'lib'), 'rev-parse', '--absolute-git-dir').trim();
  plant(f, `[filter "subf"]\n\tclean = ${f.prog} clean-sub\n`, '* filter=subf\n', subGitDir);
  touchEdit(path.join(jail.dir, 'lib', 'l.txt'), 'm\n');
  await jailTree(jail.dir);
  await diffJail(jail);
  assert.deepEqual(fired(f), []);
});

test('removeJail runs no planted driver either', T, async (t) => {
  const f = fixture(t);
  const jail: Jail = await createJail(task(f.repo), 'r_rm');
  plant(f, `[filter "evil"]\n\tclean = ${f.prog} clean\n\tsmudge = ${f.prog} smudge\n`, '* filter=evil\n');
  touchEdit(path.join(jail.dir, 'a.txt'), 'one\nTWO\nthree\n');
  await removeJail(jail);
  assert.deepEqual(fired(f), []);
  assert.equal(fs.existsSync(jail.dir), false);
});

test('an honest repo (text, eol and ident attributes, no driver) snapshots to the same tree as before', T, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), '*.txt text eol=lf\n*.id ident\n*.crlf text eol=crlf\n');
  fs.writeFileSync(path.join(f.repo, 'v.id'), '$Id$\n');
  g(f.repo, 'add', '-A');
  g(f.repo, 'commit', '-qm', 'attrs');
  const jail = await createJail(task(f.repo), 'r_honest');
  assert.match(fs.readFileSync(path.join(jail.dir, 'v.id'), 'utf8'), /^\$Id: [0-9a-f]{40} \$\n$/, 'ident still expands on checkout');
  fs.writeFileSync(path.join(jail.dir, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  fs.writeFileSync(path.join(jail.dir, 'w.crlf'), 'x\ny\n');
  fs.writeFileSync(path.join(jail.dir, 'v.id'), '$Id: deadbeef $\nmore\n');
  // What the tree was before this change: the same `add -A` + `write-tree` into a copy of the jail's index, with
  // only the old pins.
  const idx = path.join(f.root, 'idx');
  fs.copyFileSync(g(jail.dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim(), idx);
  const env = { ...genv, GIT_INDEX_FILE: idx };
  const old = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];
  execFileSync('git', [...old, 'add', '-A'], { cwd: jail.dir, env });
  const before = execFileSync('git', [...old, 'write-tree'], { cwd: jail.dir, env, encoding: 'utf8' }).trim();
  assert.equal(await jailTree(jail.dir), before);
});

test('a repo that relies on a filter is snapshotted as the bytes on disk, not as the filter\'s output (the documented cost)', T, async (t) => {
  const f = fixture(t);
  const jail = await createJail(task(f.repo), 'r_lfsish');
  g(f.repo, 'config', 'filter.upper.clean', 'tr a-z A-Z');
  plant(f, '', 'a.txt filter=upper\n');
  fs.writeFileSync(path.join(jail.dir, 'a.txt'), 'changed\n');
  const tree = await jailTree(jail.dir);
  assert.equal(g(f.repo, 'cat-file', 'blob', `${tree}:a.txt`), 'changed\n');
});

test('the driver listing: what it costs, and that it names what a call needs', T, async (t) => {
  const f = fixture(t);
  plant(f, `[filter "evil"]\n\tclean = ${f.prog} clean\n[merge "m"]\n\tdriver = ${f.prog} m\n`, '');
  let t0 = process.hrtime.bigint();
  const env = await driverlessEnv(f.repo);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const pairs = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => `${env[k]}=${env[k.replace('KEY', 'VALUE')]}`).sort();
  assert.equal(env['GIT_CONFIG_COUNT'], String(pairs.length));
  // At least these: a machine's system gitconfig may define drivers of its own (git-lfs), and they are listed too.
  for (const want of ['filter.evil.clean=', 'filter.evil.process=', 'filter.evil.required=false', 'filter.evil.smudge=', 'merge.m.driver=git merge-file -q --marker-size=%L %A %O %B']) {
    assert.ok(pairs.includes(want), `${want} is listed; got ${JSON.stringify(pairs)}`);
  }
  t0 = process.hrtime.bigint();
  const plain = await driverlessEnv(path.join(f.root));
  const outside = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(!Object.values(plain).some((v) => v?.startsWith('filter.evil.')), 'outside the repo, its drivers are not listed');
  t.diagnostic(`driver listing: ${ms.toFixed(1)} ms in a repo with two drivers; ${outside.toFixed(1)} ms outside any repo`);
});

test('the driver listing finds the planted pairs when the system gitconfig defines filter.lfs.* as well', T, async (t) => {
  const f = fixture(t);
  plant(f, `[filter "evil"]\n\tclean = ${f.prog} clean\n[merge "m"]\n\tdriver = ${f.prog} m\n`, '');
  const system = path.join(f.root, 'system-gitconfig');
  // filter.lfs.* as ubuntu's git-lfs writes it, and one filter no machine has: the lfs pairs alone could come from the
  // machine's own config (ubuntu CI, or a `git lfs install` in ~/.gitconfig), so only the probe proves the file is read.
  fs.writeFileSync(system, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n' +
    '[filter "foreman-system-probe"]\n\tclean = false\n');
  // `extra` is what driverlessEnv hands its own config listing (the product drops GIT_CONFIG_* it inherited). The
  // global config is the test's empty scratch file, so the listing is the repo's and this system file's, nothing else.
  const env = await driverlessEnv(f.repo, { GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: genv['GIT_CONFIG_GLOBAL'] });
  const pairs = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => `${env[k]}=${env[k.replace('KEY', 'VALUE')]}`).sort();
  assert.deepEqual(pairs, [
    'filter.evil.clean=', 'filter.evil.process=', 'filter.evil.required=false', 'filter.evil.smudge=',
    'filter.foreman-system-probe.clean=', 'filter.foreman-system-probe.process=', 'filter.foreman-system-probe.required=false', 'filter.foreman-system-probe.smudge=',
    'filter.lfs.clean=', 'filter.lfs.process=', 'filter.lfs.required=false', 'filter.lfs.smudge=',
    'merge.m.driver=git merge-file -q --marker-size=%L %A %O %B',
  ]);
  assert.equal(env['GIT_CONFIG_COUNT'], String(pairs.length));
});

test('a filter and a merge driver with an EMPTY name (`[filter ""]`, named by `filter=`), or a DOTTED one (`[filter "a.b"]`), do not run either', T, async (t) => {
  const f = fixture(t);
  plant(f, `[filter ""]\n\tsmudge = ${f.prog} smudge-empty\n\tclean = ${f.prog} clean-empty\n[merge ""]\n\tdriver = ${f.prog} merge-empty\n` +
    `[filter "a.b"]\n\tsmudge = ${f.prog} smudge-dotted\n\tclean = ${f.prog} clean-dotted\n`,
    '* filter= merge=\nb.txt filter=a.b\n');
  const jail = await createJail(task(f.repo), 'r_empty');
  touchEdit(path.join(jail.dir, 'a.txt'), 'one\ntwo\nTHREE\n');
  touchEdit(path.join(jail.dir, 'b.txt'), 'BEE\n');
  await jailTree(jail.dir);
  await diffJail(jail);
  // A patch both sides changed, carried three-way: git hands a.txt to the merge driver, had it one.
  const patch = path.join(f.root, 'p.diff');
  fs.writeFileSync(patch, '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n two\n three\n');
  assert.equal((await carryDiff(jail, patch)).ok, false, 'the conflict is reported as one');
  assert.deepEqual(fired(f), []);
});

test('no lazy fetch: a promisor remote whose uploadpack is a planted program is not run when a read object is missing', T, async (t) => {
  const f = fixture(t);
  const jail = await createJail(task(f.repo), 'r_lazy');
  for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', f.repo],
    ['remote.origin.promisor', 'true'], ['remote.origin.uploadpack', `${f.prog} uploadpack`]] as const) g(jail.dir, 'config', k, v);
  const oid = g(jail.dir, 'rev-parse', 'HEAD:a.txt').trim();
  fs.rmSync(path.join(f.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  fs.writeFileSync(path.join(jail.dir, 'a.txt'), 'ONE\n');
  await diffJail(jail).catch(() => '');
  await changedFiles(jail).catch(() => []);
  assert.deepEqual(fired(f), []);
});

test('the driver listing fails closed: an index it cannot list is an error, not "no nested repositories"', T, async (t) => {
  const f = fixture(t);
  const jail = await createJail(task(f.repo), 'r_badidx');
  fs.writeFileSync(g(jail.dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim(), 'DIRC garbage');
  await assert.rejects(driverlessEnv(jail.dir), /index/);
});

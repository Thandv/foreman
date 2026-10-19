import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { carryDiff, createJail, diffJail, jailTree } from '../src/isolate.ts';
import type { Task } from '../src/types.ts';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-carry-'));
  const g = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };
  g('init', '-q'); g('config', 'user.email', 't@e.x'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  return dir;
}
const task = (r: string): Task => ({ id: 't_carry', repo: r, baseRef: null } as unknown as Task);

test('a retry jail carries the previous run\'s work on top of a base that moved', async () => {
  const r = repo();
  const first = await createJail(task(r), 'r_one');
  fs.writeFileSync(path.join(first.dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(first.dir, 'new.js'), 'export const ui = 1;\n');
  const diffPath = path.join(r, '..', `carry-${process.pid}.diff`);
  fs.writeFileSync(diffPath, await diffJail(first));
  // Meanwhile main moves on (another ticket merged).
  fs.writeFileSync(path.join(r, 'b.txt'), 'merged meanwhile\n');
  execFileSync('git', ['add', '-A'], { cwd: r }); execFileSync('git', ['commit', '-qm', 'other ticket'], { cwd: r });
  const second = await createJail(task(r), 'r_two');
  assert.deepEqual(await carryDiff(second, diffPath), { ok: true });
  assert.equal(fs.readFileSync(path.join(second.dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  assert.ok(fs.existsSync(path.join(second.dir, 'new.js')), 'new files come along');
  assert.ok(fs.existsSync(path.join(second.dir, 'b.txt')), 'and the moved base is kept');
  fs.rmSync(diffPath, { force: true });
});

test('a carry that conflicts leaves the fresh jail exactly as cut', async () => {
  const r = repo();
  const first = await createJail(task(r), 'r_three');
  fs.writeFileSync(path.join(first.dir, 'a.txt'), 'one\nTWO\nthree\n');
  const diffPath = path.join(r, '..', `carry-x-${process.pid}.diff`);
  fs.writeFileSync(diffPath, await diffJail(first));
  fs.writeFileSync(path.join(r, 'a.txt'), 'one\nDIFFERENT\nthree\n');
  execFileSync('git', ['commit', '-qam', 'conflicting'], { cwd: r });
  const second = await createJail(task(r), 'r_four');
  const out = await carryDiff(second, diffPath);
  assert.equal(out.ok, false);
  assert.equal(fs.readFileSync(path.join(second.dir, 'a.txt'), 'utf8'), 'one\nDIFFERENT\nthree\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: second.dir, encoding: 'utf8' }).trim(), '');
  fs.rmSync(diffPath, { force: true });
});

test('a diff holding a binary file is still refused whole by a carry: no empty or partial file, and the text is not half-carried', async () => {
  const r = repo();
  const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000), Buffer.from('\nIDAT\n\xff\xfe', 'latin1')]);
  const first = await createJail(task(r), 'r_bin_one');
  fs.writeFileSync(path.join(first.dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(first.dir, 'logo.png'), image);
  const diffPath = path.join(r, '..', `carry-bin-${process.pid}.diff`);
  // As the scheduler does around every diff it stores; it also puts the image
  // in the shared object store, where a patch naming it in full would find it.
  await jailTree(first.dir);
  const diff = await diffJail(first);
  assert.match(diff, new RegExp(`^Binary file logo\\.png changed \\(${image.length} bytes, sha256 [0-9a-f]{64}\\)$`, 'm'));
  fs.writeFileSync(diffPath, diff);
  const second = await createJail(task(r), 'r_bin_two');
  const out = await carryDiff(second, diffPath);
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /cannot apply binary patch to 'logo\.png' without full index line/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: second.dir, encoding: 'utf8' }).trim(), '', 'the jail is as cut');
  assert.ok(!fs.existsSync(path.join(second.dir, 'logo.png')));
  fs.rmSync(diffPath, { force: true });
});

test('a baseRef that has merged into HEAD cuts from HEAD, not from the stale draft', async () => {
  const r = repo();
  const g = (...a: string[]): void => { execFileSync('git', a, { cwd: r, stdio: 'ignore' }); };
  g('checkout', '-qb', 'draft');
  fs.writeFileSync(path.join(r, 'draft.txt'), 'the parent\'s work\n');
  g('add', '-A'); g('commit', '-qm', 'draft');
  g('checkout', '-q', '-');
  g('merge', '--no-ff', '-qm', 'merge draft', 'draft');
  fs.writeFileSync(path.join(r, 'later.txt'), 'merged after the draft\n');
  g('add', '-A'); g('commit', '-qm', 'later ticket');
  const jail = await createJail({ ...task(r), id: 't_followup', baseRef: 'draft' } as Task, 'r_merged');
  assert.equal(jail.base, 'HEAD');
  assert.equal(jail.baseMerged, true);
  assert.ok(fs.existsSync(path.join(jail.dir, 'draft.txt')), 'the parent\'s work is there');
  assert.ok(fs.existsSync(path.join(jail.dir, 'later.txt')), 'and so is everything merged since');
});

test('an unmerged baseRef still cuts from the draft', async () => {
  const r = repo();
  const g = (...a: string[]): void => { execFileSync('git', a, { cwd: r, stdio: 'ignore' }); };
  g('checkout', '-qb', 'draft2');
  fs.writeFileSync(path.join(r, 'draft.txt'), 'unmerged work\n');
  g('add', '-A'); g('commit', '-qm', 'draft');
  g('checkout', '-q', '-');
  const jail = await createJail({ ...task(r), id: 't_review', baseRef: 'draft2' } as Task, 'r_unmerged');
  assert.equal(jail.base, 'draft2');
  assert.ok(!jail.baseMerged);
  assert.ok(fs.existsSync(path.join(jail.dir, 'draft.txt')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tool.js');

function run(input, cwd) {
  const res = spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
  });
  return res;
}

function workdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apply-fixes-'));
}

test('happy path: a unique occurrence is replaced and reported APPLIED', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'The kngiht rode north.\n');
  const res = run({ files: [{ path: 'a.md', fixes: [{ old: 'kngiht', new: 'knight' }] }] }, dir);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.applied, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.report[0].status, 'APPLIED');
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'The knight rode north.\n');
});

test('malformed input is rejected rather than guessed at', () => {
  const dir = workdir();
  const notJson = run('{not json', dir);
  assert.notEqual(notJson.status, 0);

  const noFiles = run({ nope: true }, dir);
  assert.notEqual(noFiles.status, 0);
  assert.match(noFiles.stderr, /files/);
});

test('an ambiguous occurrence is skipped and reported AMBIGUOUS×N, never guessed', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'b.md'), 'the the the the\n');
  const res = run({ files: [{ path: 'b.md', fixes: [{ old: 'the', new: 'THE' }] }] }, dir);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.applied, 0);
  assert.equal(out.skipped, 1);
  assert.equal(out.report[0].status, 'AMBIGUOUS×4');
  // Untouched — an ambiguous fix must never partially apply.
  assert.equal(fs.readFileSync(path.join(dir, 'b.md'), 'utf8'), 'the the the the\n');
});

test('absolute paths and directory escapes are refused before any write happens', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'c.md'), 'hello world\n');
  const outsideFile = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-fixes-outside-'));
  fs.writeFileSync(path.join(outsideFile, 'secret.md'), 'do not touch\n');

  const abs = run({ files: [{ path: '/etc/hosts', fixes: [{ old: 'x', new: 'y' }] }] }, dir);
  assert.notEqual(abs.status, 0);
  assert.match(abs.stderr, /refused|absolute/);

  const escape = run(
    { files: [{ path: '../' + path.basename(outsideFile) + '/secret.md', fixes: [{ old: 'do not touch', new: 'TOUCHED' }] }] },
    dir,
  );
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /refused|escapes/);
  assert.equal(fs.readFileSync(path.join(outsideFile, 'secret.md'), 'utf8'), 'do not touch\n');
});

test('a dangling symlink inside the working directory is refused, not followed to write outside it', () => {
  const dir = workdir();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-fixes-outside-dangling-'));
  const outsideTarget = path.join(outsideDir, 'escaped.md');
  fs.symlinkSync(outsideTarget, path.join(dir, 'link.md'));

  const res = run({ files: [{ path: 'link.md', fixes: [{ old: 'x', new: 'y' }] }] }, dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refused|symlink/);
  assert.equal(fs.existsSync(outsideTarget), false, 'the dangling symlink must not have been followed to create/write the file outside the jail');
});

test('a symlink pointing at an existing file (even inside the jail) is refused', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'real.md'), 'apples and oranges\n');
  fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link-to-real.md'));

  const res = run({ files: [{ path: 'link-to-real.md', fixes: [{ old: 'apples', new: 'pears' }] }] }, dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refused|symlink/);
  assert.equal(fs.readFileSync(path.join(dir, 'real.md'), 'utf8'), 'apples and oranges\n', 'the real file behind the symlink must be untouched');
});

test('a normal nested write (new subdirectories, no symlinks involved) still works', () => {
  const dir = workdir();
  fs.mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'deep', 'file.md'), 'The kngiht rode north.\n');
  const res = run({ files: [{ path: 'nested/deep/file.md', fixes: [{ old: 'kngiht', new: 'knight' }] }] }, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'deep', 'file.md'), 'utf8'), 'The knight rode north.\n');
});

test('a batch is all-or-nothing on path validation: a bad path leaves earlier files untouched', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'good.md'), 'apples and oranges\n');
  const res = run(
    {
      files: [
        { path: 'good.md', fixes: [{ old: 'apples', new: 'pears' }] },
        { path: '/tmp/nope', fixes: [{ old: 'x', new: 'y' }] },
      ],
    },
    dir,
  );
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'good.md'), 'utf8'), 'apples and oranges\n');
});

test('a missing file later in the batch fails the call with no earlier file modified', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'teh cat');
  const res = run({
    files: [
      { path: 'a.md', fixes: [{ old: 'teh', new: 'the' }] },
      { path: 'missing.md', fixes: [{ old: 'x', new: 'y' }] },
    ],
  }, dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /missing\.md/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'teh cat');
});

test('two entries naming the same file apply in order against the same text', () => {
  const dir = workdir();
  fs.writeFileSync(path.join(dir, 'a.md'), 'teh cat sat');
  const res = run({
    files: [
      { path: 'a.md', fixes: [{ old: 'teh', new: 'the' }] },
      { path: './a.md', fixes: [{ old: 'cat sat', new: 'cat sits' }] },
    ],
  }, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).applied, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'the cat sits');
});

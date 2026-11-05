import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'checks', 'no-test-counts.ts');
const run = (dir?: string) => spawnSync(process.execPath, dir ? [script, dir] : [script], { cwd: root, encoding: 'utf8' });

function tree(files: Record<string, string>): string {
  const dir = scratchDir('foreman-testcounts-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('the no-test-counts check fails and names file:line for a planted count in README.md and docs/', () => {
  const dir = tree({
    'README.md': '# T\n\nThe suite has ~2,600 tests.\n',
    'docs/sub/x.md': 'ok\nok\n2598/2600 tests pass; 2600 tests passing; about 40 tests\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /README\.md:3: ~2,600 tests/);
    assert.match(r.stderr, /docs[\\/]sub[\\/]x\.md:3: 2598\/2600 tests/);
    assert.match(r.stderr, /x\.md:3: 2600 tests/);
    assert.match(r.stderr, /x\.md:3: 40 tests/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the no-test-counts check passes on prose that is not a count', () => {
  const dir = tree({ 'README.md': 'Add two tests. The next ten tests, and tests 5 and 6, run first. The v2 tests and ES2022 tests too.\n', 'docs/a.md': 'Run the tests.\n' });
  try {
    assert.equal(run(dir).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the no-test-counts check passes on this repository and defaults to the current directory', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every FOREMAN_ setting that `foreman help` says to "see README" for is named in README.md', () => {
  const help = execFileSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'help'], { encoding: 'utf8' });
  const names = help
    .split('\n')
    .filter((l) => /see README/.test(l))
    .flatMap((l) => [...l.matchAll(/FOREMAN_[A-Z0-9_]+/g)].map((m) => m[0]));
  assert.ok(names.length > 0, 'help still points at the README for at least one setting');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.deepEqual(names.filter((n) => !readme.includes(n)), []);
});

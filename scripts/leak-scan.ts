// Dev tool: run each given test file alone with a fresh TMPDIR and list the foreman-* entries it leaves behind.
// Usage: npm run leak-scan -- test/a.test.ts test/b.test.ts   (no arguments: every test file)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : fs
        .readdirSync('test')
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => path.join('test', f));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'leakscan-'));
for (const file of files) {
  const tmp = fs.mkdtempSync(path.join(base, 'run-'));
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=180000', file], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  // test/env.ts privateTmpdir() names what a file with its own temp dir left in it.
  for (const m of String(r.stderr).matchAll(/^foreman-tmp-leak: (.*)$/gm)) console.log(file + ': left in its private temp dir: ' + m[1]);
  const left = fs.readdirSync(tmp).filter((n) => n.startsWith('foreman-'));
  if (left.length) {
    const kinds = [...new Set(left.map((n) => n.replace(/[A-Za-z0-9]{6}$/, '')))].join(' ');
    console.log(file + ' (exit ' + r.status + '): ' + left.length + ' left: ' + kinds);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.rmSync(base, { recursive: true, force: true });
console.log('leak-scan done');

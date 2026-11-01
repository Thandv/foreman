import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'checks', 'config-truth.ts');
const run = (dir?: string) => spawnSync(process.execPath, dir ? [script, dir] : [script], { cwd: root, encoding: 'utf8' });

const row = (n: string) => `| \`${n}\` | 1 | what it does |\n`;
const DOC = `## Configuration\n\n| Name | Default | Effect |\n|---|---|---|\n${row('FOREMAN_FIX_A')}${row('FOREMAN_FIX_B')}`;
const SRC = `const a = process.env.FOREMAN_FIX_A;\nconst b = envNum('FOREMAN_FIX_B', 1);\n`;

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-configtruth-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('config-truth passes when every name read in src/ has a table row and prints read N = documented D + allow-listed A', () => {
  const r = run(tree({ 'src/a.ts': SRC, 'docs/configuration.md': DOC }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /read 2 = documented 2 \+ allow-listed 0/);
});

test('config-truth fails naming a name whose table row was removed', () => {
  const r = run(tree({ 'src/a.ts': SRC, 'docs/configuration.md': DOC.replace(row('FOREMAN_FIX_B'), '') }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /undocumented: FOREMAN_FIX_B \(read in src\/a\.ts\)/);
});

test('config-truth fails naming a new read that no table row documents', () => {
  const r = run(tree({ 'src/a.ts': SRC + "const c = process.env['FOREMAN_FIX_NEW'];\n", 'docs/configuration.md': DOC }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /undocumented: FOREMAN_FIX_NEW/);
});

test('config-truth fails as stale for a documented name that src/ never reads', () => {
  const r = run(tree({ 'src/a.ts': SRC, 'docs/configuration.md': DOC + row('FOREMAN_FIX_GONE') }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale: FOREMAN_FIX_GONE/);
});

test('config-truth ignores a name that only appears in a comment', () => {
  const src = SRC + "// process.env.FOREMAN_FIX_LINE and 'FOREMAN_FIX_LINE2'\n/* `FOREMAN_FIX_BLOCK`\n spans lines */\n";
  const r = run(tree({ 'src/a.ts': src, 'docs/configuration.md': DOC }));
  assert.equal(r.status, 0, r.stderr);
});

test('config-truth passes on this repository', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /read \d+ = documented \d+ \+ allow-listed \d+/);
});

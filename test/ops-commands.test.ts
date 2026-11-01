import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commandNames } from '../scripts/checks/ops-commands.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'checks', 'ops-commands.ts');
const run = (dir?: string) => spawnSync(process.execPath, dir ? [script, dir] : [script], { cwd: root, encoding: 'utf8' });

const FAKE_CLI = [
  'const USAGE = `foreman',
  '',
  '  foreman serve                start',
  '  foreman approve <id>         accept',
  '  foreman retry <id>           requeue',
  '  foreman prune                reclaim',
  '`;',
  'switch (cmd) {',
  "    case 'retry':",
  "    case 'prune': {",
  "    case 'hidden': {",
  '',
].join('\n');

/** Runs the check on a temp tree holding the fake cli.ts and `files`, then removes the tree. */
function check(files: Record<string, string>): ReturnType<typeof run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-opscmds-'));
  try {
    for (const [rel, text] of Object.entries({ 'src/cli.ts': FAKE_CLI, ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the ops-commands check fails and names file:line and the command for a planted unknown foreman command', () => {
  const r = check({ 'docs/OPERATING.md': '# Ops\n\nRun `foreman frobnicate` now.\n\n```\nforeman bogus 12\n```\n\n~~~\nforeman tilde\n~~~\n\n`foreman hidden`\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/OPERATING\.md:3: foreman frobnicate/);
  assert.match(r.stderr, /docs\/OPERATING\.md:6: foreman bogus/);
  assert.match(r.stderr, /docs\/OPERATING\.md:10: foreman tilde/);
  // A dispatch case that `foreman help` does not name is not a command a reader can find.
  assert.match(r.stderr, /docs\/OPERATING\.md:13: foreman hidden/);
});

test('the ops-commands check passes known commands, subcommands and flags, and ignores prose and file names', () => {
  const r = check({
    'docs/OPERATING.md': 'Use `foreman approve 12 --as-is abc`, `foreman retry`, `foreman prune --days 9`, `foreman help`.\n\nforeman needs a daemon. See `foreman.db` and `~/foreman/x`.\n',
    'docs/commands.md': '```\nforeman serve\n```\n',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ops-commands: ok/);
});

test('the ops-commands check fails when src/cli.ts cannot be read', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-opscmds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(dir).status, 1);
});

test('the ops-commands check passes on this repository tree', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

test('the ops-commands check starts no process and reads no FOREMAN_HOME', () => {
  const src = fs.readFileSync(script, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /child_process|spawn|exec|FOREMAN_HOME|process\.env/);
});

test('the command names parsed from src/cli.ts are exactly the commands the real `foreman help` names', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-opshome-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'help'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FOREMAN_HOME: home, FOREMAN_RUN_ID: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const printed = new Set([...r.stdout.matchAll(/^ {2}foreman ([a-z][a-z-]*)/gm)].map((m) => m[1]!));
  assert.ok(printed.size > 20, 'the help table was not read');
  const source = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
  assert.deepEqual([...commandNames(source)].sort(), [...printed, 'help'].sort());
  // Nothing was written to the scratch home by a help call.
  assert.deepEqual(fs.readdirSync(home), []);
});

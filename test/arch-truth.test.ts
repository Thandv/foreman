import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'checks', 'arch-truth.ts');
const run = (dir?: string) => spawnSync(process.execPath, dir ? [script, dir] : [script], { cwd: root, encoding: 'utf8' });

const TYPES = [
  "export type TaskStatus =",
  "  | 'queued'",
  "  | 'running'",
  "  | 'done';",
  "export interface Run {",
  "  id: string;",
  "  status: 'running' | 'succeeded';",
  "}",
  '',
].join('\n');

function doc(opts: { extra?: string; taskStates?: string; runStates?: string } = {}): string {
  return [
    '# Architecture',
    '',
    'The queue lives in `src/queue.ts`; its tests are in `test/queue.test.ts`. Runtime files are at <FOREMAN_HOME>/x and `<FOREMAN_HOME>/work/`.',
    opts.extra ?? '',
    '```mermaid',
    'stateDiagram-v2',
    opts.taskStates ?? '  [*] --> queued\n  queued --> running\n  running --> done\n  done --> [*]',
    '```',
    '```mermaid',
    'stateDiagram-v2',
    '  %% runs',
    opts.runStates ?? '  [*] --> running\n  running --> succeeded',
    '```',
    '',
  ].join('\n');
}

function tree(docText: string, bigLines = 0): string {
  const dir = scratchDir('foreman-archtruth-');
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('src/types.ts', TYPES);
  put('src/queue.ts', 'export {};\n'.repeat(bigLines || 1));
  put('test/queue.test.ts', '');
  put('docs/ARCHITECTURE.md', docText);
  return dir;
}

function check(dir: string): { status: number | null; stderr: string; stdout: string } {
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('arch-truth passes on a doc whose paths, large files and states all match the tree', () => {
  const r = check(tree(doc(), 600));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /arch-truth: ok/);
});

test('arch-truth fails and names a planted stale path in the doc', () => {
  const r = check(tree(doc({ extra: 'See `src/gone/missing.ts` and `scripts/nothing.ts`.' })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ARCHITECTURE\.md:\d+: `src\/gone\/missing\.ts` does not exist/);
  assert.match(r.stderr, /`scripts\/nothing\.ts` does not exist/);
});

test('arch-truth fails when a task state in the diagram is not in the TaskStatus union', () => {
  const r = check(tree(doc({ taskStates: '  [*] --> queued\n  queued --> running\n  running --> finished' })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names not in TaskStatus: finished/);
  assert.match(r.stderr, /lacks: done/);
});

test('arch-truth reads a `state "name" as id` line as the name, and an id without one as itself', () => {
  const aliased = '  state "done" as done_state\n  [*] --> queued\n  queued --> running\n  running --> done_state';
  assert.equal(check(tree(doc({ taskStates: aliased }))).status, 0);
  const r = check(tree(doc({ taskStates: aliased.split('\n').slice(1).join('\n') })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names not in TaskStatus: done_state/);
});

test('arch-truth fails when a run state in the diagram is not in the Run status union', () => {
  const r = check(tree(doc({ runStates: '  [*] --> running\n  running --> succeded' })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names not in Run\.status: succeded/);
});

test('arch-truth fails, instead of skipping, when the doc has a run diagram and the Run status union cannot be read', () => {
  const dir = tree(doc());
  fs.writeFileSync(path.join(dir, 'src/types.ts'), TYPES.replace('export interface Run {', 'export interface Run extends Base {'));
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has a run-status diagram, but no `status` union of `export interface Run \{` was found/);
});

test('arch-truth fails for a src file over 500 lines that the doc does not name', () => {
  const dir = tree(doc().replace('`src/queue.ts`', 'the queue'), 501);
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/queue\.ts has 501 lines \(over 500\) and docs\/ARCHITECTURE\.md does not name it/);
});

test('arch-truth does not ask for a src file of exactly 500 lines to be named', () => {
  const r = check(tree(doc().replace('`src/queue.ts`', 'the queue'), 500));
  assert.equal(r.status, 0, r.stderr);
});

test('arch-truth passes on this repository', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

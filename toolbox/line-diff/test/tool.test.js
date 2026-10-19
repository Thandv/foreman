// Ported from the author's earlier tools (end-to-end tool coverage is new).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tool.js');

function run(input) {
  return spawnSync(process.execPath, [TOOL], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('happy path: end-to-end diff via stdin/stdout', () => {
  const res = run({ before: 'alpha\nbeta\ngamma', after: 'alpha\nnew\ngamma' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.lines, [
    { kind: 'same', text: 'alpha' },
    { kind: 'remove', text: 'beta' },
    { kind: 'add', text: 'new' },
    { kind: 'same', text: 'gamma' },
  ]);
});

test('identical inputs produce an all-same diff', () => {
  const res = run({ before: 'x\ny', after: 'x\ny' });
  const out = JSON.parse(res.stdout);
  assert.ok(out.lines.every((l) => l.kind === 'same'));
});

test('empty strings are valid input (empty diff)', () => {
  const res = run({ before: '', after: '' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.lines, []);
});

test('rejects malformed input: after is not a string', () => {
  const res = run({ before: 'x', after: 5 });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: missing fields', () => {
  const res = run({ before: 'x' });
  assert.notEqual(res.status, 0);
});

test('rejects malformed input: not JSON', () => {
  const res = run('not json at all');
  assert.notEqual(res.status, 0);
});

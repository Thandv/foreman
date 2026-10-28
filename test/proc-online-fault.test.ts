import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnStreaming } from '../src/runners/proc.ts';

function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-online-fault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watchEscapes(t: test.TestContext): unknown[] {
  const escaped: unknown[] = [];
  const collect = (e: unknown): void => {
    escaped.push(e);
  };
  process.on('uncaughtException', collect);
  process.on('unhandledRejection', collect);
  t.after(() => {
    process.off('uncaughtException', collect);
    process.off('unhandledRejection', collect);
  });
  return escaped;
}

test('a throw from onLine on the first line ends the child, stops the lines and rejects the spawn', async (t) => {
  const escaped = watchEscapes(t);
  const seen: string[] = [];
  let pid = 0;
  // The child outlives the suite's 180 s test timeout, so only ending its group can settle the spawn in time.
  await assert.rejects(
    spawnStreaming('sh', ['-c', 'echo one; echo two; echo three >&2; sleep 600'], {
      cwd: scratch(t),
      signal: new AbortController().signal,
      onSpawn: (p) => {
        pid = p;
      },
      onLine: (line) => {
        seen.push(line);
        throw new Error('SQLITE_BUSY');
      },
    }),
    /SQLITE_BUSY/,
  );
  // stdout and stderr are separate pipes with no ordering between them: under load the stderr line can be read first.
  // Either way exactly one line, the first the callback was given (never "two", which follows "one" on stdout), got in.
  assert.equal(seen.length, 1, `only the line that threw reached onLine, saw ${JSON.stringify(seen)}`);
  assert.ok(seen[0] === 'one' || seen[0] === 'three', `the line that threw was the first of its pipe, saw ${seen[0]}`);
  assert.ok(pid > 0);
  assert.equal(groupAlive(pid), false, "the child's group has ended");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(escaped, [], 'nothing escaped');
});

test('a healthy onLine still sees every line and the exit code resolves', async (t) => {
  const seen: string[] = [];
  const code = await spawnStreaming('sh', ['-c', 'echo one; echo two >&2; exit 3'], {
    cwd: scratch(t),
    signal: new AbortController().signal,
    onLine: (line) => {
      seen.push(line);
    },
  });
  assert.equal(code, 3);
  assert.deepEqual(seen.sort(), ['one', 'two']);
});

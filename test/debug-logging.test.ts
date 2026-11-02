import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat } from '../src/models.ts';
import { spawnStreaming } from '../src/runners/proc.ts';
import { checkOllamaParallelism } from '../src/warm.ts';
import { debug } from '../src/debug.ts';

const SENTINEL = 'SENTINEL-prompt-7f3a91';

function setEnv(t: TestContext, name: string, value: string | undefined): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

/** Everything written to fd 2 through fs.writeSync while the test runs; `fail` makes that write throw instead. */
function captureStderr(t: TestContext, fail?: NodeJS.ErrnoException): string[] {
  const lines: string[] = [];
  const real = fs.writeSync;
  (fs as { writeSync: unknown }).writeSync = (fd: number, ...rest: unknown[]) => {
    if (fd !== 2) return (real as (...a: unknown[]) => number)(fd, ...rest);
    if (fail) throw fail;
    lines.push(String(rest[0]));
    return String(rest[0]).length;
  };
  t.after(() => {
    (fs as { writeSync: unknown }).writeSync = real;
  });
  return lines;
}

function mockFetch(t: TestContext, impl: () => Response | Promise<Response>): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => impl()) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
}

const ollamaReply = (): Response =>
  new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 2 })}\n`);

const ask = () => chat({ alias: 'local-fast', sensitivity: 'S1', messages: [{ role: 'user', content: SENTINEL }] });

test('FOREMAN_DEBUG unset writes nothing to stderr from a model call or a spawn', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', undefined);
  const lines = captureStderr(t);
  mockFetch(t, ollamaReply);
  await ask();
  await spawnStreaming(process.execPath, ['-e', '0'], { cwd: os.tmpdir(), signal: new AbortController().signal, onLine() {} });
  assert.deepEqual(lines, []);
});

test('FOREMAN_DEBUG=0 writes nothing to stderr', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '0');
  const lines = captureStderr(t);
  mockFetch(t, ollamaReply);
  await ask();
  assert.deepEqual(lines, []);
});

test('a model call logs a start and an end line and never the prompt', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  mockFetch(t, ollamaReply);
  await ask();
  const out = lines.join('');
  assert.match(lines[0]!, /^\[foreman debug\] model chat start .*alias=local-fast/);
  assert.match(lines[1]!, /^\[foreman debug\] model chat end .*status=ok .*ms=\d+ .*bytes_in=\d+ bytes_out=2 tok_in=3 tok_out=2/);
  assert.equal(lines.length, 2);
  assert.ok(!out.includes(SENTINEL));
});

test('a failed model call logs an end line with status=error and the error type', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  mockFetch(t, () => new Response(`${SENTINEL} boom`, { status: 500 }));
  await assert.rejects(ask());
  const end = lines.find((l) => l.includes('chat end'));
  assert.match(end ?? '', /status=error .*error=ModelUnavailable/);
  assert.ok(!lines.join('').includes(SENTINEL));
});

test('a spawn logs argv0, the argument count, cwd and the exit code but not an argument', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-debug-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const code = await spawnStreaming(process.execPath, ['-e', 'process.exit(3)', SENTINEL], { cwd, signal: new AbortController().signal, onLine() {} });
  assert.equal(code, 3);
  const out = lines.join('');
  assert.match(out, /spawn start .*argv0=node.* argc=4 .*cwd=/);
  assert.match(out, /spawn end .*exit=3 .*ms=\d+/);
  assert.ok(!out.includes(SENTINEL));
  assert.ok(!out.includes('process.exit'));
});

test('a swallowed error is logged by its type and never its message', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  setEnv(t, 'OLLAMA_NUM_PARALLEL', undefined);
  const lines = captureStderr(t);
  mockFetch(t, () => {
    throw Object.assign(new Error(`${SENTINEL} refused`), { code: 'ECONNREFUSED' });
  });
  const r = await checkOllamaParallelism();
  assert.equal(r.ok, false);
  const out = lines.join('');
  assert.match(out, /ollama version end status=error error=ECONNREFUSED/);
  assert.match(out, /swallowed .*error=ECONNREFUSED/);
  assert.ok(!out.includes(SENTINEL));
});

test('secrets are redacted in every shape', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  const shapes = [
    'api_key=hunter2hunter2',
    '{"api_key": "hunter3hunter3"}',
    'Authorization: Bearer hunter4hunter4',
    'sk-hunter5hunter5',
    'ghp_hunter6hunter6',
    'https://user:hunter7hunter7@example.com/path',
  ];
  for (const s of shapes) debug('test', 'shape', { v: s });
  const out = lines.join('');
  for (let i = 2; i <= 7; i++) assert.ok(!out.includes(`hunter${i}`), `shape ${i} leaked: ${out}`);
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('@example.com'));
});

test('a message with a newline cannot forge a second debug line', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  debug('test', 'x\n[foreman debug] model chat end status=ok', { a: 1 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.trimEnd().split('\n').length, 1);
});

test('a closed stderr does not throw', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  captureStderr(t, Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.doesNotThrow(() => debug('test', 'hello', { a: 1 }));
});

import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat } from '../src/models.ts';
import { spawnStreaming } from '../src/runners/proc.ts';
import { checkOllamaParallelism } from '../src/warm.ts';
import { debug, errType } from '../src/debug.ts';

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
  const cwd = scratchDir('foreman-debug-');
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
  // A timed-out fetch rejects with a DOMException, whose numeric code (23) is a legacy number.
  assert.equal(errType(new DOMException(SENTINEL, 'TimeoutError')), 'TimeoutError');
});

test('a non-OK ollama version answer ends with one line, carrying its status', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  setEnv(t, 'OLLAMA_NUM_PARALLEL', undefined);
  const lines = captureStderr(t);
  mockFetch(t, () => new Response('down', { status: 500 }));
  assert.equal((await checkOllamaParallelism()).ok, false);
  assert.deepEqual(lines.filter((l) => l.includes('ollama version end')).map((l) => /status=\S+/.exec(l)?.[0]), ['status=500']);
});

test('a spawn that cannot start logs an end line with status=error and the code', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  const cwd = scratchDir('foreman-debug-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await assert.rejects(spawnStreaming(path.join(cwd, 'no-such-program'), [SENTINEL], { cwd, signal: new AbortController().signal, onLine() {} }), { code: 'ENOENT' });
  assert.match(lines.join(''), /spawn end argv0=no-such-program argc=2 .*status=error error=ENOENT ms=\d+/);
  assert.ok(!lines.join('').includes(SENTINEL));
});

test('the claude -p path logs its spawn start and end (exit 0 and 1), never the prompt, the reply or the CLI output', async (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const dir = scratchDir('foreman-debug-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A stand-in CLI: the prompt rides in argv after -p. It echoes every argument to stderr and the prompt back as
  // the reply; with FAKE_CLAUDE_FAIL set it exits 1, and execFile's error message then quotes the whole command line.
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'printf "%s " "$@" >&2',
    '[ -n "$FAKE_CLAUDE_FAIL" ] && exit 1',
    'while [ $# -gt 0 ]; do [ "$1" = "-p" ] && p="$2"; shift; done',
    'printf \'{"result":"%s","usage":{"input_tokens":5,"output_tokens":3}}\' "$p"',
    '',
  ].join('\n'), { mode: 0o755 });
  setEnv(t, 'FOREMAN_CLAUDE_BIN', bin);
  setEnv(t, 'FAKE_CLAUDE_FAIL', undefined);
  const lines = captureStderr(t);
  const ask = () => chat({ alias: 'haiku', sensitivity: 'S1', messages: [{ role: 'user', content: SENTINEL }] });
  const r = await ask();
  assert.equal(r.text, SENTINEL, 'the stand-in echoed the prompt back');
  process.env['FAKE_CLAUDE_FAIL'] = '1';
  await assert.rejects(ask(), (err: Error) => err.message.includes(SENTINEL));
  const out = lines.join('');
  assert.match(out, /model chat start alias=haiku provider=claude-cli /);
  assert.match(out, /spawn start argv0=claude argc=\d+ cwd=/);
  assert.match(out, /spawn end argv0=claude argc=\d+ cwd=.* exit=0 ms=\d+ bytes_out=\d+/);
  assert.match(out, /model chat end status=ok .*alias=haiku .*tok_in=5 tok_out=3/);
  assert.match(out, /spawn end argv0=claude argc=\d+ cwd=.* exit=1 ms=\d+/);
  assert.match(out, /model chat end status=error error=ModelUnavailable /);
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
    'a bare Bearer hunter8hunter8',
  ];
  for (const s of shapes) debug('test', 'shape', { v: s });
  const out = lines.join('');
  for (let i = 2; i <= 8; i++) assert.ok(!out.includes(`hunter${i}`), `shape ${i} leaked: ${out}`);
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('@example.com'));
});

test('a scope or a message with a newline cannot forge a second debug line', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  debug('test\n[foreman debug] forged', 'x\n[foreman debug] model chat end status=ok', { a: 1 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.trimEnd().split('\n').length, 1);
});

test('a value cannot carry a terminal escape and is capped at 200 characters', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  // A model-chosen tool name: set the window title, erase the line, move up, then a long tail.
  debug('test', 'x', { tool: `\u001b]0;title\u0007\u001b[2K\u001b[1A\u009b${'y'.repeat(500)}` });
  const line = lines[0]!.replace(/\n$/, '');
  assert.doesNotMatch(line, /\p{Cc}/u);
  assert.ok(line.length < 260, `not capped: ${line.length}`);
});

test('a field named tokens_in keeps its numeric value; only values are scrubbed', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  debug('test', 'end', { tokens_in: 3, tokens_out: 2, note: 'token=hunter9' });
  assert.match(lines[0]!, /tokens_in=3 tokens_out=2 /);
  assert.ok(!lines[0]!.includes('hunter9'));
});

test('a value under a secret-named key is redacted whatever it looks like', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  const lines = captureStderr(t);
  // hunter9-14 match no value pattern on their own: only the key can redact them.
  debug('test', 'auth', { token: 'hunter9', api_key: 'sk-test123456789', password: 'hunter10', authorization: 'hunter11', apiKey: 'hunter12', secret: 'hunter13', cookie: 'hunter14', tokens_in: 3, tokens_out: 2, tok_in: 4, tok_out: 5 });
  const line = lines[0]!;
  assert.doesNotMatch(line, /hunter(9|1[0-4])/);
  assert.ok(!line.includes('test123456789'));
  assert.match(line, /token=\[REDACTED\] api_key=\[REDACTED\] password=\[REDACTED\] authorization=\[REDACTED\] apiKey=\[REDACTED\] secret=\[REDACTED\] cookie=\[REDACTED\] tokens_in=3 tokens_out=2 tok_in=4 tok_out=5\n$/);
});

test('a closed stderr does not throw', (t) => {
  setEnv(t, 'FOREMAN_DEBUG', '1');
  captureStderr(t, Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.doesNotThrow(() => debug('test', 'hello', { a: 1 }));
});

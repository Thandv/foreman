import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat, ModelUnavailable } from '../src/models.ts';

/** A fake Ollama on port 0 that answers /api/chat with the given raw lines, then tears itself down. */
async function withStream(lines: string[], run: () => Promise<void>): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(lines.map((l) => `${l}\n`).join(''));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const chunk = (t: string): string => JSON.stringify({ message: { content: t }, done: false });
const final = JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 2 });
const ask = () => chat({ alias: 'local-fast', messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S1' });

test('a mid-stream error object makes chat reject instead of returning the partial reply', async () => {
  await withStream([chunk('one '), chunk('two'), '{"error":"model ran out of memory"}'], async () => {
    await assert.rejects(ask(), (e: unknown) => e instanceof ModelUnavailable && /model ran out of memory/.test((e as Error).message));
  });
});

test('a malformed line in the middle of a good stream is skipped and the reply completes', async () => {
  await withStream([chunk('one '), '{"message": {"content": "tru', chunk('two'), final], async () => {
    const res = await ask();
    assert.equal(res.text, 'one two');
  });
});

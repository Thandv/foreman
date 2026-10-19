import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat, ModelUnavailable, reloadSpecs, timeoutForCall } from '../src/models.ts';

/**
 * The streaming model transport.
 *
 * This exists because of a measured defect, not a hypothetical one: a
 * NON-streaming request sends no response headers until generation completes,
 * and undici (the fetch Node ships) abandons the request after 300s with
 * UND_ERR_HEADERS_TIMEOUT — which no AbortSignal can rescue, because undici has
 * already given up. On a machine sustaining ~10 tok/s that killed every
 * generation past roughly 2,500 tokens, i.e. every chapter draft.
 *
 * So these cases are about the properties that make that impossible to
 * regress: that we ask for a stream, that we reassemble it correctly across
 * arbitrary chunk boundaries, and that a slow-but-progressing stream is not
 * mistaken for a dead one.
 */

interface Stub {
  url: string;
  close: () => Promise<void>;
  /** Every request body the stub received, parsed. */
  bodies: Record<string, unknown>[];
}

/** A local HTTP server that replies with whatever `write` sends, in order. */
async function stubServer(
  handler: (body: Record<string, unknown>, write: (s: string) => Promise<void>, res: http.ServerResponse) => Promise<void>,
): Promise<Stub> {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (s: string): Promise<void> =>
        new Promise((resolve) => { res.write(s) ? resolve() : res.once('drain', () => resolve()); });
      void handler(body, write, res).then(() => res.end()).catch(() => res.destroy());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Point `local-reason` at the stub for the duration of `fn`. */
async function withOllamaStub(stub: Stub, fn: () => Promise<void>): Promise<void> {
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = stub.url;
  reloadSpecs();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    reloadSpecs();
  }
}

const ndjson = (content: string, done = false, counts?: { in: number; out: number }): string =>
  JSON.stringify({
    message: { content },
    done,
    ...(counts ? { prompt_eval_count: counts.in, eval_count: counts.out } : {}),
  }) + '\n';

test('the Ollama call asks for a stream — the whole point of the fix', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('hi', true, { in: 3, out: 1 }));
  });
  await withOllamaStub(stub, async () => {
    await chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1' });
    assert.equal(stub.bodies[0]!['stream'], true, 'stream:false is exactly the bug this file exists for');
    assert.equal(stub.bodies[0]!['think'], false, 'the think:false lesson must survive the rewrite');
  });
  await stub.close();
});

test('the stream is reassembled in order, and the token counts come off the final object', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('Hello'));
    await write(ndjson(', '));
    await write(ndjson('world'));
    await write(ndjson('', true, { in: 11, out: 3 }));
  });
  await withOllamaStub(stub, async () => {
    const res = await chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1' });
    assert.equal(res.text, 'Hello, world');
    assert.equal(res.tokensIn, 11);
    assert.equal(res.tokensOut, 3);
  });
  await stub.close();
});

test('a chunk boundary in the middle of a line loses nothing', async () => {
  // The failure this prevents: TCP splits wherever it likes, so a naive
  // per-chunk JSON.parse drops whichever object straddled the boundary.
  const whole = ndjson('alpha') + ndjson('beta') + ndjson('', true, { in: 1, out: 2 });
  const cut = Math.floor(whole.length / 2);
  const stub = await stubServer(async (_b, write) => {
    await write(whole.slice(0, cut));
    await write(whole.slice(cut));
  });
  await withOllamaStub(stub, async () => {
    const res = await chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1' });
    assert.equal(res.text, 'alphabeta');
  });
  await stub.close();
});

test('a malformed line is dropped rather than losing the whole generation', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('good'));
    await write('{ this is not json }\n');
    await write(ndjson(' more', true, { in: 1, out: 2 }));
  });
  await withOllamaStub(stub, async () => {
    const res = await chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1' });
    assert.equal(res.text, 'good more', 'one bad keep-alive line must not cost 4,000 good tokens');
  });
  await stub.close();
});

test('a final object with no trailing newline is still read', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('start'));
    await write(JSON.stringify({ message: { content: 'end' }, done: true, eval_count: 2 }));
  });
  await withOllamaStub(stub, async () => {
    const res = await chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1' });
    assert.equal(res.text, 'startend');
    assert.equal(res.tokensOut, 2);
  });
  await stub.close();
});

test('a slow stream that keeps arriving is not treated as a dead one', async () => {
  // This is the regression that matters most: the old transport failed a
  // long generation *because it was long*. A stream that takes well over a
  // second per chunk must still complete, bounded only by timeoutMs.
  const stub = await stubServer(async (_b, write) => {
    for (const word of ['one ', 'two ', 'three']) {
      await new Promise((r) => setTimeout(r, 250));
      await write(ndjson(word));
    }
    await write(ndjson('', true, { in: 1, out: 3 }));
  });
  await withOllamaStub(stub, async () => {
    const res = await chat({
      alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1',
      timeoutMs: 10_000,
    });
    assert.equal(res.text, 'one two three');
  });
  await stub.close();
});

test('a stream that goes silent is killed, and says so as silence not as slowness', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('start'));
    await new Promise((r) => setTimeout(r, 5_000));
  });
  await withOllamaStub(stub, async () => {
    await assert.rejects(
      chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1', timeoutMs: 300 }),
      (err: Error) => err instanceof ModelUnavailable && /sent nothing for 300ms/.test(err.message),
    );
  });
  await stub.close();
});

test('a stream that keeps producing runs well past its own timeout — the point of the idle clock', async () => {
  // This is the property the whole redesign exists for. The old total-duration
  // ceiling had to be guessed from an assumed token rate, and guessing low
  // killed ordinary long drafts mid-scene. Here the timeout is 400ms and the
  // stream runs for ~2s: it must complete, because it never stopped producing.
  const stub = await stubServer(async (_b, write) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await write(ndjson('tick '));
    }
    await write(ndjson('', true, { in: 1, out: 10 }));
  });
  await withOllamaStub(stub, async () => {
    const started = Date.now();
    const res = await chat({
      alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1',
      timeoutMs: 400,
    });
    const elapsed = Date.now() - started;
    assert.equal(res.text.trim(), 'tick tick tick tick tick tick tick tick tick tick');
    assert.ok(elapsed > 1_500, `expected the call to outlive its 400ms timeout, took ${elapsed}ms`);
  });
  await stub.close();
});

test('a caller abort still wins, and is not reported as a timeout', async () => {
  const stub = await stubServer(async (_b, write) => {
    await write(ndjson('start'));
    await new Promise((r) => setTimeout(r, 5_000));
  });
  await withOllamaStub(stub, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(
      chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1', signal: ac.signal, timeoutMs: 30_000 }),
      (err: Error) => err instanceof ModelUnavailable && !/timed out/.test(err.message),
    );
  });
  await stub.close();
});

test('a transport failure carries its cause, not the bare string "fetch failed"', async () => {
  // Without this, the header-timeout defect was unfalsifiable: every failure
  // read as "fetch failed" and named nothing.
  const server = http.createServer((_req, res) => res.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${port}`;
  reloadSpecs();
  try {
    await assert.rejects(
      chat({ alias: 'local-reason', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1', timeoutMs: 5_000 }),
      (err: Error) => err instanceof ModelUnavailable && /\(.+\)/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    reloadSpecs();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('an OpenAI-compatible stream is read from `delta`, and SSE framing is stripped', async () => {
  // The persona path: an adopted persona is served by its own mlx_lm.server,
  // and it does exactly the long generations that hit the header timeout.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-models-'));
  const stub = await stubServer(async (_b, write) => {
    await write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n');
    await write(': keep-alive comment\n');
    await write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n');
    await write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n');
    await write('data: [DONE]\n');
  });
  const prevHome = process.env['FOREMAN_HOME'];
  process.env['FOREMAN_HOME'] = dir;
  try {
    // config.home is captured at module load, so write the models file where
    // the already-loaded config points, and register the alias there.
    const { config } = await import('../src/config.ts');
    fs.mkdirSync(config.home, { recursive: true });
    const modelsFile = path.join(config.home, 'models.json');
    const existed = fs.existsSync(modelsFile) ? fs.readFileSync(modelsFile, 'utf8') : null;
    fs.writeFileSync(modelsFile, JSON.stringify({
      models: [{ alias: 'stub-persona', provider: 'openai', model: 'stub', local: true, baseUrl: `${stub.url}/v1`, usdPerMTokIn: 0, usdPerMTokOut: 0 }],
    }));
    reloadSpecs();
    try {
      const res = await chat({ alias: 'stub-persona', messages: [{ role: 'user', content: 'x' }], sensitivity: 'S1', timeoutMs: 10_000 });
      assert.equal(res.text, 'Hello');
      assert.equal(res.tokensIn, 4);
      assert.equal(res.tokensOut, 2);
      assert.equal(stub.bodies[0]!['stream'], true);
    } finally {
      if (existed === null) fs.rmSync(modelsFile, { force: true });
      else fs.writeFileSync(modelsFile, existed);
      reloadSpecs();
    }
  } finally {
    if (prevHome === undefined) delete process.env['FOREMAN_HOME'];
    else process.env['FOREMAN_HOME'] = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

// ------------------------------------------------------------------ timeouts

test('the idle allowance still stretches for a big local request, whose first chunk is slowest', () => {
  const floor = timeoutForCall({ local: true });
  assert.equal(floor, 180_000, 'the historical default is still the floor');

  // The one wait a pure idle clock still gets wrong is the FIRST chunk: model
  // load plus evaluation of a 16k-token prompt on a cold 9B, before a single
  // token is emitted. A big request implies a big prompt, so it gets room.
  assert.ok(timeoutForCall({ maxTokens: 8192, local: true }) > floor);

  // A small call is not slowed down by the rule.
  assert.equal(timeoutForCall({ maxTokens: 100, local: true }), floor);
  // A cloud model's first chunk is fast; the floor already covers it.
  assert.equal(timeoutForCall({ maxTokens: 8192, local: false }), floor);
  // An explicit ceiling always wins, in both directions.
  assert.equal(timeoutForCall({ timeoutMs: 42, maxTokens: 8192, local: true }), 42);
});

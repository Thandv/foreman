import './env.ts';
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savePersona, seedPersonas } from '../src/align/personas.ts';
import { servePersona } from '../src/align/personaServe.ts';

const escaped: unknown[] = [];
const collect = (reason: unknown): void => {
  escaped.push(reason);
};
before(() => {
  process.on('unhandledRejection', collect);
  process.on('uncaughtException', collect);
});
after(() => {
  process.off('unhandledRejection', collect);
  process.off('uncaughtException', collect);
});

function setEnv(t: TestContext, name: string, value: string): void {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

test('a persona server that cannot be spawned resolves not-serving at once and removes its pid file', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-persona-spawn-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const emptyBin = path.join(home, 'bin');
  fs.mkdirSync(emptyBin);
  setEnv(t, 'FOREMAN_ALIGN_DIR', path.join(home, 'align'));
  setEnv(t, 'FOREMAN_PERSONA_URL_PUBLISHING_AUTHOR', 'http://127.0.0.1:1/v1');
  const persona = seedPersonas()[0]!;
  savePersona(persona);
  const adapter = path.join(home, 'align', 'personas', persona.id, 'adapter');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(path.join(adapter, 'adapters.safetensors'), 'weights');
  setEnv(t, 'PATH', emptyBin);
  escaped.splice(0);
  // A long start timeout: only the spawn error can end the call within the test's own limit.
  const result = await servePersona(persona, { startTimeoutMs: 600_000 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.ok, false);
  assert.equal(result.pid, null);
  assert.match(result.reason, /ENOENT/);
  assert.equal(fs.existsSync(path.join(home, 'align', 'personas', persona.id, 'server.pid')), false, 'the pid file is gone');
  assert.deepEqual(escaped.splice(0).map(String), [], 'nothing escaped');
});

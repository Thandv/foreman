import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { personaPort, savePersona, seedPersonas, type Persona } from '../src/align/personas.ts';
import { servePersona, stopPersonaServer } from '../src/align/personaServe.ts';
import { startAdoptedPersonas } from '../src/align/personaHealth.ts';

function setEnv(t: TestContext, name: string, value: string): void {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

interface Fixture {
  persona: Persona;
  pidFile: string;
  marker: string;
}

/**
 * An adopted persona with a trained adapter, a FOREMAN_PYTHON stub that marks that it was spawned, and a stub HTTP
 * server answering /models on exactly personaPort(id) — a listener Foreman did not start.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const home = scratchDir('foreman-persona-port-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  setEnv(t, 'FOREMAN_ALIGN_DIR', path.join(home, 'align'));
  setEnv(t, 'FOREMAN_PERSONAS_DIR', path.join(home, 'personas'));

  const listener = http.createServer((_req, res) => res.end('{"data":[]}'));
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const port = (listener.address() as AddressInfo).port;

  const persona: Persona = { ...seedPersonas()[0]!, status: 'adopted', alias: 'persona-port-test' };
  const offset = personaPort(persona.id) - 4200; // the env sweep in test/env.ts leaves the default base
  setEnv(t, 'FOREMAN_PERSONA_PORT_BASE', String(port - offset));
  assert.equal(personaPort(persona.id), port);
  savePersona(persona);

  const adapter = path.join(home, 'align', 'personas', persona.id, 'adapter');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(path.join(adapter, 'adapters.safetensors'), 'weights');

  const marker = path.join(home, 'spawned');
  const stub = path.join(home, 'python');
  fs.writeFileSync(stub, `#!/bin/sh\necho spawned > '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
  setEnv(t, 'FOREMAN_PYTHON', stub);
  t.after(() => {
    stopPersonaServer(persona.id);
  });
  return { persona, pidFile: path.join(home, 'align', 'personas', persona.id, 'server.pid'), marker };
}

const foreign = (id: string): RegExp =>
  new RegExp(`^port \\d+ answered by another process \\(persona ${id.replace(/\./g, '\\.')}\\); set FOREMAN_PERSONA_PORT_BASE or FOREMAN_PERSONA_URL_<ID>$`);

test('servePersona refuses a persona port another process already answers, and spawns nothing', async (t) => {
  const { persona, pidFile, marker } = await fixture(t);
  const result = await servePersona(persona, { startTimeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.equal(result.pid, null);
  assert.match(result.reason, foreign(persona.id));
  assert.match(result.reason, new RegExp(`port ${personaPort(persona.id)} `));
  assert.equal(fs.existsSync(pidFile), false, 'no pid file');
  assert.equal(fs.existsSync(marker), false, 'nothing was spawned');
});

test('startAdoptedPersonas reports a foreign listener on the persona port as not ok, and spawns nothing', async (t) => {
  const { persona, pidFile, marker } = await fixture(t);
  const reports = await startAdoptedPersonas({ startTimeoutMs: 60_000 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.id, persona.id);
  assert.equal(reports[0]!.ok, false);
  assert.match(reports[0]!.reason, foreign(persona.id));
  assert.equal(fs.existsSync(pidFile), false, 'no pid file');
  assert.equal(fs.existsSync(marker), false, 'nothing was spawned');
});

test("the persona's own live server (pid file pid alive) is still 'already serving'", async (t) => {
  const { persona, pidFile, marker } = await fixture(t);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  let reports;
  try {
    reports = await startAdoptedPersonas({ startTimeoutMs: 60_000 });
  } finally {
    // The fixture's cleanup stops the persona server by its pid file, which here names this test process.
    fs.rmSync(pidFile, { force: true });
  }
  assert.deepEqual(reports, [{ id: persona.id, ok: true, reason: 'already serving' }]);
  assert.equal(fs.existsSync(marker), false, 'nothing was spawned');
});

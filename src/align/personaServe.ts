import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { alignDir } from './extract.ts';
import { personaAdapterDir, personaPort, personaServerUrl, type Persona } from './personas.ts';

/** Read lazily so a test or an operator can point it elsewhere per case. */
const python = (): string => process.env['FOREMAN_PYTHON'] ?? '/opt/homebrew/bin/python3';

/**
 * Serving an adopted persona, for real.
 *
 * `foreman persona serve` used to print the command to run. That is how an
 * adopted persona ends up registered as a model alias, routed live work by
 * `modelForTask`, and answering nothing at all — the alias exists, the endpoint
 * does not, and the first ticket to reach it fails on a connection refused.
 * Adoption changes routing, so serving has to be something the system does
 * rather than something it suggests.
 *
 * The server is deliberately NOT held behind the machine's local-model lock: it
 * is meant to stay up and answer tickets, which is the opposite of a job that
 * finishes and hands the machine back. Its memory cost is real and the operator
 * should know it — `persona serve --stop` is the other half of this command.
 */
function pidFile(id: string): string {
  return path.join(alignDir(), 'personas', id, 'server.pid');
}

/** The pid serving this persona, or null. A dead pid is cleared. */
export function personaServerPid(id: string): number | null {
  const file = pidFile(id);
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    fs.rmSync(file, { force: true });
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(file, { force: true });
    return null;
  }
}

export function stopPersonaServer(id: string): boolean {
  const pid = personaServerPid(id);
  if (pid === null) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(pidFile(id), { force: true });
  return true;
}

export interface ServeResult {
  ok: boolean;
  reason: string;
  pid: number | null;
}

export async function servePersona(
  persona: Persona,
  opts: { startTimeoutMs?: number } = {},
): Promise<ServeResult> {
  const adapter = personaAdapterDir(persona.id);
  if (!fs.existsSync(adapter) || !fs.readdirSync(adapter).some((f) => f.endsWith('.safetensors'))) {
    return { ok: false, reason: `no trained adapter at ${adapter}`, pid: null };
  }

  const args = [
    '-m', 'mlx_lm', 'server',
    '--model', persona.base,
    '--adapter-path', adapter,
    '--port', String(personaPort(persona.id)),
  ];
  // Niced: this answers tickets in the background and should lose to whatever
  // the operator is doing in the foreground.
  const child = spawn('nice', ['-n', process.env['FOREMAN_SERVE_NICE'] ?? '10', python(), ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  // A spawn that fails (no `nice` on PATH) emits 'error'; with no listener that is an uncaught exception.
  let spawnError: Error | null = null;
  const failed = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      spawnError = err;
      resolve();
    });
  });

  fs.mkdirSync(path.dirname(pidFile(persona.id)), { recursive: true });
  fs.writeFileSync(pidFile(persona.id), String(child.pid ?? 0));

  const base = personaServerUrl(persona.id);
  const deadline = Date.now() + (opts.startTimeoutMs ?? 300_000);
  for (;;) {
    if (spawnError) {
      fs.rmSync(pidFile(persona.id), { force: true });
      return { ok: false, reason: `could not start the server: ${(spawnError as Error).message}`, pid: null };
    }
    if (child.exitCode !== null) {
      fs.rmSync(pidFile(persona.id), { force: true });
      return { ok: false, reason: `mlx_lm server exited ${child.exitCode}`, pid: null };
    }
    try {
      const res = await Promise.race([fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) }), failed]);
      if (res && res.ok) return { ok: true, reason: 'serving', pid: child.pid ?? null };
    } catch {
      /* not up yet */
    }
    if (spawnError) continue;
    if (Date.now() > deadline) {
      stopPersonaServer(persona.id);
      return { ok: false, reason: `did not come up on ${base} within the start timeout`, pid: null };
    }
    let nap: NodeJS.Timeout | undefined;
    await Promise.race([new Promise((r) => (nap = setTimeout(r, 2_000))), failed]);
    clearTimeout(nap);
  }
}

// Imported first by each bench script, before anything from src/: src/config.ts reads FOREMAN_HOME when it loads.
// A bench runs with a known configuration in a home of its own, whatever the caller's shell exports, so its numbers
// do not depend on the operator's tuning and it writes nothing to the operator's (or a running daemon's) home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

for (const name of Object.keys(process.env)) {
  if (name.startsWith('FOREMAN_')) delete process.env[name];
}

/** Every temp dir the bench made; all removed when it exits. */
const made: string[] = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
// Ctrl-C or a kill exits through the handler above too, so a stopped bench leaves no temp dirs behind.
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) process.on(sig, () => process.exit(code));

/** Stops the exit handler removing the temp dirs and returns them: for a script whose operator asked to keep them. */
export function keepScratch(): string[] {
  return made.splice(0);
}

/** A fresh temp dir, removed when the bench exits. */
export function scratch(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `foreman-bench-${prefix}-`)));
  made.push(dir);
  return dir;
}

process.env['FOREMAN_HOME'] = scratch('home');
// No daemon is started; a server a bench opens listens on an ephemeral loopback port.
process.env['FOREMAN_PORT'] = '0';
// The benches measure Foreman's own queue and pipeline. The OS sandbox is a per-command wrapper whose cost depends on
// the platform (and which does not exist on Linux), so it is off here, as it is for the suites.
process.env['FOREMAN_SANDBOX'] = 'off';

/** The bench's options: `--name value` pairs as numbers or number lists, and `--json`. */
export function options<K extends string>(defaults: Record<K, string>): { values: Record<K, string>; json: boolean } {
  const spec: Record<string, { type: 'string' | 'boolean' }> = { json: { type: 'boolean' } };
  for (const k of Object.keys(defaults)) spec[k] = { type: 'string' };
  const { values } = parseArgs({ options: spec, strict: true });
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as K[]) {
    const v = values[k];
    if (typeof v === 'string') out[k] = v;
  }
  return { values: out, json: values['json'] === true };
}

/** A positive whole number from an option, or an error naming it. */
export function count(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  return n;
}

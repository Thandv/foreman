import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The benchmarks in scripts/bench are too slow for the suite at their real sizes. These runs are the smallest sizes
// that still exercise every path: each script runs from the checkout, with no network, and leaves the FOREMAN_HOME it
// was started with untouched.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function bench(script: string, args: string[]): Promise<{ out: unknown; home: string }> {
  // The caller's home: the bench must not write here (nor anywhere but its own temp dir).
  const home = scratchDir('foreman-bench-caller-');
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'bench', script), ...args, '--json'], {
    cwd: root,
    env: { ...process.env, FOREMAN_HOME: home },
    timeout: 120_000,
  });
  return { out: JSON.parse(stdout) as unknown, home };
}

test('tsconfig typechecks scripts/bench, so npm run verify does', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as { include: string[] };
  assert.ok(tsconfig.include.includes('scripts/bench'), `include is ${JSON.stringify(tsconfig.include)}`);
});

test('the ledger bench reports p50 and p99 of each operation at each size, and writes nothing to FOREMAN_HOME', async () => {
  const { out, home } = await bench('ledger.ts', ['--sizes', '50,100', '--iterations', '3']);
  const rows = out as Array<{ tasks: number; op: string; p50Ms: number; p99Ms: number; samples: number }>;
  for (const tasks of [50, 100]) {
    assert.deepEqual(
      rows.filter((r) => r.tasks === tasks).map((r) => r.op),
      ['reconcileBlocked', 'claimable', 'snapshot', 'record'],
      `every operation is measured at ${tasks} tasks`,
    );
  }
  for (const r of rows) {
    assert.equal(r.samples, 3);
    assert.ok(r.p50Ms >= 0 && r.p99Ms >= r.p50Ms, JSON.stringify(r));
  }
  assert.deepEqual(fs.readdirSync(home), [], 'the caller\'s FOREMAN_HOME is untouched');
});

test('the pipeline bench lands every ticket with gate batching on and off, and batching makes fewer model calls', async () => {
  const { out, home } = await bench('pipeline.ts', ['--tickets', '3', '--suite-ms', '10', '--model-ms', '10']);
  const runs = out as Array<{
    gateBatch: 'on' | 'off'; tickets: number; landed: number; modelCalls: number; ticketsPerHour: number;
    suiteRunsPerLanded: number; dispatchMs: { p50: number }; gateMs: { p50: number }; landingMs: { p50: number };
  }>;
  assert.deepEqual(runs.map((r) => r.gateBatch), ['on', 'off']);
  for (const r of runs) {
    assert.equal(r.landed, 3, `${r.gateBatch}: every ticket landed`);
    assert.ok(r.ticketsPerHour > 0);
    // Each landing runs the suite at least twice: the ticket's own check, then the post-merge check on main.
    assert.ok(r.suiteRunsPerLanded >= 2, `${r.gateBatch}: ${r.suiteRunsPerLanded} suite runs per landed ticket`);
    for (const ms of [r.dispatchMs.p50, r.gateMs.p50, r.landingMs.p50]) assert.ok(ms >= 0);
  }
  const [on, off] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(off.modelCalls, 3, 'batching off: one owner-gate call per ticket');
  assert.ok(on.modelCalls < off.modelCalls, `batching on made ${on.modelCalls} calls`);
  assert.deepEqual(fs.readdirSync(home), [], 'the caller\'s FOREMAN_HOME is untouched');
});

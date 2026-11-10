import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ownerCall, OwnerCallError } from '../src/assistant/ownerCall.ts';
import { SensitivityViolation } from '../src/models.ts';

/** A claude CLI stand-in that leaves a marker when it is spawned at all. */
function stubClaude(): { marker: string; restore: () => void } {
  const dir = scratchDir('foreman-ownercall-s2-');
  const marker = path.join(dir, 'spawned');
  const body = JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0, result: 'ok' });
  fs.writeFileSync(path.join(dir, 'body'), body);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n: > "${marker}"\ncat "${path.join(dir, 'body')}"\n`);
  fs.chmodSync(bin, 0o755);
  const prev = { bin: process.env['FOREMAN_CLAUDE_BIN'], local: process.env['FOREMAN_LOCAL_ONLY'] };
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  delete process.env['FOREMAN_LOCAL_ONLY'];
  return {
    marker,
    restore: () => {
      for (const [key, value] of [['FOREMAN_CLAUDE_BIN', prev.bin], ['FOREMAN_LOCAL_ONLY', prev.local]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('an S2 owner call is refused with SensitivityViolation before the hosted CLI is spawned', async () => {
  const stub = stubClaude();
  try {
    await assert.rejects(
      ownerCall('judge this diff', { sensitivity: 'S2' }),
      (err: unknown) => err instanceof SensitivityViolation && /S2 task refused: alias '.+' runs on claude-cli/.test(err.message),
    );
    assert.equal(fs.existsSync(stub.marker), false, 'the CLI must never run for S2 work');
  } finally {
    stub.restore();
  }
});

test('S0 and S1 owner calls still reach the CLI', async () => {
  for (const sensitivity of ['S0', 'S1'] as const) {
    const stub = stubClaude();
    try {
      const res = await ownerCall('judge this diff', { sensitivity });
      assert.equal(res.text, 'ok');
      assert.equal(fs.existsSync(stub.marker), true, `${sensitivity} spawns the CLI`);
    } finally {
      stub.restore();
    }
  }
});

test('local-only keeps its own refusal for every sensitivity, and spawns nothing', async () => {
  for (const sensitivity of ['S1', 'S2'] as const) {
    const stub = stubClaude();
    process.env['FOREMAN_LOCAL_ONLY'] = '1';
    try {
      await assert.rejects(
        ownerCall('judge this diff', { sensitivity }),
        (err: unknown) => err instanceof OwnerCallError && err.reason === 'spawn' &&
          /FOREMAN_LOCAL_ONLY.*: the owner CLI is a hosted model and may not be called$/.test(err.message),
      );
      assert.equal(fs.existsSync(stub.marker), false);
    } finally {
      stub.restore();
    }
  }
});

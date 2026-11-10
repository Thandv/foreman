import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

function run(argv: string[], env: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...argv], { env: { ...process.env, FOREMAN_HOME: testHome, ...env }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('foreman config --effective prints each config.ts knob with its source, and other FOREMAN_* names only', () => {
  const r = run(['config', '--effective'], {
    FOREMAN_SANDBOX: 'off',
    FOREMAN_MAX_WORKERS: '7',
    FOREMAN_SOME_API_TOKEN: 'sekrit-value-123',
  });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(r.stdout, /^FOREMAN_MAX_WORKERS\s+7\s+env$/m);
  assert.match(r.stdout, /^FOREMAN_TICK_MS\s+5\s+env$/m);
  assert.match(r.stdout, /^FOREMAN_COUNCIL_MAX_TOKENS\s+350\s+default$/m);
  assert.match(r.stdout, /^FOREMAN_TASK_TIMEOUT_MS\s+\d+\s+default$/m);
  const last = lines.at(-1)!;
  assert.match(last, /^\d+ other FOREMAN_\* names are read in place \(not shown\): /);
  assert.match(last, /\bFOREMAN_SANDBOX\b/);
  assert.match(last, /\bFOREMAN_SOME_API_TOKEN\b/);
  assert.doesNotMatch(last, /FOREMAN_MAX_WORKERS/, 'a knob config.ts resolves is not in the trailing line');
  assert.doesNotMatch(r.stdout, /sekrit-value-123/);
  assert.doesNotMatch(r.stdout, /=off|\boff\b/, 'FOREMAN_SANDBOX appears by name only');
});

test('foreman config without --effective is a usage error', () => {
  const r = run(['config'], {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: foreman config --effective/);
});

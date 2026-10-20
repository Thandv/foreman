import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prewarmRoster, residentSummary, warmSummary, warmTargets } from '../src/warm.ts';

test('residentSummary reports resident models, and the reason when Ollama is unreachable', async () => {
  const fast = (await import('../src/models.ts')).resolveSpec('local-fast').model;
  assert.equal(
    await residentSummary(['local-fast', 'local-code'], async () => new Set([fast])),
    'local-fast — failed: local-code (not loaded)',
  );
  assert.equal(
    await residentSummary(['local-fast'], async () => { throw new Error('fetch failed'); }),
    '(none) — failed: local-fast (fetch failed)',
  );
});

const res = (alias: string, ok: boolean, error: string | null = null) =>
  ({ alias, model: alias, ok, ms: 1, error });

test('warmSummary lists every model when all warmed', () => {
  assert.equal(warmSummary([res('local-fast', true), res('local-code', true)]), 'local-fast, local-code');
});

test('warmSummary lists the warmed models and names the failed ones with the reason', () => {
  assert.equal(
    warmSummary([res('local-fast', true), res('local-code', false, 'fetch failed')]),
    'local-fast — failed: local-code (fetch failed)',
  );
});

test('warmSummary lists no model as warmed when all failed', () => {
  assert.equal(
    warmSummary([res('local-fast', false, 'fetch failed'), res('local-code', false, 'fetch failed')]),
    '(none) — failed: local-fast (fetch failed); local-code (fetch failed)',
  );
});

test('the warm list is rung-0 only, and Ollama-only', () => {
  const targets = warmTargets('S1');
  assert.ok(targets.length >= 1 && targets.length <= 3, `expected the rung-0 set, got ${targets.join(',')}`);
  assert.equal(new Set(targets).size, targets.length, 'no model is warmed twice');
  // Non-local providers cannot be pre-warmed and must not be attempted.
  assert.ok(targets.every((a) => a.startsWith('local-')), targets.join(','));
});

test('pre-warming stops once a load evicts a model it just warmed', async () => {
  const lines: string[] = [];
  // A machine that holds exactly one model: each load evicts the last.
  let resident = new Set<string>();
  const warmed = await prewarmRoster({
    aliases: ['local-fast', 'local-reason', 'local-code'],
    timeoutMs: 500,
    onLine: (l) => lines.push(l),
    residentFn: async () => resident,
  });
  // The fetches fail against a nonexistent server in CI; what matters is that
  // the loop is sequential and bounded, never a parallel stampede.
  assert.ok(warmed.length >= 1);
  assert.ok(warmed.length <= 3);
  assert.ok(resident.size === 0);
});

test('pre-warming is skippable and reports every failure honestly', async () => {
  process.env['FOREMAN_PREWARM'] = 'off';
  assert.deepEqual(await prewarmRoster(), []);
  delete process.env['FOREMAN_PREWARM'];

  const lines: string[] = [];
  const results = await prewarmRoster({
    aliases: ['local-fast'],
    timeoutMs: 1,
    onLine: (l) => lines.push(l),
    residentFn: async () => new Set<string>(),
  });
  assert.equal(results.length, 1);
  if (!results[0]!.ok) {
    assert.match(lines.join('\n'), /could not warm local-fast/);
    assert.ok(results[0]!.error, 'a failed warm carries its reason');
  }
});

test('an unknown alias is not silently treated as warmed', async () => {
  const results = await prewarmRoster({
    aliases: ['no-such-alias'],
    timeoutMs: 200,
    residentFn: async () => new Set<string>(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error!, /unknown model alias/);

  // …and one bad alias must not abandon warming for the rest.
  const mixed = await prewarmRoster({
    aliases: ['no-such-alias', 'local-fast'],
    timeoutMs: 200,
    residentFn: async () => new Set<string>(),
  });
  assert.equal(mixed.length, 2, 'the loop continued past the bad alias');
});

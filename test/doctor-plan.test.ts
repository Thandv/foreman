import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { doctorMemoryNote, pingError, pingRoster, swapNote } from '../src/doctorPlan.ts';
import { memoryWarning } from '../src/memory.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('doctor pings claude-cli and cloud models even when every local ping times out', async () => {
  const all = [
    { alias: 'local-a', local: true },
    { alias: 'local-b', local: true },
    { alias: 'sonnet', local: false },
    { alias: 'cloud', local: false },
  ];
  let budget = 60; // stands in for the doctor deadline; each local ping burns all of it
  const result = await pingRoster(
    all,
    async (s) => { await sleep(40); budget -= 40; return { alias: s.alias, ok: false, error: 'timed out' }; },
    async (s) => (budget < 30
      ? { alias: s.alias, ok: false, error: 'not pinged' }
      : { alias: s.alias, ok: true, error: null }),
  );
  assert.deepEqual(result.map((r) => r.alias), ['local-a', 'local-b', 'sonnet', 'cloud']);
  assert.ok(result.slice(0, 2).every((r) => r.error === 'timed out'));
  assert.ok(result.slice(2).every((r) => r.ok), 'remote models were checked before the local budget ran out');
});

const tight = { reclaimableGb: 1, swapUsedGb: 2, swapTotalGb: 4 };

const roomOnceEvicted = { reclaimableGb: 5, swapUsedGb: 2, swapTotalGb: 4 };

test('with another model resident, doctor names the swap and the resident model, not a memory shortage', () => {
  const note = doctorMemoryNote(roomOnceEvicted, { name: 'qwen2.5-coder:14b', sizeGb: 9 }, [{ name: 'llama3.1:8b', sizeGb: 4.9 }]);
  assert.match(note ?? '', /llama3\.1:8b/);
  assert.match(note ?? '', /swapped in/);
  assert.doesNotMatch(note ?? '', /short of memory/);
});

test('without a different resident model, doctor keeps the plain memory warning', () => {
  assert.match(doctorMemoryNote(tight, { name: 'qwen2.5-coder:14b', sizeGb: 9 }, []) ?? '', /short of memory/);
  assert.match(
    doctorMemoryNote(tight, { name: 'qwen2.5-coder:14b', sizeGb: 9 }, [{ name: 'qwen2.5-coder:14b', sizeGb: 9 }]) ?? '',
    /short of memory/,
  );
  assert.equal(doctorMemoryNote({ ...tight, reclaimableGb: 30 }, { name: 'x:1', sizeGb: 9 }, [{ name: 'y:1', sizeGb: 4 }]), null);
});

test('no room even with the resident model evicted is a memory shortage, not a swap', () => {
  assert.match(doctorMemoryNote(tight, { name: 'qwen2.5-coder:14b', sizeGb: 9 }, [{ name: 'qwen3.5:2b', sizeGb: 2.7 }]) ?? '', /short of memory/);
});

test('a local ping that stalled says swap, not shortage, exactly where the doctor sees a swap', () => {
  const stalled = `http://127.0.0.1:11434/api/chat sent nothing for 45000ms — ${memoryWarning(roomOnceEvicted, 6.6)}`;
  const swap = swapNote(roomOnceEvicted, { name: 'qwen3.5:9b', sizeGb: 6.6 }, [{ name: 'llama3.1:8b', sizeGb: 4.9 }]);
  assert.match(pingError(stalled, swap), /sent nothing for 45000ms — Ollama has llama3\.1:8b .*swapped in/);
  assert.doesNotMatch(pingError(stalled, swap), /short of memory/);
  assert.equal(pingError(stalled, null), stalled);
});

test('/api/doctor reads /api/ps before its pings load models', () => {
  const src = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("seg[1] === 'doctor'"));
  assert.ok(route.indexOf('residentModels()') >= 0 && route.indexOf('residentModels()') < route.indexOf('pingRoster('));
});

import { testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agentsDir } from '../src/agents.ts';
import { envAssignee } from '../src/assign.ts';
import { effectiveConfig } from '../src/config.ts';
import { minFreeMb } from '../src/diskSpace.ts';
import { gitTimeoutMs } from '../src/gitTimeout.ts';
import { playbooksDir } from '../src/playbooks.ts';
import { postMergeCheckEnabled } from '../src/postMerge.ts';
import { limitBackoffMs } from '../src/providerLimit.ts';
import { slotWaitCreditMs } from '../src/runClock.ts';
import { leftoverSampleMs } from '../src/runners/proctree.ts';

/** Run fn with one variable set (or unset when undefined), then put it back as it was. */
function withVar<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// Each knob's default and env override, read through the module that uses it, with the parsing quirks of each read
// (an empty value is not always the default) pinned as they are.
const CASES: Array<[string, () => unknown, Array<[string | undefined, unknown]>]> = [
  ['FOREMAN_AGENTS_DIR', agentsDir, [[undefined, path.join(testHome, 'agents')], ['/x/agents', '/x/agents'], ['', '']]],
  ['FOREMAN_PLAYBOOKS_DIR', playbooksDir, [[undefined, path.join(testHome, 'playbooks')], ['/x/pb', '/x/pb'], ['', '']]],
  ['FOREMAN_ASSIGNEE', envAssignee, [[undefined, null], [' Human ', 'human'], ['ai', 'ai'], ['robot', null]]],
  ['FOREMAN_MIN_FREE_MB', () => minFreeMb(), [[undefined, 2048], ['', 2048], ['lots', 2048], ['-5', 2048], ['512', 512], ['0.5', 0.5]]],
  ['FOREMAN_GIT_TIMEOUT_MS', gitTimeoutMs, [[undefined, 120_000], ['', 120_000], ['0', 120_000], ['300.7', 300]]],
  ['FOREMAN_POSTMERGE_CHECK', postMergeCheckEnabled, [[undefined, true], [' OFF ', false], ['on', true], ['nope', true]]],
  ['FOREMAN_LIMIT_BACKOFF_MS', limitBackoffMs, [[undefined, 900_000], ['', 900_000], ['0', 900_000], ['x', 900_000], ['1500.5', 1500.5]]],
  ['FOREMAN_SLOT_WAIT_CREDIT_MS', slotWaitCreditMs, [[undefined, 1_800_000], ['', 0], ['0', 0], ['-1', 1_800_000], ['2500', 2500]]],
  ['FOREMAN_LEFTOVER_SAMPLE_MS', leftoverSampleMs, [[undefined, 3000], ['', 0], ['-1', 3000], ['x', 3000], ['250', 250]]],
];

test('each moved knob keeps its default and env override, read on each call', () => {
  for (const [name, read, cases] of CASES) {
    for (const [raw, want] of cases) {
      assert.deepEqual(withVar(name, raw, read), want, `${name}=${JSON.stringify(raw)}`);
    }
  }
});

test('config --effective lists the moved knobs with their value and source', () => {
  const knob = (name: string) => effectiveConfig().knobs.find((k) => k.name === name);
  for (const [name, read] of CASES) {
    assert.deepEqual(withVar(name, undefined, () => knob(name)), { name, value: String(withVar(name, undefined, read)), source: 'default' });
  }
  assert.deepEqual(withVar('FOREMAN_ECHO_STEP_MS', undefined, () => knob('FOREMAN_ECHO_STEP_MS')),
    { name: 'FOREMAN_ECHO_STEP_MS', value: '900', source: 'default' });
  assert.deepEqual(withVar('FOREMAN_ECHO_STEP_MS', '40', () => knob('FOREMAN_ECHO_STEP_MS')),
    { name: 'FOREMAN_ECHO_STEP_MS', value: '40', source: 'env' });
  assert.deepEqual(withVar('FOREMAN_MIN_FREE_MB', '512', () => knob('FOREMAN_MIN_FREE_MB')),
    { name: 'FOREMAN_MIN_FREE_MB', value: '512', source: 'env' });
  const others = withVar('FOREMAN_ASSIGNEE', 'human', () => effectiveConfig().others);
  assert.ok(!others.includes('FOREMAN_ASSIGNEE'), 'a knob config.ts resolves is not among the names read in place');
});

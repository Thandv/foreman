import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { snapshotProcs } from '../src/runners/proctree.ts';
import { NEEDS_PS, procGuard } from './helpers/procguard.ts';

const SKIP = process.platform !== 'darwin' ? 'the lstart identity is macOS only; Linux reads /proc/<pid>/stat, which has no zone' : NEEDS_PS.skip;

const PS_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };

function rawLstart(pid: number, tz: string): string {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...PS_ENV, TZ: tz } }).stdout.trim();
}

async function identity(pid: number, tz: string): Promise<string | undefined> {
  const rows = await snapshotProcs(5_000, { env: { TZ: tz } });
  return rows?.find((r) => r.pid === pid)?.start;
}

test('the reaper\'s process identity does not follow the system zone', { skip: SKIP }, async (t) => {
  const guard = procGuard(t);
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  guard.track(child.pid);
  const pid = child.pid!;

  const utc = rawLstart(pid, 'UTC');
  const tokyo = rawLstart(pid, 'Asia/Tokyo');
  assert.ok(utc && tokyo, 'ps printed an lstart for the child');
  assert.notEqual(utc, tokyo, 'pre-check: raw lstart really differs between zones, or this test proves nothing');

  const a = await identity(pid, 'Asia/Tokyo');
  const b = await identity(pid, 'America/Los_Angeles');
  assert.ok(a, 'the child is in the snapshot');
  assert.equal(a, b);
  // And it is the UTC form, not merely the same twice: without the pin, two reads that both ignored the zone given
  // would agree in the host zone. Whitespace as parseProcRows joins it (ps pads a one-digit day).
  assert.equal(a, utc.split(/\s+/).join(' '));
});

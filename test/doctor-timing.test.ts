import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCTOR_DEADLINE_MS, DOCTOR_PING_TIMEOUT_MS, doctorTimingLine } from '../src/doctorTiming.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('doctor\'s printed timing line states the deadlines the daemon enforces', () => {
  const line = doctorTimingLine();
  assert.ok(line.includes(`up to ${DOCTOR_PING_TIMEOUT_MS / 1000}s`), line);
  assert.ok(line.includes(`${DOCTOR_DEADLINE_MS / 60_000} minutes in all`), line);
});

test('the README Quick start states the same doctor deadlines', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(readme.includes(`waits up to ${DOCTOR_PING_TIMEOUT_MS / 1000} seconds`), 'per-model wait');
  assert.ok(readme.includes(`stop after ${DOCTOR_DEADLINE_MS / 60_000} minutes`), 'overall deadline');
});

test('/api/doctor takes its deadlines from doctorTiming, not literals', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
  assert.match(src, /Date\.now\(\) \+ DOCTOR_DEADLINE_MS/);
  assert.match(src, /Math\.min\(DOCTOR_PING_TIMEOUT_MS,/);
});

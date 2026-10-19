import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoBrief } from '../src/assistant/repoBrief.ts';

function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-brief-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  return dir;
}

test('repoBrief: lists tracked files, includes the README and docs the ask names, not the rest', () => {
  const dir = repoWith({
    'README.md': 'readme body',
    'SPEC.md': 'the binding spec: SSE not websockets',
    'NOTES.md': 'unmentioned notes',
    'src/a.ts': 'export {}',
  });
  try {
    const brief = repoBrief(dir, 'Build it exactly as SPEC.md says');
    assert.match(brief, /FILES \(4 tracked\)/);
    assert.match(brief, /src\/a\.ts/);
    assert.match(brief, /--- README\.md ---\nreadme body/);
    assert.match(brief, /--- SPEC\.md ---\nthe binding spec/);
    assert.doesNotMatch(brief, /unmentioned notes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repoBrief: a named doc that is a symlink out of the repo is never read', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-brief-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-THE-REPO');
  const dir = repoWith({ 'README.md': 'r' });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'SPEC.md'));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  try {
    const brief = repoBrief(dir, 'read SPEC.md');
    assert.match(brief, /SPEC\.md/); // listed: it is tracked
    assert.doesNotMatch(brief, /OUTSIDE-THE-REPO/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repoBrief: secrets in a doc are redacted, oversized docs truncated, and no repo means no brief', () => {
  const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
  const dir = repoWith({ 'README.md': `key ${key}\n${'x'.repeat(30_000)}` });
  try {
    const brief = repoBrief(dir, 'anything');
    assert.ok(!brief.includes(key));
    assert.match(brief, /truncated/);
    assert.ok(brief.length < 20_000);
    assert.equal(repoBrief(null, 'x'), '');
    assert.equal(repoBrief(path.join(dir, 'nope'), 'x'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

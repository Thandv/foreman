import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoBrief, trackedListing } from '../src/assistant/repoBrief.ts';

function repoWith(files: Record<string, string>): string {
  const dir = scratchDir('foreman-brief-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  return dir;
}

test('repoBrief: lists tracked files, includes the README and docs the ask names, not the rest', async () => {
  const dir = repoWith({
    'README.md': 'readme body',
    'SPEC.md': 'the binding spec: SSE not websockets',
    'NOTES.md': 'unmentioned notes',
    'src/a.ts': 'export {}',
  });
  try {
    const brief = await repoBrief(dir, 'Build it exactly as SPEC.md says');
    assert.match(brief, /FILES \(4 tracked\)/);
    assert.match(brief, /src\/a\.ts/);
    assert.match(brief, /--- README\.md ---\nreadme body/);
    assert.match(brief, /--- SPEC\.md ---\nthe binding spec/);
    assert.doesNotMatch(brief, /unmentioned notes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repoBrief: a named doc that is a symlink out of the repo is never read', async () => {
  const outside = scratchDir('foreman-brief-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-THE-REPO');
  const dir = repoWith({ 'README.md': 'r' });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'SPEC.md'));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  try {
    const brief = await repoBrief(dir, 'read SPEC.md');
    assert.match(brief, /SPEC\.md/); // listed: it is tracked
    assert.doesNotMatch(brief, /OUTSIDE-THE-REPO/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('repoBrief: secrets in a doc are redacted, oversized docs truncated, and no repo means no brief', async () => {
  const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
  const dir = repoWith({ 'README.md': `key ${key}\n${'x'.repeat(30_000)}` });
  try {
    const brief = await repoBrief(dir, 'anything');
    assert.ok(!brief.includes(key));
    assert.match(brief, /truncated/);
    assert.ok(brief.length < 20_000);
    assert.equal(await repoBrief(null, 'x'), '');
    assert.equal(await repoBrief(path.join(dir, 'nope'), 'x'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repoBrief and trackedListing: exact text on a fixture repo', async () => {
  const dir = repoWith({ 'README.md': 'hello', 'src/b.ts': 'export {}', 'a.txt': 'a' });
  try {
    assert.equal(
      await repoBrief(dir, 'nothing named'),
      'REPO SNAPSHOT (taken before planning; plan against what is already here — do not ticket work that already exists):\n' +
        'FILES (3 tracked):\n  README.md\n  a.txt\n  src/b.ts\n\n--- README.md ---\nhello\n',
    );
    assert.equal(await trackedListing(dir), 'FILES ALREADY TRACKED IN THIS TREE (3):\n  README.md\n  a.txt\n  src/b.ts');
    assert.equal(await trackedListing(path.join(dir, 'nope')), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

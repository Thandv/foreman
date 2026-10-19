import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { demandedLiterals, literalNote, ungroundedLiterals } from '../src/verify/literals.ts';

test('demandedLiterals pulls every scanned string from a critique, in each quote style, once', () => {
  const critique = [
    "Change it to `includes(\"closest('[data-card]')\")`.",
    "Also `search.includes(\"class: 'learn-lang'\")` and body.indexOf('S.notRun = null').",
    'And `x.includes(`button[${attr}]`)` plus a repeat: includes("closest(\'[data-card]\')").',
    "Too short to mean anything: includes('ab').",
  ].join('\n');
  assert.deepEqual(demandedLiterals(critique), [
    "closest('[data-card]')",
    "class: 'learn-lang'",
    'S.notRun = null',
    'button[${attr}]',
  ]);
  assert.deepEqual(demandedLiterals("Assert `body.includes('it\\'s here')`."), ["it's here"], 'escapes are undone');
  assert.deepEqual(demandedLiterals('no scans here, only prose about includes and indexOf'), []);
});

function repo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-literals-'));
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const write = (m: Record<string, string>): void => {
    for (const [rel, body] of Object.entries(m)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  };
  write(files);
  git('add', '-A');
  git('commit', '-qm', 'base');
  write(untracked);
  return dir;
}

test('a demanded string that only a test file contains is still ungrounded; the real form and new files ground', () => {
  const dir = repo(
    {
      'ui/app.js': "const pick = (attr) => e.target.closest(`button[${attr}]`)?.getAttribute(attr);\n",
      'test/app.test.ts': "assert.ok(body.includes(\"closest('[data-card]')\"));\n",
    },
    { 'ui/new.js': 'S.notRun = null;\n' },
  );
  try {
    const critique =
      "Use `includes(\"closest('[data-card]')\")`, keep `includes('closest(`button[${attr}]`)')`... " +
      "and `includes('S.notRun = null')`.";
    assert.deepEqual(ungroundedLiterals(critique, dir), ["closest('[data-card]')"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no claim about a tree that cannot be listed, and none when nothing is demanded', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-literals-nogit-'));
  try {
    assert.deepEqual(ungroundedLiterals("includes('anything at all')", plain), []);
    assert.deepEqual(ungroundedLiterals('prose only', plain), []);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('the note names each missing string and tells the reviewer it may not fail on it again', () => {
  const note = literalNote(["closest('[data-card]')"]);
  assert.match(note, /^FOREMAN CHECK \(deterministic\)/);
  assert.match(note, /- closest\('\[data-card\]'\)/);
  assert.match(note, /Meet the INTENT/);
  assert.match(note, /may not fail the work again/);
});

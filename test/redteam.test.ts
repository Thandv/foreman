import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { safePath } from '../src/runners/api.ts';
import { planAsk } from '../src/assistant/plan.ts';
import { resolveSpec } from '../src/models.ts';

// ---------------------------------------------------------------- jail escape

/**
 * The file-tool jail (read_file/write_file/list_dir) must resolve symlinks: a
 * malicious model can `ln -s /etc jail/evil` via run_shell, then a lexical
 * containment check would happily hand back `jail/evil/passwd`. safePath must
 * refuse it on the *real* path, for reads and for not-yet-created writes alike.
 */
test('safePath refuses a read through a symlink that points out of the jail', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-'));
  const jail = path.join(base, 'jail');
  fs.mkdirSync(jail);
  const secret = path.join(base, 'secret');
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'id_rsa'), 'PRIVATE KEY');
  fs.symlinkSync(secret, path.join(jail, 'evil')); // planted inside the jail

  assert.throws(() => safePath(jail, 'evil/id_rsa'), /escapes the jail/,
    'reading through an out-of-jail symlink must be refused');
  fs.rmSync(base, { recursive: true, force: true });
});

test('safePath refuses a write to a new file underneath an escaping symlink', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-'));
  const jail = path.join(base, 'jail');
  fs.mkdirSync(jail);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(jail, 'link'));

  // The target does not exist yet — exactly the write_file case.
  assert.throws(() => safePath(jail, 'link/pwned.txt'), /escapes the jail/);
  assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false, 'nothing was written outside');
  fs.rmSync(base, { recursive: true, force: true });
});

test('safePath refuses a write through a dangling symlink whose target is outside the jail', () => {
  // existsSync follows the link, so a link to a file that does not exist yet
  // looked like a new file in the jail, and writeFileSync created its target.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-'));
  const jail = path.join(base, 'jail');
  fs.mkdirSync(jail);
  const target = path.join(base, 'outside-profile');
  fs.symlinkSync(target, path.join(jail, 'notes.md'));
  fs.mkdirSync(path.join(jail, 'dir'));
  fs.symlinkSync(path.join(base, 'nowhere', 'deeper'), path.join(jail, 'dir', 'link'));

  assert.throws(() => safePath(jail, 'notes.md'), /escapes the jail/);
  assert.throws(() => safePath(jail, 'dir/link/new.txt'), /escapes the jail/);
  assert.equal(fs.existsSync(target), false, 'nothing was created outside');
  fs.rmSync(base, { recursive: true, force: true });
});

test('safePath refuses absolute paths and .. traversal', () => {
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-'));
  assert.throws(() => safePath(jail, '/etc/passwd'), /escapes the jail/);
  assert.throws(() => safePath(jail, '../../etc/passwd'), /escapes the jail/);
  assert.throws(() => safePath(jail, 'a/b/../../../etc/passwd'), /escapes the jail/);
  fs.rmSync(jail, { recursive: true, force: true });
});

test('safePath still allows ordinary paths, new files, and in-jail symlinks', () => {
  const jail = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-jail-')));
  fs.mkdirSync(path.join(jail, 'src'), { recursive: true });
  fs.writeFileSync(path.join(jail, 'src', 'f.txt'), 'hi');
  fs.symlinkSync(path.join(jail, 'src'), path.join(jail, 'inlink')); // stays inside

  assert.equal(safePath(jail, 'src/f.txt'), path.join(jail, 'src', 'f.txt'));
  assert.equal(safePath(jail, 'src/new/deep.ts'), path.join(jail, 'src', 'new', 'deep.ts'),
    'a brand-new nested path resolves inside the jail');
  assert.equal(safePath(jail, 'inlink/f.txt'), path.join(jail, 'src', 'f.txt'),
    'a symlink pointing inside the jail is followed to its real in-jail target');
  assert.equal(safePath(jail, '.'), jail);
  fs.rmSync(jail, { recursive: true, force: true });
});

// ------------------------------------------------------ planner: malformed model output

function plannerReturning(text: string): { store: Store; broker: Broker } {
  const store = new Store(':memory:');
  const broker = new Broker(store, {
    chatFn: async (o) => ({ text, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) }),
  });
  return { store, broker };
}

test('a planner reply whose nodes is a scalar/string falls back, does not throw', async () => {
  for (const bad of ['{"nodes":"abc"}', '{"nodes":123}', '{"nodes":true}', 'null', '[]']) {
    const { store, broker } = plannerReturning(bad);
    const plan = await planAsk({ ask: 'do a thing', store, broker });
    assert.equal(plan.degraded, true, `"${bad}" must degrade to a single-node fallback`);
    assert.equal(plan.nodes.length, 1);
    store.close();
  }
});

test('a planner reply with null / scalar entries in nodes skips them instead of crashing', async () => {
  const { store, broker } = plannerReturning(JSON.stringify({
    notes: 'mixed junk',
    nodes: [null, 42, 'nope', { ref: 'n1', title: 'Real step', prompt: 'do the real work', kind: 'general' }],
  }));
  const plan = await planAsk({ ask: 'mix', store, broker });
  assert.equal(plan.degraded, false);
  assert.equal(plan.nodes.length, 1, 'only the one well-formed node survives');
  assert.equal(plan.nodes[0]!.title, 'Real step');
  store.close();
});

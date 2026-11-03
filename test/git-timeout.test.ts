import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pinnedGit } from '../src/isolate.ts';
import { gitSubcommand, gitTimeoutMs } from '../src/gitTimeout.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('a wedged git is killed at FOREMAN_GIT_TIMEOUT_MS: pinnedGit rejects naming the subcommand and no child is left', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-timeout-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const pidFile = path.join(dir, 'pid');
    // exec: the sleeping process IS the child execFile started, so its pid is the one to look for.
    const fake = path.join(bin, 'git');
    fs.writeFileSync(fake, `#!/bin/sh\n[ -n "$FAKE_GIT_WARM" ] && exit 0\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
    // The first run of a new executable can be slow (the OS scans it), longer than the 300 ms bound below.
    execFileSync(fake, [], { env: { ...process.env, FAKE_GIT_WARM: '1' } });
    const t0 = Date.now();
    const err = await withEnv({ PATH: `${bin}:${process.env['PATH']}`, FOREMAN_GIT_TIMEOUT_MS: '300' }, () =>
      pinnedGit(dir, ['status', '--secret-path-argument']).then(() => null, (e: Error) => e));
    assert.ok(err, 'the call rejected');
    assert.ok(Date.now() - t0 < 1500, `rejected in ${Date.now() - t0}ms`);
    // The first git pinnedGit starts is the driver lookup (`config`), so that is the subcommand named.
    assert.match(err.message, /^git (config|status) timed out after 300ms$/);
    assert.ok(!err.message.includes(dir) && !err.message.includes('secret'));
    assert.ok(fs.existsSync(pidFile), 'the fake git ran');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 1);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, 'the git child is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal git call still works under the time limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-timeout-ok-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const { stdout } = await withEnv({ FOREMAN_GIT_TIMEOUT_MS: '20000' }, () => pinnedGit(dir, ['rev-parse', '--is-inside-work-tree']));
    assert.equal(stdout.trim(), 'true');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FOREMAN_GIT_TIMEOUT_MS falls back to 120000 on empty, non-numeric or non-positive values', async () => {
  for (const v of ['', '  ', 'abc', '0', '-5', 'NaN']) {
    await withEnv({ FOREMAN_GIT_TIMEOUT_MS: v }, async () => assert.equal(gitTimeoutMs(), 120_000, JSON.stringify(v)));
  }
  await withEnv({ FOREMAN_GIT_TIMEOUT_MS: '300' }, async () => assert.equal(gitTimeoutMs(), 300));
  assert.equal(gitSubcommand(['-c', 'core.x=1', '-C', '/p/a/th', '--no-optional-locks', 'ls-files', '-z']), 'ls-files');
});

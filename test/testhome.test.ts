import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTests } from '../src/verify/tests.ts';

/** Point process.env.HOME at a fake "real home" for the duration, so nothing touches the operator's. */
function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-realhome-'));
  fs.writeFileSync(path.join(fake, '.gitconfig'), '[user]\n\tname = Op\n\temail = op@example.com\n');
  const saved = process.env['HOME'];
  process.env['HOME'] = fake;
  return fn(fake).finally(() => {
    if (saved === undefined) delete process.env['HOME'];
    else process.env['HOME'] = saved;
    fs.rmSync(fake, { recursive: true, force: true });
  });
}

test('a test stage writing to ~ lands in a throwaway home, never the operator\'s, and keeps the git identity', async () => {
  await withFakeHome(async (real) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-th-work-'));
    const cmd = `mkdir -p "$HOME/Kiln Projects/guard-made" && echo "home=$HOME" && node -e "console.log('homedir='+require('os').homedir())" && git config --global user.name && echo "xdg=$XDG_CONFIG_HOME"`;
    const r = await runTests(work, cmd, new AbortController().signal);
    assert.equal(r.passed, true, r.output);
    assert.equal(fs.existsSync(path.join(real, 'Kiln Projects')), false, 'nothing was written to the real home');
    const home = /home=(.+)/.exec(r.output)![1]!.trim();
    assert.notEqual(home, real);
    assert.match(r.output, new RegExp(`homedir=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'os.homedir() follows it');
    assert.match(r.output, /\nOp\n/, 'the global git identity carried over');
    assert.match(r.output, new RegExp(`xdg=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.config`));
    assert.equal(fs.existsSync(home), false, 'the throwaway home is removed afterwards');
    fs.rmSync(work, { recursive: true, force: true });
  });
});

test('FOREMAN_TEST_REAL_HOME=1 keeps the real home for a suite that needs it', async () => {
  await withFakeHome(async (real) => {
    process.env['FOREMAN_TEST_REAL_HOME'] = '1';
    try {
      const r = await runTests(os.tmpdir(), 'echo "home=$HOME"', new AbortController().signal);
      assert.match(r.output, new RegExp(`home=${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      delete process.env['FOREMAN_TEST_REAL_HOME'];
    }
  });
});

test('the suites ignore the caller\'s FOREMAN_* settings: a daemon-tuned environment still reads the defaults', () => {
  // A Foreman test stage runs the suite with the daemon's environment; before test/env.ts cleared it, the daemon's
  // FOREMAN_FAILED_JAIL_RETAIN_DAYS=3650 failed every test that pins the default of 14.
  const probe = "import './test/env.ts'; const { config } = await import('./src/config.ts'); " +
    "console.log(JSON.stringify({ days: config.failedJailRetainDays, skills: config.skillsDir ?? null, " +
    "home: process.env.FOREMAN_HOME, leaked: Object.keys(process.env).filter((k) => k === 'FOREMAN_DAEMON_ONLY') }));";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, FOREMAN_FAILED_JAIL_RETAIN_DAYS: '3650', FOREMAN_SKILLS_DIR: '/nonexistent-skills', FOREMAN_DAEMON_ONLY: 'x' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout) as { days: number; skills: string | null; home: string; leaked: string[] };
  assert.equal(seen.days, 14, 'the default retention, not the daemon\'s');
  assert.notEqual(seen.skills, '/nonexistent-skills', 'the caller\'s skills repository is not used');
  assert.deepEqual(seen.leaked, [], 'no other inherited FOREMAN_ variable survives');
  assert.ok(seen.home.includes('foreman-test-'), 'the suite\'s own home is set after the clear');
});

/**
 * Whether a process is still running. A killed grandchild is re-parented to
 * PID 1, and under a PID 1 that does not reap (a container's init shim) it
 * stays a zombie: signal 0 still finds it, though it is dead and holds nothing.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // /proc/<pid>/stat: "pid (comm) S ..."; the state follows the last ')'.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true; // no /proc (macOS): signal 0 is the only answer
  }
}

test('a test command that never exits is killed at FOREMAN_TEST_TIMEOUT_MIN and fails saying so', async () => {
  const saved = process.env['FOREMAN_TEST_TIMEOUT_MIN'];
  process.env['FOREMAN_TEST_TIMEOUT_MIN'] = '0.01'; // 600 ms
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-to-work-'));
  const pidFile = path.join(work, 'grandchild.pid');
  try {
    const started = Date.now();
    // A grandchild in the same group: the timeout must take the whole group down, not just the shell.
    const r = await runTests(work, `sleep 60 & echo $! > "${pidFile}"; echo started; wait`, new AbortController().signal);
    assert.ok(Date.now() - started < 10_000, 'it did not wait for the command');
    assert.equal(r.passed, false);
    assert.match(r.output, /started/);
    assert.match(r.output, /timed out after .* min and was killed/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(running(pid), false, 'the grandchild is gone too');
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_TEST_TIMEOUT_MIN'];
    else process.env['FOREMAN_TEST_TIMEOUT_MIN'] = saved;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an aborted run is not reported as a timeout', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-to-work-'));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runTests(work, 'sleep 30', ac.signal);
  assert.equal(r.passed, false);
  assert.doesNotMatch(r.output, /timed out/);
  fs.rmSync(work, { recursive: true, force: true });
});

/** Point TMPDIR (what os.tmpdir() and the isolated home follow) at a fresh dir, so leaks can be counted. */
async function withFakeTmp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-faketmp-'));
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (saved === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a test command\'s temp files land in the isolated home and leave nothing in the real temp dir', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-th-work-'));
  try {
    await withFakeTmp(async (tmp) => {
      // macOS /usr/bin/mktemp ignores TMPDIR without a template (it asks confstr), so the
      // shell case uses the portable "$TMPDIR/..." form; node's os.tmpdir() follows TMPDIR.
      const cmd =
        'd=$(mktemp -d "${TMPDIR:-/tmp}/leak.XXXXXX") && touch "$d/f" && ' +
        `n=$(node -e "console.log(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'leak-')))") && ` +
        'echo "tmp=$d $n $TMP $TEMP"';
      const r = await runTests(work, cmd, new AbortController().signal);
      assert.equal(r.passed, true, r.output);
      assert.deepEqual(fs.readdirSync(tmp), [], 'nothing left behind in the real temp dir');
      const [d, n, tmpVar, tempVar] = /tmp=(.+)/.exec(r.output)![1]!.trim().split(' ');
      assert.equal(tmpVar, tempVar);
      assert.equal(path.dirname(d!), tmpVar, 'mktemp used the per-run dir TMP/TEMP name');
      assert.equal(path.dirname(n!), tmpVar, 'so did os.tmpdir()');
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a spawn error still removes the isolated home', async () => {
  await withFakeTmp(async (tmp) => {
    const missing = path.join(tmp, 'no-such-dir');
    await assert.rejects(runTests(missing, 'true', new AbortController().signal));
    assert.deepEqual(fs.readdirSync(tmp), [], 'the throwaway home was cleaned up');
  });
});

test('the per-run TMPDIR stays short: a unix socket a few levels under it can still listen', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-th-work-'));
  try {
    // Kiln's test/security-race.test.ts shape: <TMPDIR>/kiln-race-XXXXXX/proj/sub/s.sock. macOS caps the path at 104 bytes.
    const script =
      "const p=require('path'),fs=require('fs'),os=require('os'),net=require('net');" +
      "const d=fs.mkdtempSync(p.join(os.tmpdir(),'kiln-race-'));fs.mkdirSync(p.join(d,'proj','sub'),{recursive:true});" +
      "const s=net.createServer();s.on('error',e=>{console.log('listen-error '+e.code);process.exit(1)});" +
      "s.listen(p.join(d,'proj','sub','s.sock'),()=>{console.log('listening');s.close()})";
    const r = await runTests(work, `echo "tmpdir=$TMPDIR" && node -e "${script}"`, new AbortController().signal);
    const tmpdir = /tmpdir=(.+)/.exec(r.output)![1]!.trim();
    assert.ok(tmpdir.length <= os.tmpdir().length + 10, `TMPDIR adds ${tmpdir.length - os.tmpdir().length} chars: ${tmpdir}`);
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /listening/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a suite that leaves an unreadable dir in TMPDIR keeps its passing result, and nothing is left behind', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-th-work-'));
  try {
    await withFakeTmp(async (tmp) => {
      const cmd = 'mkdir -p "$TMPDIR/locked/inner" "$HOME/locked/inner" && touch "$TMPDIR/locked/inner/f" "$HOME/locked/inner/f" && chmod 000 "$TMPDIR/locked" "$HOME/locked" && echo done';
      const r = await runTests(work, cmd, new AbortController().signal);
      assert.equal(r.passed, true, r.output);
      assert.deepEqual(fs.readdirSync(tmp), [], 'the home and the TMPDIR were both removed');
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a test command does not see credential-shaped variables unless FOREMAN_TEST_KEEP_ENV names them', async () => {
  const names = ['FOREMAN_PLANTED_API_KEY', 'FOREMAN_PLANTED_TOKEN', 'FOREMAN_PLANTED_PLAIN'];
  for (const n of names) process.env[n] = `value-of-${n}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-env-work-'));
  try {
    const cmd = names.map((n) => `echo "${n}=\${${n}:-unset}"`).join(' && ');
    const r = await runTests(work, cmd, new AbortController().signal);
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /FOREMAN_PLANTED_API_KEY=unset/);
    assert.match(r.output, /FOREMAN_PLANTED_TOKEN=unset/);
    assert.match(r.output, /FOREMAN_PLANTED_PLAIN=value-of-FOREMAN_PLANTED_PLAIN/, 'ordinary variables still reach the suite');

    process.env['FOREMAN_TEST_KEEP_ENV'] = ' FOREMAN_PLANTED_TOKEN ,NOT_SET_ANYWHERE';
    const kept = await runTests(work, cmd, new AbortController().signal);
    assert.match(kept.output, /FOREMAN_PLANTED_TOKEN=value-of-FOREMAN_PLANTED_TOKEN/);
    assert.match(kept.output, /FOREMAN_PLANTED_API_KEY=unset/, 'only the named variable is passed through');
  } finally {
    for (const n of names) delete process.env[n];
    delete process.env['FOREMAN_TEST_KEEP_ENV'];
    fs.rmSync(work, { recursive: true, force: true });
  }
});

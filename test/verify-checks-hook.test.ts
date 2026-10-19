import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERIFY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify.sh');

const COUNTS = 'echo "# tests 3"\necho "# pass 2"\necho "# fail 1"\n';

/**
 * A scratch tree with a copy of verify.sh, a stub tsgo and a stub `npm` (shell body `npm`), so the real suite never
 * recurses. `checks` maps file names under scripts/checks to their JS source.
 */
function run(
  npm: string,
  checks: Record<string, string> = {},
  opts: { env?: Record<string, string>; noChecksDir?: boolean; timeoutMs?: number } = {},
): { status: number | null; out: string; ms: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verifychecks-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', opts.noChecksDir ? '' : 'checks'), { recursive: true });
    fs.copyFileSync(VERIFY, path.join(dir, 'scripts', 'verify.sh'));
    for (const [name, src] of Object.entries(checks)) fs.writeFileSync(path.join(dir, 'scripts', 'checks', name), src);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const local = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(local, { recursive: true });
    const stub = (at: string, name: string, body: string): void => {
      fs.writeFileSync(path.join(at, name), `#!/bin/bash\n${body}\n`);
      fs.chmodSync(path.join(at, name), 0o755);
    };
    stub(local, 'tsgo', 'exit 0');
    stub(bin, 'npm', npm);
    const { NODE_TEST_CONTEXT: _c, FORCE_COLOR: _f, NO_COLOR: _n, ...env } = process.env;
    const t0 = Date.now();
    const r = spawnSync('bash', [path.join(dir, 'scripts', 'verify.sh')], {
      encoding: 'utf8',
      env: { ...env, ...opts.env, PATH: `${bin}:${process.env['PATH']}` },
      timeout: opts.timeoutMs ?? 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (out: string): string[] => out.trimEnd().split('\n');

test('a failing suite prints its count lines before "verify: FAIL"', () => {
  const r = run(`${COUNTS}echo "not ok 1 - boom"\nexit 1`);
  assert.equal(r.status, 1);
  const l = lines(r.out);
  const pass = l.indexOf('# pass 2');
  const fail = l.indexOf('# fail 1');
  assert.ok(pass >= 0 && fail >= 0, r.out);
  assert.equal(l[l.length - 1], 'verify: FAIL (tests exited 1)');
  // The tail dump below also contains the stub's output; the counts must come BEFORE it.
  const tail = l.indexOf('--- last 80 lines ---');
  assert.ok(tail > 0 && pass < tail && fail < tail, r.out);
});

test('a check that exits 1 fails verify and the output names the file', () => {
  const r = run(`${COUNTS.replace('fail 1', 'fail 0')}exit 0`, { 'a-ok.ts': 'process.exit(0)', 'b-bad.ts': 'process.exit(1)' });
  assert.equal(r.status, 1);
  assert.ok(r.out.split('\n').includes('verify: FAIL (check scripts/checks/b-bad.ts exited 1)'), r.out);
  assert.doesNotMatch(r.out, /verify: PASS/);
  assert.doesNotMatch(r.out, /a-ok\.ts/);
});

test('with no check files the output is the success path\'s plus nothing else', () => {
  const r = run(`${COUNTS.replace('fail 1', 'fail 0')}exit 0`);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, 'typecheck…\ntests…\n# tests 3\n# pass 2\n# fail 0\nverify: PASS\n');
});

test('a failing suite with passing checks exits with the suite\'s exact status', () => {
  const r = run(`${COUNTS}exit 7`, { 'ok.ts': 'console.log("CHECK-RAN")' });
  assert.equal(r.status, 7);
  assert.match(r.out, /CHECK-RAN/);
  assert.equal(lines(r.out).pop(), 'verify: FAIL (tests exited 7)');
});

test('when the suite and a check both fail, the suite\'s status wins and FAIL (tests) is last', () => {
  const r = run(`${COUNTS}exit 7`, { 'bad.ts': 'process.exit(3)' });
  assert.equal(r.status, 7);
  assert.match(r.out, /verify: FAIL \(check scripts\/checks\/bad\.ts exited 3\)/);
  assert.equal(lines(r.out).pop(), 'verify: FAIL (tests exited 7)');
});

test('with a passing suite the first failing check\'s status is the exit status, in sorted order', () => {
  const r = run(`${COUNTS.replace('fail 1', 'fail 0')}exit 0`, { 'z.ts': 'process.exit(5)', 'b.ts': 'process.exit(4)', 'a.ts': 'console.log("A-RAN-FIRST")' });
  assert.equal(r.status, 4);
  assert.ok(r.out.indexOf('A-RAN-FIRST') < r.out.indexOf('check scripts/checks/b.ts'), r.out);
  assert.ok(r.out.indexOf('check scripts/checks/b.ts') < r.out.indexOf('check scripts/checks/z.ts'), r.out);
});

const PASSING = `${COUNTS.replace('fail 1', 'fail 0')}exit 0`;

test('a check file whose name has a space runs as one file, not two word-split paths', () => {
  const r = run(PASSING, { 'has space.ts': 'console.log("SPACE-RAN")', 'a b c.ts': 'process.exit(6)' });
  assert.equal(r.status, 6, r.out);
  assert.match(r.out, /SPACE-RAN/);
  assert.ok(r.out.split('\n').includes('verify: FAIL (check scripts/checks/a b c.ts exited 6)'), r.out);
  assert.doesNotMatch(r.out, /check scripts\/checks\/(a|has) exited/);
});

test('a check that outlives VERIFY_CHECK_TIMEOUT_SECS is stopped, named, and fails verify', () => {
  const r = run(PASSING, { 'hang.ts': 'setInterval(() => {}, 1000)', 'later.ts': 'console.log("LATER-RAN")' }, { env: { VERIFY_CHECK_TIMEOUT_SECS: '1' } });
  assert.notEqual(r.status, 0, r.out);
  assert.notEqual(r.status, null, `verify itself hung: ${r.out}`);
  assert.ok(r.out.split('\n').includes('verify: FAIL (check scripts/checks/hang.ts timed out after 1s)'), r.out);
  // The check after the hung one was still started. The timeout is one value for every check, so on a loaded
  // machine a cold `node later.ts` can itself outlive 1 s; either outcome proves verify moved on past the hang, and
  // neither depends on how fast this machine starts node.
  const laterRan = /LATER-RAN/.test(r.out)
    || r.out.split('\n').includes('verify: FAIL (check scripts/checks/later.ts timed out after 1s)');
  assert.ok(laterRan, `the check after the hung one never ran: ${r.out}`);
  assert.doesNotMatch(r.out, /verify: PASS/);
  assert.ok(r.ms < 20_000, `took ${r.ms}ms`);
});

test('a timed-out check\'s own children are stopped too, so they cannot hold verify\'s output open', () => {
  const hang = "import { spawn } from 'node:child_process'; spawn('sleep', ['40'], { stdio: 'inherit' }); setInterval(() => {}, 1000);";
  const r = run(PASSING, { 'spawner.ts': hang }, { env: { VERIFY_CHECK_TIMEOUT_SECS: '1' }, timeoutMs: 30_000 });
  assert.notEqual(r.status, null, `verify did not return: ${r.out}`);
  assert.ok(r.out.split('\n').includes('verify: FAIL (check scripts/checks/spawner.ts timed out after 1s)'), r.out);
  assert.ok(r.ms < 20_000, `took ${r.ms}ms`);
});

test('a timed-out check with a failing suite still leaves "verify: FAIL (tests exited N)" last, with the suite\'s status', () => {
  const r = run(`${COUNTS}exit 7`, { 'hang.ts': 'setInterval(() => {}, 1000)' }, { env: { VERIFY_CHECK_TIMEOUT_SECS: '1' } });
  assert.equal(r.status, 7, r.out);
  assert.match(r.out, /check scripts\/checks\/hang\.ts timed out after 1s/);
  assert.equal(lines(r.out).pop(), 'verify: FAIL (tests exited 7)');
});

test('a VERIFY_CHECK_TIMEOUT_SECS that is not a positive whole number fails verify before anything runs', () => {
  for (const bad of ['abc', '0', '-1', '1.5', '$(touch x)']) {
    const r = run(PASSING, { 'ok.ts': 'console.log("CHECK-RAN")' }, { env: { VERIFY_CHECK_TIMEOUT_SECS: bad } });
    assert.equal(r.status, 2, `${bad}: ${r.out}`);
    assert.match(r.out, /^verify: FAIL \(VERIFY_CHECK_TIMEOUT_SECS must be a positive whole number of seconds\)$/m);
    assert.doesNotMatch(r.out, /CHECK-RAN|typecheck/);
  }
});

test('a missing scripts/checks directory is the same as an empty one', () => {
  const r = run(PASSING, {}, { noChecksDir: true });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, 'typecheck…\ntests…\n# tests 3\n# pass 2\n# fail 0\nverify: PASS\n');
});

test('only *.ts files in scripts/checks run: the README and other files are not checks', () => {
  const r = run(PASSING, { 'README.md': 'process.exit(9)', 'x.js': 'process.exit(9)', 'ok.ts': 'console.log("TS-RAN")' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /TS-RAN/);
});

test('with no override the per-check limit is generous: a check taking a few seconds passes', () => {
  const r = run(PASSING, { 'slow.ts': 'setTimeout(() => console.log("SLOW-DONE"), 3000)' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /SLOW-DONE/);
  assert.match(r.out, /verify: PASS\n$/);
});

test('Ctrl-C while a check runs stops that check and verify itself; later checks do not run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-verifychecks-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'checks'), { recursive: true });
    fs.copyFileSync(VERIFY, path.join(dir, 'scripts', 'verify.sh'));
    const pidFile = path.join(dir, 'check.pid');
    fs.writeFileSync(path.join(dir, 'scripts', 'checks', 'a.ts'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('A-STARTED'); setInterval(() => {}, 1000);`);
    fs.writeFileSync(path.join(dir, 'scripts', 'checks', 'b.ts'), 'console.log("B-RAN")');
    for (const [at, name, body] of [['node_modules/.bin', 'tsgo', 'exit 0'], ['bin', 'npm', `${COUNTS.replace('fail 1', 'fail 0')}exit 0`]] as const) {
      fs.mkdirSync(path.join(dir, at), { recursive: true });
      fs.writeFileSync(path.join(dir, at, name), `#!/bin/bash\n${body}\n`);
      fs.chmodSync(path.join(dir, at, name), 0o755);
    }
    const { NODE_TEST_CONTEXT: _c, FORCE_COLOR: _f, NO_COLOR: _n, ...env } = process.env;
    // Its own process group, like a terminal's foreground job: Ctrl-C is SIGINT to that group.
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const child = spawn('bash', [path.join(dir, 'scripts', 'verify.sh')], { env: { ...env, TMPDIR: tmp, PATH: `${path.join(dir, 'bin')}:${process.env['PATH']}` }, detached: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += String(d); });
    child.stderr.on('data', (d: Buffer) => { out += String(d); });
    // 'exit', not 'close': a check left running would hold the pipes open and 'close' would never come.
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const t0 = Date.now();
    while (!out.includes('A-STARTED')) {
      assert.ok(Date.now() - t0 < 30_000, `the check never started: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const stoppedAt = Date.now();
    process.kill(-child.pid!, 'SIGINT');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    // On a regression, end everything this test started before failing, so the run itself is not held.
    const killer = setTimeout(() => {
      for (const p of [-child.pid!, -pid, pid]) try { process.kill(p, 'SIGKILL'); } catch {}
    }, 15_000);
    const r = await done;
    clearTimeout(killer);
    assert.ok(Date.now() - stoppedAt < 10_000, `verify did not stop on Ctrl-C: ${out}`);
    assert.notEqual(r.code, 0, out);
    assert.doesNotMatch(out, /B-RAN|verify: PASS/);
    assert.equal(r.signal, 'SIGINT', `verify should die of the Ctrl-C itself: ${JSON.stringify(r)}`);
    assert.deepEqual(fs.readdirSync(tmp), [], 'the suite\'s temp output file was left behind');
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'the check was left running after Ctrl-C');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

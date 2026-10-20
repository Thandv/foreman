// FOREMAN_SANDBOX: the OS sandbox around test commands, shell tickets and run_shell (src/security/sandbox.ts).
// Everything here is behavioural: real /usr/bin/sandbox-exec, real git, a fake HOME holding decoy "secrets" (never
// the real ~/.ssh), and listeners standing in for the control port and the other closed loopback ports. Each attack
// asserts the EFFECT is absent, and has the same command run with the switch off beside it where that proves the
// switch is what is being tested.
import { testHome } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Broker } from '../src/budget.ts';
import type { RunnerContext } from '../src/runners/index.ts';
import type { Task } from '../src/types.ts';

process.env['FOREMAN_OLLAMA_URL'] = 'http://127.0.0.1:9';

const TMP = fs.realpathSync(os.tmpdir());
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const made: string[] = [];
const listeners: net.Server[] = [];
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** A loopback listener that counts the connections it sees. */
async function listener(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = net.createServer((sock) => {
    hits++;
    sock.on('error', () => {});
    sock.end('hello\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  listeners.push(server);
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

// The stand-in for the daemon's control port must exist BEFORE src/config.ts is read: config.port is what the
// sandbox closes. Hence the dynamic imports below.
const control = await listener();
process.env['FOREMAN_PORT'] = String(control.port);

// The fake home. HOME points here for this whole file, so nothing below can reach the operator's real one by default
// and isolatedHome() copies THIS .gitconfig into each run's private home.
const HOME = fs.mkdtempSync(path.join(TMP, 'fsbx-home-'));
made.push(HOME);
process.env['HOME'] = HOME;
fs.writeFileSync(path.join(HOME, '.gitconfig'), '[user]\n\tname = Sandbox Test\n\temail = sandbox@test.invalid\n[init]\n\tdefaultBranch = main\n');
const DECOYS: Record<string, string> = {
  '.ssh/id_x': 'DECOY-SSH-KEY-7f3a',
  '.aws/credentials': 'DECOY-AWS-SECRET-91bc',
  '.claude.json': 'DECOY-CLAUDE-TOKEN-55de',
  '.config/gh/hosts.yml': 'DECOY-GH-TOKEN-0c2e',
  '.npmrc': 'DECOY-NPM-TOKEN-ab41',
};
for (const [rel, body] of Object.entries(DECOYS)) {
  fs.mkdirSync(path.dirname(path.join(HOME, rel)), { recursive: true });
  fs.writeFileSync(path.join(HOME, rel), `${body}\n`);
}
const DB_DECOY = 'DECOY-FOREMAN-DB-6612';
fs.writeFileSync(path.join(testHome, 'foreman.db'), `${DB_DECOY}\n`);

const { config } = await import('../src/config.ts');
const sbx = await import('../src/security/sandbox.ts');
const { runTests, sandboxedShell, isolatedHome } = await import('../src/verify/tests.ts');
const { spawnStreaming } = await import('../src/runners/proc.ts');
const { shellRunner } = await import('../src/runners/shell.ts');
const { apiRunner } = await import('../src/runners/api.ts');
const { checkMain } = await import('../src/postMerge.ts');
const { depsCacheRoot, lockHash, provisionDeps } = await import('../src/deps.ts');

test.after(() => {
  for (const s of listeners) s.close();
});

// --------------------------------------------------------------------------------------------------- helpers

/** Run `fn` with these variables set (undefined = unset), restored afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** The switch at its default (unset = tests). test/env.ts turns it off for every other suite. */
const ON = { FOREMAN_SANDBOX: undefined };
const OFF = { FOREMAN_SANDBOX: 'off' };

// Skip, with the reason, where the sandbox cannot be exercised: not macOS, no sandbox-exec, or this suite is itself
// running inside a sandbox (Foreman's own gate under FOREMAN_SANDBOX=tests), where nothing can be nested.
const availability = await withEnv(ON, () => sbx.sandboxAvailable());
const skip = availability === 'ok' ? false : `the sandbox cannot be exercised here: ${availability === 'nested' ? 'this suite is already running inside a sandbox' : availability}`;
const T = { skip, timeout: 170_000 };

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', killSignal: 'SIGKILL', timeout: 120_000 }).trim();
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const guard = (): AbortSignal => AbortSignal.timeout(150_000);
const outLines = (output: string): string[] => output.split('\n').filter((l) => l.startsWith('OUT '));

/** Content hash of a whole tree: names, kinds, modes and bytes. Anything a command changed shows. */
function snapshot(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (p: string, rel: string): void => {
    const st = fs.lstatSync(p);
    h.update(`${rel}\0${st.mode}\0`);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name), `${rel}/${name}`);
    else if (st.isFile()) h.update(fs.readFileSync(p));
    else if (st.isSymbolicLink()) h.update(fs.readlinkSync(p));
  };
  walk(dir, '');
  return h.digest('hex');
}

interface Fixture {
  /** The REAL repository, under the fake home: nothing in it may change. */
  repo: string;
  /** A worktree jail of it, inside Foreman's home like a real one. */
  jail: string;
  /** Another run's jail. */
  otherJail: string;
  /** A commit that exists in the repo and is not main. */
  otherSha: string;
  mainSha: string;
}

function fixture(t: TestContext, jailName?: string): Fixture {
  const id = crypto.randomBytes(4).toString('hex');
  const repo = path.join(HOME, 'Projects', `app-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const one = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const mainSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const one = 2;\n');
  git(repo, 'commit', '-qam', 'other');
  const otherSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const jail = path.join(fs.realpathSync(testHome), 'work', jailName ?? `r_${id}`);
  fs.mkdirSync(path.dirname(jail), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `foreman/t-${id}`, jail, 'main');
  const otherJail = path.join(fs.realpathSync(testHome), 'work', `r_other_${id}`);
  fs.mkdirSync(otherJail, { recursive: true });
  fs.writeFileSync(path.join(otherJail, 'notes.txt'), 'DECOY-OTHER-JAIL-3310\n');
  t.after(() => {
    for (const d of [jail, otherJail, repo]) fs.rmSync(d, { recursive: true, force: true });
  });
  return { repo, jail, otherJail, otherSha, mainSha };
}

/** A scratch directory under the temp dir (not a repo), removed after the test. */
function scratch(t: TestContext, name = 'fsbx-'): string {
  const dir = fs.mkdtempSync(path.join(TMP, name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// --------------------------------------------------------------------------------------------- the switch itself

test('the switch: unset is tests, off|tests|all are accepted, anything else is an error and never a silent off', async () => {
  await withEnv({ FOREMAN_SANDBOX: undefined }, async () => assert.equal(sbx.sandboxMode(), 'tests'));
  for (const v of ['off', 'tests', 'all', ' OFF ']) {
    await withEnv({ FOREMAN_SANDBOX: v }, async () => assert.equal(sbx.sandboxMode(), v.trim().toLowerCase()));
  }
  for (const v of ['0', 'no', 'false', 'none', 'test', 'disabled']) {
    await withEnv({ FOREMAN_SANDBOX: v }, async () => {
      assert.throws(() => sbx.sandboxMode(), /FOREMAN_SANDBOX must be off, tests or all/);
      assert.match((await sbx.selfTest()) ?? '', /FOREMAN_SANDBOX must be off, tests or all/, 'the start-up check refuses it');
    });
  }
});

test('an unknown switch value fails the run with the reason and spawns nothing', async (t) => {
  const dir = scratch(t);
  const r = await withEnv({ FOREMAN_SANDBOX: 'bogus' }, () => runTests(dir, 'touch ran.txt', guard()));
  assert.equal(r.passed, false);
  assert.match(r.output, /FOREMAN_SANDBOX must be off, tests or all/);
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false, 'the command did not run');
});

test('the switch reaches a worker\'s slot wrapper: FOREMAN_SANDBOX, _RO, _DENY_PORTS and _ALLOW are on the worker\'s environment allowlist', async () => {
  const { claudeWorkerEnv } = await import('../src/runners/claudeIsolation.ts');
  const vars = { FOREMAN_SANDBOX: 'off', FOREMAN_SANDBOX_RO: '/opt/tools', FOREMAN_SANDBOX_DENY_PORTS: '11434', FOREMAN_SANDBOX_ALLOW: 'fsevents' };
  const env = await withEnv(vars, async () => claudeWorkerEnv({ id: 't_sbx_env' } as Task));
  for (const [k, v] of Object.entries(vars)) assert.equal(env[k], v, `${k} is passed on, so the rollback also covers a worker's own suite runs`);
});

// --------------------------------------------------------------------------------------------------- attacks

/** Every write a test command should not be able to make, each attempted on its own so one failure hides no other. */
function writeAttacks(f: Fixture, obj: string): string {
  const targets = [
    `echo pwned > ${q(path.join(HOME, 'pwned.txt'))}`,
    `echo pwned >> ${q(path.join(HOME, '.ssh', 'known_hosts'))}`,
    `mkdir -p ${q(path.join(HOME, 'Library', 'LaunchAgents'))} && echo pwned > ${q(path.join(HOME, 'Library', 'LaunchAgents', 'x.plist'))}`,
    `echo pwned > ${q(path.join(f.repo, 'pwned-worktree.txt'))}`,
    `echo pwned >> ${q(path.join(f.repo, 'app.js'))}`,
    `echo ${f.otherSha} > ${q(path.join(f.repo, '.git', 'refs', 'heads', 'main'))}`,
    `echo '[core]' >> ${q(path.join(f.repo, '.git', 'config'))}`,
    `echo '#!/bin/sh' > ${q(path.join(f.repo, '.git', 'hooks', 'x'))}`,
    `echo '* filter=evil' > ${q(path.join(f.repo, '.git', 'info', 'attributes'))}`,
    `mkdir -p ${q(path.join(f.repo, '.git', 'objects', 'aa'))} && echo evil > ${q(path.join(f.repo, '.git', 'objects', 'aa', 'bb'))}`,
    `chmod u+w ${q(obj)} && echo garbage >> ${q(obj)}`,
    `git -C ${q(f.repo)} replace ${f.mainSha} ${f.otherSha}`,
    `git -C ${q(f.repo)} config core.hooksPath /tmp/x`,
    `echo pwned > ${q(path.join(testHome, 'foreman.db'))}`,
    `echo pwned > ${q(path.join(fs.realpathSync(testHome), 'pwned.txt'))}`,
    `echo pwned > ${q(path.join(f.otherJail, 'pwned.txt'))}`,
    `mv ${q(path.join(f.otherJail, 'notes.txt'))} ${q(path.join(f.otherJail, 'moved.txt'))}`,
    `ln -s ${q(HOME)} via-link && echo pwned > via-link/pwned-through-symlink.txt`,
    `echo pwned > /private/tmp/fsbx-pwned-$$.txt && echo OUT shared-tmp-written`,
  ];
  return `${targets.map((c) => `( ${c} ) 2>/dev/null`).join('; ')}; echo inside > inside.txt; echo OUT ran`;
}

test('attack: a test command cannot write the home, the real repo (work tree, refs, config, hooks, objects), Foreman\'s state or another jail', T, async (t) => {
  const f = fixture(t);
  const objRel = git(f.repo, 'rev-parse', `${f.mainSha}^{tree}`);
  const obj = path.join(f.repo, '.git', 'objects', objRel.slice(0, 2), objRel.slice(2));
  const before = { repo: snapshot(f.repo), home: snapshot(testHome + '/foreman.db'), other: snapshot(f.otherJail) };

  const r = await withEnv(ON, () => runTests(f.jail, writeAttacks(f, obj), guard()));

  assert.deepEqual(outLines(r.output), ['OUT ran'], `the command ran to its end and the shared temp dir was not writable:\n${r.output}`);
  assert.equal(fs.readFileSync(path.join(f.jail, 'inside.txt'), 'utf8'), 'inside\n', 'the jail itself is writable');
  assert.equal(snapshot(f.repo), before.repo, 'the real repo, its .git included, is byte-identical');
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.mainSha, 'main did not move');
  assert.equal(git(f.repo, 'for-each-ref', 'refs/replace'), '', 'no replace ref');
  assert.doesNotThrow(() => git(f.repo, 'fsck', '--no-dangling'), 'the object store is intact');
  assert.equal(snapshot(testHome + '/foreman.db'), before.home, 'foreman.db unchanged');
  assert.equal(fs.existsSync(path.join(testHome, 'pwned.txt')), false);
  assert.equal(snapshot(f.otherJail), before.other, 'the other run\'s jail unchanged');
  for (const p of ['pwned.txt', '.ssh/known_hosts', 'Library/LaunchAgents/x.plist', 'pwned-through-symlink.txt']) {
    assert.equal(fs.existsSync(path.join(HOME, p)), false, `${p} was not created in the home`);
  }
});

test('control: with FOREMAN_SANDBOX=off the same writes land (the switch is what stops them)', T, async (t) => {
  const f = fixture(t);
  const objRel = git(f.repo, 'rev-parse', `${f.mainSha}^{tree}`);
  const obj = path.join(f.repo, '.git', 'objects', objRel.slice(0, 2), objRel.slice(2));
  const before = snapshot(f.repo);
  t.after(() => {
    for (const p of ['pwned.txt', '.ssh/known_hosts', 'Library', 'pwned-through-symlink.txt']) fs.rmSync(path.join(HOME, p), { recursive: true, force: true });
    fs.rmSync(path.join(testHome, 'pwned.txt'), { force: true });
    fs.writeFileSync(path.join(testHome, 'foreman.db'), `${DB_DECOY}\n`);
    for (const name of fs.readdirSync('/private/tmp')) if (/^fsbx-pwned-\d+\.txt$/.test(name)) fs.rmSync(path.join('/private/tmp', name), { force: true });
  });
  await withEnv(OFF, () => runTests(f.jail, writeAttacks(f, obj), guard()));
  assert.notEqual(snapshot(f.repo), before, 'unsandboxed, the real repo was changed');
  assert.equal(fs.existsSync(path.join(HOME, 'pwned.txt')), true);
  assert.equal(fs.readFileSync(path.join(f.repo, '.git', 'refs', 'heads', 'main'), 'utf8').trim(), f.otherSha, 'unsandboxed, main was moved by a file write');
});

test('attack X5: git update-ref from a worktree jail does not move the real main; with the switch off it does', T, async (t) => {
  const f = fixture(t);
  const cmd = `git update-ref refs/heads/main ${f.otherSha}; echo OUT rc=$?; git -C ${q(f.repo)} update-ref refs/heads/main ${f.otherSha}; echo OUT rc=$?`;
  const on = await withEnv(ON, () => runTests(f.jail, cmd, guard()));
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.mainSha, `main did not move:\n${on.output}`);
  assert.equal(outLines(on.output).filter((l) => l === 'OUT rc=0').length, 0, 'both update-ref calls failed');

  await withEnv(OFF, () => runTests(f.jail, cmd, guard()));
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.otherSha, 'unsandboxed, the same command moves main (hole X5)');
});

test('attack: decoy secrets in the home, Foreman\'s database, another repo and another jail cannot be read, listed or stat-ed', T, async (t) => {
  const f = fixture(t);
  const other = fixture(t);
  fs.writeFileSync(path.join(other.repo, 'secret.txt'), 'DECOY-OTHER-REPO-4471\n');
  const files = [
    ...Object.keys(DECOYS).map((rel) => path.join(HOME, rel)),
    path.join(testHome, 'foreman.db'),
    path.join(other.repo, 'secret.txt'),
    path.join(other.repo, '.git', 'config'),
    path.join(f.otherJail, 'notes.txt'),
    path.join(f.repo, 'app.js'),
    path.join('/System/Volumes/Data', HOME, '.ssh', 'id_x'),
  ];
  const cmd =
    files.map((p) => `cat ${q(p)}; cat < ${q(p)}; test -e ${q(p)} && echo OUT stat-ok ${q(p)}`).join('; ') +
    `; ls ${q(HOME)}; ls ${q(path.join(HOME, '.ssh'))}; ls ${q(path.dirname(HOME))}; ls /Users; ls ${q(testHome)}; ` +
    `ln -s ${q(path.join(HOME, '.ssh', 'id_x'))} link-to-key && cat link-to-key; ` +
    `node -e ${q(`for (const p of ${JSON.stringify(files)}) { try { console.log(require('fs').readFileSync(p, 'utf8')) } catch (e) { console.log('OUT node ' + e.code) } }`)}; echo OUT ran`;
  const secrets = [...Object.values(DECOYS), DB_DECOY, 'DECOY-OTHER-REPO-4471', 'DECOY-OTHER-JAIL-3310', 'export const one'];

  const on = await withEnv(ON, () => runTests(f.jail, cmd, guard()));
  assert.ok(outLines(on.output).includes('OUT ran'), on.output);
  for (const s of secrets) assert.ok(!on.output.includes(s), `the output must not contain ${s}:\n${on.output}`);
  assert.equal(outLines(on.output).filter((l) => l.startsWith('OUT stat-ok')).length, 0, 'none of them can even be stat-ed');
  assert.ok(!on.output.includes('id_x\n') && !/^Projects$/m.test(on.output), 'the home cannot be listed');
  assert.equal(outLines(on.output).filter((l) => l === 'OUT node EPERM').length, files.length, 'node gets EPERM for each');

  const off = await withEnv(OFF, () => runTests(f.jail, cmd, guard()));
  for (const s of secrets) assert.ok(off.output.includes(s), `unsandboxed, ${s} is readable (the decoys are real files)`);
});

test('attack: a file another program left in a shared temp dir (/tmp, /var/tmp) cannot be read or listed', T, async (t) => {
  const f = fixture(t);
  // Real shared directories, as any program of the same user would use them; each decoy sits in a directory of its own.
  const shared = ['/private/tmp', '/private/var/tmp'].filter((d) => fs.existsSync(d));
  assert.equal(shared.length, 2, 'precondition: both shared temp dirs exist here');
  const decoys = shared.map((d) => path.join(fs.mkdtempSync(path.join(d, 'fsbx-shared-')), 'left-behind.txt'));
  t.after(() => {
    for (const p of decoys) fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });
  decoys.forEach((p, i) => fs.writeFileSync(p, `DECOY-SHARED-TMP-${i}-5c1d\n`));
  const cmd =
    decoys.map((p) => `cat ${q(p)}; cat ${q(path.join('/System/Volumes/Data', p))}; ls ${q(path.dirname(p))} | sed 's/^/OUT ls /'; test -e ${q(p)} && echo OUT stat-ok`).join('; ') +
    `; ${shared.map((d) => `ls ${q(d)} | sed 's/^/OUT ls /'`).join('; ')}; echo OUT ran`;
  const on = await withEnv(ON, () => runTests(f.jail, cmd, guard()));
  assert.deepEqual(outLines(on.output), ['OUT ran'], `nothing there can be listed or stat-ed:\n${on.output}`);
  assert.ok(!on.output.includes('DECOY-SHARED-TMP'), `nor read:\n${on.output}`);
  // The control: the same command with no sandbox prints every decoy. Run plainly (no run machinery around it) and
  // asked again until the expected text is there or a generous bound passes: at a machine load of 136-180 this half
  // once came back empty while the sandboxed half above had already passed. No timing is asserted.
  const want = decoys.map((_, i) => `DECOY-SHARED-TMP-${i}-5c1d`);
  let plain = '';
  let last = '';
  for (const end = Date.now() + 100_000; ;) {
    plain = await new Promise<string>((resolve) => {
      execFile('/bin/sh', ['-c', cmd], { cwd: f.jail, killSignal: 'SIGKILL', timeout: 45_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        last = err ? String(err).slice(0, 300) : '';
        resolve(stdout);
      });
    });
    if (want.every((w) => plain.includes(w)) || Date.now() > end) break;
    await sleep(250);
  }
  for (let i = 0; i < decoys.length; i++) assert.ok(plain.includes(want[i]!), `unsandboxed, ${decoys[i]} is readable (last error: ${last || 'none'})`);
});

test('/Users and /Volumes can be stat-ed as directories by a sandboxed command, and still not listed', T, async (t) => {
  // A scratch jail outside /Users, so /Users is not stat-able merely for being above the jail.
  const dir = scratch(t);
  const probe = `for (const p of ['/Users', '/Volumes']) { const fs = require('fs'); try { console.log('OUT stat ' + p + ' ' + fs.statSync(p).isDirectory()); } catch (e) { console.log('OUT stat ' + p + ' ' + e.code); } try { console.log('OUT list ' + p + ' ' + fs.readdirSync(p).length); } catch (e) { console.log('OUT list ' + p + ' ' + e.code); } }`;
  const on = await withEnv(ON, () => runTests(dir, `node -e ${q(probe)}; for d in /Users /Volumes ${q(HOME)}; do ls "$d" | sed 's/^/OUT ls /'; done; echo OUT ran`, guard()));
  assert.deepEqual(outLines(on.output), [
    'OUT stat /Users true', 'OUT list /Users EPERM', 'OUT stat /Volumes true', 'OUT list /Volumes EPERM', 'OUT ran',
  ], on.output);
});

test('attack: the control port and the closed loopback ports cannot be reached; another loopback port can', T, async (t) => {
  const f = fixture(t);
  const denied = [await listener(), await listener()];
  const open = await listener();
  // A unix socket outside the run's own directories (the Docker socket, mDNSResponder, the slot socket of a later stage).
  const sockDir = scratch(t);
  const outside = net.createServer((c) => {
    c.on('error', () => {});
    c.end('hi');
  });
  await new Promise<void>((r) => outside.listen(path.join(sockDir, 'o.sock'), r));
  t.after(() => outside.close());
  const probe = `
    const net = require('net');
    const targets = ${JSON.stringify([
      ['control', '127.0.0.1', control.port], ['control-localhost', 'localhost', control.port], ['control-v6', '::1', control.port],
      ['denied1', '127.0.0.1', denied[0]!.port], ['denied2', 'localhost', denied[1]!.port], ['open', '127.0.0.1', open.port],
      ['internet', '192.0.2.1', 443], ['unix-outside', path.join(sockDir, 'o.sock'), 0],
    ])};
    (async () => {
      for (const [name, host, port] of targets) {
        await new Promise((done) => {
          const s = port ? net.connect({ host, port }) : net.connect(host);
          s.setTimeout(name === 'internet' ? 3000 : 20000, () => { console.log('OUT ' + name + ' timeout'); s.destroy(); done(); });
          s.on('connect', () => { console.log('OUT ' + name + ' connected'); s.destroy(); done(); });
          s.on('error', (e) => { console.log('OUT ' + name + ' ' + e.code); done(); });
        });
      }
    })();`;
  fs.writeFileSync(path.join(f.jail, 'probe.cjs'), probe);
  // A grandchild too: curl started by the shell, against the control port.
  const cmd = `node probe.cjs; curl -s -m 20 http://127.0.0.1:${control.port}/api/tasks; echo OUT curl rc=$?`;
  const ports = { FOREMAN_SANDBOX_DENY_PORTS: `${denied[0]!.port},${denied[1]!.port}` };
  const hits = (): number[] => [control.hits(), denied[0]!.hits(), denied[1]!.hits(), open.hits()];

  const before = hits();
  const on = await withEnv({ ...ON, ...ports }, () => runTests(f.jail, cmd, guard()));
  const got = Object.fromEntries(outLines(on.output).map((l) => l.slice(4).split(' ', 2) as [string, string]));
  assert.equal(got['control'], 'EPERM', on.output);
  assert.equal(got['control-localhost'], 'EPERM', on.output);
  assert.match(got['control-v6'] ?? '', /^(EPERM|ECONNREFUSED)$/, 'nothing listens on ::1 here; either way no connection');
  assert.equal(got['denied1'], 'EPERM', on.output);
  assert.equal(got['denied2'], 'EPERM', on.output);
  assert.equal(got['open'], 'connected', 'a loopback port that is not on the list stays reachable');
  assert.equal(got['internet'], 'EPERM', 'no address off this machine');
  assert.equal(got['unix-outside'], 'EPERM', 'no unix socket outside the run\'s own directories');
  assert.ok(!on.output.includes('OUT curl rc=0'), 'curl could not reach the control port either');
  const after = hits();
  assert.deepEqual([after[0]! - before[0]!, after[1]! - before[1]!, after[2]! - before[2]!], [0, 0, 0], 'the closed listeners saw no connection');
  assert.equal(after[3]! - before[3]!, 1, 'the open listener saw exactly one');

  const off = await withEnv({ ...OFF, ...ports }, () => runTests(f.jail, 'node probe.cjs', guard()));
  assert.ok(off.output.includes('OUT control connected') && off.output.includes('OUT denied1 connected') && off.output.includes('OUT unix-outside connected'), `unsandboxed, the same ports answer:\n${off.output}`);
});

test('the default closed ports are 8000, 8001, 8002 and 3010, and FOREMAN_SANDBOX_DENY_PORTS replaces the list', T, async (t) => {
  const dir = scratch(t);
  const defs = async (): Promise<string[]> => (await sbx.wrap('tests', { jail: dir, tmp: dir, home: dir }, '/usr/bin/true', [])).args.filter((a) => a.startsWith('DENY_PORT_') || a.startsWith('CONTROL_PORT='));
  await withEnv({ FOREMAN_SANDBOX_DENY_PORTS: undefined }, async () =>
    assert.deepEqual(await defs(), [`CONTROL_PORT=${control.port}`, 'DENY_PORT_1=8000', 'DENY_PORT_2=8001', 'DENY_PORT_3=8002', 'DENY_PORT_4=3010']));
  await withEnv({ FOREMAN_SANDBOX_DENY_PORTS: '11434 4000' }, async () =>
    assert.deepEqual(await defs(), [`CONTROL_PORT=${control.port}`, 'DENY_PORT_1=11434', 'DENY_PORT_2=4000']));
  await withEnv({ FOREMAN_SANDBOX_DENY_PORTS: '' }, async () => assert.deepEqual(await defs(), [`CONTROL_PORT=${control.port}`]));
  for (const bad of ['1,2,3,4,5', 'http', '0', '70000', '80;(allow default)']) {
    await withEnv({ FOREMAN_SANDBOX_DENY_PORTS: bad }, async () => {
      await assert.rejects(defs(), sbx.SandboxError, `${bad} is refused`);
      const r = await withEnv(ON, () => runTests(dir, 'touch ran.txt', guard()));
      assert.equal(r.passed, false);
      assert.match(r.output, /FOREMAN_SANDBOX_DENY_PORTS/);
      assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false, 'a bad list fails the run; it does not run unconfined');
    });
  }
});

test('attack: launchctl is refused, sandbox-exec cannot be nested to get out, and a bystander process cannot be signalled', T, async (t) => {
  const f = fixture(t);
  const bystander = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true });
  t.after(() => {
    try {
      process.kill(bystander.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  const escaped = path.join(HOME, 'escaped.txt');
  t.after(() => fs.rmSync(escaped, { force: true }));
  const cmd =
    `/bin/launchctl print user/$(id -u) > launchctl.out 2>&1; echo OUT launchctl rc=$?; ` +
    `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/sh -c ${q(`echo x > ${q(escaped)}`)}; echo OUT nest rc=$?; ` +
    `kill -TERM ${bystander.pid}; echo OUT kill rc=$?; kill -KILL ${bystander.pid}; echo OUT kill9 rc=$?`;
  const on = await withEnv(ON, () => runTests(f.jail, cmd, guard()));
  const lines = outLines(on.output);
  assert.equal(lines.length, 4, on.output);
  assert.ok(!lines.includes('OUT launchctl rc=0'), 'launchctl did not run');
  const printed = fs.existsSync(path.join(f.jail, 'launchctl.out')) ? fs.readFileSync(path.join(f.jail, 'launchctl.out'), 'utf8') : '';
  assert.ok(!/com\.apple\./.test(printed), 'and listed none of the user\'s services');
  assert.ok(!lines.includes('OUT nest rc=0'), 'a nested sandbox-exec is refused');
  assert.equal(fs.existsSync(escaped), false, 'nothing was written through a nested "allow default" profile');
  assert.ok(!lines.includes('OUT kill rc=0') && !lines.includes('OUT kill9 rc=0'), 'kill was refused');
  assert.equal(alive(bystander.pid!), true, 'the bystander is still alive');

  const off = await withEnv(OFF, () => runTests(f.jail, `kill -TERM ${bystander.pid}; echo OUT kill rc=$?`, guard()));
  assert.ok(off.output.includes('OUT kill rc=0'), 'unsandboxed, the same kill is delivered');
});

test('what the README says a sandboxed command loses: a setuid program (ps) does not start, and the compiler\'s lookup cache lands in the private TMPDIR', T, async (t) => {
  const f = fixture(t);
  // Not rules of ours: macOS starts no setuid program inside any sandbox, and xcrun keeps its cache in the user's
  // temp dir, which here is the run's own. Both surprised a real gate (Kiln's), so both are pinned and documented.
  const ps = `ps -o pid= -p $$ > ps.out 2>&1; echo OUT ps rc=$?`;
  const on = await withEnv(ON, () => runTests(f.jail, ps, guard()));
  assert.deepEqual(outLines(on.output), ['OUT ps rc=126'], on.output);
  assert.match(fs.readFileSync(path.join(f.jail, 'ps.out'), 'utf8'), /Operation not permitted/);
  const off = await withEnv(OFF, () => runTests(f.jail, ps, guard()));
  assert.deepEqual(outLines(off.output), ['OUT ps rc=0'], 'unsandboxed, ps runs');

  const hasCxx = await new Promise<boolean>((r) => execFile('/usr/bin/xcrun', ['-f', 'clang++'], { timeout: 60_000, killSignal: 'SIGKILL' }, (e) => r(!e)));
  if (!hasCxx) return t.diagnostic('no clang++ here: the xcrun cache is not exercised');
  const cc = `echo 'int main(){return 0;}' > m.c && clang -fsyntax-only m.c && echo OUT compiled && ls -A "$TMPDIR" | sed 's/^/OUT tmp /'`;
  const sandboxed = await withEnv(ON, () => runTests(f.jail, cc, guard()));
  assert.deepEqual(outLines(sandboxed.output), ['OUT compiled', 'OUT tmp xcrun_db'], sandboxed.output);
  const plain = await withEnv(OFF, () => runTests(f.jail, cc, guard()));
  assert.deepEqual(outLines(plain.output), ['OUT compiled'], 'unsandboxed, the cache is the user\'s shared one and TMPDIR stays empty');
});

// ------------------------------------------------------------------------------------------------ fail closed

test('fail closed: FOREMAN_TEST_REAL_HOME=1 with the sandbox on fails the run with the reason and spawns nothing', T, async (t) => {
  const dir = scratch(t);
  const spawned: (number | null)[] = [];
  const r = await withEnv({ ...ON, FOREMAN_TEST_REAL_HOME: '1' }, () => runTests(dir, 'touch ran.txt', guard(), undefined, (pid) => spawned.push(pid)));
  assert.equal(r.ran, true);
  assert.equal(r.passed, false);
  assert.match(r.output, /FOREMAN_TEST_REAL_HOME=1 cannot be used with the sandbox on/);
  assert.match(r.output, /FOREMAN_SANDBOX=off/);
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
  assert.deepEqual(spawned, [null], 'no pid was ever reported');
  // With the switch off it keeps today's meaning: the real (here: fake) HOME reaches the command.
  const off = await withEnv({ ...OFF, FOREMAN_TEST_REAL_HOME: '1' }, () => runTests(dir, 'echo "OUT $HOME"', guard()));
  assert.deepEqual(outLines(off.output), [`OUT ${HOME}`]);
});

test('fail closed: sandbox-exec missing, not executable, failing, or a profile that does not compile — the command never runs unsandboxed', T, async (t) => {
  const dir = scratch(t);
  const stubs = scratch(t);
  const notExec = path.join(stubs, 'not-executable');
  fs.writeFileSync(notExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const failing = path.join(stubs, 'failing');
  fs.writeFileSync(failing, '#!/bin/sh\necho "stub: sandbox is broken" >&2\nexit 71\n', { mode: 0o755 });
  // Passes the availability probe (-p …) and then cannot build the real sandbox (-D …): only the per-run check sees it.
  const lateFailing = path.join(stubs, 'late-failing');
  fs.writeFileSync(lateFailing, '#!/bin/sh\n[ "$1" = "-p" ] && exit 0\necho "stub: cannot apply" >&2\nexit 71\n', { mode: 0o755 });
  const badProfiles = path.join(stubs, 'profiles');
  fs.cpSync(path.join(SRC_ROOT, 'src', 'security', 'sandbox'), badProfiles, { recursive: true });
  fs.appendFileSync(path.join(badProfiles, 'profile-tests.sb'), '\n(allow no-such-operation-at-all)\n(');
  const emptyProfiles = path.join(stubs, 'empty');
  fs.mkdirSync(emptyProfiles);
  t.after(() => sbx._setSandboxSeamsForTest(null));

  const cases: [string, { exec?: string; profileDir?: string }, RegExp][] = [
    ['missing', { exec: path.join(stubs, 'nope') }, /missing or not executable/],
    ['not executable', { exec: notExec }, /missing or not executable/],
    ['failing', { exec: failing }, /stub: sandbox is broken/],
    ['failing only on the real profile', { exec: lateFailing }, /did not start: stub: cannot apply/],
    ['profile does not compile', { profileDir: badProfiles }, /did not start/],
    ['profile file missing', { profileDir: emptyProfiles }, /did not start/],
  ];
  for (const [name, seams, reason] of cases) {
    sbx._setSandboxSeamsForTest(seams);
    const marker = path.join(dir, `ran-${name.replace(/\W+/g, '-')}.txt`);
    const said: string[] = [];
    const r = await withEnv(ON, () => runTests(dir, `touch ${q(marker)}`, guard(), (l) => said.push(l)));
    assert.equal(r.passed, false, name);
    assert.match(r.output, reason, name);
    assert.match(r.output, /FOREMAN_SANDBOX=off/, `${name}: the reason names the switch`);
    assert.deepEqual(said, [r.output], `${name}: the reason is streamed, not only returned`);
    assert.equal(fs.existsSync(marker), false, `${name}: the command did not run`);
    assert.match((await withEnv(ON, () => sbx.selfTest())) ?? '', /FOREMAN_SANDBOX=off/, `${name}: the start-up check refuses to run work`);

    // The shell runner and run_shell fail the same way.
    await withEnv(ON, () => assert.rejects(sandboxedShell(dir, `touch ${q(marker)}`), sbx.SandboxError, name));

    // And with the switch off none of this is consulted: the command runs as it always did.
    const off = await withEnv(OFF, () => runTests(dir, `touch ${q(marker)} && echo OUT ran`, guard()));
    assert.equal(off.passed, true, `${name}: off does not depend on sandbox-exec`);
    assert.ok(fs.existsSync(marker));
    assert.equal(await withEnv(OFF, () => sbx.selfTest()), null);
  }
  sbx._setSandboxSeamsForTest(null);
  assert.equal(await withEnv(ON, () => sbx.sandboxAvailable()), 'ok', 'a failed probe is not remembered');
  assert.equal(await withEnv(ON, () => sbx.selfTest()), null, 'the start-up check passes on the real thing');
  assert.equal(fs.existsSync(path.join(testHome, '.sandbox-selftest')), false, 'and leaves nothing in Foreman\'s home');
});

// ------------------------------------------------------------------------------ wrap(): parameters, not text

test('wrap: every path goes in as a real path in its own -D argv entry; relative paths, a fifth read-only tree, one inside Foreman\'s home, and a jail that contains Foreman\'s home are refused', T, async (t) => {
  const dir = scratch(t);
  // os.tmpdir() is /var/folders/… (a symlink to /private/var/…); /tmp is one to /private/tmp.
  const viaVar = path.join(os.tmpdir(), path.basename(dir));
  assert.notEqual(viaVar, dir, 'precondition: the temp dir is reached through a symlink');
  const tmpDir = fs.mkdtempSync('/tmp/fsbx-wrap-');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const roDir = fs.mkdtempSync('/tmp/fsbx-ro-');
  t.after(() => fs.rmSync(roDir, { recursive: true, force: true }));
  const w = await withEnv({ FOREMAN_SANDBOX_RO: undefined, FOREMAN_SANDBOX_DENY_PORTS: '' }, () =>
    sbx.wrap('tests', { jail: viaVar, tmp: tmpDir, home: viaVar, readOnly: [roDir] }, '/bin/sh', ['-c', 'echo "a b"; (c)']));
  assert.equal(w.cmd, '/usr/bin/sandbox-exec');
  // NODE_ROOT (the running node's install root) depends on where this node lives; it has tests of its own.
  const defs = w.args.filter((_, i) => w.args[i - 1] === '-D').filter((d) => !d.startsWith('NODE_ROOT='));
  assert.deepEqual(defs, [
    `PROFILE_DIR=${fs.realpathSync(path.join(SRC_ROOT, 'src', 'security', 'sandbox'))}`,
    `JAIL=${dir}`, `TMP=${fs.realpathSync(tmpDir)}`, `RUNHOME=${dir}`, `FOREMAN_HOME=${fs.realpathSync(testHome)}`,
    `CONTROL_PORT=${control.port}`, `RO_1=/private${roDir}`,
  ]);
  assert.ok(fs.realpathSync(tmpDir).startsWith('/private/tmp/'));
  assert.deepEqual(w.args.slice(-4), [path.join(fs.realpathSync(SRC_ROOT), 'src', 'security', 'sandbox', 'profile-tests.sb'), '/bin/sh', '-c', 'echo "a b"; (c)'], 'the command and its arguments follow untouched');
  assert.equal(config.sourceRoot, SRC_ROOT, 'profiles come from the daemon\'s own source root');

  const o = { jail: dir, tmp: dir, home: dir };
  await assert.rejects(sbx.wrap('tests', { ...o, jail: 'relative/jail' }, '/usr/bin/true', []), /must be absolute/);
  await assert.rejects(sbx.wrap('tests', { ...o, readOnly: ['rel'] }, '/usr/bin/true', []), /must be absolute/);
  await assert.rejects(sbx.wrap('tests', { ...o, readOnly: ['/a', '/b', '/c', '/d', '/e'] }, '/usr/bin/true', []), /at most 4 read-only trees/);
  await withEnv({ FOREMAN_SANDBOX_RO: '/a:/b:/c' }, () =>
    assert.rejects(sbx.wrap('tests', { ...o, readOnly: ['/d', '/e'] }, '/usr/bin/true', []), /at most 4 read-only trees/, 'the two lists share the four slots'));
  await assert.rejects(sbx.wrap('tests', { ...o, readOnly: [path.join(testHome, 'artifacts')] }, '/usr/bin/true', []), /inside Foreman's home/);
  await withEnv({ FOREMAN_SANDBOX_RO: path.join(os.tmpdir(), path.basename(testHome)) }, () =>
    assert.rejects(sbx.wrap('tests', o, '/usr/bin/true', []), /inside Foreman's home/, 'also through FOREMAN_SANDBOX_RO, also through the symlinked spelling'));
  await assert.rejects(sbx.wrap('tests', { ...o, jail: TMP }, '/usr/bin/true', []), /contains Foreman's home/);
  await assert.rejects(sbx.wrap('tests', { ...o, jail: testHome }, '/usr/bin/true', []), /contains Foreman's home/);
  const r = await withEnv(ON, () => runTests(TMP, `touch ${q(path.join(dir, 'ran.txt'))}`, guard()));
  assert.match(r.output, /contains Foreman's home/, 'such a run is refused, not run unconfined');
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
});

test('a jail whose path has spaces, quotes, parentheses, a semicolon and non-ASCII letters, reached through a symlinked prefix, is confined like any other', T, async (t) => {
  const root = scratch(t);
  const odd = `we ird ("q') [x]; (allow default) ü 漢`;
  const realParent = path.join(root, 'real parent');
  fs.mkdirSync(path.join(realParent, odd), { recursive: true });
  fs.symlinkSync(realParent, path.join(root, 'link'));
  const jail = path.join(root, 'link', odd); // reached through a symlink, like /tmp and /var
  const outside = path.join(root, `outside ${odd}.txt`);
  const cmd = `echo in > inside.txt; echo OUT inside rc=$?; echo out > ${q(outside)}; echo OUT outside rc=$?; pwd -P | sed 's/^/OUT pwd /'`;
  const on = await withEnv(ON, () => runTests(jail, cmd, guard()));
  assert.deepEqual(outLines(on.output), ['OUT inside rc=0', 'OUT outside rc=1', `OUT pwd ${path.join(realParent, odd)}`], on.output);
  assert.equal(fs.readFileSync(path.join(realParent, odd, 'inside.txt'), 'utf8'), 'in\n');
  assert.equal(fs.existsSync(outside), false);
  const off = await withEnv(OFF, () => runTests(jail, cmd, guard()));
  assert.deepEqual(outLines(off.output).slice(0, 2), ['OUT inside rc=0', 'OUT outside rc=0'], 'unsandboxed, the outside write lands');
});

test('worktreeGitDir: a worktree jail yields the real git dir; a .git file edited to name another tree yields nothing, so nothing extra becomes readable', T, async (t) => {
  const f = fixture(t);
  const victim = fixture(t);
  fs.writeFileSync(path.join(victim.repo, '.git', 'description'), 'DECOY-VICTIM-GITDIR-8820\n');
  assert.equal(await sbx.worktreeGitDir(f.jail), path.join(f.repo, '.git'));
  assert.equal(await sbx.worktreeGitDir(f.repo), null, 'a repo with its own .git directory needs no give-back');
  assert.equal(await sbx.worktreeGitDir(path.join(f.jail, 'nope')), null);

  // The worker rewrites its jail's .git file to point at ANOTHER repo's worktree admin dir (which points back at that
  // repo's own jail, not this one), and at a directory it made up under the home.
  const admin = path.join(victim.repo, '.git', 'worktrees', fs.readdirSync(path.join(victim.repo, '.git', 'worktrees'))[0]!);
  const madeUp = path.join(HOME, 'Documents', '.git', 'worktrees', 'x');
  fs.mkdirSync(madeUp, { recursive: true });
  t.after(() => fs.rmSync(path.join(HOME, 'Documents'), { recursive: true, force: true }));
  fs.mkdirSync(path.join(HOME, 'Documents', '.git', 'objects'));
  fs.writeFileSync(path.join(madeUp, 'gitdir'), `${path.join(victim.jail, '.git')}\n`);
  fs.writeFileSync(path.join(HOME, 'Documents', 'private.txt'), 'DECOY-DOCUMENTS-1177\n');
  for (const target of [admin, madeUp, HOME, path.join(HOME, '.ssh')]) {
    fs.writeFileSync(path.join(f.jail, '.git'), `gitdir: ${target}\n`);
    assert.equal(await sbx.worktreeGitDir(f.jail), null, `${target} is not believed`);
    const r = await withEnv(ON, () =>
      runTests(f.jail, `cat ${q(path.join(victim.repo, '.git', 'description'))} ${q(path.join(HOME, '.ssh', 'id_x'))} ${q(path.join(HOME, 'Documents', 'private.txt'))}; echo OUT ran`, guard()));
    assert.ok(r.output.includes('OUT ran'));
    assert.ok(!/DECOY-/.test(r.output), `nothing leaked through ${target}:\n${r.output}`);
  }
});

test('FOREMAN_SANDBOX_RO: a tool under the home is invisible without it, readable and runnable with it, and still not writable', T, async (t) => {
  const f = fixture(t);
  const tools = path.join(HOME, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tools, 'lint.sh'), '#!/bin/sh\necho OUT lint ok\n', { mode: 0o755 });
  const cmd = `${q(path.join(tools, 'lint.sh'))}; echo x >> ${q(path.join(tools, 'lint.sh'))}; echo OUT write rc=$?; cat ${q(path.join(HOME, '.ssh', 'id_x'))}`;
  const without = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: undefined }, () => runTests(f.jail, cmd, guard()));
  assert.deepEqual(outLines(without.output), ['OUT write rc=1'], without.output);
  assert.match(without.output, /foreman: this ran sandboxed \(FOREMAN_SANDBOX=tests\).*FOREMAN_SANDBOX_RO/, 'the failed run says where to look');
  const withRo = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: tools }, () => runTests(f.jail, cmd, guard()));
  assert.deepEqual(outLines(withRo.output), ['OUT lint ok', 'OUT write rc=1'], withRo.output);
  assert.ok(!withRo.output.includes(DECOYS['.ssh/id_x']!), 'the rest of the home stays unreadable');
  assert.equal(fs.readFileSync(path.join(tools, 'lint.sh'), 'utf8'), '#!/bin/sh\necho OUT lint ok\n');
});

test('wrap refuses a read-only tree that is, or contains, a tree the sandbox closes — in every spelling — and accepts a subtree', T, async (t) => {
  const f = fixture(t);
  const root = scratch(t);
  const jail = path.join(root, 'jails', 'r1');
  fs.mkdirSync(jail, { recursive: true });
  const llvm = path.join(HOME, '.local', 'llvm-23');
  fs.mkdirSync(llvm, { recursive: true });
  t.after(() => fs.rmSync(path.join(HOME, '.local'), { recursive: true, force: true }));
  const o = { jail, tmp: jail, home: jail, realGit: path.join(f.repo, '.git') };
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refused: [string, RegExp][] = [
    ['/', /the filesystem root/],
    ['/Users', /\/Users/],
    ['/Volumes', /\/Volumes/],
    ['/private', /\/private/],
    ['/private/tmp', /shared temp dir \/tmp/],
    ['/private/var', /\/var/],
    ['/tmp', /shared temp dir \/tmp/],
    ['/var', /\/var/],
    ['/private/var/folders', /per-user temp dirs/],
    [HOME, /your home directory/],
    [path.join(os.tmpdir(), path.basename(HOME)), /your home directory/], // the symlinked spelling (/var/folders/…)
    [os.userInfo().homedir, /your home directory/], // the account's home, whatever HOME says
    [TMP, /./], // the temp dir: Foreman's home, the fake home and every private HOME are inside it
    [path.dirname(fs.realpathSync(testHome)), /Foreman's home|your home directory/],
    [path.dirname(jail), /the directory above the run's jail/],
    [root, /the directory above the run's jail/],
    [f.repo, /the real repository/],
    [path.dirname(f.repo), /the real repository/],
    ['/System/Volumes/Data', /the filesystem root/],
    ['/System/Volumes/Data/Users', /\/Users/],
    ['/System/Volumes/Data/private/tmp', /shared temp dir \/tmp/],
    [path.join('/System/Volumes/Data', HOME), /your home directory/],
    [path.join('/System/Volumes/Data', f.repo), /the real repository/],
  ];
  for (const [entry, what] of refused) {
    const named = new RegExp(`read-only tree ${esc(JSON.stringify(entry))}.* is, or contains, .*refused`);
    for (const [how, call] of [
      ['opts.readOnly', () => withEnv({ FOREMAN_SANDBOX_RO: undefined }, () => sbx.wrap('tests', { ...o, readOnly: [entry] }, '/usr/bin/true', []))],
      ['FOREMAN_SANDBOX_RO', () => withEnv({ FOREMAN_SANDBOX_RO: entry }, () => sbx.wrap('tests', o, '/usr/bin/true', []))],
    ] as const) {
      await assert.rejects(call(), (err: Error) => {
        assert.ok(err instanceof sbx.SandboxError, `${entry} via ${how}: ${err}`);
        assert.match(err.message, named, `${entry} via ${how}: the message names the entry`);
        assert.match(err.message, what, `${entry} via ${how}`);
        return true;
      }, `${entry} via ${how} is refused`);
    }
  }
  // Every tree base.sb closes outright is on the list: read from the profile, so a rule added there without its
  // entry here fails this test. The tree itself and the directory above it are both refused.
  const baseSb = fs.readFileSync(path.join(SRC_ROOT, 'src', 'security', 'sandbox', 'base.sb'), 'utf8');
  const denyBlock = /\(deny file-read\*\n([\s\S]*?)\n;; 3\. /.exec(baseSb)?.[1] ?? '';
  const closedInProfile = [...denyBlock.matchAll(/^\s*\(subpath "([^"]+)"\)/gm)].map((m) => m[1]!);
  assert.ok(closedInProfile.length >= 15 && closedInProfile.includes('/Library/Keychains') && closedInProfile.includes('/Users'), `the profile's closed list was found: ${closedInProfile.join(' ')}`);
  for (const tree of closedInProfile) {
    for (const entry of [tree, path.dirname(tree)]) {
      await withEnv({ FOREMAN_SANDBOX_RO: entry }, () =>
        assert.rejects(sbx.wrap('tests', o, '/usr/bin/true', []), /is, or contains, .*refused/, `${entry} (base.sb closes ${tree})`));
    }
  }
  // Inside Foreman's home is refused as before (its own message), whether or not the tree is also the jails' root.
  await assert.rejects(sbx.wrap('tests', { ...o, readOnly: [config.workRoot] }, '/usr/bin/true', []), /inside Foreman's home/);

  // A subtree is what the knob is for: a toolchain under the home, the daemon's toolbox, Foreman's source, and the
  // real repo's git directory (which Foreman itself passes as REAL_GIT).
  const ok = await withEnv({ FOREMAN_SANDBOX_RO: llvm }, () =>
    sbx.wrap('tests', { ...o, readOnly: [config.toolbox, path.join(f.repo, '.git'), SRC_ROOT] }, '/usr/bin/true', []));
  const defs = ok.args.filter((_, i) => ok.args[i - 1] === '-D');
  for (const d of [`RO_1=${fs.realpathSync(config.toolbox)}`, `RO_2=${path.join(f.repo, '.git')}`, `RO_3=${fs.realpathSync(SRC_ROOT)}`, `RO_4=${llvm}`, `REAL_GIT=${path.join(f.repo, '.git')}`]) {
    assert.ok(defs.includes(d), `${d} in ${defs.join(' ')}`);
  }
  assert.equal(path.dirname(config.toolbox), SRC_ROOT, 'precondition: the toolbox is the one in the daemon\'s source tree');
  // The same tree named by Foreman and again in FOREMAN_SANDBOX_RO takes one of the four slots, not two.
  const twice = await withEnv({ FOREMAN_SANDBOX_RO: `${llvm}:${config.toolbox}` }, () =>
    sbx.wrap('tests', { ...o, readOnly: [config.toolbox, path.join(f.repo, '.git'), SRC_ROOT] }, '/usr/bin/true', []));
  assert.equal(twice.args.filter((a) => /^RO_\d=/.test(a)).length, 4);
});

test('FOREMAN_SANDBOX_RO naming the home: the run is refused with the entry named, nothing runs, and the decoy in the home is never read', T, async (t) => {
  const f = fixture(t);
  const decoy = path.join(HOME, '.ssh', 'id_x');
  const cmd = `cat ${q(decoy)}; ls ${q(HOME)} | sed 's/^/OUT ls /'; echo ran > ran.txt; echo OUT ran`;
  for (const entry of [HOME, path.dirname(HOME), '/private/var/folders', path.join('/System/Volumes/Data', HOME)]) {
    const r = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: entry }, () => runTests(f.jail, cmd, guard()));
    // First, so that without the refusal this fails on what matters: the decoy in the home was read.
    assert.ok(!r.output.includes(DECOYS['.ssh/id_x']!), `the decoy was not read (${entry}):\n${r.output}`);
    assert.equal(r.passed, false, entry);
    assert.match(r.output, /^foreman: read-only tree .* is, or contains, .*refused/, `refused, with the reason as the whole output:\n${r.output}`);
    assert.ok(r.output.includes(JSON.stringify(entry)), `the entry is named:\n${r.output}`);
    assert.deepEqual(outLines(r.output), [], `nothing ran (${entry})`);
    assert.equal(fs.existsSync(path.join(f.jail, 'ran.txt')), false, `nothing ran (${entry})`);
    const shell = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: entry }, () => sandboxedShell(f.jail, cmd).then(() => 'built', (err: Error) => err.message));
    assert.match(shell, /is, or contains, .*refused/, 'the shell runners refuse it too');
  }
  // The subtree that was meant is accepted, and opens that subtree only.
  const tools = path.join(HOME, 'ro-tools');
  fs.mkdirSync(tools);
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tools, 'note.txt'), 'RO-TOOLS-READABLE-4417\n');
  const ok = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: tools }, () => runTests(f.jail, `cat ${q(path.join(tools, 'note.txt'))}; ${cmd}`, guard()));
  assert.ok(ok.output.includes('RO-TOOLS-READABLE-4417'), ok.output);
  assert.ok(!ok.output.includes(DECOYS['.ssh/id_x']!), ok.output);
  assert.deepEqual(outLines(ok.output), ['OUT ran'], ok.output);
});

test('the profile itself keeps Foreman\'s home shut under a read-only tree that contains it (wrap refuses such a tree; this is the rule behind it)', T, async (t) => {
  const f = fixture(t);
  // wrap() no longer lets a tree that contains Foreman's home through, so the parameter is put in by hand: the
  // directory above Foreman's home is handed over read-only, as ~/src/foreman would hand over
  // ~/src/foreman/.foreman, and only the profile's rule that names Foreman's home is left to keep it shut.
  const above = path.dirname(fs.realpathSync(testHome));
  await withEnv({ ...ON, FOREMAN_SANDBOX_RO: above }, () =>
    assert.rejects(sbx.wrap('tests', { jail: f.jail, tmp: f.jail, home: f.jail }, '/usr/bin/true', []), /is, or contains, .*refused/));
  const beside = path.join(scratch(t), 'beside.txt');
  fs.writeFileSync(beside, 'BESIDE-READABLE-2291\n');
  const db = path.join(fs.realpathSync(testHome), 'foreman.db');
  const cmd =
    `cat ${q(beside)}; cat ${q(db)}; cat ${q(path.join(f.otherJail, 'notes.txt'))}; ls ${q(fs.realpathSync(testHome))} | sed 's/^/OUT ls /'; ` +
    `test -e ${q(db)} && echo OUT db stat-ok; echo x >> ${q(db)}; echo OUT db write rc=$?; echo in > inside.txt; cat inside.txt | sed 's/^/OUT jail /'`;
  const home = isolatedHome()!;
  t.after(() => {
    for (const d of home.dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const launch = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: undefined }, () =>
    sbx.wrap('tests', { jail: f.jail, tmp: home.tmp, home: home.dir, realGit: path.join(f.repo, '.git') }, '/bin/sh', ['-c', cmd]));
  const at = launch.args.indexOf('-f');
  // The same for the node install root (NODE_ROOT): nodeGiveBack refuses such a root too; the profile is the backstop.
  for (const param of ['RO_1', 'NODE_ROOT']) {
    const head = launch.args.slice(0, at).filter((a, i, all) => !(a === '-D' && all[i + 1]?.startsWith(`${param}=`)) && !(all[i - 1] === '-D' && a.startsWith(`${param}=`)));
    const args = [...head, '-D', `${param}=${above}`, ...launch.args.slice(at)];
    const lines: string[] = [];
    await spawnStreaming(launch.cmd, args, { cwd: f.jail, signal: guard(), env: { ...home.env, PATH: '/usr/bin:/bin' }, replaceEnv: true, onLine: (l) => lines.push(l) });
    const output = lines.join('\n');
    assert.ok(output.includes('BESIDE-READABLE-2291'), `${param}: precondition: the tree around Foreman's home really was readable:\n${output}`);
    assert.ok(!output.includes(DB_DECOY), `${param}: the database is not readable:\n${output}`);
    assert.ok(!output.includes('DECOY-OTHER-JAIL-3310'), `${param}: nor another run's jail:\n${output}`);
    assert.deepEqual(outLines(output), ['OUT db write rc=1', 'OUT jail in'], `${param}: no listing, no stat, no write; the run's own jail inside Foreman's home still works`);
    assert.equal(fs.readFileSync(db, 'utf8'), `${DB_DECOY}\n`);
  }
});

// ------------------------------------------------------------------------- the running node's install root

const { nodeInstall } = await import('../src/security/nodeRoot.ts');

/** cp with clonefile where the filesystem has it (APFS), a plain copy elsewhere. */
function cpTree(src: string, dst: string): void {
  try {
    execFileSync('cp', ['-Rc', src, dst], { stdio: 'ignore' });
  } catch {
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  }
}

/** The npm package directory of the running node: beside it, else the one the PATH resolves. null when there is none. */
function npmPackageDir(): string | null {
  const beside = path.join(path.dirname(path.dirname(fs.realpathSync(process.execPath))), 'lib', 'node_modules', 'npm');
  if (fs.existsSync(path.join(beside, 'package.json'))) return beside;
  for (const dir of (process.env['PATH'] ?? '').split(':').filter((d) => path.isAbsolute(d))) {
    let p: string;
    try {
      p = fs.realpathSync(path.join(dir, 'npm'));
    } catch {
      continue;
    }
    for (; p !== path.dirname(p); p = path.dirname(p)) {
      if (path.basename(p) === 'npm' && path.basename(path.dirname(p)) === 'node_modules' && fs.existsSync(path.join(p, 'package.json'))) return p;
    }
  }
  return null;
}

/**
 * A node install at `root` in the nodejs.org tarball layout that nvm, fnm and volta unpack: bin/node (the running
 * binary, with its libnode if it has one), lib/node_modules/npm, bin/npm and bin/npx. Real enough to run.
 */
function nodeInstallAt(root: string): void {
  const exe = fs.realpathSync(process.execPath);
  const npm = npmPackageDir();
  assert.ok(npm, 'precondition: an npm to copy beside node');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'node_modules'), { recursive: true });
  cpTree(exe, path.join(root, 'bin', 'node'));
  const lib = path.join(path.dirname(path.dirname(exe)), 'lib');
  for (const name of fs.existsSync(lib) ? fs.readdirSync(lib) : []) if (/^libnode\./.test(name)) cpTree(path.join(lib, name), path.join(root, 'lib', name));
  cpTree(npm, path.join(root, 'lib', 'node_modules', 'npm'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(root, 'bin', 'npm'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(root, 'bin', 'npx'));
}

/** The layout alone (an empty bin/node), for checks that never run it. */
function nodeLayoutAt(root: string, extraDirs: string[] = []): string {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'node_modules', 'npm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'node'), '');
  fs.writeFileSync(path.join(root, 'lib', 'node_modules', 'npm', 'package.json'), '{}\n');
  for (const d of extraDirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return path.join(root, 'bin', 'node');
}

const SYS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

test('nodeInstall: the nodejs.org layout is a node install; a binary outside bin/, no npm, or a root holding more than node is not', async (t) => {
  const base = scratch(t, 'fsbx-nodeinst-');
  const ok = path.join(base, 'v24.0.0');
  const r = nodeLayoutAt(ok);
  {
    assert.deepEqual(await nodeInstall(r, SYS_PATH), { exe: r, root: ok, why: null, tree: ok });
    // Homebrew's Cellar keeps npm elsewhere: accepted when the npm on PATH lives under the root.
    const brew = path.join(base, 'cellar-node');
    const b = nodeLayoutAt(brew);
    fs.rmSync(path.join(brew, 'lib', 'node_modules'), { recursive: true });
    assert.match((await nodeInstall(b, SYS_PATH)).why ?? '', /no npm/);
    fs.mkdirSync(path.join(brew, 'libexec', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(brew, 'libexec', 'bin', 'npm'), '');
    assert.equal((await nodeInstall(b, `${path.join(brew, 'libexec', 'bin')}:${SYS_PATH}`)).root, brew);
    // A prefix such as ~/.local: more than a node install.
    const local = path.join(base, 'local');
    const l = nodeLayoutAt(local, ['state', 'lib/python3.12']);
    const lw = await nodeInstall(l, SYS_PATH);
    assert.equal(lw.root, null);
    assert.match(lw.why ?? '', /state\//);
    fs.rmSync(path.join(local, 'state'), { recursive: true });
    assert.match((await nodeInstall(l, SYS_PATH)).why ?? '', /lib\/ also holds python3\.12/);
    // Everything in the root becomes readable, so every directory but bin/ holds only node's own, and the top only
    // node's own files: other programs' data under share/ (a ~/.local), anything else under include/ or etc/, a
    // stray file at the top. The tarball's own layout, Homebrew's keg files and a top-level symlink stay accepted.
    const full = path.join(base, 'tarball');
    const fe = nodeLayoutAt(full, ['include/node', 'share/doc/node', 'share/man/man1', 'share/systemtap', 'etc/bash_completion.d', 'libexec/bin', 'libexec/lib']);
    for (const name of ['CHANGELOG.md', 'LICENSE', 'README.md', 'INSTALL_RECEIPT.json', 'sbom.spdx.json', 'etc/npmrc']) fs.writeFileSync(path.join(full, name), '');
    fs.symlinkSync(base, path.join(full, 'outside-link'));
    assert.equal((await nodeInstall(fe, SYS_PATH)).root, full);
    for (const [extra, why] of [
      ['share/uv/credentials/credentials.toml', /its share\/ also holds uv/], ['include/secrets.h', /its include\/ also holds secrets\.h/],
      ['etc/passwords', /its etc\/ also holds passwords/], ['libexec/state/x', /its libexec\/ also holds state/],
      ['.env', /it also holds \.env,/], ['notes.txt', /it also holds notes\.txt,/],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(full, extra)), { recursive: true });
      fs.writeFileSync(path.join(full, extra), 'SECRET\n');
      const got = await nodeInstall(fe, SYS_PATH);
      assert.equal(got.root, null, extra);
      assert.match(got.why ?? '', why, extra);
      fs.rmSync(path.join(full, extra.split('/').slice(0, 2).join('/')), { recursive: true });
    }
    assert.equal((await nodeInstall(fe, SYS_PATH)).root, full, 'accepted again once the extras are gone');
    // Not in a bin/ directory.
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, 'node'), '');
    const lo = await nodeInstall(path.join(loose, 'node'), SYS_PATH);
    assert.deepEqual([lo.root, lo.tree], [null, base]);
    assert.match(lo.why ?? '', /not in a bin\/ directory/);
    // A symlink is followed: the root is the real one.
    const link = path.join(base, 'link-node');
    fs.symlinkSync(r, link);
    assert.equal((await nodeInstall(link, SYS_PATH)).root, ok);
  }
});

test('nodeGiveBack: Homebrew and system node add nothing; a version-manager root under the home is given back; a root that is or holds a closed tree, or sits in Foreman\'s home or the repository, is not and says why', () => {
  const inst = (root: string | null, tree: string, exe = path.join(tree, 'bin', 'node')) => ({ exe, root, why: root ? null : 'it also holds state/, which a node install does not', tree });
  const fh = '/Users/someone/.foreman';
  const closed: [string, string][] = [
    ['/', 'the filesystem root'], ['/Users', '/Users'], ['/private/var/folders', 'the per-user temp dirs'], [fh, "Foreman's home"],
    ['/Users/someone', 'your home directory'], ['/private/var/folders/xy/T', 'the temp dir the private homes live in'],
    ['/Users/someone/src/app', 'the real repository'], ['/Users/someone/src', 'the directory above the real repository'],
    ['/Users/someone/fm-work', 'the directory the jails live in'],
  ];
  const none = { root: null, note: null };
  // Homebrew (the Cellar keeps npm elsewhere, so it is not even a node-only install), /usr/local, the system: readable already.
  assert.deepEqual(sbx.nodeGiveBack(inst(null, '/opt/homebrew/Cellar/node/24.1.0'), fh, closed), none);
  assert.deepEqual(sbx.nodeGiveBack(inst('/usr/local', '/usr/local'), fh, closed), none);
  assert.deepEqual(sbx.nodeGiveBack(inst(null, '/usr', '/usr/bin/node'), fh, closed), none);
  // nvm, volta, a tarball in a temp dir, and the Data-volume spelling of the home: given back.
  for (const root of ['/Users/someone/.nvm/versions/node/v24.0.0', '/Users/someone/.volta/tools/image/node/24.0.0', '/private/var/folders/xy/T/node-v24.0.0-darwin-arm64', '/System/Volumes/Data/Users/someone/.nvm/versions/node/v24.0.0']) {
    assert.deepEqual(sbx.nodeGiveBack(inst(root, root), fh, closed), { root, note: null }, root);
  }
  const say = (root: string | null, tree: string): string => {
    const g = sbx.nodeGiveBack(inst(root, tree), fh, closed);
    assert.equal(g.root, null, tree);
    assert.match(g.note ?? '', /^sandboxed commands may not find node: .* which the sandbox closes/, tree);
    return g.note!;
  };
  assert.match(say('/Users/someone', '/Users/someone'), /was not given back: it is, or contains, (your home directory|Foreman's home) .*FOREMAN_SANDBOX_RO$/);
  assert.match(say('/Users', '/Users'), /is, or contains, \/Users/);
  assert.match(say('/private/var/folders/xy/T', '/private/var/folders/xy/T'), /the temp dir the private homes live in/);
  assert.match(say('/Users/someone/src/app/node', '/Users/someone/src/app/node'), /is inside the real repository/);
  // A jail is written by a worker: a node there is never trusted, whoever's jail it is.
  assert.match(say('/Users/someone/fm-work/r_other/node', '/Users/someone/fm-work/r_other/node'), /is inside the directory the jails live in/);
  assert.match(say('/Users/someone/.foreman/node', '/Users/someone/.foreman/node'), /inside Foreman's home .*outside FOREMAN_HOME/);
  assert.match(say(null, '/Users/someone/.local'), /does not look like a node install only \(it also holds state\/.*FOREMAN_SANDBOX_RO=\/Users\/someone\/\.local$/);
  assert.doesNotMatch(say(null, '/Users/someone'), /FOREMAN_SANDBOX_RO=/, 'never a hint to open the home');
});

test('nodeGiveBack knows every tree base.sb closes: a node install under any of them is given back, never silently left closed', () => {
  // sandbox.ts keeps its own copy of base.sb's closed list (PROFILE_CLOSED); read the profile so a tree added there
  // without its entry here fails this test instead of leaving node unreachable with nothing said.
  const baseSb = fs.readFileSync(path.join(SRC_ROOT, 'src', 'security', 'sandbox', 'base.sb'), 'utf8');
  const denyBlock = /\(deny file-read\*\n([\s\S]*?)\n;; 3\. /.exec(baseSb)?.[1] ?? '';
  const closedInProfile = [...denyBlock.matchAll(/^\s*\(subpath "([^"]+)"\)/gm)].map((m) => m[1]!);
  assert.ok(closedInProfile.length >= 15 && closedInProfile.includes('/Library/Keychains'), `the profile's closed list was found: ${closedInProfile.join(' ')}`);
  for (const tree of closedInProfile) {
    const root = path.join(tree, 'node-v24.0.0');
    assert.deepEqual(sbx.nodeGiveBack({ exe: path.join(root, 'bin', 'node'), root, why: null, tree: root }, '/nonexistent/.foreman', []), { root, note: null }, tree);
  }
});

test('the running node\'s install root under the home (nvm) or in a temp dir: node and npm start sandboxed; the rest of the home and the temp dir stay closed; the root is not writable and takes no FOREMAN_SANDBOX_RO place', T, async (t) => {
  const f = fixture(t);
  t.after(() => sbx._setSandboxSeamsForTest(null));
  const nvm = path.join(HOME, '.nvm', 'versions', 'node', 'v24.0.0');
  t.after(() => fs.rmSync(path.join(HOME, '.nvm'), { recursive: true, force: true }));
  for (const root of [nvm, path.join(scratch(t, 'fsbx-node-'), 'node-v24.0.0-darwin-arm64')]) {
    nodeInstallAt(root);
    const sibling = path.join(path.dirname(root), 'beside.txt');
    fs.writeFileSync(sibling, 'NODE-SIBLING-DECOY-8812\n');
    const planted = path.join(root, 'bin', 'planted');
    const cmd =
      `echo "OUT which $(command -v node)"; node -e 0 && echo OUT node ok; npm --version > /dev/null && echo OUT npm ok; ` +
      `cat ${q(sibling)}; cat ${q(path.join(HOME, '.ssh', 'id_x'))}; ls ${q(path.dirname(root))} | sed 's/^/OUT ls /'; ` +
      `echo x > ${q(planted)}; echo OUT write rc=$?; echo x >> ${q(path.join(root, 'bin', 'node'))}; echo OUT write node rc=$?`;
    const env = { ...ON, PATH: `${path.join(root, 'bin')}:${SYS_PATH}`, FOREMAN_SANDBOX_RO: '/opt/fsbx-a:/opt/fsbx-b:/opt/fsbx-c:/opt/fsbx-d' };
    // Control: node readable elsewhere (no give-back), so this root stays closed and `node` is not found.
    sbx._setSandboxSeamsForTest({ nodeExec: '/usr/bin/true' });
    const closed = await withEnv(env, () => runTests(f.jail, cmd, guard()));
    assert.ok(!outLines(closed.output).includes('OUT node ok'), `precondition: without the give-back node does not start:\n${closed.output}`);
    sbx._setSandboxSeamsForTest({ nodeExec: path.join(root, 'bin', 'node') });
    const w = await withEnv(env, () => sbx.wrap('tests', { jail: f.jail, tmp: f.jail, home: f.jail }, '/usr/bin/true', []));
    assert.ok(w.args.includes(`NODE_ROOT=${fs.realpathSync(root)}`), w.args.join(' '));
    assert.equal(w.args.filter((a) => /^RO_\d=/.test(a)).length, 4, 'the four FOREMAN_SANDBOX_RO places are all still the user\'s');
    const r = await withEnv(env, () => runTests(f.jail, cmd, guard()));
    assert.deepEqual(outLines(r.output), [`OUT which ${path.join(root, 'bin', 'node')}`, 'OUT node ok', 'OUT npm ok', 'OUT write rc=1', 'OUT write node rc=1'], r.output);
    assert.ok(!r.output.includes('NODE-SIBLING-DECOY-8812'), `a file beside the root stays unreadable:\n${r.output}`);
    assert.ok(!r.output.includes(DECOYS['.ssh/id_x']!), `the home stays unreadable:\n${r.output}`);
    assert.equal(fs.existsSync(planted), false, 'nothing was written into the root');
    assert.equal(await sbx.sandboxNodeNote(), null, 'nothing to say when it is given back');
  }
});

test('a node root too broad to give back (the home itself, or more than a node install) is not added, node stays closed, and doctor/serve say how to fix it', T, async (t) => {
  const f = fixture(t);
  t.after(() => sbx._setSandboxSeamsForTest(null));
  // HOME is a node install itself (bin/, lib/ and nothing else beside the decoy-free layout).
  const bare = scratch(t, 'fsbx-nodehome-');
  const bareExe = nodeLayoutAt(bare);
  fs.writeFileSync(path.join(bare, 'HOME-DECOY.txt'), 'NODE-HOME-DECOY-7731\n');
  // And a prefix that is more than node, under the fake home.
  const local = path.join(HOME, '.local');
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const localExe = nodeLayoutAt(local, ['state']);
  for (const [exe, home, want] of [
    [bareExe, bare, /is, or contains, your home directory .*FOREMAN_SANDBOX_RO$/],
    [localExe, HOME, /does not look like a node install only \(it also holds state\/.*FOREMAN_SANDBOX_RO=/],
  ] as const) {
    sbx._setSandboxSeamsForTest({ nodeExec: exe });
    const env = { ...ON, HOME: home, FOREMAN_SANDBOX_RO: undefined };
    const w = await withEnv(env, () => sbx.wrap('tests', { jail: f.jail, tmp: f.jail, home: f.jail }, '/usr/bin/true', []));
    assert.ok(!w.args.some((a) => a.startsWith('NODE_ROOT=')), w.args.join(' '));
    const note = await withEnv(env, () => sbx.sandboxNodeNote());
    assert.match(note ?? '', /^sandboxed commands may not find node: /);
    assert.match(note!, want);
    const summary = await withEnv(env, () => sbx.sandboxSummary());
    assert.deepEqual(summary.split('\n').slice(1), [`sandbox tests: ${note}`], 'one line after the status line, in doctor and at serve');
    const r = await withEnv(env, () => runTests(f.jail, `cat ${q(path.join(bare, 'HOME-DECOY.txt'))}; ls ${q(path.dirname(exe))} | sed 's/^/OUT ls /'; echo OUT ran`, guard()));
    assert.deepEqual(outLines(r.output), ['OUT ran'], r.output);
    assert.ok(!r.output.includes('NODE-HOME-DECOY-7731'), r.output);
  }
});

// ------------------------------------------------------------------------------------------ legitimate flows

/** The same command with the switch off and on: both must pass and print the same OUT lines. */
async function both(_t: TestContext, dir: () => string, cmd: string, env: Record<string, string | undefined> = {}): Promise<string[]> {
  const off = await withEnv({ ...OFF, ...env }, () => runTests(dir(), cmd, guard()));
  const on = await withEnv({ ...ON, ...env }, () => runTests(dir(), cmd, guard()));
  assert.equal(off.passed, true, `precondition: passes unsandboxed:\n${off.output}`);
  assert.equal(on.passed, true, `passes sandboxed:\n${on.output}`);
  assert.deepEqual(outLines(on.output), outLines(off.output), 'same output either way');
  assert.ok(!on.output.includes('this ran sandboxed'), 'a green run carries no sandbox note');
  return outLines(on.output);
}

const SUITE = `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
test('a server on 127.0.0.1:0 answers its own client', async () => {
  const server = http.createServer((_q, s) => s.end('pong'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const body = await (await fetch('http://127.0.0.1:' + server.address().port)).text();
  server.close();
  assert.equal(body, 'pong');
});
test('a unix socket under TMPDIR', async () => {
  const sock = path.join(os.tmpdir(), 's-' + process.pid + '.sock');
  const server = net.createServer((c) => c.end('hi'));
  await new Promise((r) => server.listen(sock, r));
  const got = await new Promise((res, rej) => { let b = ''; const c = net.connect(sock); c.on('data', (d) => (b += d)); c.on('end', () => res(b)); c.on('error', rej); });
  server.close();
  assert.equal(got, 'hi');
});
test('temp files, the home dir and the user name', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
  fs.writeFileSync(path.join(d, 'f'), '1');
  fs.writeFileSync(path.join(os.homedir(), '.suite-wrote-here'), '1');
  assert.ok(os.userInfo().username.length > 0);
  fs.writeFileSync('built.txt', 'built');
});
`;

test('flow: node --test (loopback server, unix socket under TMPDIR, temp files) and npm test pass sandboxed exactly as unsandboxed', T, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.jail, 'suite.test.mjs'), SUITE);
  fs.writeFileSync(path.join(f.jail, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', scripts: { test: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap suite.test.mjs' } }));
  const tap = `| grep -E '^# (tests|pass|fail) ' | sed 's/^/OUT /'`;
  assert.deepEqual(await both(t, () => f.jail, `set -o pipefail; env -u NODE_TEST_CONTEXT node --test --test-reporter=tap suite.test.mjs ${tap}`), ['OUT # tests 3', 'OUT # pass 3', 'OUT # fail 0']);
  assert.deepEqual(await both(t, () => f.jail, `set -o pipefail; npm test --silent ${tap}`), ['OUT # tests 3', 'OUT # pass 3', 'OUT # fail 0']);
  // A failing suite fails the same way: the exit status is the suite's, and the sandbox note comes last.
  fs.writeFileSync(path.join(f.jail, 'red.test.mjs'), `import test from 'node:test'; import assert from 'node:assert'; test('red', () => assert.equal(1, 2));\n`);
  const off = await withEnv(OFF, () => runTests(f.jail, 'env -u NODE_TEST_CONTEXT node --test red.test.mjs', guard()));
  const on = await withEnv(ON, () => runTests(f.jail, 'env -u NODE_TEST_CONTEXT node --test red.test.mjs', guard()));
  assert.deepEqual([off.passed, on.passed], [false, false]);
  assert.match(on.output.split('\n').at(-1)!, /^foreman: this ran sandboxed \(FOREMAN_SANDBOX=tests\): no network beyond loopback, no reads under \/Users except the jail\. If the suite needs a tool under your home, add it to FOREMAN_SANDBOX_RO\./);
  assert.ok(!off.output.includes('this ran sandboxed'));
});

test('flow: npx tsc --noEmit from a provisioned node_modules passes sandboxed, and reports a type error the same way', T, async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.jail, 'node_modules', '.bin'), { recursive: true });
  // The repo's own copy of the compiler, cloned (copy-on-write) like provisionDeps does.
  execFileSync('/bin/cp', ['-c', '-R', path.join(SRC_ROOT, 'node_modules', 'typescript'), path.join(f.jail, 'node_modules', 'typescript')], { killSignal: 'SIGKILL', timeout: 150_000 });
  fs.symlinkSync('../typescript/bin/tsc', path.join(f.jail, 'node_modules', '.bin', 'tsc'));
  fs.writeFileSync(path.join(f.jail, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', types: [] }, files: ['a.ts'] }));
  fs.writeFileSync(path.join(f.jail, 'a.ts'), 'export const n: number = 1;\n');
  assert.deepEqual(await both(t, () => f.jail, 'npx tsc --noEmit && echo OUT tsc ok'), ['OUT tsc ok']);
  fs.writeFileSync(path.join(f.jail, 'a.ts'), 'export const n: number = "one";\n');
  const off = await withEnv(OFF, () => runTests(f.jail, 'npx tsc --noEmit', guard()));
  const on = await withEnv(ON, () => runTests(f.jail, 'npx tsc --noEmit', guard()));
  assert.deepEqual([off.passed, on.passed], [false, false]);
  const err = (o: string): string[] => o.split('\n').filter((l) => l.includes('error TS'));
  assert.deepEqual(err(on.output), err(off.output));
  assert.equal(err(on.output).length, 1);
});

test('flow: a tool from node_modules/.bin, provisioned by provisionDeps from the cache and from the repo, is found by name and runs from inside the jail', T, async (t) => {
  // 2026-10-12: the first sandboxed gate failed with `sh: tsc: command not found` — the jail's .bin/tsc was an
  // absolute link into the deps cache, under Foreman's home, which the sandbox closes.
  const tool = (modules: string): void => {
    fs.mkdirSync(path.join(modules, 'fixtool', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'fixtool', 'package.json'), JSON.stringify({ name: 'fixtool', version: '1.0.0', bin: { fixtool: 'bin/fixtool.js' } }));
    fs.writeFileSync(path.join(modules, 'fixtool', 'bin', 'fixtool.js'), `#!/usr/bin/env node\nconsole.log('OUT fixtool ran from ' + require('node:fs').realpathSync(__filename));\n`, { mode: 0o755 });
    fs.symlinkSync('../fixtool/bin/fixtool.js', path.join(modules, '.bin', 'fixtool'));
    fs.writeFileSync(path.join(modules, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  };
  for (const source of ['cache', 'repo'] as const) {
    const f = fixture(t);
    const lock = JSON.stringify({ lockfileVersion: 3, name: 'app', nonce: path.basename(f.repo) + source });
    for (const dir of [f.repo, f.jail]) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { verify: 'fixtool' } }));
      fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    }
    const key = lockHash(path.join(f.jail, 'package-lock.json'));
    if (source === 'cache') {
      // The repo's own install is not usable (no hidden lockfile), as after a lockfile change: the cache is next.
      fs.mkdirSync(path.join(f.repo, 'node_modules'));
      tool(path.join(depsCacheRoot(), key, 'node_modules'));
      t.after(() => fs.rmSync(path.join(depsCacheRoot(), key), { recursive: true, force: true }));
    } else {
      tool(path.join(f.repo, 'node_modules'));
    }
    const deps = await withEnv({ FOREMAN_DEPS_MODE: undefined }, () => provisionDeps(f.jail, f.repo, { allowInstall: false }));
    assert.equal(deps.source, source, deps.reason);
    // By name, the way a package.json script reaches it: npm puts node_modules/.bin on the PATH.
    const out = await both(t, () => f.jail, 'npm run verify --silent');
    assert.deepEqual(out, [`OUT fixtool ran from ${path.join(f.jail, 'node_modules', 'fixtool', 'bin', 'fixtool.js')}`], `${source}: the jail's own copy ran`);
  }
});

test('flow: git status, diff and log work inside a worktree jail; a repo made inside the jail or under TMPDIR takes add and commit', T, async (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.jail, 'app.js'), 'export const two = 2;\n');
  const cmd =
    `rm -rf sub; git status --porcelain | sed 's/^/OUT status /'; git diff --stat | grep -c app.js | sed 's/^/OUT diff /'; ` +
    `git log -1 --format='OUT log %s'; git rev-parse --abbrev-ref HEAD | sed 's/^foreman.*/OUT branch foreman/'; ` +
    `mkdir sub && cd sub && git init -q -b main && echo a > a && git add -A && git commit -qm in-jail && git log -1 --format='OUT sub %s' && cd .. && ` +
    `d=$(mktemp -d) && cd "$d" && git init -q -b main && echo b > b && git add -A && git commit -qm in-tmp && git log -1 --format='OUT tmp %s %an'; cd "$OLDPWD"; rm -rf sub`;
  assert.deepEqual(await both(t, () => f.jail, cmd), [
    'OUT status  M app.js', 'OUT diff 1', 'OUT log base', 'OUT branch foreman', 'OUT sub in-jail', 'OUT tmp in-tmp Sandbox Test',
  ]);
  // What is NOT possible in a worktree jail, by design: its index and objects live in the real repo's .git.
  const before = snapshot(path.join(f.repo, '.git'));
  const add = await withEnv(ON, () => runTests(f.jail, 'git add -A && git commit -qm x', guard()));
  assert.equal(add.passed, false, 'git add in a worktree jail would write the real repo\'s .git: refused');
  assert.equal(snapshot(path.join(f.repo, '.git')), before);
});

test('flow: the private TMPDIR and HOME, python3, a C++ compile, and the environment scrubbing are as without the sandbox', T, async (t) => {
  const f = fixture(t);
  const cmd =
    `echo data > "$TMPDIR/t.txt" && cat "$TMPDIR/t.txt" | sed 's/^/OUT tmp /'; echo x > "$HOME/h.txt" && echo OUT home ok; ` +
    `echo "$HOME" > home.path; echo "$TMPDIR" > tmp.path; test -f "$HOME/.gitconfig" && echo OUT gitconfig copied; ` +
    `echo "OUT secret=[$FSBX_API_TOKEN] kept=[$FSBX_KEEP_TOKEN] plain=[$FSBX_PLAIN]"; ` +
    `python3 -c 'import os,tempfile,getpass; f=tempfile.NamedTemporaryFile(); print("OUT py", 6*7, len(getpass.getuser())>0)'; ` +
    `perl -e 'print "OUT perl ok\\n"'; date +%Y > /dev/null && echo OUT date ok; head -c 8 /dev/urandom | wc -c | sed 's/ *//;s/^/OUT urandom /'`;
  const env = { FSBX_API_TOKEN: 'DECOY-ENV-TOKEN', FSBX_KEEP_TOKEN: 'kept-value', FSBX_PLAIN: 'plain', FOREMAN_TEST_KEEP_ENV: 'FSBX_KEEP_TOKEN' };
  const lines = await both(t, () => f.jail, cmd, env);
  assert.deepEqual(lines, [
    'OUT tmp data', 'OUT home ok', 'OUT gitconfig copied', 'OUT secret=[] kept=[kept-value] plain=[plain]',
    'OUT py 42 True', 'OUT perl ok', 'OUT date ok', 'OUT urandom 8',
  ]);
  // The private dirs are the short /var/folders spelling (unix socket paths are capped at 104 bytes) and are removed.
  const home = fs.readFileSync(path.join(f.jail, 'home.path'), 'utf8').trim();
  const tmp = fs.readFileSync(path.join(f.jail, 'tmp.path'), 'utf8').trim();
  assert.ok(home.startsWith(os.tmpdir()) && tmp.startsWith(os.tmpdir()), 'TMPDIR keeps its short spelling in the environment');
  assert.equal(fs.existsSync(home) || fs.existsSync(tmp), false, 'the private HOME and TMPDIR are removed after the run');

  const hasCxx = await new Promise<boolean>((r) => execFile('/usr/bin/xcrun', ['-f', 'clang++'], { timeout: 60_000, killSignal: 'SIGKILL' }, (e) => r(!e)));
  if (!hasCxx) return t.diagnostic('no clang++ here: the C++ compile is not exercised');
  fs.writeFileSync(path.join(f.jail, 'm.cpp'), '#include <iostream>\n#include <vector>\nint main(){ std::vector<int> v{1,2,3}; std::cout << "OUT cxx " << v.size() << "\\n"; return 0; }\n');
  assert.deepEqual(await both(t, () => f.jail, 'clang++ -std=c++17 -o m m.cpp && ./m'), ['OUT cxx 3']);

  // AddressSanitizer names file:line by starting atos against the crashing program: a task read inside the sandbox.
  fs.writeFileSync(path.join(f.jail, 'heap.cpp'), '#include <cstdio>\nint main(){ int* a = new int[4]; a[4] = 7; std::printf("%d\\n", a[4]); delete[] a; return 0; }\n');
  const asan = `clang++ -g -O0 -fsanitize=address -o heap heap.cpp && { ./heap 2>&1 | grep -o 'in main heap.cpp:2' | head -1 | sed 's/^/OUT /'; true; }`;
  assert.deepEqual(await both(t, () => f.jail, asan), ['OUT in main heap.cpp:2'], 'the sanitizer report is symbolized the same');
  // …and only inside: the same tool pointed at a process outside the sandbox is refused.
  fs.writeFileSync(path.join(f.jail, 'wait.cpp'), '#include <unistd.h>\nint main(){ sleep(600); return 0; }\n');
  const built = await withEnv(OFF, () => runTests(f.jail, 'clang++ -o waitbin wait.cpp', guard()));
  assert.equal(built.passed, true, built.output);
  const outsider = spawn(path.join(f.jail, 'waitbin'), [], { stdio: 'ignore' });
  t.after(() => outsider.kill('SIGKILL'));
  const atos = `atos -p ${outsider.pid} 0x100000000 2>&1; echo OUT atos done`;
  const on = await withEnv(ON, () => runTests(f.jail, atos, guard()));
  assert.match(on.output, /cannot examine process/, on.output);
  const off = await withEnv(OFF, () => runTests(f.jail, atos, guard()));
  assert.doesNotMatch(off.output, /cannot examine process/, 'unsandboxed, the same process can be examined');
});

test('flow + attack: a suite can allocate and use its own pseudo-terminal; a terminal it did not allocate cannot be written', T, async (t) => {
  const f = fixture(t);
  // Outside the sandbox, a stand-in for the operator's terminal: holds a pty open, says its name, then reports what arrived on it.
  // It keeps reading, so a writer's close() never waits on an undrained terminal.
  const holderSrc = [
    'import os, pty, select, sys',
    'm, s = pty.openpty()',
    'print(os.ttyname(s), flush=True)',
    "got = b''",
    'while True:',
    '    r, _, _ = select.select([m, sys.stdin], [], [])',
    '    if m in r: got += os.read(m, 200)',
    '    if sys.stdin in r: break',
    "print('GOT', got, flush=True)",
  ].join('\n');
  const holder = spawn('python3', ['-c', holderSrc], { stdio: ['pipe', 'pipe', 'ignore'], killSignal: 'SIGKILL' });
  t.after(() => holder.kill('SIGKILL'));
  let held = '';
  holder.stdout!.on('data', (d: Buffer) => (held += d));
  await until(() => held.includes('\n') || holder.exitCode !== null, 'the stand-in terminal', 60_000);
  const other = held.split('\n')[0]!.trim();
  if (!/^\/dev\/ttys\d+$/.test(other)) return t.diagnostic('no python3 with pty here: pseudo-terminals are not exercised');
  fs.writeFileSync(path.join(f.jail, 'ptyprobe.py'), [
    'import os, pty, sys',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    "    os.execv('/bin/sh', ['/bin/sh', '-c', 'test -t 0 && test -t 1 && echo on-a-tty'])",
    "d = b''",
    "while b'on-a-tty' not in d:",
    '    try: c = os.read(fd, 1024)',
    '    except OSError: break',
    '    if not c: break',
    '    d += c',
    'os.waitpid(pid, 0)',
    "print('OUT own pty', 'ok' if b'on-a-tty' in d else 'FAILED')",
    'try:',
    '    o = os.open(sys.argv[1], os.O_WRONLY | os.O_NONBLOCK); os.write(o, b"INJECTED"); os.close(o); print("OUT foreign tty written")',
    'except OSError as e: print("OUT foreign tty", e.errno)',
  ].join('\n'));
  const cmd = `python3 ptyprobe.py ${other}; script -q /dev/null /bin/sh -c 'test -t 1 && echo OUT script ok' < /dev/null | grep -o 'OUT script ok'`;
  const on = await withEnv(ON, () => runTests(f.jail, cmd, guard()));
  assert.deepEqual(outLines(on.output), ['OUT own pty ok', 'OUT foreign tty 1', 'OUT script ok'], on.output);
  const off = await withEnv(OFF, () => runTests(f.jail, `python3 ptyprobe.py ${other}`, guard()));
  assert.deepEqual(outLines(off.output), ['OUT own pty ok', 'OUT foreign tty written'], 'unsandboxed, the same write reaches the other terminal');
  holder.stdin!.end();
  await until(() => held.includes('GOT'), 'the stand-in terminal to report', 60_000);
  assert.match(held, /GOT b'INJECTED'/, 'exactly one write arrived: the unsandboxed one');
});

test('file watching is off unless FOREMAN_SANDBOX_ALLOW=fsevents; with it a watcher sees its jail and not the files that live outside', T, async (t) => {
  const f = fixture(t);
  await withEnv({ FOREMAN_SANDBOX_ALLOW: 'fsevents,keychain' }, async () => {
    assert.throws(() => sbx.sandboxAllowances(), /"keychain" is not known/);
    const r = await withEnv(ON, () => runTests(f.jail, 'touch ran.txt', guard()));
    assert.match(r.output, /FOREMAN_SANDBOX_ALLOW/, 'an unknown allowance fails the run');
    assert.equal(fs.existsSync(path.join(f.jail, 'ran.txt')), false);
  });
  // Watches the whole volume, says when it is listening, and prints what it was told until `stop` appears.
  fs.writeFileSync(path.join(f.jail, 'watch.cjs'), `
    const fs = require('fs');
    const seen = new Set();
    try {
      const w = fs.watch('/', { recursive: true }, (_e, name) => { if (name && /FSBXW/.test(name)) seen.add(require('path').basename(name)); });
      w.on('error', (e) => { console.log('OUT watch error ' + e.code); });
    } catch (e) { console.log('OUT watch threw ' + e.code); }
    setTimeout(() => fs.writeFileSync('ready', '1'), 1500);
    const end = Date.now() + 60000;
    const wait = () => (fs.existsSync('stop') || Date.now() > end ? (console.log('OUT seen ' + [...seen].sort().join(',')), process.exit(0)) : setTimeout(wait, 100));
    wait();
  `);
  const outside = [path.join(HOME, 'FSBXW-home.txt'), path.join(HOME, '.ssh', 'FSBXW-key'), path.join(testHome, 'FSBXW-foreman-home.txt'), path.join(f.repo, 'FSBXW-real-repo.txt')];
  t.after(() => {
    for (const p of outside) fs.rmSync(p, { force: true });
  });
  const run = async (env: Record<string, string | undefined>): Promise<string[]> => {
    for (const n of ['ready', 'stop']) fs.rmSync(path.join(f.jail, n), { force: true });
    const done = withEnv(env, () => runTests(f.jail, 'node watch.cjs', guard()));
    // The environment is read when the run starts; what follows only waits and writes files.
    await until(() => fs.existsSync(path.join(f.jail, 'ready')), 'the watcher to listen', 90_000);
    await sleep(500);
    fs.writeFileSync(path.join(f.jail, 'FSBXW-inside.txt'), String(Date.now()));
    for (const p of outside) fs.writeFileSync(p, String(Date.now()));
    await sleep(3000);
    fs.writeFileSync(path.join(f.jail, 'stop'), '1');
    return outLines((await done).output);
  };
  const without = await run({ ...ON, FOREMAN_SANDBOX_ALLOW: undefined });
  assert.ok(!without.some((l) => l.includes('FSBXW')), `without the allowance nothing is reported: ${without.join(' | ')}`);
  assert.deepEqual(await run({ ...ON, FOREMAN_SANDBOX_ALLOW: 'fsevents' }), ['OUT seen FSBXW-inside.txt'], 'with it: the jail\'s own change, and none of the files outside');
  const off = await run({ ...OFF, FOREMAN_SANDBOX_ALLOW: undefined });
  assert.deepEqual(off, ['OUT seen FSBXW-foreman-home.txt,FSBXW-home.txt,FSBXW-inside.txt,FSBXW-key,FSBXW-real-repo.txt'], 'unsandboxed, a watcher sees them all');
});

// --------------------------------------------------------- what the wrapped run must still do, exactly as before

test('exit codes, streamed lines and the 400-line tail are the same sandboxed and not', T, async (t) => {
  const f = fixture(t);
  for (const mode of [OFF, ON]) {
    for (const code of [0, 1, 7, 127]) {
      const launch = await withEnv(mode, () => sandboxedShell(f.jail, `echo out; echo err >&2; exit ${code}`));
      const lines: string[] = [];
      try {
        assert.equal(launch.cmd, mode === ON ? '/usr/bin/sandbox-exec' : '/bin/sh');
        const got = await spawnStreaming(launch.cmd, launch.args, { cwd: f.jail, signal: guard(), env: launch.env, onLine: (l, s) => lines.push(`${s}:${l}`) });
        assert.equal(got, code, `exit ${code} comes back as ${code}`);
        assert.deepEqual(lines.sort(), ['stderr:err', 'stdout:out']);
      } finally {
        launch.done();
      }
    }
    // A command killed by a signal resolves as today: non-zero, no throw.
    const killed = await withEnv(mode, () => runTests(f.jail, 'kill -KILL $$', guard()));
    assert.equal(killed.passed, false);
    const streamed: string[] = [];
    const r = await withEnv(mode, () => runTests(f.jail, 'seq 1 450', guard(), (l) => streamed.push(l)));
    assert.equal(r.passed, true);
    assert.equal(streamed.length, 450, 'every line is streamed');
    assert.deepEqual([r.output.split('\n').length, r.output.split('\n')[0], r.output.split('\n').at(-1)], [400, '51', '450'], 'the tail keeps the last 400');
  }
});

test('a timeout kills the whole process group through sandbox-exec, including a descendant that ignores SIGTERM', { skip, timeout: 175_000 }, async (t) => {
  const f = fixture(t);
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
  // The shell starts a child that ignores SIGTERM and keeps starting sleeps; both record their pids and group.
  const cmd =
    `/bin/sh -c 'trap "" TERM; echo $$ > stubborn.pid; perl -e "print getpgrp()" > stubborn.pgid; echo OUT stubborn up; while :; do sleep 1; done' & ` +
    `echo $$ > leader.pid; echo OUT leader up; wait; sleep 600`;
  for (const mode of [OFF, ON]) {
    for (const name of ['stubborn.pid', 'stubborn.pgid', 'leader.pid']) fs.rmSync(path.join(f.jail, name), { force: true });
    let spawned: number | null = null;
    const lines: string[] = [];
    const r = await withEnv({ ...mode, FOREMAN_TEST_TIMEOUT_MIN: '0.25' }, () =>
      runTests(f.jail, cmd, guard(), (l) => lines.push(l), (pid) => { if (pid) spawned = pid; }));
    const stubborn = Number(fs.readFileSync(path.join(f.jail, 'stubborn.pid'), 'utf8'));
    const leader = Number(fs.readFileSync(path.join(f.jail, 'leader.pid'), 'utf8'));
    pids.push(stubborn, leader);
    assert.equal(r.passed, false);
    assert.match(r.output, /foreman: test command timed out after .* and was killed \(FOREMAN_TEST_TIMEOUT_MIN\)/);
    assert.ok(lines.includes('OUT stubborn up') && lines.includes('OUT leader up'), 'output before the kill was streamed');
    assert.equal(leader, spawned, 'the pid Foreman records IS the command (sandbox-exec execs it; no extra process in between)');
    assert.equal(Number(fs.readFileSync(path.join(f.jail, 'stubborn.pgid'), 'utf8')), spawned, 'and the descendant is in its process group');
    await until(() => !alive(stubborn) && !alive(leader), `the SIGTERM-ignoring descendant to die (${mode === ON ? 'sandboxed' : 'plain'})`, 30_000);
    if (mode === ON) assert.match(r.output.split('\n').at(-1)!, /this ran sandboxed/);
  }
});

test('an abort (the operator cancels) kills a sandboxed shell ticket\'s whole group too', T, async (t) => {
  const f = fixture(t);
  const ac = new AbortController();
  const launch = await withEnv(ON, () => sandboxedShell(f.jail, `/bin/sh -c 'trap "" TERM; echo $$ > stubborn2.pid; echo OUT up; while :; do sleep 1; done' & wait`));
  let stubborn = 0;
  t.after(() => {
    launch.done();
    if (stubborn) {
      try {
        process.kill(stubborn, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
  const done = spawnStreaming(launch.cmd, launch.args, {
    cwd: f.jail, signal: AbortSignal.any([ac.signal, guard()]), env: launch.env,
    onLine: (l) => { if (l === 'OUT up') ac.abort(); },
  });
  const code = await done;
  stubborn = Number(fs.readFileSync(path.join(f.jail, 'stubborn2.pid'), 'utf8'));
  assert.notEqual(code, 0);
  await until(() => !alive(stubborn), 'the descendant to die', 30_000);
});

test('an abort also reaps a sandboxed descendant that left the command\'s process group and ignores SIGTERM', T, async (t) => {
  const f = fixture(t);
  const ac = new AbortController();
  // perl makes its own group (as `detached: true` or setsid would), records pid and group, ignores SIGTERM. The group
  // signal to the command cannot reach it: the unsandboxed reaper has to find it under sandbox-exec in the process table.
  const cmd =
    `perl -e 'setpgrp(0,0); $SIG{TERM}="IGNORE"; open(F,">own.tmp"); print F "$$ ".getpgrp(); close F; rename("own.tmp","own.pid"); sleep 600' & ` +
    `while [ ! -s own.pid ]; do sleep 0.1; done; echo "OUT up $(cat own.pid)"; wait`;
  const launch = await withEnv(ON, () => sandboxedShell(f.jail, cmd));
  let own = 0;
  let ownGroup = 0;
  t.after(() => {
    launch.done();
    if (own) {
      try {
        process.kill(own, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
  let spawned = 0;
  const code = await spawnStreaming(launch.cmd, launch.args, {
    cwd: f.jail, signal: AbortSignal.any([ac.signal, guard()]), env: launch.env,
    onSpawn: (pid) => { if (pid) spawned = pid; },
    // The pid is noted before the abort, so a descendant that outlives a failing run is still cleaned up below.
    onLine: (l) => {
      const m = /^OUT up (\d+) (\d+)$/.exec(l);
      if (!m) return;
      [own, ownGroup] = [Number(m[1]), Number(m[2])];
      ac.abort();
    },
  });
  const [pid, pgid] = [own, ownGroup];
  assert.ok(pid > 1, 'the descendant started');
  assert.notEqual(code, 0);
  assert.equal(pgid, pid, 'precondition: the descendant leads a group of its own');
  assert.notEqual(pgid, spawned, 'which is not the command\'s group');
  await until(() => !alive(pid), 'the own-group descendant to die', 60_000);
});

// ------------------------------------------------------------------------------------------- the other callers

function runnerCtx(dir: string, prompt: string, logs: string[], broker?: Broker): RunnerContext {
  return {
    task: { id: 't_sbx', title: 'sbx', prompt, repairNotes: null, kind: 'code', runner: 'shell', agent: null, sensitivity: 'S1' } as unknown as Task,
    runId: 'r_sbx', dir, signal: guard(), broker: broker as Broker,
    stage() {}, child() {}, session() {}, log: (l: string) => logs.push(l), progress() {}, usage() {},
  } as unknown as RunnerContext;
}

test('the shell runner: the ticket\'s command is confined to its jail, and keeps its exit code and output', T, async (t) => {
  const f = fixture(t);
  const pwned = path.join(HOME, 'shell-pwned.txt');
  t.after(() => fs.rmSync(pwned, { force: true }));
  const prompt = `echo made > made.txt; echo x > ${q(pwned)}; echo x > ${q(path.join(f.repo, '.git', 'hooks', 'x'))}; cat ${q(path.join(HOME, '.ssh', 'id_x'))}; echo "OUT home=$HOME"; exit 3`;
  const logs: string[] = [];
  const on = await withEnv(ON, () => shellRunner.run(runnerCtx(f.jail, prompt, logs)));
  assert.deepEqual([on.ok, on.exitCode], [false, 3]);
  assert.equal(fs.readFileSync(path.join(f.jail, 'made.txt'), 'utf8'), 'made\n');
  assert.equal(fs.existsSync(pwned), false);
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'hooks', 'x')), false);
  assert.ok(!logs.join('\n').includes(DECOYS['.ssh/id_x']!));
  const home = logs.find((l) => l.startsWith('OUT home='))!.slice(9);
  assert.notEqual(home, HOME, 'it has a private HOME');
  assert.equal(fs.existsSync(home), false, 'removed afterwards');

  const offLogs: string[] = [];
  const off = await withEnv(OFF, () => shellRunner.run(runnerCtx(f.jail, prompt, offLogs)));
  assert.deepEqual([off.ok, off.exitCode], [false, 3]);
  assert.equal(fs.existsSync(pwned), true, 'unsandboxed, the same ticket writes the home');
  assert.ok(offLogs.includes(`OUT home=${HOME}`), 'and with the switch off its HOME is the daemon\'s, as before');
  fs.rmSync(path.join(f.repo, '.git', 'hooks', 'x'), { force: true });

  // A sandbox that cannot start: the ticket fails with the reason and the command does not run.
  sbx._setSandboxSeamsForTest({ exec: path.join(f.jail, 'no-such-sandbox-exec') });
  t.after(() => sbx._setSandboxSeamsForTest(null));
  const refused = await withEnv(ON, () => shellRunner.run(runnerCtx(f.jail, 'echo x > should-not-exist.txt', [])));
  sbx._setSandboxSeamsForTest(null);
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /not run: .*FOREMAN_SANDBOX=off/);
  assert.equal(fs.existsSync(path.join(f.jail, 'should-not-exist.txt')), false);
});

test('the api runner\'s run_shell: a command the model wrote is confined to the jail', T, async (t) => {
  const { Store } = await import('../src/queue.ts');
  const f = fixture(t);
  const pwned = path.join(HOME, 'api-pwned.txt');
  t.after(() => fs.rmSync(pwned, { force: true }));
  fs.writeFileSync(path.join(f.jail, 'step.sh'), `echo made > made-by-model.txt\necho x > ${q(pwned)}\ncat ${q(path.join(HOME, '.aws', 'credentials'))}\necho OUT step done\n`);
  const run = async (): Promise<string> => {
    let calls = 0;
    const seen: string[] = [];
    const broker = {
      call: async (req: { messages: { role: string; content: string }[] }) => {
        calls++;
        seen.push(req.messages.at(-1)!.content);
        const reply = calls === 1 ? { tool: 'run_shell', command: 'sh step.sh' } : { tool: 'done', summary: 'did it' };
        return { text: JSON.stringify(reply), tokensIn: 0, tokensOut: 0, costUsd: 0, spec: { alias: 'stub', model: 'stub' } };
      },
    } as unknown as Broker;
    const store = new Store(':memory:');
    try {
      const ctx = runnerCtx(f.jail, 'do it', [], broker);
      (ctx as { task: Task }).task = store.addTask({ title: 'sbx', prompt: 'do it', runner: 'api', kind: 'code' });
      await apiRunner.run(ctx);
    } finally {
      store.close();
    }
    return seen.join('\n');
  };
  const on = await withEnv(ON, run);
  assert.match(on, /exit 0/);
  assert.ok(on.includes('OUT step done'), on);
  assert.equal(fs.existsSync(path.join(f.jail, 'made-by-model.txt')), true);
  assert.equal(fs.existsSync(pwned), false, 'the home was not written');
  assert.ok(!on.includes(DECOYS['.aws/credentials']!), 'the decoy credential never reached the model');
  const off = await withEnv(OFF, run);
  assert.equal(fs.existsSync(pwned), true, 'unsandboxed, the same command writes the home');
  assert.ok(off.includes(DECOYS['.aws/credentials']!));
});

test('the api runner\'s use_tool: a catalog tool is confined to the jail like run_shell — it cannot write the real repo\'s .git or read the home, and can read its own toolbox', T, async (t) => {
  const { Store } = await import('../src/queue.ts');
  const { registerTool, getTool } = await import('../src/tools/catalog.ts');
  const { runTool } = await import('../src/tools/run.ts');
  const f = fixture(t);
  // A catalog of its own, outside Foreman's home, as the tracked toolbox is. The tool takes every path as an argument.
  const catalog = scratch(t, 'fsbx-toolbox-');
  const src = scratch(t, 'fsbx-toolsrc-');
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
    name: 'poke', description: 'writes and reads the paths it is given', runtime: 'node', entry: 'tool.js',
    input: { type: 'object', properties: { write: { type: 'array', items: { type: 'string' } }, read: { type: 'array', items: { type: 'string' } } }, required: ['write', 'read'] },
    output: { type: 'object' },
  }));
  fs.writeFileSync(path.join(src, 'data.txt'), 'TOOLBOX-DATA-READABLE-6093\n');
  fs.writeFileSync(path.join(src, 'tool.js'), `
const fs = require('node:fs');
const path = require('node:path');
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const args = JSON.parse(raw);
  const out = { wrote: [], read: [], home: process.env.HOME, own: fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8').trim() };
  for (const p of args.write) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, 'poked\\n'); out.wrote.push(p); } catch { /* refused */ } }
  for (const p of args.read) { try { out.read.push(fs.readFileSync(p, 'utf8').trim()); } catch { /* refused */ } }
  process.stdout.write(JSON.stringify(out));
});
`);
  const inJail = path.join(f.jail, 'made-by-tool.txt');
  const targets = {
    write: [path.join(f.repo, '.git', 'hooks', 'pre-commit'), path.join(f.repo, '.git', 'refs', 'heads', 'main'), path.join(f.repo, '.git', 'config'), path.join(HOME, 'tool-pwned.txt'), path.join(catalog, 'poke', 'tool.js'), inJail],
    read: [path.join(HOME, '.ssh', 'id_x'), path.join(HOME, '.aws', 'credentials'), path.join(fs.realpathSync(testHome), 'foreman.db')],
  };
  t.after(() => fs.rmSync(path.join(HOME, 'tool-pwned.txt'), { force: true }));
  const prevDir = process.env['FOREMAN_TOOLS_DIR'];
  process.env['FOREMAN_TOOLS_DIR'] = catalog;
  t.after(() => {
    if (prevDir === undefined) delete process.env['FOREMAN_TOOLS_DIR'];
    else process.env['FOREMAN_TOOLS_DIR'] = prevDir;
  });
  registerTool({ sourceDir: src });
  const toolSource = fs.readFileSync(path.join(catalog, 'poke', 'tool.js'), 'utf8');

  /** One api-runner session whose model calls the tool once; what the model was shown is returned. */
  const session = async (): Promise<string> => {
    let calls = 0;
    const seen: string[] = [];
    const broker = {
      call: async (req: { messages: { role: string; content: string }[] }) => {
        calls++;
        seen.push(req.messages.at(-1)!.content);
        const reply = calls === 1 ? { tool: 'use_tool', name: 'poke', args: targets } : { tool: 'done', summary: 'did it' };
        return { text: JSON.stringify(reply), tokensIn: 0, tokensOut: 0, costUsd: 0, spec: { alias: 'stub', model: 'stub' } };
      },
    } as unknown as Broker;
    const store = new Store(':memory:');
    try {
      const ctx = runnerCtx(f.jail, 'do it', [], broker);
      (ctx as { task: Task }).task = store.addTask({ title: 'sbx', prompt: 'do it', runner: 'api', kind: 'code' });
      await apiRunner.run(ctx);
    } finally {
      store.close();
    }
    return seen.join('\n');
  };

  const before = snapshot(f.repo);
  const on = await withEnv(ON, session);
  assert.match(on, /tool poke ok/, on);
  assert.equal(snapshot(f.repo), before, 'the real repository, .git included, is byte-identical');
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.mainSha);
  assert.ok(!/DECOY-/.test(on), `no decoy reached the model:\n${on}`);
  assert.equal(fs.existsSync(path.join(HOME, 'tool-pwned.txt')), false, 'the home was not written');
  assert.equal(fs.readFileSync(path.join(catalog, 'poke', 'tool.js'), 'utf8'), toolSource, 'the toolbox is readable, not writable');
  assert.ok(on.includes('TOOLBOX-DATA-READABLE-6093'), 'the tool read a file beside itself in the toolbox');
  assert.equal(fs.readFileSync(inJail, 'utf8'), 'poked\n', 'and wrote its jail');
  const line = on.split('\n').find((l) => l.startsWith('{"wrote"'));
  assert.ok(line, `the tool's output reached the model:\n${on}`);
  const shown = JSON.parse(line) as { wrote: string[]; read: string[]; home: string };
  assert.deepEqual(shown.wrote, [inJail], 'only the write inside the jail landed');
  assert.deepEqual(shown.read, []);
  assert.notEqual(shown.home, HOME, 'it ran with a private HOME');
  assert.equal(fs.existsSync(shown.home), false, 'removed afterwards');
  assert.equal(getTool('poke')!.stats.failures, 0);

  // A sandbox that cannot be built refuses the call: the tool is not run plain, and it is not a strike against the tool.
  fs.rmSync(inJail);
  const refused = await withEnv({ ...ON, FOREMAN_SANDBOX_RO: HOME }, session);
  assert.match(refused, /tool poke failed: refused: read-only tree .* is, or contains, /, refused);
  assert.equal(fs.existsSync(inJail), false, 'nothing ran');
  assert.ok(!/DECOY-/.test(refused), refused);
  sbx._setSandboxSeamsForTest({ exec: path.join(f.jail, 'no-such-sandbox-exec') });
  t.after(() => sbx._setSandboxSeamsForTest(null));
  const broken = await withEnv(ON, () => runTool(getTool('poke')!, targets, { cwd: f.jail }));
  sbx._setSandboxSeamsForTest(null);
  assert.equal(broken.ok, false);
  assert.match(broken.error!, /^refused: .*FOREMAN_SANDBOX=off/);
  assert.equal(fs.existsSync(inJail), false, 'nothing ran');
  // A toolbox inside Foreman's home cannot be given back to a sandbox: refused as well, never run unconfined.
  const inHome = path.join(fs.realpathSync(testHome), 'fsbx-toolbox-in-home');
  fs.cpSync(catalog, inHome, { recursive: true });
  t.after(() => fs.rmSync(inHome, { recursive: true, force: true }));
  process.env['FOREMAN_TOOLS_DIR'] = inHome;
  const homed = await withEnv(ON, () => runTool(getTool('poke')!, targets, { cwd: f.jail }));
  process.env['FOREMAN_TOOLS_DIR'] = catalog;
  assert.match(homed.error ?? '', /^refused: read-only tree .* is inside Foreman's home/);
  assert.equal(fs.existsSync(inJail), false, 'nothing ran');
  assert.equal(getTool('poke')!.stats.failures, 0, 'a refusal is not the tool\'s failure');
  assert.equal(snapshot(f.repo), before);

  // The control: with the switch off the same call does all of it, so the sandbox is what stopped it.
  const off = await withEnv(OFF, session);
  assert.match(off, /tool poke ok/, off);
  assert.ok(off.includes(DECOYS['.ssh/id_x']!), 'unsandboxed, the tool reads the decoy');
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'hooks', 'pre-commit')), true, 'and writes the real repo\'s .git');
  assert.equal(fs.existsSync(path.join(HOME, 'tool-pwned.txt')), true);
});

test('the post-merge check: the scratch checkout\'s suite reads the real .git and cannot write it', T, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'check.sh'), `git log -1 --format='OUT log %s'\ngit status --porcelain | wc -l | sed 's/ *//;s/^/OUT dirty /'\necho x > "$1/.git/hooks/post-merge"\necho "OUT hook rc=$?"\necho built > built.txt\n`);
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-qm', 'with check');
  const check = await withEnv({ ...ON, FOREMAN_DEPS_MODE: 'off' }, () => checkMain(f.repo, `sh check.sh ${q(f.repo)}; echo OUT end`));
  assert.equal(check.ok, true, check.tail);
  assert.deepEqual(outLines(check.tail), ['OUT log with check', 'OUT dirty 0', 'OUT hook rc=1', 'OUT end']);
  assert.equal(fs.existsSync(path.join(f.repo, '.git', 'hooks', 'post-merge')), false);
  const off = await withEnv({ ...OFF, FOREMAN_DEPS_MODE: 'off' }, () => checkMain(f.repo, `sh check.sh ${q(f.repo)}; echo OUT end`));
  assert.ok(outLines(off.tail).includes('OUT hook rc=0'), 'unsandboxed, the check can plant a hook in the real repo');
  fs.rmSync(path.join(f.repo, '.git', 'hooks', 'post-merge'), { force: true });

  // The git directory is named by Foreman from the REAL repo, not worked out from the checkout: a repo whose git
  // directory is not `<repo>/.git` (here: --separate-git-dir) cannot be worked out, and its check still reads it.
  const sep = path.join(HOME, 'Projects', `sep-${path.basename(f.repo)}`);
  const store = path.join(HOME, 'Projects', `sep-store-${path.basename(f.repo)}.git`);
  t.after(() => {
    for (const d of [sep, store]) fs.rmSync(d, { recursive: true, force: true });
  });
  fs.mkdirSync(sep, { recursive: true });
  git(sep, 'init', '-q', '-b', 'main', `--separate-git-dir=${store}`);
  fs.writeFileSync(path.join(sep, 'a.txt'), 'a\n');
  git(sep, 'add', '-A');
  git(sep, 'commit', '-qm', 'separate store');
  const sepCheck = await withEnv({ ...ON, FOREMAN_DEPS_MODE: 'off' }, () => checkMain(sep, `git log -1 --format='OUT log %s'; echo x > ${q(path.join(store, 'hooks', 'x'))}; echo OUT end`));
  assert.deepEqual(outLines(sepCheck.tail), ['OUT log separate store', 'OUT end'], sepCheck.tail);
  assert.equal(fs.existsSync(path.join(store, 'hooks', 'x')), false);
});

// ------------------------------------------------------- the verify slot: leased outside, the suite runs inside

test('the slot wrapper end to end: the lease is taken from the live daemon by the unsandboxed wrapper, and the suite it then runs is sandboxed', { skip, timeout: 175_000 }, async (t) => {
  const { Store } = await import('../src/queue.ts');
  const { Scheduler } = await import('../src/scheduler.ts');
  const { createServer } = await import('../src/server.ts');
  const { verifySlotStats } = await import('../src/verify/slots.ts');
  const f = fixture(t);
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let child: ChildProcess | null = null;
  t.after(async () => {
    child?.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
  });
  const pwned = path.join(HOME, 'slot-pwned.txt');
  t.after(() => fs.rmSync(pwned, { force: true }));
  // The "suite": asks the daemon for the task list (the control port), writes outside, then holds until released.
  fs.writeFileSync(path.join(f.jail, 'suite.cjs'), `
    const fs = require('fs'), net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: ${port} });
    const next = (r) => {
      console.log('OUT control ' + r);
      try { fs.writeFileSync(${JSON.stringify(pwned)}, 'x'); console.log('OUT outside written'); } catch (e) { console.log('OUT outside ' + e.code); }
      fs.writeFileSync('ran.txt', 'ran');
      const wait = () => (fs.existsSync('go') ? process.exit(0) : setTimeout(wait, 50));
      wait();
    };
    s.on('connect', () => next('connected'));
    s.on('error', (e) => next(e.code));
  `);
  const wrapperPath = path.join(SRC_ROOT, 'src', 'verify', 'testSlot.ts');
  let stdout = '';
  let stderr = '';
  const env = { ...process.env, FOREMAN_HOME: testHome, FOREMAN_HOST: '127.0.0.1', FOREMAN_PORT: String(port), FOREMAN_WORKER_TEST_CMD: 'node suite.cjs' };
  delete (env as Record<string, string | undefined>)['FOREMAN_SANDBOX']; // the default: tests
  child = spawn(process.execPath, [wrapperPath], { cwd: f.jail, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  child.stdout!.on('data', (d: Buffer) => (stdout += d));
  child.stderr!.on('data', (d: Buffer) => (stderr += d));
  const exit = new Promise<number | null>((r) => child!.on('exit', (code) => r(code)));

  await until(() => fs.existsSync(path.join(f.jail, 'ran.txt')), `the suite to start:\n${stderr}\n${stdout}`, 150_000);
  assert.deepEqual(verifySlotStats(), { active: 1, waiting: 0 }, 'the daemon holds one slot for it while it runs');
  fs.writeFileSync(path.join(f.jail, 'go'), '');
  assert.equal(await exit, 0, `${stderr}\n${stdout}`);
  assert.match(stderr, /testSlot: slot held after \d+s; running node suite\.cjs/, 'the lease was granted over the live protocol');
  assert.match(stderr, /testSlot: node suite\.cjs PASSED/);
  assert.ok(stdout.includes('OUT control EPERM'), `inside, the control port is closed:\n${stdout}`);
  assert.ok(stdout.includes('OUT outside EPERM'), stdout);
  assert.equal(fs.existsSync(pwned), false);
  await until(() => verifySlotStats().active === 0, 'the slot to be released');
});

test('already inside a sandbox: runTests does not try to nest, runs the command plain and stays green; the start-up check passes', T, async (t) => {
  const f = fixture(t);
  const home = isolatedHome()!;
  t.after(() => {
    for (const d of home.dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(f.jail, 'inner.mjs'), `
    process.env.FOREMAN_HOME = ${JSON.stringify(testHome)};
    const sbx = await import(${JSON.stringify(path.join(SRC_ROOT, 'src/security/sandbox.ts'))});
    const { runTests } = await import(${JSON.stringify(path.join(SRC_ROOT, 'src/verify/tests.ts'))});
    console.log('OUT available ' + await sbx.sandboxAvailable());
    console.log('OUT selftest ' + await sbx.selfTest());
    const r = await runTests(process.cwd(), 'echo inner > inner.txt && echo OUT inner ran', AbortSignal.timeout(100000));
    console.log(r.output);
    console.log('OUT passed ' + r.passed);
  `);
  // The outer sandbox is the real one, with Foreman's source readable (as a self-task's slot wrapper would need).
  const launch = await withEnv(ON, () => sbx.wrapChecked('tests', { jail: f.jail, tmp: home.tmp, home: home.dir, readOnly: [SRC_ROOT] }, process.execPath, ['inner.mjs']));
  const lines: string[] = [];
  const env = { ...home.env, PATH: process.env['PATH'] ?? '' };
  const code = await spawnStreaming(launch.cmd, launch.args, { cwd: f.jail, signal: guard(), env, replaceEnv: true, onLine: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(lines.filter((l) => l.startsWith('OUT ')), ['OUT available nested', 'OUT selftest null', 'OUT inner ran', 'OUT passed true'], lines.join('\n'));
  assert.equal(fs.readFileSync(path.join(f.jail, 'inner.txt'), 'utf8'), 'inner\n');
});

// --------------------------------------------------------------------------- through the scheduler's own call sites

test('a shell ticket through the scheduler: its command and its test command both run confined, and the ticket still reaches the gate', { skip, timeout: 175_000 }, async (t) => {
  const { Store } = await import('../src/queue.ts');
  const { Scheduler } = await import('../src/scheduler.ts');
  const f = fixture(t);
  const pw = (n: string): string => path.join(HOME, `sched-${n}.txt`);
  t.after(() => {
    for (const n of ['work', 'test']) fs.rmSync(pw(n), { force: true });
  });
  const store = new Store(':memory:');
  const sched = new Scheduler(store, {
    maxWorkers: 1, tickMs: 5,
    verify: async ({ task, runId }) => store.addVerdict({ runId, taskId: task.id, verdict: 'pass', disagreement: false, council: [] }),
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const attempt = (n: string): string =>
    `echo x > ${q(pw(n))}; echo ${f.otherSha} > ${q(path.join(f.repo, '.git', 'refs', 'heads', 'main'))}; git update-ref refs/heads/main ${f.otherSha}; true`;
  const task = await withEnv({ ...ON, FOREMAN_DEPS_MODE: 'off', FOREMAN_POSTMERGE_CHECK: 'off' }, async () => {
    const added = store.addTask({
      title: 'sandboxed shell ticket', kind: 'code', runner: 'shell', repo: f.repo,
      prompt: `echo 'export const three = 3;' >> app.js; ${attempt('work')}`,
      testCmd: `${attempt('test')}; grep -q three app.js && git rev-parse HEAD > /dev/null`,
    });
    await sched.drain(150_000);
    return store.getTask(added.id)!;
  });
  assert.equal(task.status, 'awaiting-approval', task.error ?? store.eventsForTask(task.id).map((e) => e.message).join('\n'));
  assert.equal(store.latestRun(task.id)!.testsPassed, true, 'the test command ran, saw the work and could use git in the jail');
  assert.equal(fs.existsSync(pw('work')) || fs.existsSync(pw('test')), false, 'neither the ticket\'s command nor its test command wrote the home');
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.mainSha, 'and neither moved the real main');
});

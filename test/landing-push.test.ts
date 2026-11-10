import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pinnedGit } from '../src/gitExec.ts';
import { Landing, type LandingMapping } from '../src/landing/config.ts';
import { FORGE_TARGET_REF, ForgeMirror, IMPORTED_REF, MirrorError, mirrorPath } from '../src/landing/push.ts';

// Commits cross between a task repo and the forge only through a Foreman-owned mirror (src/landing/push.ts). The task
// repo's .git/config is writable from a jail, and PINNED does not pin url.*.insteadOf: any fetch or push run there can
// be pointed at another repository. These tests set that rewrite for both the forge and the mirror.

const TOKEN = 'glpat-push-test-Zq81';
const TOKEN_B64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commit(work: string, file: string): string {
  fs.writeFileSync(path.join(work, file), `${file}\n`);
  git(work, 'add', file);
  git(work, 'commit', '-q', '-m', `add ${file}`);
  return git(work, 'rev-parse', 'HEAD');
}

interface Fixture {
  home: string;
  /** The forge's bare repo (the pushUrl), with main. */
  forge: string;
  /** The task repo: main as the forge has it, and the reviewed tip on a task branch. */
  repo: string;
  /** A repo the worker controls. */
  attacker: string;
  target: string;
  tip: string;
  attackerSha: string;
  map: LandingMapping;
}

function fixture(): Fixture {
  const home = scratchDir('landing-push-home-');
  const forge = path.join(scratchDir('landing-push-forge-'), 'app.git');
  git(path.dirname(forge), 'init', '-q', '--bare', '-b', 'main', forge);
  const repo = fs.realpathSync(scratchDir('landing-push-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  const target = commit(repo, 'base.txt');
  git(repo, 'push', '-q', forge, 'main:refs/heads/main');
  git(repo, 'checkout', '-q', '-b', 'foreman/task');
  const tip = commit(repo, 'feature.txt');
  git(repo, 'checkout', '-q', 'main');
  const attacker = path.join(scratchDir('landing-push-attacker-'), 'evil.git');
  git(path.dirname(attacker), 'init', '-q', '--bare', '-b', 'main', attacker);
  const evilWork = scratchDir('landing-push-evil-');
  git(evilWork, 'init', '-q', '-b', 'main');
  const attackerSha = commit(evilWork, 'evil.txt');
  git(evilWork, 'push', '-q', attacker, 'main:refs/heads/main');
  const map: LandingMapping = {
    repo, mode: 'mr', forge: 'gitlab', baseUrl: 'http://127.0.0.1:9', project: 'group/app', pushUrl: forge,
    targetBranch: 'main', requirePipeline: true,
  };
  return { home, forge, repo, attacker, target, tip, attackerSha, map };
}

/** What a worker can write: the task repo's config sends both the forge and the mirror to the attacker. */
function poison(f: Fixture): void {
  git(f.repo, 'config', `url.${f.attacker}.insteadOf`, f.forge);
  git(f.repo, 'config', '--add', `url.${f.attacker}.insteadOf`, mirrorPath(f.home, f.repo));
}

const refs = (bare: string): string => git(bare, 'for-each-ref', '--format=%(objectname) %(refname)');

/**
 * Every git Foreman spawns while `run` runs, as [directory, ...argv], through a logging wrapper first on PATH; `config`
 * is the GIT_CONFIG_* environment those calls carried.
 */
async function spawned(t: TestContext, run: () => Promise<void>): Promise<{ argv: string[][]; config: string }> {
  const bin = scratchDir('landing-push-bin-');
  const log = path.join(bin, 'argv.log');
  const envLog = path.join(bin, 'env.log');
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `{ printf '%s' "$(pwd -P)"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> '${log}'`,
    `env | grep '^GIT_CONFIG_' >> '${envLog}'`,
    `exec '${REAL_GIT}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const before = process.env['PATH'];
  process.env['PATH'] = `${bin}${path.delimiter}${before ?? ''}`;
  t.after(() => { process.env['PATH'] = before; });
  try {
    await run();
  } finally {
    process.env['PATH'] = before;
  }
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { argv: read(log).split('\n').filter(Boolean).map((l) => l.split('\x1f')), config: read(envLog) };
}

test('the threat: pinned git in the task repo follows the worker\'s insteadOf for the forge and for a mirror', async () => {
  const f = fixture();
  const mirror = mirrorPath(f.home, f.repo);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  git(path.dirname(mirror), 'init', '-q', '--bare', mirror);
  git(f.repo, 'push', '-q', mirror, 'main:refs/heads/main');
  poison(f);
  await pinnedGit(f.repo, ['push', '--quiet', f.forge, `${f.tip}:refs/heads/foreman/t_1`]);
  assert.match(refs(f.attacker), new RegExp(`${f.tip} refs/heads/foreman/t_1`), 'a naive push landed in the attacker repo');
  assert.doesNotMatch(refs(f.forge), /foreman\/t_1/);
  await pinnedGit(f.repo, ['fetch', '--quiet', mirror, '+refs/heads/main:refs/foreman/naive']);
  assert.equal(git(f.repo, 'rev-parse', 'refs/foreman/naive'), f.attackerSha, 'a naive fetch from the mirror brought the attacker commit');
});

test('with both rewrites set, fetchTarget, pushReviewed and importCommit use the real forge and the real mirror', async (t) => {
  const f = fixture();
  poison(f);
  const m = new ForgeMirror(f.home, f.map, null);
  const { argv: calls } = await spawned(t, async () => {
    assert.equal(await m.fetchTarget(), f.target);
    assert.equal(git(f.repo, 'rev-parse', FORGE_TARGET_REF), f.target);
    await m.pushReviewed(f.tip, 't_1');
    // The forge moves on (what a merged MR does); the mirror learns it and hands the commit over.
    const work = scratchDir('landing-push-merge-');
    git(work, 'clone', '-q', f.forge, '.');
    const merged = commit(work, 'later.txt');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(m.dir, 'fetch', '-q', f.forge, '+refs/heads/main:refs/test/merged');
    assert.throws(() => git(f.repo, 'cat-file', '-e', merged));
    await m.importCommit(merged);
    assert.equal(git(f.repo, 'rev-parse', IMPORTED_REF), merged);
    assert.equal(git(f.repo, 'log', '-1', '--format=%s', IMPORTED_REF), 'add later.txt');
  });
  assert.equal(refs(f.attacker), `${f.attackerSha} refs/heads/main`, 'the attacker repo received nothing');
  assert.match(refs(f.forge), new RegExp(`${f.tip} refs/heads/foreman/t_1`));
  const inRepo = calls.filter(([dir]) => dir === f.repo);
  assert.ok(inRepo.length > 0, 'the wrapper saw git run in the task repo');
  for (const [, ...argv] of inRepo) {
    for (const word of ['fetch', 'push', 'pull', 'ls-remote', 'remote']) assert.ok(!argv.includes(word), `task repo ran: git ${argv.join(' ')}`);
  }
});

test('the mirror is made once, and later calls reuse it', async () => {
  const f = fixture();
  const a = new ForgeMirror(f.home, f.map, null);
  assert.equal(await a.fetchTarget(), f.target);
  const head = fs.statSync(path.join(a.dir, 'HEAD')).ino;
  const b = new ForgeMirror(f.home, f.map, null);
  assert.equal(b.dir, a.dir);
  assert.equal(await b.fetchTarget(), f.target);
  assert.equal(fs.statSync(path.join(a.dir, 'HEAD')).ino, head);
});

test('two pushes for different tasks in one repo do not interfere', async () => {
  const f = fixture();
  git(f.repo, 'checkout', '-q', '-b', 'foreman/other', f.target);
  const other = commit(f.repo, 'other.txt');
  const m = new ForgeMirror(f.home, f.map, null);
  await m.fetchTarget();
  await Promise.all([m.pushReviewed(f.tip, 't_1'), m.pushReviewed(other, 't_2')]);
  assert.match(refs(f.forge), new RegExp(`${f.tip} refs/heads/foreman/t_1`));
  assert.match(refs(f.forge), new RegExp(`${other} refs/heads/foreman/t_2`));
});

test('a branch outside refs/heads/foreman/ is refused before anything is pushed', async () => {
  const f = fixture();
  const m = new ForgeMirror(f.home, f.map, null);
  for (const id of ['../main', 'x:refs/heads/main', '', '-f', 'a/b', 'a..b']) {
    await assert.rejects(m.pushReviewed(f.tip, id), MirrorError);
  }
  await assert.rejects(m.pushReviewed('main', 't_1'), MirrorError);
  assert.equal(refs(f.forge), `${f.target} refs/heads/main`);
});

test('a forge that does not report the pushed sha afterwards is an error', async () => {
  const f = fixture();
  // The forge hides the branch from readers: the push is accepted, ls-remote does not show it.
  git(f.forge, 'config', 'uploadpack.hideRefs', 'refs/heads/foreman/');
  const m = new ForgeMirror(f.home, f.map, null);
  await assert.rejects(m.pushReviewed(f.tip, 't_1'), (err: Error) => err instanceof MirrorError && /reports refs\/heads\/foreman\/t_1 at nothing/.test(err.message));
});

test('an https forge gets the token as a header keyed on the push URL origin, never in argv or an error', async (t) => {
  const f = fixture();
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['authorization']);
    res.writeHead(403).end(`denied ${String(req.headers['authorization'])}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  // The API is on another host than the git remote: the header follows the push URL.
  const map = { ...f.map, baseUrl: 'http://localhost:9', pushUrl: `http://127.0.0.1:${port}/group/app.git` };
  const m = new Landing([map], TOKEN).mirror(map, f.home);
  let error: unknown;
  const { argv, config } = await spawned(t, async () => {
    await m.fetchTarget().catch((err: unknown) => { error = err; });
  });
  assert.match(config, new RegExp(`GIT_CONFIG_KEY_0=http\\.http://127\\.0\\.0\\.1:${port}/\\.extraHeader`));
  assert.ok(error instanceof MirrorError, `fetchTarget failed as a MirrorError: ${String(error)}`);
  assert.ok(seen.length > 0, 'the forge was asked');
  assert.ok(seen.every((h) => h === `Basic ${TOKEN_B64}`), `every request carried the header: ${JSON.stringify(seen)}`);
  for (const text of [error.message, String(error.stack), JSON.stringify(argv)]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN_B64), `token leaked into: ${text}`);
  }
});

test('a local-path forge gets no header', async (t) => {
  const f = fixture();
  const m = new Landing([f.map], TOKEN).mirror(f.map, f.home);
  const { argv, config } = await spawned(t, async () => {
    assert.equal(await m.fetchTarget(), f.target);
  });
  assert.ok(argv.length > 0);
  assert.doesNotMatch(config, /extraHeader/i);
});

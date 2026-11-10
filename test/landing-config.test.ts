import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { startFakeGitlab } from '../scripts/forge/fakeGitlab.ts';
import { landingDoctorLines, LandingConfigError, loadLanding } from '../src/landing/config.ts';
import { ForgeTokenError, readForgeToken } from '../src/security/forgeToken.ts';
import { landingMode } from '../src/config.ts';

// <FOREMAN_HOME>/landing.json (src/landing/config.ts) and the GitLab token file (src/security/forgeToken.ts):
// validated once, the token never shown, doctor checked against the local fake GitLab.

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const TOKEN = 'glpat-landing-test-7Qx2';

const mapping = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'mr', forge: 'gitlab', baseUrl: 'http://127.0.0.1:9', project: 'group/app',
  pushUrl: '/srv/forge/app.git', targetBranch: 'main', requirePipeline: true, ...over,
});

function home(files: { landing?: unknown; token?: string; tokenMode?: number } = {}): string {
  const h = scratchDir('landing-config-home-');
  if (files.landing !== undefined) fs.writeFileSync(path.join(h, 'landing.json'), JSON.stringify(files.landing));
  if (files.token !== undefined) {
    fs.mkdirSync(path.join(h, 'secrets'), { mode: 0o700 });
    const file = path.join(h, 'secrets', 'gitlab-token');
    fs.writeFileSync(file, `${files.token}\n`, { mode: 0o600 });
    fs.chmodSync(file, files.tokenMode ?? 0o600);
  }
  return h;
}

test('FOREMAN_LANDING is merge unless set to mr; a typo throws', () => {
  assert.equal(landingMode(undefined), 'merge');
  assert.equal(landingMode(' MR '), 'mr');
  assert.throws(() => landingMode('gitlab'), /FOREMAN_LANDING must be merge or mr, got "gitlab"/);
});

test('two switches: no landing without FOREMAN_LANDING=mr, and none with mr but no file', () => {
  assert.equal(loadLanding(home({ landing: { '/repo/app': mapping() } }), 'merge'), null);
  assert.equal(loadLanding(home(), 'mr'), null);
});

test('a valid file gives each mapping, and the token as set or unset, never its value', () => {
  const withToken = loadLanding(home({ landing: { '/repo/app': mapping() }, token: TOKEN }), 'mr');
  assert.ok(withToken);
  assert.deepEqual(withToken.mappings, [{ repo: '/repo/app', ...mapping() }]);
  const lines = withToken.describe('/h').join('\n');
  assert.match(lines, /\/repo\/app {2}gitlab group\/app at http:\/\/127\.0\.0\.1:9 {2}push \/srv\/forge\/app\.git {2}target main {2}pipeline required/);
  assert.match(lines, /token: set/);
  assert.doesNotMatch(lines, new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(withToken), new RegExp(TOKEN));
  const without = loadLanding(home({ landing: { '/repo/app': mapping() } }), 'mr');
  assert.match(without!.describe('/h').join('\n'), /token: unset/);
});

test('each bad mapping fails with a LandingConfigError naming the repo and the problem', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ 'repo/app': mapping() }, /repo\/app: the repo must be an absolute, resolved path/],
    [{ '/repo/../app': mapping() }, /the repo must be an absolute, resolved path/],
    [{ '/repo/app': mapping({ mode: 'merge' }) }, /\/repo\/app: mode must be "mr", not "merge"/],
    [{ '/repo/app': mapping({ forge: 'github' }) }, /forge must be "gitlab"/],
    [{ '/repo/app': mapping({ extra: 1 }) }, /unknown key "extra"/],
    [{ '/repo/app': { mode: 'mr' } }, /missing forge, baseUrl, project, pushUrl, targetBranch, requirePipeline/],
    [{ '/repo/app': mapping({ baseUrl: 'ftp://gitlab.example.test' }) }, /baseUrl must be https:\/\/, or http:\/\/ on a loopback host/],
    [{ '/repo/app': mapping({ baseUrl: 'http://gitlab.example.test' }) }, /baseUrl must be https:\/\//],
    [{ '/repo/app': mapping({ pushUrl: 'git@gitlab.example.test:group/app.git' }) }, /pushUrl is not a URL/],
    [{ '/repo/app': mapping({ pushUrl: 'relative/app.git' }) }, /pushUrl is not a URL/],
    [{ '/repo/app': mapping({ pushUrl: 'https://user:pw@gitlab.example.test/group/app.git' }) }, /pushUrl must not carry credentials/],
    [{ '/repo/app': mapping({ project: 'app' }) }, /project must be a GitLab path/],
    [{ '/repo/app': mapping({ targetBranch: '-x' }) }, /targetBranch is not a branch name/],
    [{ '/repo/app': mapping({ requirePipeline: 'yes' }) }, /requirePipeline must be true or false/],
  ];
  for (const [landing, want] of cases) {
    assert.throws(() => loadLanding(home({ landing }), 'mr'), (err: unknown) => err instanceof LandingConfigError && want.test(err.message), JSON.stringify(landing));
  }
  assert.throws(() => loadLanding(home({ landing: [] }), 'mr'), /must be an object mapping repo paths/);
  const h = home();
  fs.writeFileSync(path.join(h, 'landing.json'), '{');
  assert.throws(() => loadLanding(h, 'mr'), (err: unknown) => err instanceof LandingConfigError && /not JSON/.test(err.message));
});

test('the token file is refused unless it is a 0600 regular file of the user running Foreman', () => {
  assert.equal(readForgeToken(home()), null);
  assert.equal(readForgeToken(home({ token: TOKEN })), TOKEN);
  const open = home({ token: TOKEN, tokenMode: 0o644 });
  assert.throws(() => readForgeToken(open), (err: unknown) => err instanceof ForgeTokenError && /has mode 0644; it must be 0600/.test(err.message) && !err.message.includes(TOKEN));
  assert.throws(() => loadLanding(home({ landing: { '/repo/app': mapping() }, token: TOKEN, tokenMode: 0o644 }), 'mr'), ForgeTokenError);
  const other = home({ token: TOKEN });
  assert.throws(() => readForgeToken(other, (process.getuid?.() ?? 0) + 1), (err: unknown) => err instanceof ForgeTokenError && /is owned by uid \d+, not by the user running Foreman/.test(err.message));
  const linked = home();
  fs.mkdirSync(path.join(linked, 'secrets'));
  fs.symlinkSync(path.join(home({ token: TOKEN }), 'secrets', 'gitlab-token'), path.join(linked, 'secrets', 'gitlab-token'));
  assert.throws(() => readForgeToken(linked), (err: unknown) => err instanceof ForgeTokenError && /is a symlink/.test(err.message));
});

test('doctor against the fake: merge_method merge is ok, ff is a FAIL, an unknown project is a FAIL line with no token', async () => {
  const bare = scratchDir('landing-config-bare-');
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare });
  for (const mergeMethod of ['merge', 'ff']) {
    const fake = await startFakeGitlab({ projects: { 'group/app': bare }, token: TOKEN, mergeMethod });
    try {
      const landing = loadLanding(home({
        landing: { '/repo/app': mapping({ baseUrl: fake.url }), '/repo/gone': mapping({ baseUrl: fake.url, project: 'group/gone' }) },
        token: TOKEN,
      }), 'mr')!;
      const [app, gone] = await landingDoctorLines(landing);
      assert.equal(app, mergeMethod === 'merge'
        ? 'landing /repo/app (group/app): ok  merge_method merge, default branch main, target main'
        : 'landing /repo/app (group/app): FAIL merge_method ff; MR landing needs merge');
      assert.match(gone!, /^landing \/repo\/gone \(group\/gone\): FAIL GitLab GET : 404/);
      assert.doesNotMatch(`${app}${gone}`, new RegExp(TOKEN));
    } finally {
      await fake.close();
    }
  }
});

test('config --effective with FOREMAN_LANDING=mr and a landing.json shows each mapping and token: set, never the token', () => {
  const h = home({ landing: { '/repo/app': mapping() }, token: TOKEN });
  const r = spawnSync(process.execPath, [CLI, 'config', '--effective'], { env: { ...process.env, FOREMAN_HOME: h, FOREMAN_LANDING: 'mr' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^FOREMAN_LANDING\s+mr\s+env$/m);
  assert.match(r.stdout, /^FOREMAN_MR_POLL_MS\s+10000\s+default$/m);
  assert.match(r.stdout, /^ {2}\/repo\/app {2}gitlab group\/app/m);
  assert.match(r.stdout, /^ {2}token: set$/m);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  const bad = home({ landing: { '/repo/app': mapping({ mode: 'push' }) } });
  const refused = spawnSync(process.execPath, [CLI, 'config', '--effective'], { env: { ...process.env, FOREMAN_HOME: bad, FOREMAN_LANDING: 'mr' }, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /landing\.json: \/repo\/app: mode must be "mr", not "push"/);
});

function serve(h: string): ReturnType<typeof spawn> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, FOREMAN_HOME: h, FOREMAN_PORT: '0', FOREMAN_LANDING: 'mr', FOREMAN_PREWARM: 'off', FOREMAN_LOCAL_ONLY: 'on',
    FOREMAN_CLAUDE_BIN: path.join(h, 'no-claude'), FOREMAN_SANDBOX: 'off', FOREMAN_BACKUP: 'off',
  };
  delete env['FOREMAN_RUN_ID'];
  return spawn(process.execPath, [CLI, 'serve'], { cwd: h, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
}

test('serve validates landing.json once at start: a bad file refuses the start before the ledger is opened', async () => {
  const h = home({ landing: { 'repo/app': mapping() } });
  const child = serve(h);
  let err = '';
  child.stderr!.on('data', (d) => { err += d; });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(err, /repo\/app: the repo must be an absolute, resolved path/);
  assert.equal(fs.existsSync(path.join(h, 'foreman.db')), false, 'no ledger was opened');
});

test('serve prints the landing map with token: set, and the token is in no output, event or file under the home', async (t) => {
  const h = home({ landing: { '/repo/app': mapping() }, token: TOKEN });
  const child = serve(h);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => {
      out += d;
      if (/^foreman up .*$/m.test(out)) resolve();
    });
    child.stderr!.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error(`serve exited before "foreman up": ${out}`)));
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.match(out, /^landing: FOREMAN_LANDING=mr, 1 repo\(s\)/m);
  assert.match(out, /^ {2}token: set$/m);
  assert.doesNotMatch(out, new RegExp(TOKEN));
  const tokenFile = path.join(h, 'secrets', 'gitlab-token');
  const files = (fs.readdirSync(h, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).filter((f) => f !== tokenFile);
  assert.ok(files.some((f) => f.endsWith('foreman.db')), `the ledger (events) is among the files searched: ${files.join(', ')}`);
  for (const f of files) assert.equal(fs.readFileSync(f).includes(TOKEN), false, `${f} holds the token`);
});

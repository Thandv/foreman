import { testHome } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeAfterStops } from './helpers/removal.ts';
import { probeTask } from '../src/types.ts';
import type { RunnerContext } from '../src/runners/index.ts';
import { codexCliRunner, resetPreflightCache } from '../src/runners/cliRunners.ts';
import { claudeConfigDir, claudeWorkerEnv } from '../src/runners/claudeIsolation.ts';

/** Set env vars for one test and put them back (or remove them) afterwards. */
function withEnv(t: TestContext, vars: Record<string, string | undefined>): void {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetPreflightCache();
  });
}

/** Run `fn` with process.env replaced by exactly `vars`, then put the whole environment back. */
function onlyEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/**
 * What a daemon may hold that a codex worker has no business reading: cloud
 * credentials included, even with Claude's Bedrock/Vertex switches on (those
 * are Claude's, not codex's).
 */
const DAEMON_SECRETS = {
  FOREMAN_GATEWAY_KEY: 'gw-secret',
  GH_TOKEN: 'gho_test',
  ANTHROPIC_API_KEY: 'sk-ant-api03-test',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-test',
  GOOGLE_APPLICATION_CREDENTIALS: '/gcp-creds.json',
};

/** A `codex` stand-in: it appends its whole environment to a file per call, then reports a finished task. */
function stubCodex(t: TestContext): () => Record<string, string>[] {
  const dir = removeAfterStops(t, fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-codex-cli-'))));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `env | sed 's/^/ENV:/' >> "${dir}/calls.log"\n` +
      `printf '<<<END>>>\\n' >> "${dir}/calls.log"\n` +
      `[ "$1" = "--version" ] && { printf 'codex 0.0.0\\n'; exit 0; }\n` +
      `printf '%s\\n' '{"id":"1","msg":{"type":"task_complete","last_agent_message":"done"}}'\n`,
  );
  fs.chmodSync(bin, 0o755);
  withEnv(t, { FOREMAN_CODEX_BIN: bin });
  return () => {
    const file = path.join(dir, 'calls.log');
    const log = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return log.split('<<<END>>>\n').filter((c) => c.trim()).map((chunk) => {
      const env: Record<string, string> = {};
      for (const l of chunk.split('\n')) {
        const m = /^ENV:([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
        if (m) env[m[1]!] = m[2]!;
      }
      return env;
    });
  };
}

test('the codex worker\'s environment is an allowlist: daemon secrets stay out, its toolchain and own config pass, in the run and the preflight', async (t) => {
  withEnv(t, { ...DAEMON_SECRETS, CODEX_HOME: '/codex-home', OPENAI_API_KEY: 'sk-openai-test', OPENAI_BASE_URL: 'https://openai.test' });
  const calls = stubCodex(t);
  const jail = removeAfterStops(t, fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-codex-jail-'))));
  const stop = new AbortController();
  t.after(() => stop.abort());

  assert.equal(await codexCliRunner.preflight(probeTask({ runner: 'codex-cli' })), null);
  const result = await codexCliRunner.run({
    task: probeTask({ id: 't_codex_env', runner: 'codex-cli', prompt: 'do the ticket' }),
    runId: 'r_codex',
    dir: jail,
    signal: stop.signal,
    broker: null,
    stage: () => {},
    child: () => {},
    session: () => {},
    log: () => {},
    progress: () => {},
    usage: () => {},
    enqueue: () => { throw new Error('not used'); },
  } as unknown as RunnerContext);

  assert.equal(result.ok, true, result.summary);
  const [preflight, run] = calls();
  assert.ok(preflight && run, 'the stub was called for the preflight and the run');
  for (const env of [preflight, run]) {
    for (const name of Object.keys(DAEMON_SECRETS)) assert.equal(env[name], undefined, `${name} is not passed on`);
    assert.deepEqual(Object.keys(env).filter((n) => /^(AWS|GOOGLE)_/.test(n)), [], 'no cloud credentials reach codex');
    assert.equal(env['PATH'], process.env['PATH'], 'the toolchain is still reachable');
    assert.equal(env['HOME'], process.env['HOME']);
    assert.equal(env['CODEX_HOME'], '/codex-home');
    assert.equal(env['OPENAI_API_KEY'], 'sk-openai-test', 'the codex CLI can still sign in');
    assert.equal(env['OPENAI_BASE_URL'], 'https://openai.test');
    assert.equal(env['FOREMAN_HOME'], testHome);
  }
  assert.equal(run['FOREMAN_RUN_ID'], 'r_codex', 'the runner\'s own additions survive the allowlist');
});

test('pinned: the claude worker\'s environment is exactly what it was, byte for byte', () => {
  const daemon = {
    PATH: '/usr/bin:/bin', HOME: '/home/op', LANG: 'en_US.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy.test:8080',
    FOREMAN_PORT: '4199', FOREMAN_MAX_VERIFIES: '2',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', ANTHROPIC_API_KEY: 'sk-ant-api03-test', ANTHROPIC_BASE_URL: 'https://gateway.test',
    CODEX_HOME: '/codex-home', OPENAI_API_KEY: 'sk-openai-test',
    AWS_SECRET_ACCESS_KEY: 'aws-secret', GOOGLE_APPLICATION_CREDENTIALS: '/keys/gcp.json', CLOUD_ML_REGION: 'us-east5',
    FOREMAN_GATEWAY_KEY: 'gw-secret', GH_TOKEN: 'gho_test', MY_PROJECT_SETTING: 'listed', OTHER_SETTING: 'unlisted',
    FOREMAN_CLAUDE_ENV_ALLOW: 'MY_PROJECT_SETTING',
  };
  const isolation = {
    FOREMAN_HOME: testHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir('t_pin'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  };
  // The daemon's variables a claude worker keeps, in the daemon's own order.
  const kept = (env: Record<string, string>, names: string[]): Record<string, string> =>
    Object.fromEntries(Object.entries(env).filter(([k]) => names.includes(k)));
  const shared = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'FOREMAN_PORT', 'FOREMAN_MAX_VERIFIES',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MY_PROJECT_SETTING',
  ];
  const cases: [Record<string, string>, string[]][] = [
    [daemon, shared],
    [{ ...daemon, CLAUDE_CODE_USE_BEDROCK: '1' }, [...shared, 'CLAUDE_CODE_USE_BEDROCK', 'AWS_SECRET_ACCESS_KEY']],
    [{ ...daemon, CLAUDE_CODE_USE_VERTEX: 'true' }, [...shared, 'CLAUDE_CODE_USE_VERTEX', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION']],
  ];
  for (const [env, names] of cases) {
    const got = onlyEnv(env, () => claudeWorkerEnv({ id: 't_pin' }));
    assert.equal(JSON.stringify(got), JSON.stringify({ ...kept(env, names), ...isolation }));
  }
});

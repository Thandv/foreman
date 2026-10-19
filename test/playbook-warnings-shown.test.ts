import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { clearLoggedPlaybookWarnings, clearPlaybookCache, formatPlaybookWarning, loadPlaybooks } from '../src/playbooks.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';

// One playbook with one bad reviewer entry, in a scratch playbooks dir; the
// operator's daemon, home and skills are never read.

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const WARNING = /playbook soft: reviewer 0 \(lead\) skill "Bad Name!" — /;

const BODY = '\n## role: lead\n\nYou lead the work.\n\n## role: dev\n\nYou implement the ticket.\n';

const PLAN = JSON.stringify({
  epic: { title: 'Fix the crash', summary: 'find it' },
  tickets: [{ ref: 't1', title: 'Ticket t1', prompt: 'Do t1 in the code.', role: 'dev', kind: 'code', after: [], acceptance: 't1 done', testCmd: null, points: 2 }],
});

async function world(fn: (port: number) => Promise<void>, skills: unknown[] = ['Bad Name!']): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pb-warnings-')));
  const pbDir = path.join(base, 'playbooks');
  fs.mkdirSync(pbDir);
  const fm = {
    id: 'soft', description: 'a test crew', triggers: ['code'],
    roles: { lead: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'lead', style: 'code-review', skills }],
    escalation: { chair: 'lead', afterFailures: 2 }, checks: [],
    gate: { default: 'human', hardHuman: ['S2'] }, constraints: ['Never do the bad thing.'],
  };
  fs.writeFileSync(path.join(pbDir, 'soft.md'), `---\n${JSON.stringify(fm, null, 2)}\n---\n${BODY}`);
  const bin = path.join(base, 'claude');
  const reply = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: PLAN });
  fs.writeFileSync(path.join(base, 'body.json'), reply);
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(base, 'body.json')}"\n`);
  fs.chmodSync(bin, 0o755);
  const keys = ['FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_CLAUDE_BIN', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_PREWARM', 'FOREMAN_SKILLS_DIR', 'FOREMAN_PORT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  process.env['FOREMAN_LOCAL_ONLY'] = '0';
  process.env['FOREMAN_PREWARM'] = 'off';
  process.env['FOREMAN_PORT'] = '0';
  delete process.env['FOREMAN_SKILLS_DIR'];
  clearPlaybookCache();
  clearLoggedPlaybookWarnings();
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { maxWorkers: 1, tickMs: 5, verifyEnabled: false });
  const server = createServer(store, sched);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sched.stop();
    store.close();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearPlaybookCache();
    clearLoggedPlaybookWarnings();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function cli(port: number, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pb-warnings-cli-'));
  try {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('foreman playbooks prints a bad reviewer entry\'s warning next to the refusals', async () => {
  await world(async (port) => {
    const r = await cli(port, ['playbooks']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}WARNING playbook soft: reviewer 0 \(lead\) skill "Bad Name!" — .+$/m);
  });
});

test('foreman build prints a bad reviewer entry\'s warning before the plan', async () => {
  await world(async (port) => {
    const r = await cli(port, ['build', 'fix the crash in the code', '--playbook', 'soft', '--no-check']);
    assert.equal(r.code, 0, r.stderr);
    const at = r.stdout.search(/^WARNING playbook soft: reviewer 0 \(lead\) skill "Bad Name!" — /m);
    assert.ok(at >= 0, r.stdout);
    assert.ok(at < r.stdout.indexOf('epic: Fix the crash'), 'the warning comes before the plan');
  });
});

test('the daemon logs a bad reviewer entry once when its playbook load runs twice in one process', async () => {
  await world(async () => {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]): void => void logged.push(a.join(' '));
    try {
      loadPlaybooks();
      clearPlaybookCache();
      loadPlaybooks();
    } finally {
      console.error = real;
    }
    assert.equal(logged.filter((l) => WARNING.test(l)).length, 1, JSON.stringify(logged));
  });
});

test('the daemon logs a bad reviewer entry once however many requests read the playbooks', async () => {
  await world(async (port) => {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]): void => void logged.push(a.join(' '));
    try {
      for (const route of ['/api/playbooks', '/api/state', '/api/playbooks', '/api/state']) {
        const res = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(res.status, 200, route);
        await res.arrayBuffer();
      }
    } finally {
      console.error = real;
    }
    assert.equal(logged.filter((l) => WARNING.test(l)).length, 1, JSON.stringify(logged));
  });
});

test('a warning\'s skill name is cut short and stripped of escapes and line breaks before it is printed or logged', async () => {
  const long = 'x'.repeat(10 * 1024);
  const hostile = 'evil\u001b[2J\u001b]0;pwn\u0007\nforeman: forged line\r\u009b31m';
  // A control character or a line break anywhere, or a C1 control (U+0080-U+009F).
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  await world(async (port) => {
    const catalog = loadPlaybooks();
    assert.deepEqual(catalog.warnings.map((w) => w.skill), [long, hostile], 'the load result keeps the entries as written');
    for (const w of catalog.warnings) {
      const line = formatPlaybookWarning(w);
      assert.ok(line.length < 300, `a ${w.skill.length}-character name gives a ${line.length}-character line`);
      assert.doesNotMatch(line, CONTROL, JSON.stringify(line));
    }
    const r = await cli(port, ['playbooks']);
    assert.equal(r.code, 0, r.stderr);
    const shown = r.stdout.split('\n').filter((l) => l.includes('WARNING'));
    assert.equal(shown.length, 2, r.stdout);
    for (const l of shown) {
      assert.ok(l.length < 300, l.slice(0, 120));
      assert.doesNotMatch(l, CONTROL, JSON.stringify(l));
    }
    assert.doesNotMatch(r.stdout, /^foreman: forged line/m);
  }, [long, hostile, 'ok-name']);
});

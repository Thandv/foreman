import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat, isAuthFailure, markCloudDown, ModelUnavailable, probeCloud, reloadSpecs, specs, TruncatedReply } from '../src/models.ts';
import { cloudDown, cloudFallback, localOnly, localOnlyMode, setCloudDown } from '../src/localOnly.ts';
import { Store } from '../src/queue.ts';
import { Scheduler } from '../src/scheduler.ts';
import { effectiveGate } from '../src/gate.ts';
import { getRunner } from '../src/runners/index.ts';
import { probeTask } from '../src/types.ts';
import { ownerCall } from '../src/assistant/ownerCall.ts';
import { parseMemory, memoryWarning } from '../src/memory.ts';
import { modelForTask, tierModel } from '../src/roles.ts';
import { routerModel } from '../src/assistant/crewPlan.ts';

/** A fake `claude` that answers `auth status --json` with the given body (or exits with `code`). */
function fakeCli(body: string, code = 0): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloudmode-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, dir };
}

async function withCli<T>(bin: string | undefined, mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = { bin: process.env['FOREMAN_CLAUDE_BIN'], mode: process.env['FOREMAN_LOCAL_ONLY'] };
  if (bin === undefined) delete process.env['FOREMAN_CLAUDE_BIN'];
  else process.env['FOREMAN_CLAUDE_BIN'] = bin;
  if (mode === undefined) delete process.env['FOREMAN_LOCAL_ONLY'];
  else process.env['FOREMAN_LOCAL_ONLY'] = mode;
  setCloudDown(null);
  reloadSpecs();
  try {
    return await fn();
  } finally {
    for (const [key, value] of [['FOREMAN_CLAUDE_BIN', prev.bin], ['FOREMAN_LOCAL_ONLY', prev.mode]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCloudDown(null);
    reloadSpecs();
  }
}

test('the flag parses three ways, and unset is auto', () => {
  const prev = process.env['FOREMAN_LOCAL_ONLY'];
  try {
    for (const [raw, mode] of [['1', 'on'], ['yes', 'on'], ['0', 'off'], ['off', 'off'], ['', 'auto'], ['auto', 'auto']] as const) {
      process.env['FOREMAN_LOCAL_ONLY'] = raw;
      assert.equal(localOnlyMode(), mode, `'${raw}'`);
    }
    delete process.env['FOREMAN_LOCAL_ONLY'];
    assert.equal(localOnlyMode(), 'auto');
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_LOCAL_ONLY'];
    else process.env['FOREMAN_LOCAL_ONLY'] = prev;
  }
});

test('auto: a signed-out CLI reroutes Claude-dependent work locally — and is NOT strict local-only', async () => {
  // Exit 1 is what the real CLI does when signed out (2.1.219): the JSON that
  // says so arrives on the FAILURE path, which is exactly where it was missed.
  const out = fakeCli('{"loggedIn": false, "authMethod": "none"}', 1);
  try {
    await withCli(out.bin, undefined, async () => {
      assert.equal(cloudFallback(), false, 'unknown is mixed — nothing has said the cloud is down');
      assert.equal(tierModel('worker'), 'sonnet');
      await probeCloud();
      assert.match(cloudDown() ?? '', /not signed in/);
      assert.equal(cloudFallback(), true);
      assert.equal(localOnly(), false, 'a lapsed sign-in is not the operator promising nothing leaves the machine');
      assert.equal(specs().has('opus'), false, 'Claude aliases stop resolving the moment they stop working');
      assert.equal(tierModel('owner'), 'local-reason');
      assert.equal(modelForTask({ agent: null, role: 'dev', playbook: null, kind: 'code' }), 'local-code');
      assert.equal(effectiveGate({ gate: 'owner', playbook: null }), 'human', 'the owner model is Claude');
      // Codex is somebody else's CLI: a Claude sign-out must not refuse it.
      const codexReason = await getRunner('codex-cli').preflight(probeTask({ runner: 'codex-cli' }));
      assert.doesNotMatch(String(codexReason), /Claude CLI is unreachable|FOREMAN_LOCAL_ONLY/);
      await assert.rejects(ownerCall('classify this'), /Claude CLI is unreachable/);
    });
  } finally {
    fs.rmSync(out.dir, { recursive: true, force: true });
  }
});

test('auto: "loggedIn:true" alone never clears a down state — only a call that works does', async () => {
  // Measured: the CLI reports loggedIn:true for a garbage key or OAuth token.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloudmode-'));
  const bin = path.join(dir, 'claude');
  const okFile = path.join(dir, 'calls-work');
  fs.writeFileSync(
    bin,
    '#!/bin/sh\n' +
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn": true}\'; exit 0; fi\n' +
      `if [ -f "${okFile}" ]; then echo '{"type":"result","is_error":false,"result":"ok","usage":{}}'; exit 0; fi\n` +
      'echo \'{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}\'; exit 1\n',
  );
  fs.chmodSync(bin, 0o755);
  try {
    await withCli(bin, undefined, async () => {
      await assert.rejects(chat({ alias: 'haiku', messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S1' }));
      assert.equal(cloudFallback(), true, 'a call failing on auth starts the fallback');
      await probeCloud();
      assert.equal(cloudFallback(), true, 'the status line said loggedIn, the confirming call still failed');
      fs.writeFileSync(okFile, '');
      await probeCloud();
      assert.equal(cloudFallback(), false, 'a call that worked is what ends the fallback');
      assert.equal(specs().has('opus'), true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto: claude-code tickets are HELD through a lapse, not failed — and run once it ends', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
  try {
    await withCli(undefined, undefined, async () => {
      setCloudDown('test: signed out');
      reloadSpecs();
      const held = store.addTask({ title: 'needs claude', prompt: 'x', runner: 'claude-code' });
      const other = store.addTask({ title: 'local work', prompt: 'x', runner: 'echo' });
      for (let i = 0; i < 5; i++) await sched.tick();
      assert.equal(store.getTask(held.id)!.status, 'queued', 'held, not failed');
      assert.equal(store.getTask(held.id)!.attempts, 0, 'no retry budget burnt');
      assert.notEqual(store.getTask(other.id)!.status, 'queued', 'work behind a held ticket still runs');
      setCloudDown(null);
      reloadSpecs();
      assert.equal(store.claimable(10).some((t) => t.id === held.id), true, 'claimable again once the CLI is back');
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('auto: a held flood cannot starve the work behind it', async () => {
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 2 });
  try {
    await withCli(undefined, undefined, async () => {
      setCloudDown('test: signed out');
      reloadSpecs();
      for (let i = 0; i < 260; i++) store.addTask({ title: `held ${i}`, prompt: 'x', runner: 'claude-code', priority: 3 });
      const behind = store.addTask({ title: 'local work', prompt: 'x', runner: 'echo', priority: 1 });
      for (let i = 0; i < 5; i++) await sched.tick();
      assert.notEqual(store.getTask(behind.id)!.status, 'queued', 'lower-priority local work still ran');
      assert.equal(store.queuedOnRunner('claude-code'), 260);
    });
  } finally {
    await sched.stop();
    store.close();
  }
});

test('auto: an unreadable status line cannot hold the fallback forever — a real call decides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloudmode-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    '#!/bin/sh\n' +
      'if [ "$1" = "auth" ]; then echo "error: unknown command auth" >&2; exit 2; fi\n' +
      `echo '{"type":"result","is_error":false,"result":"ok","usage":{}}'; exit 0\n`,
  );
  fs.chmodSync(bin, 0o755);
  try {
    await withCli(bin, undefined, async () => {
      markCloudDown('claude cli: Failed to authenticate: earlier');
      assert.equal(cloudFallback(), true);
      await probeCloud();
      assert.equal(cloudFallback(), false, 'the confirming call worked, so the fallback ends');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto: overlapping probes share one confirmation call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloudmode-'));
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(
    bin,
    '#!/bin/sh\n' +
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn": true}\'; exit 0; fi\n' +
      `echo x >> "${log}"; sleep 0.3\n` +
      `echo '{"type":"result","is_error":false,"result":"ok","usage":{}}'\n`,
  );
  fs.chmodSync(bin, 0o755);
  try {
    await withCli(bin, undefined, async () => {
      markCloudDown('claude cli: Failed to authenticate: earlier');
      await Promise.all([probeCloud(), probeCloud(), probeCloud()]);
      assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one call, not one per caller');
      assert.equal(cloudFallback(), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('off: nothing is probed and no confirmation calls are spent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cloudmode-'));
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\necho '{"loggedIn": true}'\n`);
  fs.chmodSync(bin, 0o755);
  try {
    await withCli(bin, '0', async () => {
      setCloudDown('earlier failure');
      await probeCloud();
      assert.equal(fs.existsSync(log), false, 'the CLI was not invoked at all');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto: output the probe cannot read leaves a working daemon alone; a missing binary does not', async () => {
  const garbled = fakeCli('Usage: claude [options]', 1);
  try {
    await withCli(garbled.bin, undefined, async () => {
      await probeCloud();
      assert.equal(cloudDown(), null, 'an older CLI without `auth status` must not change routing');
      assert.equal(cloudFallback(), false);
    });
    await withCli('/nonexistent/claude-binary', undefined, async () => {
      await probeCloud();
      assert.match(cloudDown() ?? '', /not found/);
      assert.equal(cloudFallback(), true);
      assert.equal(localOnly(), false);
    });
  } finally {
    fs.rmSync(garbled.dir, { recursive: true, force: true });
  }
});

test('an explicit 0 keeps mixed mode even with the cloud down; an explicit 1 is strict local-only', async () => {
  await withCli('/nonexistent/claude-binary', '0', async () => {
    markCloudDown('claude cli: Failed to authenticate: test');
    assert.ok(cloudDown(), 'a failing call is still recorded');
    assert.equal(cloudFallback(), false, 'the operator forced mixed');
    assert.equal(tierModel('worker'), 'sonnet');
  });
  await withCli('/nonexistent/claude-binary', '1', async () => {
    assert.equal(localOnly(), true);
  });
});

test('a failed CLI call surfaces the CLI’s own reason, and an auth failure starts the fallback', async () => {
  const expired = fakeCli(
    '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}',
    1,
  );
  try {
    await withCli(expired.bin, undefined, async () => {
      await assert.rejects(
        chat({ alias: 'haiku', messages: [{ role: 'user', content: 'hi' }], sensitivity: 'S1', timeoutMs: 10_000 }),
        (err: Error) => {
          assert.ok(err instanceof ModelUnavailable);
          assert.match(err.message, /OAuth session expired/, 'not the 300-character command line');
          return true;
        },
      );
      assert.match(cloudDown() ?? '', /OAuth session expired/);
      assert.equal(cloudFallback(), true);
    });
  } finally {
    fs.rmSync(expired.dir, { recursive: true, force: true });
  }
});

test('an owner call failing on auth starts the fallback too — the planner, gate and reviewers go through it', async () => {
  const expired = fakeCli('{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}', 1);
  try {
    await withCli(expired.bin, undefined, async () => {
      await assert.rejects(ownerCall('plan this'));
      assert.equal(cloudFallback(), true);
    });
  } finally {
    fs.rmSync(expired.dir, { recursive: true, force: true });
  }
});

test('only the CLI’s own auth envelopes count — never prose that mentions authentication', () => {
  for (const real of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Invalid API key · Please run /login',
    'Not logged in · Please run /login',
  ]) assert.equal(isAuthFailure(real), true, real);
  for (const prose of [
    'rate limited, try again',
    'Let me check the authentication module before deciding.',
    'The diff adds OAuth refresh handling; verdict follows.',
    'Reached max turns while reviewing /login route changes',
  ]) assert.equal(isAuthFailure(prose), false, prose);
});

test('the memory warning names a machine that cannot host a model, and stays quiet otherwise', () => {
  const vm = (free: number, inactive: number): string =>
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  ${free}.\nPages inactive:  ${inactive}.\nPages speculative:  0.\n`;
  const tight = parseMemory(vm(2000, 40000), 'vm.swapusage: total = 17408.00M  used = 16804.94M  free = 603.06M');
  assert.ok(tight && tight.reclaimableGb < 1);
  assert.match(memoryWarning(tight) ?? '', /short of memory .*16\.4\/17\.0 GB swap/);
  const roomy = parseMemory(vm(400000, 200000), 'vm.swapusage: total = 2048.00M  used = 100.00M  free = 1948.00M');
  assert.equal(memoryWarning(roomy), null);
  // macOS grows swapfiles on demand: a high swap RATIO with room to spare is healthy.
  const grownSwap = parseMemory(vm(100000, 280000), 'vm.swapusage: total = 15360.00M  used = 14233.00M  free = 1127.00M');
  assert.ok(grownSwap && grownSwap.reclaimableGb > 6);
  assert.equal(memoryWarning(grownSwap), null, 'no false alarm on a machine with 6 GB reclaimable');
  assert.equal(memoryWarning(grownSwap, 2.7), null, 'plenty for the 2B');
  assert.match(memoryWarning(grownSwap, 9.0) ?? '', /needing ~9\.0 GB/, 'not enough for the 14B — the case that stalled');
  assert.equal(parseMemory('nonsense', 'nonsense'), null);
});

test('a reply cut off at its ceiling is a TruncatedReply — still unavailable to every verdict path', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        JSON.stringify({ message: { content: 'p' } }) + '\n' +
        JSON.stringify({ done: true, done_reason: 'length', prompt_eval_count: 3, eval_count: 1 }) + '\n',
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env['FOREMAN_OLLAMA_URL'];
  process.env['FOREMAN_OLLAMA_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(
      chat({ alias: 'local-fast', messages: [{ role: 'user', content: 'ping' }], sensitivity: 'S1', maxTokens: 1 }),
      (err: Error) => err instanceof TruncatedReply && err instanceof ModelUnavailable,
    );
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_OLLAMA_URL'];
    else process.env['FOREMAN_OLLAMA_URL'] = prev;
    server.close();
  }
});

test('an ambiguous classification consults the router model, not the owner', () => {
  const prev = process.env['FOREMAN_MODEL_ROUTER'];
  try {
    delete process.env['FOREMAN_MODEL_ROUTER'];
    assert.equal(routerModel(), 'claude-haiku-4-5');
    process.env['FOREMAN_MODEL_ROUTER'] = 'sonnet';
    assert.equal(routerModel(), 'claude-sonnet-5-5');
    process.env['FOREMAN_MODEL_ROUTER'] = 'local-reason';
    assert.equal(routerModel(), 'claude-haiku-4-5', 'a local alias cannot serve a CLI consult');
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_MODEL_ROUTER'];
    else process.env['FOREMAN_MODEL_ROUTER'] = prev;
  }
});

async function settle(sched: Scheduler, until: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the scheduler');
    await sched.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a worker refused by the provider usage limit is held and requeued, not failed — and nothing behind it dies', async () => {
  const prevBackoff = process.env['FOREMAN_LIMIT_BACKOFF_MS'];
  process.env['FOREMAN_LIMIT_BACKOFF_MS'] = '60000';
  // Like the real CLI at its limit: --version still answers, real work is refused.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-limit-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)"; exit 0;; esac\necho "You've hit your session limit · resets 4:30pm (Europe/London)"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const cli = { bin, dir };
  const store = new Store(':memory:');
  const sched = new Scheduler(store, { tickMs: 5, verifyEnabled: false, maxWorkers: 1 });
  try {
    await withCli(cli.bin, 'off', async () => {
      const t = store.addTask({ title: 'limited work', prompt: 'x', runner: 'claude-code', maxAttempts: 1 });
      const dep = store.addTask({ title: 'waits on it', prompt: 'x', runner: 'echo', deps: [t.id] });
      const second = store.addTask({ title: 'more claude work', prompt: 'x', runner: 'claude-code' });
      await settle(sched, () => store.getTask(t.id)!.status === 'queued' && sched.limitHoldUntil > 0, 20_000);
      const after = store.getTask(t.id)!;
      assert.equal(after.status, 'queued', 'held, not failed, though it had one attempt');
      assert.equal(after.attempts, 0, 'the attempt is given back');
      assert.match(after.error ?? '', /provider usage limit was reached/);
      assert.equal(store.verdictsForTask(t.id).length, 0, 'no fail verdict recorded against the work');
      assert.equal(store.getTask(dep.id)!.status, 'blocked', 'the dependent waits; it is not failed');
      for (let i = 0; i < 5; i++) await sched.tick();
      assert.equal(store.getTask(second.id)!.status, 'queued', 'no other claude-code work is claimed during the hold');
      assert.equal(store.getTask(second.id)!.attempts, 0);
      assert.equal(store.latestRun(second.id), null, 'it is never even started against the same wall');
      assert.equal(store.runsForTask(t.id).length, 1, 'the limited ticket is not re-run against the wall while the hold lasts');
      sched.limitHoldUntil = 0;
      assert.ok(store.claimable(10).some((x) => x.id === second.id), 'claimable once the hold passes');
    });
  } finally {
    await sched.stop();
    store.close();
    fs.rmSync(cli.dir, { recursive: true, force: true });
    if (prevBackoff === undefined) delete process.env['FOREMAN_LIMIT_BACKOFF_MS'];
    else process.env['FOREMAN_LIMIT_BACKOFF_MS'] = prevBackoff;
  }
});

test('isProviderLimit knows a quota refusal from a real failure', async () => {
  const { isProviderLimit } = await import('../src/providerLimit.ts');
  for (const s of ["You've hit your session limit · resets 4:30pm", 'Claude AI usage limit reached|1791373200', 'Error: 429 Too Many Requests', '{"type":"overloaded_error"}'])
    assert.equal(isProviderLimit(s), true, s);
  for (const s of ['tests failed: 3 of 10', 'TypeError: x is not a function', 'limit the output to 10 lines', null])
    assert.equal(isProviderLimit(s), false, String(s));
});

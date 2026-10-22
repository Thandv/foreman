import './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/queue.ts';
import { Scheduler, type VerifyArgs } from '../src/scheduler.ts';

/**
 * The scheduler undoes a claude-code worker's change to its own permission file before the next round's CLI starts:
 * a stand-in CLI widens `.claude/settings.json` in round 1, the review sends it back, and round 2 — a resumed session
 * in the same worktree — must start on the base commit's file.
 */

delete process.env['NODE_TEST_CONTEXT'];
const T = { timeout: 300_000 };
const BASE = '{"permissions":{"deny":["Bash(rm:*)"]}}';
const WIDE = '{"permissions":{"allow":["WebFetch"]}}';
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function fixture(t: TestContext): { repo: string; seen: () => string[] } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agentcfg-w-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), BASE);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  // What the CLI found in its permission file when it started, one line per round; then it widens the file.
  const seen = path.join(root, 'seen');
  const bin = path.join(root, 'claude');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    // Only a worker round (`-p`) is the stand-in; anything else the daemon asks the CLI (its version) is answered.
    'case " $* " in *" -p "*) ;; *) echo "2.1.287 (Claude Code)"; exit 0 ;; esac',
    `cat .claude/settings.json >> '${seen}' 2>/dev/null || printf NONE >> '${seen}'`,
    `echo >> '${seen}'`,
    `printf '%s' '${WIDE}' > .claude/settings.json`,
    'echo round >> a.txt',
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s-1"}'`,
    '',
  ].join('\n'), { mode: 0o755 });
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  t.after(() => delete process.env['FOREMAN_CLAUDE_BIN']);
  return { repo, seen: () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean) : []) };
}

test('a repair round starts on the base commit permission file, not the one the worker wrote', T, async (t) => {
  const f = fixture(t);
  const store = new Store(':memory:');
  let reviews = 0;
  const sched = new Scheduler(store, {
    tickMs: 5,
    maxWorkers: 1,
    verify: async (args: VerifyArgs) => {
      reviews++;
      const verdict = reviews === 1 ? 'fail' : 'pass';
      return store.addVerdict({
        runId: args.runId, taskId: args.task.id, verdict, disagreement: false, critique: 'again',
        council: [{ model: 'local-0', provider: 'ollama', local: true, verdict, confidence: 0.9, critique: 'again', costUsd: 0, latencyMs: 5 }],
      });
    },
  });
  t.after(async () => {
    await sched.stop();
    store.close();
  });
  const task = store.addTask({ title: 'ticket', kind: 'code', runner: 'claude-code', repo: f.repo, prompt: 'p' });
  const deadline = Date.now() + 240_000;
  while (f.seen().length < 2 && Date.now() < deadline) {
    await sched.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
  const events = store.eventsForTask(task.id, 800).map((e) => e.message).join('\n');
  assert.equal(f.seen().length >= 2, true, `two rounds ran\n${events}`);
  assert.deepEqual(f.seen().slice(0, 2), [BASE, BASE], 'each round started on the base file');
  assert.match(events, /agent settings: \.claude\/settings\.json: restored to the base commit/);
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPlaybookCache } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';
import { Store } from '../src/queue.ts';
import { crewChairShareMs, crewReview, type CrewVerdict } from '../src/verify/crewReview.ts';

// A two-reviewer chain, senior then architect (the architect with a named skill), over a stub claude CLI.
// Everything lives in a temp dir: neither the real skills repository nor the real playbooks are read.

const ENV_KEYS = ['FOREMAN_SKILLS_DIR', 'FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_CLAUDE_BIN'];
const ARCH_MARK = 'FULL-BODY-review-architecture';

const playbook = (): string => {
  const fm = {
    id: 'pair',
    description: 'senior and architect review',
    triggers: ['x'],
    roles: { architect: { tier: 'senior' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers: [{ role: 'senior', style: 'code-review' }, { role: 'architect', style: 'code-review', skills: ['review-architecture'] }],
    escalation: { chair: 'architect', afterFailures: 2 },
    checks: [],
    gate: { default: 'human', hardHuman: ['S2'] },
    constraints: ['Never do the bad thing.'],
  };
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n\n## role: architect\n\nYou review the design.\n\n## role: senior\n\nYou review the code.\n\n## role: dev\n\nYou implement.\n`;
};

const envelope = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });
const reply = (verdict: 'pass' | 'fail'): string =>
  envelope(JSON.stringify({ verdict, critique: `${verdict} from a stub`, issues: [], acceptance: [{ item: 1, status: verdict === 'pass' ? 'met' : 'missing', note: 'x' }] }));

type Answer = 'pass' | 'fail' | 'throw';

/** A claude CLI stand-in: the architect's prompt carries its skill body, the senior's does not. */
async function scenario(
  senior: Answer,
  architect: Answer,
  fn: (out: CrewVerdict | null, store: Store, taskId: string) => void | Promise<void>,
): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewverdict-')));
  const root = path.join(base, 'repo');
  const pbDir = path.join(base, 'playbooks');
  fs.mkdirSync(path.join(root, 'skills', 'review-architecture'), { recursive: true });
  fs.mkdirSync(pbDir, { recursive: true });
  const skillDir = path.join(root, 'skills', 'review-architecture');
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({ name: 'review-architecture', description: 'd', roles: ['pair.architect'], kinds: ['code'], when: 'always', status: 'draft' }));
  fs.writeFileSync(path.join(skillDir, 'full.md'), `${ARCH_MARK}: look at the design.\n`);
  fs.writeFileSync(path.join(skillDir, 'card.md'), 'CARD\n');
  fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify({ roles: { 'pair.architect': { allowed: ['review-architecture'] } } }));
  fs.writeFileSync(path.join(pbDir, 'pair.md'), playbook());

  const answer = (a: Answer): string => (a === 'throw' ? 'echo "stub chat blew up" >&2\nexit 1\n' : `cat <<'EOF'\n${reply(a)}\nEOF\n`);
  const bin = path.join(base, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$*" in\n*${ARCH_MARK}*)\n${answer(architect)};;\n*)\n${answer(senior)};;\nesac\n`);
  fs.chmodSync(bin, 0o755);

  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['FOREMAN_SKILLS_DIR'] = root;
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_LOCAL_ONLY'] = '0';
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  clearSkillCache();
  clearPlaybookCache();
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'T', prompt: 'the brief', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'pair', acceptance: '1. works' });
    const out = await crewReview({
      task: store.getTask(t.id)!, runId: store.startRun(t.id).id, store,
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n a\n+b',
    });
    await fn(out, store, t.id);
  } finally {
    store.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearSkillCache();
    clearPlaybookCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('a chain whose architect fails and whose senior passes is not a pass', async () => {
  await scenario('pass', 'fail', (out) => {
    assert.equal(out?.verdict, 'fail');
  });
});

test('a chain whose senior fails and whose architect passes is not a pass', async () => {
  await scenario('fail', 'pass', (out) => {
    assert.equal(out?.verdict, 'fail');
  });
});

test('a chain whose senior and architect both pass is a pass', async () => {
  await scenario('pass', 'pass', (out) => {
    assert.equal(out?.verdict, 'pass');
    assert.equal(out?.reviews.length, 2);
  });
});

test('an architect whose chat call throws, with a passing senior, is split and held, never a pass', async () => {
  await scenario('pass', 'throw', (out, store, taskId) => {
    assert.ok(out, 'a crew verdict is returned, not null (null would leave the council verdict to stand)');
    assert.equal(out.verdict, 'split');
    assert.equal(out.record.verdict, 'split');
    assert.deepEqual(store.verdictsForTask(taskId).map((v) => v.verdict), ['split'], 'the split is the recorded verdict');

    const architect = out.reviews.find((r) => r.role === 'architect');
    assert.match(architect?.error ?? '', /./, 'the error is recorded for the architect');
    const senior = out.reviews.find((r) => r.role === 'senior');
    assert.equal(senior?.error, undefined);
    assert.equal(senior?.verdict, 'pass', "the senior's verdict is recorded");

    assert.equal(out.record.council.find((o) => o.role === 'senior')?.verdict, 'pass', "the senior's verdict is on the verdict row");
    assert.match(out.critique, /architect \(code-review\) gave no usable answer/, 'the lost reviewer is named for the person at the gate');
    assert.ok(
      store.eventsForTask(taskId).some((e) => e.type === 'error' && /crew review incomplete: architect \(code-review\)/.test(e.message)),
      'the board sees an error event naming the architect',
    );
  });
});

test('a senior whose chat call throws, with a passing architect, is split and held, never a pass', async () => {
  await scenario('throw', 'pass', (out) => {
    assert.equal(out?.verdict, 'split');
    assert.ok(out?.reviews.find((r) => r.role === 'senior')?.error);
    assert.equal(out?.reviews.find((r) => r.role === 'architect')?.verdict, 'pass');
  });
});

test('a lost reviewer does not soften a surviving fail', async () => {
  await scenario('fail', 'throw', (out) => {
    assert.equal(out?.verdict, 'fail');
  });
});

test('the chair of a two-reviewer chain gets a third of the timeout, never under 1000 ms', () => {
  assert.equal(crewChairShareMs(1_800_000, 2), 600_000, 'the default 30 minute task timeout');
  assert.equal(crewChairShareMs(90 * 60_000, 2), 1_800_000, 'the 90 minute local-only timeout');
  assert.equal(crewChairShareMs(3_001, 2), 1_000, 'floor(3001 / 3) is exactly the floor');
  assert.equal(crewChairShareMs(3_000, 2), 1_000);
  assert.equal(crewChairShareMs(5_000, 2), 1_666, 'floored, not rounded');
  assert.equal(crewChairShareMs(2_999, 2), 1_000, 'a third under the floor is lifted to it');
  assert.equal(crewChairShareMs(1, 2), 1_000);
  assert.equal(crewChairShareMs(0, 2), 1_000);
});

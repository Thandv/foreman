import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clearPlaybookCache, getPlaybook } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';
import { Store } from '../src/queue.ts';
import { buildReviewPrompt, crewReview, type CrewVerdict } from '../src/verify/crewReview.ts';

// A blocker the worker cannot act on from its worktree — a fault in Foreman or the environment, a rebase, another
// ticket's state, data it cannot read — sent back as a repair demand starts a round that delivers nothing (measured
// on the ledger: six such rounds, each resolved by hand). Tagged "(operator)" by the reviewer, or asking for work on
// a host this one is not, it holds the review for the operator instead, and is never filed for a runner.

const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n a\n+b';
const ENV_KEYS = ['FOREMAN_SKILLS_DIR', 'FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_CLAUDE_BIN', 'FOREMAN_LOCAL_ONLY'];
const OTHER_OS = process.platform === 'linux' ? 'Windows' : 'Linux';

const pbText = `---\n${JSON.stringify({
  id: 'solo',
  description: 'a one-reviewer crew',
  triggers: ['x'],
  roles: { architect: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'architect', style: 'code-review' }],
  escalation: { chair: 'architect', afterFailures: 9 },
  checks: [],
  gate: { default: 'human', hardHuman: ['S2'] },
  constraints: [],
}, null, 2)}\n---\n\n## role: architect\n\nYou review.\n\n## role: dev\n\nYou implement.\n`;

const envelope = (result: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

const REBASE = { title: '(operator) Rebase the ticket branch onto main', prompt: 'The branch predates the commit this ticket builds on; the sandbox blocks git rebase.', severity: 'blocker', role: 'dev' };
const DEFECT = { title: 'Fix the off-by-one in paging', prompt: 'The last row of every page is dropped.', severity: 'blocker', role: 'dev' };
const ELSEWHERE = { title: 'Re-run the capture', prompt: `Re-run the capture script on ${OTHER_OS} and commit the output.`, severity: 'blocker', role: 'dev' };
const NORMAL = { title: 'Rename the helper', prompt: 'Taste.', severity: 'normal', role: 'dev' };

async function scenario(
  review: { verdict: 'pass' | 'fail'; issues: Array<Record<string, unknown>> },
  fn: (o: { out: CrewVerdict | null; store: Store; taskId: string }) => void,
): Promise<void> {
  const base = fs.realpathSync(scratchDir('foreman-opblockers-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const pbDir = path.join(base, 'playbooks');
  const skills = path.join(base, 'skills-repo');
  fs.mkdirSync(pbDir);
  fs.mkdirSync(path.join(skills, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(pbDir, 'solo.md'), pbText);
  fs.writeFileSync(path.join(base, 'reply'), envelope(JSON.stringify({
    verdict: review.verdict, critique: `${review.verdict} critique`, issues: review.issues,
    acceptance: [{ item: 1, status: 'met', note: 'x' }],
  })));
  const bin = path.join(base, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${base}/reply"\n`);
  fs.chmodSync(bin, 0o755);
  Object.assign(process.env, { FOREMAN_SKILLS_DIR: skills, FOREMAN_PLAYBOOKS_DIR: pbDir, FOREMAN_CLAUDE_BIN: bin, FOREMAN_LOCAL_ONLY: '0' });
  clearSkillCache();
  clearPlaybookCache();
  const store = new Store(':memory:');
  try {
    const t = store.addTask({ title: 'Paginate', prompt: 'Show 20 rows per page.', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'solo', acceptance: '1. 20 rows' });
    const out = await crewReview({ task: store.getTask(t.id)!, runId: store.startRun(t.id).id, store, diff: DIFF });
    fn({ out, store, taskId: t.id });
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

const titles = (store: Store, id: string): string[] => store.childrenOf(id).map((c) => c.title).sort();

test('a blocker tagged (operator) holds a passing review for the operator: no repair round, nothing filed', async () => {
  await scenario({ verdict: 'pass', issues: [REBASE, NORMAL] }, ({ out, store, taskId }) => {
    assert.equal(out?.verdict, 'split');
    assert.match(out?.critique ?? '', /FOR THE OPERATOR[^]*Rebase the ticket branch onto main/);
    assert.doesNotMatch(out?.critique ?? '', /BLOCKERS TO FIX/);
    assert.doesNotMatch(out?.critique ?? '', /blocking issue\(s\) raised on an otherwise passing review/, 'not presented as the worker\'s failure');
    assert.deepEqual(titles(store, taskId), [NORMAL.title], 'the operator blocker is not filed; the follow-up is');
  });
});

test('a failing review with an (operator) blocker is held too; its other blockers are listed for the operator, not repaired or filed', async () => {
  await scenario({ verdict: 'fail', issues: [REBASE, DEFECT] }, ({ out, store, taskId }) => {
    assert.equal(out?.verdict, 'split');
    const critique = out?.critique ?? '';
    assert.match(critique, /FOR THE OPERATOR[^]*Rebase the ticket branch[^]*not repaired or filed[^]*off-by-one/);
    assert.doesNotMatch(critique, /BLOCKERS TO FIX IN THIS REPAIR/, 'no repair runs on a held review');
    assert.deepEqual(titles(store, taskId), []);
  });
});

test('an untagged blocker that asks for work on another host is held as if tagged', async () => {
  await scenario({ verdict: 'pass', issues: [ELSEWHERE] }, ({ out, store, taskId }) => {
    assert.equal(out?.verdict, 'split');
    assert.match(out?.critique ?? '', /FOR THE OPERATOR[^]*Re-run the capture/);
    assert.deepEqual(titles(store, taskId), []);
  });
});

test('an ordinary blocker still fails a passing review and goes into the repair, as before', async () => {
  await scenario({ verdict: 'pass', issues: [DEFECT] }, ({ out }) => {
    assert.equal(out?.verdict, 'fail');
    assert.match(out?.critique ?? '', /BLOCKERS TO FIX[^]*off-by-one/);
    assert.doesNotMatch(out?.critique ?? '', /FOR THE OPERATOR/);
  });
});

test('the reviewer is told to tag a blocker the worker cannot act on as (operator)', () => {
  const base = fs.realpathSync(scratchDir('foreman-opblockers-prompt-'));
  const pbDir = path.join(base, 'playbooks');
  fs.mkdirSync(pbDir);
  fs.writeFileSync(path.join(pbDir, 'solo.md'), pbText);
  const saved = process.env['FOREMAN_PLAYBOOKS_DIR'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  clearPlaybookCache();
  try {
    const pb = getPlaybook('solo')!;
    const store = new Store(':memory:');
    const t = store.addTask({ title: 'T', prompt: 'p', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'solo' });
    const prompt = buildReviewPrompt(pb, pb.reviewers[0]!, store.getTask(t.id)!, DIFF);
    store.close();
    assert.match(prompt, /blocker[^\n]*cannot act on[^]*"\(operator\)"/i);
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = saved;
    clearPlaybookCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

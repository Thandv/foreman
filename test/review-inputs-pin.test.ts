import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReviewPrompt } from '../src/verify/crewReview.ts';
import { getPlaybook } from '../src/playbooks.ts';
import type { Task } from '../src/types.ts';

/**
 * The review prompt for a code-only diff with a short worker report, pinned
 * byte for byte against main at 6a87d08 (the commit fix/review-inputs was cut
 * from). The fixtures were written by this file itself on that commit
 * (REVIEW_PIN_WRITE=1), before any source change of the branch.
 */

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'review-inputs');

const PLAYBOOK = `---\n${JSON.stringify({
  id: 'pin',
  description: 'One reviewer, one chair.',
  triggers: ['pin'],
  roles: { planner: { tier: 'owner' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'senior', style: 'code-review' }],
  escalation: { chair: 'planner', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  constraints: ['Keep diffs minimal.'],
}, null, 2)}\n---\n\n## role: planner\n\nYou chair the crew.\n\n## role: senior\n\nYou review what you did not write.\n\n## role: dev\n\nYou implement the ticket.\n`;

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,2 +1,3 @@',
  ' export function auth(token) {',
  '+  if (!token) return null;',
  '   return verify(token);',
  'diff --git a/test/auth.test.ts b/test/auth.test.ts',
  '--- a/test/auth.test.ts',
  '+++ b/test/auth.test.ts',
  '@@ -3,0 +4,3 @@',
  "+test('a request without a token is refused', () => {",
  '+  assert.equal(auth(undefined), null);',
  '+});',
].join('\n');

const REPORT = [
  'DONE: auth() returns null for a missing token.',
  'CHANGED: src/auth.ts, test/auth.test.ts',
  '',
  'ACCEPTANCE MAP',
  '1. test/auth.test.ts :: a request without a token is refused',
].join('\n');

const TRACKED = 'FILES ALREADY TRACKED IN THIS TREE (3):\n  README.md\n  src/auth.ts\n  test/auth.test.ts';

const task = (acceptance: string): Task => ({
  id: 't_pin', title: 'Implement token auth', prompt: 'Add bearer-token auth to the API.', kind: 'code',
  runner: 'claude-code', role: 'dev', playbook: 'pin', acceptance, sensitivity: 'S1',
} as unknown as Task);

function prompts(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pin-pb-'));
  const before = { pb: process.env['FOREMAN_PLAYBOOKS_DIR'], skills: process.env['FOREMAN_SKILLS_DIR'] };
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  delete process.env['FOREMAN_SKILLS_DIR'];
  try {
    fs.writeFileSync(path.join(dir, 'pin.md'), PLAYBOOK);
    const pb = getPlaybook('pin')!;
    const r = pb.reviewers[0]!;
    const gate = { ran: true, passed: true, cmd: 'npm run verify' };
    return {
      // No numbered acceptance item: nothing of this branch applies.
      'pin-code-only-unnumbered.txt': buildReviewPrompt(pb, r, task('requests without a token get 401'), DIFF, false, gate, TRACKED, REPORT),
      // Numbered acceptance: the one block this branch adds is the ACCEPTANCE STATUS contract.
      'pin-code-only-numbered.txt': buildReviewPrompt(pb, r, task('1. requests without a token get 401\n2. npm run verify passes'), DIFF, false, gate, TRACKED, REPORT),
    };
  } finally {
    if (before.pb === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR']; else process.env['FOREMAN_PLAYBOOKS_DIR'] = before.pb;
    if (before.skills !== undefined) process.env['FOREMAN_SKILLS_DIR'] = before.skills;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a code-only diff with a short report and no numbered acceptance: the review prompt is byte-identical to main', () => {
  const now = prompts();
  if (process.env['REVIEW_PIN_WRITE'] === '1') {
    for (const [name, text] of Object.entries(now)) fs.writeFileSync(path.join(FIXTURES, name), text);
    return;
  }
  assert.equal(now['pin-code-only-unnumbered.txt'], fs.readFileSync(path.join(FIXTURES, 'pin-code-only-unnumbered.txt'), 'utf8'));
});

test('with numbered acceptance the one block added to that prompt is the ACCEPTANCE STATUS contract; the rest is main byte for byte', () => {
  const now = prompts()['pin-code-only-numbered.txt']!;
  const main = fs.readFileSync(path.join(FIXTURES, 'pin-code-only-numbered.txt'), 'utf8');
  const from = now.indexOf('ACCEPTANCE STATUS — required.');
  const to = now.indexOf('\n\n', from);
  assert.ok(from > 0 && to > from, 'the contract is one block');
  // Item 2 only says the gate passes, and the gate passed: one item is asked for.
  assert.match(now.slice(from, to), /for each of these numbered acceptance items: 1\.\n/);
  assert.equal(now.slice(0, from) + now.slice(to + 2), main);
});

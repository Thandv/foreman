import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaybooksFrom, type Playbook } from '../src/playbooks.ts';
import { probeTask } from '../src/types.ts';
import { buildReviewPrompt, reviewerRoleBlock } from '../src/verify/crewReview.ts';

const catalog = loadPlaybooksFrom('playbooks');
const software = (): Playbook => {
  const pb = catalog.playbooks.find((p) => p.id === 'software');
  assert.ok(pb, 'the software playbook loads');
  return pb;
};
const task = probeTask({ title: 'T', prompt: 'the brief', playbook: 'software', role: 'dev', acceptance: '1. works' });

test("a crew review carries the reviewer's own role prompt, between the style and the reply contract", () => {
  const pb = software();
  for (const reviewer of pb.reviewers) {
    const prompt = buildReviewPrompt(pb, reviewer, task, 'diff body');
    const at = (needle: string): number => {
      const i = prompt.indexOf(needle);
      assert.ok(i >= 0, `${needle} is in the ${reviewer.role} review prompt`);
      return i;
    };
    const roleText = pb.rolePrompts[reviewer.role]!.trim();
    assert.ok(prompt.includes(roleText), `the whole ${reviewer.role} prompt reaches its review`);
    assert.ok(at('REVIEW STYLE (') < at(`YOUR ROLE (${reviewer.role}, from the software playbook)`), 'after the style');
    assert.ok(at(`YOUR ROLE (${reviewer.role}`) < at('Reply with JSON only'), 'before the reply contract, which still binds');
    assert.ok(at(`YOUR ROLE (${reviewer.role}`) < at('WORK UNDER REVIEW'), 'static, before the per-ticket content');
    assert.match(prompt, /You have no tools in this review/);
    // The role's "Report back" (critical/important/minor) must not outrank the JSON reply: the header says so.
    assert.match(prompt, /the reply contract below decides the shape[^\n]*severity "blocker" \(a critical finding\) or "normal"/);
  }
});

test("the senior's review prompt carries its severity and break-the-change guidance", () => {
  const pb = software();
  const senior = pb.reviewers.find((r) => r.role === 'senior')!;
  const prompt = buildReviewPrompt(pb, senior, task, 'diff body');
  assert.match(prompt, /severity\s+\(critical,\s+important,\s+minor\)/);
  assert.match(prompt, /would\s+still\s+pass\s+with\s+the\s+change\s+reverted/);
});

test('a role with no prompt adds nothing, and a long one is cut at the bound with the marker', () => {
  const pb = software();
  assert.equal(reviewerRoleBlock({ ...pb, rolePrompts: { ...pb.rolePrompts, senior: '   ' } }, 'senior'), '');
  assert.equal(reviewerRoleBlock(pb, 'no-such-role'), '');
  const long = 'x'.repeat(10_000);
  const block = reviewerRoleBlock({ ...pb, rolePrompts: { ...pb.rolePrompts, senior: long } }, 'senior');
  assert.ok(block.length < 5_000, `bounded (${block.length})`);
  assert.match(block, /FOREMAN cut this section here at 4000 bytes/);
});

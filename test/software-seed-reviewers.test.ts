import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybooksFrom, type Playbook, type PlaybookCatalog } from '../src/playbooks.ts';
import { checkTicketSkills, clearSkillCache } from '../src/skills.ts';
import { planSkillsSection } from '../src/assistant/crewPlan.ts';
import { buildReviewPrompt } from '../src/verify/crewReview.ts';
import { config } from '../src/config.ts';
import { probeTask } from '../src/types.ts';

// The skills repo is never read: a fixture mirrors the FM-E0 loadouts for software.architect and software.senior
// (read by the operator from foreman-skills at main 7a1fd9d).

const LOADOUTS = {
  roles: {
    'software.architect': { default: ['architecture-decision'], allowed: ['review-architecture', 'security-review'] },
    'software.senior': {
      default: ['review-correctness', 'review-silent-failures'],
      allowed: ['review-test-quality', 'security-review', 'architecture-decision', 'review-architecture'],
    },
  },
};
const ALL = ['architecture-decision', 'review-architecture', 'security-review', 'review-correctness', 'review-silent-failures', 'review-test-quality'];

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify({ name, description: `the ${name} procedure`, roles: ['software.architect', 'software.senior'], kinds: ['code'], when: 'always', status: 'draft' }),
  );
  fs.writeFileSync(path.join(dir, 'full.md'), `FULL-BODY-${name}\n`);
  fs.writeFileSync(path.join(dir, 'card.md'), `CARD-${name}\n`);
}

/** The repo seed loaded against a fixture skills dir that has all of `names`; fn runs while the env points at it. */
function withSeed<T>(names: string[], fn: (c: PlaybookCatalog, pb: Playbook) => T): T {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-seed-')));
  const saved = process.env['FOREMAN_SKILLS_DIR'];
  try {
    const root = path.join(base, 'repo');
    const pbDir = path.join(base, 'playbooks');
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.mkdirSync(pbDir, { recursive: true });
    for (const n of names) writeSkill(root, n);
    fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify(LOADOUTS));
    fs.copyFileSync(path.join(config.sourceRoot, 'playbooks', 'software.md'), path.join(pbDir, 'software.md'));
    process.env['FOREMAN_SKILLS_DIR'] = root;
    clearSkillCache();
    const c = loadPlaybooksFrom(pbDir);
    assert.deepEqual(c.refused, []);
    const pb = c.playbooks.find((p) => p.id === 'software');
    assert.ok(pb);
    return fn(c, pb);
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_SKILLS_DIR'];
    else process.env['FOREMAN_SKILLS_DIR'] = saved;
    clearSkillCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const task = probeTask({ title: 'T', prompt: 'the brief', playbook: 'software', role: 'dev', acceptance: '1. works' });

test('the software seed loads against the FM-E0 loadouts with no warnings', () => {
  withSeed(ALL, (c) => assert.deepEqual(c.warnings, []));
});

test('the software seed has the senior then the architect as its two reviewers, the architect naming both skills', () => {
  withSeed(ALL, (_c, pb) => {
    assert.deepEqual(pb.reviewers, [
      { role: 'senior', style: 'code-review' },
      { role: 'architect', style: 'code-review', skills: ['review-architecture', 'security-review'] },
    ]);
  });
});

test('a fixture without review-architecture warns about the architect reviewer and serves it only security-review', () => {
  withSeed(ALL.filter((n) => n !== 'review-architecture'), (c, pb) => {
    assert.equal(c.warnings.length, 1);
    assert.equal(c.warnings[0]!.playbook, 'software');
    assert.equal(c.warnings[0]!.reviewer, 1);
    assert.equal(c.warnings[0]!.role, 'architect');
    assert.equal(c.warnings[0]!.skill, 'review-architecture');
    const prompt = buildReviewPrompt(pb, pb.reviewers[1]!, task, 'diff body');
    assert.match(prompt, /## security-review\nFULL-BODY-security-review/);
    assert.doesNotMatch(prompt, /FULL-BODY-(review-architecture|architecture-decision)/);
    assert.match(prompt, /Foreman left out: review-architecture/);
  });
});

test('the code-review prompt has no senior-specific wording, and the architect gets the same style text as the senior', () => {
  withSeed(ALL, (_c, pb) => {
    const senior = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'diff body');
    const architect = buildReviewPrompt(pb, pb.reviewers[1]!, task, 'diff body');
    const style = (p: string): string => p.slice(0, p.indexOf('\n\n'));
    assert.equal(style(architect), style(senior));
    assert.doesNotMatch(style(architect), /senior/i);
    assert.match(architect, /REVIEW STYLE \(code-review\)/);
  });
});

test('with the seed, review-architecture and security-review are not offered for architect tickets', () => {
  withSeed(ALL, (_c, pb) => {
    const menu = planSkillsSection(pb).text;
    assert.doesNotMatch(menu, /^- architect: /m);
    // No reviewer entry of the senior names them: its menu is as the loadout says.
    assert.match(menu, /^- senior: default review-correctness, review-silent-failures; may carry instead review-test-quality, security-review, architecture-decision, review-architecture$/m);
  });
});

test('checkTicketSkills still accepts review-architecture and security-review on an architect ticket: the menu filter is not a permission', () => {
  withSeed(ALL, () => {
    const check = checkTicketSkills({ playbook: 'software', role: 'architect' }, ['review-architecture', 'security-review']);
    assert.deepEqual(check.refused, []);
    assert.deepEqual(check.names, ['review-architecture', 'security-review']);
  });
});

// The role section is the architect worker's brief (roles.ts roleAgent); a crew review prompt carries no role text,
// so the architect reviewer's procedure comes from its review-architecture skill, not from this paragraph.
test('the architect role section carries a When reviewing paragraph: quote diff lines, do not redesign', () => {
  withSeed(ALL, (_c, pb) => {
    const text = pb.rolePrompts['architect']!;
    assert.match(text, /When reviewing/);
    assert.match(text, /boundaries, coupling direction, failure\s+isolation and security/);
    assert.match(text, /Quote the diff lines/);
    assert.match(text, /Do not redesign/);
  });
});

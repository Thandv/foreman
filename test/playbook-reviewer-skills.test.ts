import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybooksFrom, type PlaybookCatalog } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';

// Every fixture lives in a temp dir; the real skills repository is never read.

const BODY = `
## role: lead

You lead the work and review it for correctness.

## role: dev

You implement exactly what the ticket asks.
`;

function writeSkill(root: string, name: string, roles: string[]): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify({ name, description: `the ${name} procedure`, roles, kinds: ['code'], when: `Use ${name} when needed.`, status: 'draft' }),
  );
  fs.writeFileSync(path.join(dir, 'full.md'), `1. FULL-${name}\n`);
  fs.writeFileSync(path.join(dir, 'card.md'), `1. CARD-${name}\n`);
}

/**
 * A playbook `soft` whose one reviewer is `lead`. With skills on, soft.lead has
 * default [review] and may also carry a1, a2, a3; `devonly` is a loaded skill
 * for soft.dev that soft.lead's loadout does not offer.
 */
function load(reviewer: Record<string, unknown>, skillsOn = true): PlaybookCatalog {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-reviewer-skills-')));
  const saved = process.env['FOREMAN_SKILLS_DIR'];
  try {
    const root = path.join(base, 'repo');
    const pbDir = path.join(base, 'playbooks');
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.mkdirSync(pbDir, { recursive: true });
    for (const n of ['review', 'a1', 'a2', 'a3']) writeSkill(root, n, ['soft.lead']);
    writeSkill(root, 'devonly', ['soft.dev']);
    fs.writeFileSync(
      path.join(root, 'loadouts.json'),
      JSON.stringify({ roles: { 'soft.lead': { default: ['review'], allowed: ['a1', 'a2', 'a3'] }, 'soft.dev': { default: [], allowed: ['devonly'] } } }),
    );
    if (skillsOn) process.env['FOREMAN_SKILLS_DIR'] = root;
    else delete process.env['FOREMAN_SKILLS_DIR'];
    clearSkillCache();
    const fm = {
      id: 'soft',
      description: 'a test crew',
      triggers: ['code'],
      roles: { lead: { tier: 'senior' }, dev: { tier: 'worker' } },
      reviewers: [{ role: 'dev', style: 'peer-review' }, { role: 'lead', style: 'code-review', ...reviewer }],
      escalation: { chair: 'lead', afterFailures: 2 },
      checks: [],
      gate: { default: 'human', hardHuman: ['S2'] },
      constraints: ['Never do the bad thing.'],
    };
    fs.writeFileSync(path.join(pbDir, 'soft.md'), `---\n${JSON.stringify(fm)}\n---\n${BODY}`);
    return loadPlaybooksFrom(pbDir);
  } finally {
    if (saved === undefined) delete process.env['FOREMAN_SKILLS_DIR'];
    else process.env['FOREMAN_SKILLS_DIR'] = saved;
    clearSkillCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const skillsOf = (c: PlaybookCatalog): string[] | undefined => c.playbooks[0]!.reviewers[1]!.skills;

test('a reviewer keeps 0, 1 and 2 valid skills', () => {
  for (const names of [[], ['a1'], ['a1', 'a2']]) {
    const c = load({ skills: names });
    assert.deepEqual(c.refused, []);
    assert.deepEqual(skillsOf(c), names);
    assert.deepEqual(c.warnings, []);
  }
});

test('a third skill is dropped with a warning naming the reviewer and skill', () => {
  const c = load({ skills: ['a1', 'a2', 'a3'] });
  assert.deepEqual(skillsOf(c), ['a1', 'a2']);
  assert.equal(c.warnings.length, 1);
  assert.equal(c.warnings[0]!.playbook, 'soft');
  assert.equal(c.warnings[0]!.reviewer, 1);
  assert.equal(c.warnings[0]!.role, 'lead');
  assert.equal(c.warnings[0]!.skill, 'a3');
});

// A well-formed name the catalog will not serve is warned about and kept: crew review checks it against the catalog
// as it is when it serves (test/crewreview-skills.test.ts), so the list is not frozen to the catalog of the first load.
test('an unknown skill name warns and is kept for crew review to check again', () => {
  const c = load({ skills: ['nope', 'a1'] });
  assert.deepEqual(skillsOf(c), ['nope', 'a1']);
  assert.deepEqual(c.warnings.map((w) => [w.reviewer, w.role, w.skill]), [[1, 'lead', 'nope']]);
});

test('a skill outside the reviewer role loadout warns and is kept for crew review to check again', () => {
  const c = load({ skills: ['devonly'] });
  assert.deepEqual(skillsOf(c), ['devonly']);
  assert.deepEqual(c.warnings.map((w) => [w.reviewer, w.role, w.skill]), [[1, 'lead', 'devonly']]);
});

test('a non-array skills value loads the playbook with no skills, not the role default', () => {
  const c = load({ skills: 'a1' });
  assert.equal(c.playbooks.length, 1);
  assert.deepEqual(skillsOf(c), []);
  assert.equal(c.warnings.length, 1);
  assert.equal(c.warnings[0]!.role, 'lead');
  assert.equal(c.warnings[0]!.reviewer, 1);
});

test('a list with no well-formed name is [] and never the role default review', () => {
  const c = load({ skills: ['Bad Name', 'nope'] });
  assert.deepEqual(skillsOf(c), ['nope']);
  assert.equal(c.warnings.length, 2);
  const none = load({ skills: ['Bad Name', 'Also Bad'] });
  assert.deepEqual(skillsOf(none), []);
  assert.equal(none.warnings.length, 2);
});

test('a reviewer with no skills key parses exactly as before', () => {
  const c = load({});
  assert.deepEqual(c.playbooks[0]!.reviewers, [
    { role: 'dev', style: 'peer-review' },
    { role: 'lead', style: 'code-review' },
  ]);
  assert.equal('skills' in c.playbooks[0]!.reviewers[1]!, false);
  assert.deepEqual(c.warnings, []);
});

test('with skills off there is no loadout warning and a valid list is kept', () => {
  const c = load({ skills: ['devonly', 'unheard-of'] }, false);
  assert.deepEqual(skillsOf(c), ['devonly', 'unheard-of']);
  assert.deepEqual(c.warnings, []);
});

test('with skills off the shape and the name are still checked', () => {
  const bad = load({ skills: 'a1' }, false);
  assert.deepEqual(skillsOf(bad), []);
  assert.equal(bad.warnings.length, 1);
  const names = load({ skills: ['Bad Name', 'a1', 'a2', 'a3'] }, false);
  assert.deepEqual(skillsOf(names), ['a1', 'a2']);
  assert.deepEqual(names.warnings.map((w) => w.skill), ['Bad Name', 'a3']);
});

test('skills.ts reaches playbooks.ts by a type-only import', () => {
  const src = fs.readFileSync(new URL('../src/skills.ts', import.meta.url), 'utf8');
  const edges = src.split('\n').filter((l) => /^\s*import\b.*['"]\.\/playbooks\.ts['"]/.test(l));
  assert.ok(edges.length > 0);
  for (const l of edges) assert.match(l, /^import type\b/);
  assert.doesNotMatch(src, /import\s*\{[^}]*\btype\b[^}]*\}\s*from\s*['"]\.\/playbooks\.ts['"]/);
});

test('a repeated name counts once, with skills on and off alike', () => {
  for (const on of [true, false]) {
    const c = load({ skills: ['a1', 'a1', 'a2'] }, on);
    assert.deepEqual(skillsOf(c), ['a1', 'a2']);
    assert.deepEqual(c.warnings, []);
  }
});

test('an over-long list is one warning and no skills, with skills on and off alike', () => {
  for (const on of [true, false]) {
    const c = load({ skills: Array.from({ length: 1000 }, (_, i) => `x${i}`) }, on);
    assert.deepEqual(skillsOf(c), []);
    assert.equal(c.warnings.length, 1);
    assert.equal(c.warnings[0]!.skill, '(1000 names)');
  }
});

test('a null skills value warns with skills on and off alike', () => {
  for (const on of [true, false]) {
    const c = load({ skills: null }, on);
    assert.equal(c.playbooks.length, 1);
    assert.deepEqual(skillsOf(c), []);
    assert.equal(c.warnings.length, 1);
    assert.equal(c.warnings[0]!.skill, '(not a list)');
  }
});

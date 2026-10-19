import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSkillsSection } from '../src/assistant/crewPlan.ts';
import { clearPlaybookCache, getPlaybook, loadPlaybooks, type Playbook } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';

// The planner's TICKET SKILLS menu at the edges of its two rules: what a reviewer entry hides from a role's menu,
// and when the plan check is told something was lost. A temp skills repo and playbooks dir per test.

interface Skill { name: string; when: string }

function withMenu(
  skills: Skill[],
  dev: { default: string[]; allowed: string[] },
  front: Record<string, unknown>,
  fn: (pb: Playbook) => void,
): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-planner-menu-')));
  const saved = { skills: process.env['FOREMAN_SKILLS_DIR'], playbooks: process.env['FOREMAN_PLAYBOOKS_DIR'] };
  try {
    const root = path.join(base, 'repo');
    const pbDir = path.join(base, 'playbooks');
    fs.mkdirSync(pbDir, { recursive: true });
    for (const s of skills) {
      const dir = path.join(root, 'skills', s.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ name: s.name, description: `the ${s.name} procedure`, roles: ['menu.dev'], kinds: ['code'], when: s.when, status: 'draft' }));
      fs.writeFileSync(path.join(dir, 'full.md'), `1. ${s.name}: do the thing.\n`);
      fs.writeFileSync(path.join(dir, 'card.md'), `1. ${s.name}.\n`);
    }
    fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify({ roles: { 'menu.dev': dev } }));
    const fm = {
      id: 'menu', description: 'a test crew', triggers: ['code'],
      roles: { lead: { tier: 'senior' }, dev: { tier: 'worker' } },
      reviewers: [{ role: 'lead', style: 'code-review' }],
      escalation: { chair: 'lead', afterFailures: 2 }, checks: [], gate: { default: 'human', hardHuman: ['S2'] },
      ...front,
    };
    fs.writeFileSync(path.join(pbDir, 'menu.md'), `---\n${JSON.stringify(fm, null, 2)}\n---\n\n## role: lead\n\nYou review.\n\n## role: dev\n\nYou build.\n`);
    process.env['FOREMAN_SKILLS_DIR'] = root;
    process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
    clearSkillCache();
    clearPlaybookCache();
    const pb = getPlaybook('menu');
    assert.ok(pb, JSON.stringify(loadPlaybooks().refused));
    fn(pb);
  } finally {
    for (const [key, value] of [['FOREMAN_SKILLS_DIR', saved.skills], ['FOREMAN_PLAYBOOKS_DIR', saved.playbooks]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearSkillCache();
    clearPlaybookCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const short = (name: string): Skill => ({ name, when: `Use ${name} when the ticket calls for it.` });

test('a skill a reviewer entry names stays on the menu when it is the role\'s loadout default and the playbook carries another', () => {
  withMenu(
    ['one', 'two', 'debug', 'docs'].map(short),
    { default: ['one', 'two'], allowed: ['debug', 'docs'] },
    {
      skills: { dev: ['debug'] },
      reviewers: [{ role: 'lead', style: 'code-review' }, { role: 'dev', style: 'code-review', skills: ['one', 'docs'] }],
    },
    (pb) => {
      // `one` is the loadout's ticket default, so a dev ticket may still be given it; `docs` is the reviewer's alone.
      assert.match(planSkillsSection(pb).text, /^- dev: default debug; may carry instead one, two$/m);
    },
  );
});

test('when only the defaults\' `when` lines go and no other skill has one, nothing the planner chooses by is lost', () => {
  // The defaults' lines alone overflow the cap; the skills a ticket may carry instead have no `when` line at all.
  const long = (name: string): Skill => ({ name, when: `Use ${name} when the ticket calls for it. ${'x'.repeat(900)}` });
  withMenu(
    [long('one'), long('two'), { name: 'debug', when: '' }],
    { default: ['one', 'two'], allowed: ['debug'] },
    {},
    (pb) => {
      const out = planSkillsSection(pb);
      assert.match(out.text, /^- dev: default one, two; may carry instead debug$/m);
      assert.doesNotMatch(out.text, /USE A SKILL WHEN:|more not shown/);
      assert.equal(out.lost, null);
    },
  );
});

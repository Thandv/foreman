import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybooks, type Playbook } from '../src/playbooks.ts';
import { missingTools, roleAgent, toolBrief } from '../src/roles.ts';

/**
 * A toolbox nobody is told about is a toolbox nobody uses. Ten book-relevant
 * tools sat in the catalog — prose-gate, numeral-tic, continuity-check,
 * find-artifacts, book-lint — while every drafting ticket went out mentioning
 * none of them, so each run either rediscovered them or, far more often, did
 * the job by hand and less well.
 */

function withPlaybook(front: Record<string, unknown>, body: string, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-pbt-'));
  const prev = process.env['FOREMAN_PLAYBOOKS_DIR'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  try {
    fs.writeFileSync(path.join(dir, `${front['id']}.md`), `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`);
    loadPlaybooks();
    fn();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    loadPlaybooks();
  }
}

const PB = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'tooltest',
  description: 'fixture',
  triggers: [],
  roles: { author: { tier: 'worker' }, editor: { tier: 'senior' } },
  reviewers: [],
  escalation: { chair: 'editor', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: [] },
  ...over,
});
const BODY = '## role: author\nwrite it\n\n## role: editor\nedit it\n';

const get = (): Playbook => loadPlaybooks().playbooks.find((p) => p.id === 'tooltest')!;

test('a role carries its tools into the prompt it is given', () => {
  withPlaybook(PB({ tools: { author: [{ name: 'prose-gate', when: 'before you call a draft done' }] } }), BODY, () => {
    const brief = toolBrief(get(), 'author');
    assert.match(brief, /prose-gate/);
    assert.match(brief, /before you call a draft done/);
    assert.match(brief, /use_tool/, 'it must say how to call them');
    // And it reaches the agent the runner actually uses.
    assert.match(roleAgent(get(), 'author').systemPrompt, /prose-gate/);
  });
});

test('a role with no declared tools gets no tool section at all', () => {
  withPlaybook(PB({ tools: { author: [{ name: 'prose-gate', when: '' }] } }), BODY, () => {
    assert.equal(toolBrief(get(), 'editor'), '', 'no empty heading for a role that declares nothing');
  });
});

test('the manifest supplies what a tool does, so the playbook never duplicates it', () => {
  withPlaybook(PB({ tools: { author: ['prose-gate'] } }), BODY, () => {
    const brief = toolBrief(get(), 'author');
    // 'prose-gate' is a real catalog tool; its own description should appear.
    assert.match(brief, /AI-tics|checklist|manuscript/i);
  });
});

test('a tool the catalog does not have is a standing request, not a silent drop', () => {
  // Refusing the playbook would throw the request away; dropping the line would
  // lose it. The forge exists to answer it.
  withPlaybook(PB({ tools: { author: [{ name: 'seam-differ', when: 'to compare chapter joins' }] } }), BODY, () => {
    const pb = get();
    assert.ok(pb, 'the playbook must still load');
    const brief = toolBrief(pb, 'author');
    assert.match(brief, /seam-differ/);
    assert.match(brief, /NOT IN THE CATALOG YET/);
    assert.match(brief, /build_tool/);

    const missing = missingTools(pb);
    assert.deepEqual(missing.map((m) => m.tool), ['seam-differ']);
    assert.equal(missing[0]!.role, 'author');
    assert.equal(missing[0]!.when, 'to compare chapter joins');
  });
});

test('a plain string is shorthand for a tool with no note', () => {
  withPlaybook(PB({ tools: { author: ['numeral-tic'] } }), BODY, () => {
    assert.deepEqual(get().tools['author'], [{ name: 'numeral-tic', when: '' }]);
  });
});

test('tools naming a role that does not exist refuses the playbook', () => {
  // A tool list attached to nothing is a typo, and a typo in a playbook is how
  // a role silently loses its tools.
  withPlaybook(PB({ tools: { nobody: ['prose-gate'] } }), BODY, () => {
    const cat = loadPlaybooks();
    assert.equal(cat.playbooks.find((p) => p.id === 'tooltest'), undefined);
    assert.match(cat.refused.map((r) => r.reason).join(' '), /not defined in roles/);
  });
});

test('a tool name the catalog could never register is refused at load', () => {
  withPlaybook(PB({ tools: { author: ['../../etc/passwd'] } }), BODY, () => {
    const cat = loadPlaybooks();
    assert.match(cat.refused.map((r) => r.reason).join(' '), /invalid tool name/);
  });
});

test('the shipped playbooks all declare tools, and every one of them exists', () => {
  // The regression that matters: a seed playbook naming a tool nobody built
  // would ship a standing request to every operator who runs `crew init`.
  const cat = loadPlaybooks();
  for (const pb of cat.playbooks) {
    assert.ok(Object.keys(pb.tools).length > 0, `${pb.id} declares no tools for any role`);
  }
  assert.deepEqual(cat.playbooks.flatMap((p) => missingTools(p)), []);
});

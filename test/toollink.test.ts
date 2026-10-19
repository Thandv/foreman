import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkToolToPlaybook, parseToolRequest } from '../src/tools/link.ts';
import { loadPlaybooks } from '../src/playbooks.ts';

/**
 * The forge could already build a tool on demand — a run decides it wants one,
 * `build_tool` queues a real task, it passes its own tests, survives an
 * admission scan and a human approves it. And then nothing remembered. The tool
 * sat in the catalog unmentioned by any role, so the next epic of the same
 * shape rediscovered the same need. A tool built for a task today should be a
 * habit tomorrow.
 */

const PB = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'linktest',
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

function withPlaybookDir(front: Record<string, unknown>, fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-link-'));
  const prev = process.env['FOREMAN_PLAYBOOKS_DIR'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  const file = path.join(dir, `${front['id']}.md`);
  try {
    fs.writeFileSync(file, `---\n${JSON.stringify(front, null, 2)}\n---\n${BODY}`);
    loadPlaybooks();
    fn(file);
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    loadPlaybooks();
  }
}

test('a tool task records who asked for it, in a line all three callers can write', () => {
  // A tool task can be queued by hand, by the planner, or by a worker calling
  // build_tool. A line of text is the one channel all three already have.
  const req = parseToolRequest('for publishing.author: to compare chapter joins\n\nBuild a tool that…');
  assert.deepEqual(req, { playbook: 'publishing', role: 'author', when: 'to compare chapter joins' });
  assert.equal(parseToolRequest('Build a tool that does a thing'), null, 'no request is null, never a guess');
});

test('an approved tool is written onto the role that wanted it', () => {
  withPlaybookDir(PB(), (file) => {
    const r = linkToolToPlaybook('seam-differ', { playbook: 'linktest', role: 'author', when: 'at every join' });
    assert.equal(r.linked, true, r.reason);

    const pb = loadPlaybooks().playbooks.find((p) => p.id === 'linktest')!;
    assert.deepEqual(pb.tools['author'], [{ name: 'seam-differ', when: 'at every join' }]);
    // And it survives on disk as valid front matter, not just in memory.
    assert.match(fs.readFileSync(file, 'utf8'), /"seam-differ"/);
  });
});

test('an existing tool list is appended to, never replaced', () => {
  withPlaybookDir(PB({ tools: { author: ['prose-gate'] } }), () => {
    linkToolToPlaybook('seam-differ', { playbook: 'linktest', role: 'author', when: 'at every join' });
    const pb = loadPlaybooks().playbooks.find((p) => p.id === 'linktest')!;
    assert.deepEqual(pb.tools['author']!.map((t) => t.name), ['prose-gate', 'seam-differ']);
  });
});

test('linking the same tool twice is a no-op, not a duplicate', () => {
  // Otherwise every rebuild of a tool appends another line to the playbook.
  withPlaybookDir(PB({ tools: { author: [{ name: 'seam-differ', when: 'x' }] } }), () => {
    const r = linkToolToPlaybook('seam-differ', { playbook: 'linktest', role: 'author', when: 'y' });
    assert.equal(r.linked, false);
    assert.match(r.reason, /already linked/);
    const pb = loadPlaybooks().playbooks.find((p) => p.id === 'linktest')!;
    assert.equal(pb.tools['author']!.length, 1);
  });
});

test('a role the playbook does not have is refused rather than invented', () => {
  withPlaybookDir(PB(), () => {
    const r = linkToolToPlaybook('seam-differ', { playbook: 'linktest', role: 'nobody', when: 'x' });
    assert.equal(r.linked, false);
    assert.match(r.reason, /has no role/);
  });
});

test('an edit that would break the playbook is rolled back', () => {
  // A playbook that fails to load is not degraded — it is dropped from the
  // catalog entirely, and every ticket loses its roles, reviewers and gate
  // policy. That is far worse than never having linked the tool.
  withPlaybookDir(PB(), (file) => {
    const before = fs.readFileSync(file, 'utf8');
    // A name the catalog could never register, which the loader refuses.
    const r = linkToolToPlaybook('../../etc/passwd', { playbook: 'linktest', role: 'author', when: 'x' });
    assert.equal(r.linked, false);
    assert.match(r.reason, /rolled back/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file must be byte-identical again');
    assert.ok(loadPlaybooks().playbooks.some((p) => p.id === 'linktest'), 'and the playbook still loads');
  });
});

test('a missing playbook file is reported, not created', () => {
  withPlaybookDir(PB(), () => {
    const r = linkToolToPlaybook('seam-differ', { playbook: 'nosuch', role: 'author', when: 'x' });
    assert.equal(r.linked, false);
    assert.match(r.reason, /no playbook file/);
  });
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPlaybookCache } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';
import { Store } from '../src/queue.ts';
import { crewReview, hostImpossibleReason } from '../src/verify/crewReview.ts';

// Fixture critiques through a stand-in claude CLI, into a scratch database file; the real skills repo is never read.

const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n a\n+b';
const ENV_KEYS = ['FOREMAN_SKILLS_DIR', 'FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_CLAUDE_BIN', 'FOREMAN_LOCAL_ONLY', 'FOREMAN_DB'];

const pbText = `---\n${JSON.stringify({
  id: 'soft',
  description: 'a test crew',
  triggers: ['x'],
  roles: { architect: { tier: 'senior' }, dev: { tier: 'worker' } },
  reviewers: [{ role: 'architect', style: 'code-review' }],
  escalation: { chair: 'architect', afterFailures: 2 },
  checks: [],
  gate: { default: 'human', hardHuman: ['S2'] },
  constraints: ['Never do the bad thing.'],
}, null, 2)}\n---\n\n## role: architect\n\nYou review.\n\n## role: dev\n\nYou implement.\n`;

const envelope = (result: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

/** File the critique's issues on a fresh parent carrying `parentSkills`; returns the store, parent and children. */
async function filed(
  issues: Array<Record<string, unknown>>,
  parentSkills: string[] | null,
  fn: (store: Store, parentId: string) => void,
): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-followups-')));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const pbDir = path.join(base, 'playbooks');
  const root = path.join(base, 'repo');
  fs.mkdirSync(pbDir);
  fs.mkdirSync(path.join(root, 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'beta'), { recursive: true });
  for (const name of ['alpha', 'beta']) {
    const roles = name === 'beta' ? ['soft.dev', 'soft.architect'] : ['soft.dev'];
    fs.writeFileSync(path.join(root, 'skills', name, 'skill.json'), JSON.stringify({ name, description: name, roles, kinds: ['code'], when: 'always', status: 'draft' }));
    fs.writeFileSync(path.join(root, 'skills', name, 'full.md'), `FULL-${name}\n`);
    fs.writeFileSync(path.join(root, 'skills', name, 'card.md'), `CARD-${name}\n`);
  }
  // The role's default is `beta`: a follow-up that fell back to it would differ from a parent that names `alpha` or none.
  // The architect may carry `beta` only: a follow-up filed for it cannot carry a dev parent's `alpha`.
  fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify({ roles: { 'soft.dev': { default: ['beta'], allowed: ['alpha'] }, 'soft.architect': { default: [], allowed: ['beta'] } } }));
  fs.writeFileSync(path.join(pbDir, 'soft.md'), pbText);
  const bin = path.join(base, 'claude');
  fs.writeFileSync(path.join(base, 'reply'), envelope(JSON.stringify({ verdict: 'pass', critique: 'fine, but', issues, acceptance: [] })));
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${base}/reply"\n`);
  fs.chmodSync(bin, 0o755);
  Object.assign(process.env, { FOREMAN_SKILLS_DIR: root, FOREMAN_PLAYBOOKS_DIR: pbDir, FOREMAN_CLAUDE_BIN: bin, FOREMAN_LOCAL_ONLY: '0', FOREMAN_DB: path.join(base, 'scratch.db') });
  clearSkillCache();
  clearPlaybookCache();
  const store = new Store(path.join(base, 'scratch.db'));
  try {
    const parent = store.addTask({ title: 'Parent', prompt: 'the brief', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'soft', acceptance: '1. works', skills: parentSkills });
    await crewReview({ task: store.getTask(parent.id)!, runId: store.startRun(parent.id).id, store, diff: DIFF });
    fn(store, parent.id);
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

const ordinary = { title: 'Handle empty token', prompt: 'Return 401 for an empty bearer token.', severity: 'normal', role: 'dev' };

// An OS that is not this host's, so the end-to-end case holds on any host (the filing uses process.platform).
const OTHER_OS = process.platform === 'linux' ? 'Windows' : 'Linux';

test('a follow-up asking for a recapture on another OS is filed (operator) for the human and never queued for a runner', async () => {
  const ask = { title: `Recapture the golden screenshots on ${OTHER_OS}`, prompt: `The golden images were taken on this host; recapture on ${OTHER_OS} and commit them.`, severity: 'normal', role: 'dev' };
  await filed([ask], null, (store, parentId) => {
    const kids = store.childrenOf(parentId);
    assert.equal(kids.length, 1);
    assert.equal(kids[0]!.title, `(operator) Recapture the golden screenshots on ${OTHER_OS}`);
    assert.equal(kids[0]!.assignee, 'human');
    assert.ok(['awaiting-human', 'blocked'].includes(kids[0]!.status), `parked for the operator, was ${kids[0]!.status}`);
    const events = store.db.prepare('SELECT message FROM events WHERE task_id = ?').all(kids[0]!.id) as Array<{ message: string }>;
    assert.ok(events.some((e) => e.message.startsWith('filed for the operator: ') && e.message.includes(OTHER_OS.toLowerCase())), 'the timeline says why');
  });
});

test('a worker follow-up filed after an (operator) one does not wait for the person', async () => {
  const ask = { title: `Recapture the golden screenshots on ${OTHER_OS}`, prompt: `Recapture on ${OTHER_OS}.`, severity: 'normal', role: 'dev' };
  await filed([ask, ordinary], null, (store, parentId) => {
    const kids = store.childrenOf(parentId);
    assert.equal(kids.length, 2);
    const op = kids.find((k) => k.assignee === 'human')!;
    const ai = kids.find((k) => k.assignee === 'ai')!;
    assert.deepEqual(store.depsOf(ai.id), [parentId], 'it waits only for the ticket it was filed on');
    assert.deepEqual(store.depsOf(op.id), [parentId]);
  });
});

test('a code fix that only describes an OS is filed for a worker, untagged', async () => {
  const fix = { title: `The parser crashes on ${OTHER_OS}; add a guard`, prompt: `The images were taken on ${OTHER_OS}. Make path handling work on ${OTHER_OS}.`, severity: 'normal', role: 'dev' };
  await filed([fix], null, (store, parentId) => {
    const kids = store.childrenOf(parentId);
    assert.equal(kids.length, 1);
    assert.equal(kids[0]!.title, fix.title);
    assert.equal(kids[0]!.assignee, 'ai');
  });
});

test('an ordinary follow-up is filed as before: AI-assigned, untagged', async () => {
  await filed([ordinary], null, (store, parentId) => {
    const kids = store.childrenOf(parentId);
    assert.equal(kids.length, 1);
    assert.equal(kids[0]!.title, 'Handle empty token');
    assert.equal(kids[0]!.assignee, 'ai');
    assert.equal(kids[0]!.role, 'dev');
  });
});

test('a follow-up carries exactly the skills of its parent, not the role default', async () => {
  await filed([ordinary], ['alpha'], (store, parentId) => {
    assert.deepEqual(store.getTask(parentId)!.skills, ['alpha']);
    assert.deepEqual(store.childrenOf(parentId)[0]!.skills, ['alpha']);
  });
});

test('a parent with no skills yields a follow-up with none', async () => {
  await filed([ordinary], null, (store, parentId) => {
    assert.equal(store.getTask(parentId)!.skills ?? null, null);
    assert.equal(store.childrenOf(parentId)[0]!.skills ?? null, null);
  });
});

test('a follow-up for a role that may not carry all the parent\'s skills keeps the allowed ones and is still filed', async () => {
  const forArchitect = { ...ordinary, title: 'Review the token check', role: 'architect' };
  await filed([forArchitect], ['alpha', 'beta'], (store, parentId) => {
    const kids = store.childrenOf(parentId);
    assert.equal(kids.length, 1, 'a skill the role may not carry must not cost the follow-up');
    assert.equal(kids[0]!.role, 'architect');
    assert.deepEqual(kids[0]!.skills, ['beta']);
    const events = store.db.prepare('SELECT message FROM events WHERE task_id = ?').all(kids[0]!.id) as Array<{ message: string }>;
    assert.ok(events.some((e) => /alpha/.test(e.message) && /not carried/.test(e.message)), 'the timeline names the dropped skill');
  });
});

test('hostImpossibleReason flags another OS or machine, and not the host OS or a bare mention', () => {
  assert.match(hostImpossibleReason('recapture on Linux', 'darwin')!, /linux/);
  assert.match(hostImpossibleReason('run the suite under Windows', 'darwin')!, /windows/);
  assert.match(hostImpossibleReason('needs a Linux box', 'darwin')!, /linux/);
  assert.match(hostImpossibleReason('try it on another machine', 'linux')!, /another machine/);
  assert.equal(hostImpossibleReason('recapture on Linux', 'linux'), null, 'the host is Linux: any worker can');
  assert.equal(hostImpossibleReason('handle Windows-style paths in the parser', 'darwin'), null);
  assert.equal(hostImpossibleReason('on Windows paths use backslashes', 'darwin'), null);
  assert.equal(hostImpossibleReason('Add a token check', 'darwin'), null);
});

test('hostImpossibleReason wants a request to do the work there, not a description of an OS', () => {
  const flagged: Array<[string, RegExp]> = [
    ['re-run on Linux', /linux/],
    ['Capture the screenshots on Windows', /windows/],
    ['Reproduce the hang on a Linux host', /linux/],
    ['taken on macOS; recapture on Linux', /linux/],
    ['check the build on a different OS', /different os/],
        ['verify on a physical iPhone', /iphone/],
    ['Please re-run the suite under Windows and paste the output', /windows/],
  ];
  for (const [text, why] of flagged) assert.match(hostImpossibleReason(text, 'darwin') ?? '(null)', why, text);
  assert.equal(hostImpossibleReason('taken on macOS; recapture on Linux', 'linux'), null, 'the only ask is for this host');
  assert.match(hostImpossibleReason('test on an Intel Mac', 'darwin', 'arm64')!, /intel mac/);
  assert.equal(hostImpossibleReason('test on an Intel Mac', 'darwin', 'x64'), null, 'this host is an Intel Mac');
  assert.equal(hostImpossibleReason('benchmark on an Apple Silicon Mac', 'darwin', 'arm64'), null, 'this host is an Apple Silicon Mac');
  for (const text of [
    'The parser crashes on Linux; add a guard',
    'the test fails on Linux CI; fix the timezone assumption',
    'make path handling work on Windows',
    'taken on macOS',
    'Normalize CRLF line endings (common on Windows) before hashing',
    'Guard the /proc read: it only exists on Linux',
    'Skip the test on Windows where signals are not supported',
    'Support running under Linux containers in the Dockerfile',
    'the CI runs on another machine, so do not hardcode /Users paths',
    'Test the parser on Windows-style paths',
  ]) {
    assert.equal(hostImpossibleReason(text, 'darwin'), null, text);
    assert.equal(hostImpossibleReason(text, 'linux'), null, text);
  }
});

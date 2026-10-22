import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPlaybookCache, getPlaybook, type Playbook } from '../src/playbooks.ts';
import { clearSkillCache } from '../src/skills.ts';
import { probeTask } from '../src/types.ts';
import { Store } from '../src/queue.ts';
import { buildReviewPrompt, crewReview, reviewerRoleBlock } from '../src/verify/crewReview.ts';

// Every fixture is built in a temp dir: the real skills repository is never read here.

const FULL = (name: string): string => `FULL-BODY-${name}: do the first thing.\n2. Report what you did.\n`;

function writeSkill(root: string, name: string, roles: string[], full = FULL(name)): void {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ name, description: `the ${name} procedure`, roles, kinds: ['code'], when: 'always', status: 'draft' }));
  fs.writeFileSync(path.join(dir, 'full.md'), full);
  fs.writeFileSync(path.join(dir, 'card.md'), `CARD-${name}\n`);
}

const pbText = (reviewers: unknown[]): string => {
  const fm = {
    id: 'soft',
    description: 'a test crew',
    triggers: ['x'],
    roles: { architect: { tier: 'senior' }, senior: { tier: 'senior' }, dev: { tier: 'worker' } },
    reviewers,
    escalation: { chair: 'architect', afterFailures: 2 },
    checks: [],
    gate: { default: 'human', hardHuman: ['S2'] },
    constraints: ['Never do the bad thing.'],
  };
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n\n## role: architect\n\nYou review the design.\n\n## role: senior\n\nYou review the code.\n\n## role: dev\n\nYou implement.\n`;
};

const ENV_KEYS = ['FOREMAN_SKILLS_DIR', 'FOREMAN_SKILL_BRIEF_BYTES', 'FOREMAN_PLAYBOOKS_DIR', 'FOREMAN_LOCAL_ONLY'];

/** A temp skills repo and playbooks dir, the env pointed at them, put back afterwards. */
async function world(reviewers: unknown[], fn: (w: { root: string; pb: Playbook }) => void | Promise<void>): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewskills-')));
  const root = path.join(base, 'repo');
  const pbDir = path.join(base, 'playbooks');
  for (const d of [path.join(root, 'skills'), pbDir]) fs.mkdirSync(d, { recursive: true });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['FOREMAN_SKILLS_DIR'] = root;
  process.env['FOREMAN_PLAYBOOKS_DIR'] = pbDir;
  process.env['FOREMAN_LOCAL_ONLY'] = '0';
  // The catalog goes in first: a playbook cuts a reviewer's list down to what the loadouts allow when it loads.
  catalog(root, NAMES, ARCH);
  fs.writeFileSync(path.join(pbDir, 'soft.md'), pbText(reviewers));
  clearSkillCache();
  clearPlaybookCache();
  try {
    const pb = getPlaybook('soft');
    assert.ok(pb);
    await fn({ root, pb });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearSkillCache();
    clearPlaybookCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const task = probeTask({ title: 'T', prompt: 'the brief', playbook: 'soft', role: 'dev', acceptance: '1. works' });

// ---------------------------------------------------------------- the golden

const GOLDEN = path.join(import.meta.dirname, 'fixtures', 'crew-review-no-skills.golden.txt');

test('a reviewer with no skills field gets the prompt main built, byte for byte', async () => {
  await world([{ role: 'architect', style: 'code-review' }], ({ pb }) => {
    const prompt = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'diff body');
    // The golden predates the reviewer's role block; with that one block out, the rest is the golden byte for byte.
    const block = reviewerRoleBlock(pb, 'architect');
    assert.ok(prompt.includes(`${block}\n\n`), 'the role block is in the prompt');
    assert.equal(prompt.replace(`${block}\n\n`, ''), fs.readFileSync(GOLDEN, 'utf8'));
    assert.match(prompt, /FULL-BODY-architecture-decision/, "the role's default skill is still served");
  });
});

// ------------------------------------------------------------- what is served

const FOUR_KB = (name: string): string => `FULL-BODY-${name}: ${'x'.repeat(4000 - `FULL-BODY-${name}: `.length - 1)}\n`;

function catalog(root: string, names: string[], loadout: Record<string, { default?: string[]; allowed?: string[] }>): void {
  for (const name of names) writeSkill(root, name, ['soft.architect', 'soft.senior']);
  fs.writeFileSync(path.join(root, 'loadouts.json'), JSON.stringify({ roles: loadout }));
  clearSkillCache();
}

const ARCH = {
  'soft.architect': { default: ['architecture-decision'], allowed: ['review-architecture', 'security-review'] },
  'soft.senior': { allowed: ['review-architecture'] },
};
const NAMES = ['architecture-decision', 'review-architecture', 'security-review'];
const BOTH = ['review-architecture', 'security-review'];
const BROKEN = '{ not json';

test('a reviewer that names skills is served exactly those, full text, and not its role default', async () => {
  await world([{ role: 'architect', style: 'code-review', skills: BOTH }], ({ pb }) => {
    const prompt = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'diff body');
    assert.match(prompt, /## review-architecture\nFULL-BODY-review-architecture: do the first thing\./);
    assert.match(prompt, /## security-review\nFULL-BODY-security-review: do the first thing\./);
    assert.doesNotMatch(prompt, /architecture-decision/);
  });
});

test('a reviewer with skills: [] has no skills block, though its role has a default', async () => {
  await world([{ role: 'architect', style: 'code-review', skills: [] }], ({ pb }) => {
    const prompt = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'diff body');
    assert.doesNotMatch(prompt, /architecture-decision|FULL-BODY/);
    assert.match(prompt, /^REVIEW STYLE \(code-review\):\n[^\n]+\n\nYOUR ROLE \(architect, from the soft playbook\)[^\n]*\nYou review the design\.\n\nReply with JSON only/);
  });
});

test('two 4,000 byte skills fit the 9,000 byte skills budget whole', async () => {
  await world([{ role: 'architect', style: 'code-review', skills: BOTH }], ({ root, pb }) => {
    process.env['FOREMAN_SKILL_BRIEF_BYTES'] = '9000';
    for (const name of BOTH) writeSkill(root, name, ['soft.architect'], FOUR_KB(name));
    clearSkillCache();
    const prompt = buildReviewPrompt(pb, pb.reviewers[0]!, task, 'diff body');
    for (const name of BOTH) assert.ok(prompt.includes(FOUR_KB(name).trim()), `${name} whole`);
    assert.doesNotMatch(prompt, /FOREMAN cut this section/);
  });
});

// ----------------------------------------------------------- refusal and cache

const envelope = (result: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result });

/** A claude CLI stand-in that logs each prompt it is called with and always passes. */
function stubClaude(): { dir: string; count(): number; prompts(): string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-crewskills-cli-'));
  const bin = path.join(dir, 'claude');
  const logs = path.join(dir, 'calls');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(dir, 'reply'), envelope(JSON.stringify({ verdict: 'pass', critique: 'fine', issues: [], acceptance: [{ item: 1, status: 'met', note: 'ok' }] })));
  // The reviewers run at once: each call writes a file of its own, so no two interleave.
  fs.writeFileSync(bin, `#!/bin/sh\nf=$(mktemp "${logs}/call.XXXXXX")\nfor a in "$@"; do printf '%s\\n' "$a" >> "$f"; done\ncat "${dir}/reply"\n`);
  fs.chmodSync(bin, 0o755);
  process.env['FOREMAN_CLAUDE_BIN'] = bin;
  const calls = (): string[] => fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), 'utf8'));
  return { dir, count: () => calls().length, prompts: calls };
}

const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n a\n+b';
const RECORD = 'crew review skills ';

/** One crew review of a fresh ticket; returns its verdict and the reviewers' skills records. */
async function review(store: Store, ticketId?: string): Promise<{ verdict: string | undefined; records: Array<Record<string, unknown>>; id: string }> {
  const id = ticketId ?? store.addTask({ title: 'T', prompt: 'the brief', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'soft', acceptance: '1. works' }).id;
  const result = await crewReview({ task: store.getTask(id)!, runId: store.startRun(id).id, store, diff: DIFF });
  const rows = store.db.prepare("SELECT message FROM events WHERE task_id = ? AND message LIKE 'crew review skills %' ORDER BY id").all(id) as Array<{ message: string }>;
  return { verdict: result?.verdict, records: rows.map((r) => JSON.parse(r.message.slice(RECORD.length)) as Record<string, unknown>), id };
}

async function withStub(fn: (stub: ReturnType<typeof stubClaude>, store: Store) => Promise<void>): Promise<void> {
  const stub = stubClaude();
  const store = new Store(':memory:');
  try {
    await fn(stub, store);
  } finally {
    store.close();
    delete process.env['FOREMAN_CLAUDE_BIN'];
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
}

test('with one named skill refused, the other is served and the refusal is recorded', async () => {
  await withStub((stub, store) => world([{ role: 'architect', style: 'code-review', skills: BOTH }], async ({ root }) => {
    fs.writeFileSync(path.join(root, 'skills', 'security-review', 'skill.json'), BROKEN);
    clearSkillCache();
    const { verdict, records } = await review(store);
    assert.equal(verdict, 'pass');
    assert.equal(stub.count(), 1);
    assert.match(stub.prompts()[0]!, /FULL-BODY-review-architecture/);
    assert.doesNotMatch(stub.prompts()[0]!, /FULL-BODY-security-review|architecture-decision/);
    assert.equal(records.length, 1);
    const rec = records[0]!;
    assert.equal(rec['role'], 'soft.architect');
    assert.equal(rec['source'], 'ticket');
    assert.equal(rec['variant'], 'full');
    assert.deepEqual(rec['skills'], ['review-architecture']);
    assert.deepEqual(rec['dropped'], [{ name: 'security-review', reason: 'refused at load (see: foreman skills)' }]);
    assert.equal(rec['fellBack'], undefined, 'the role default never stands in');
  }));
});

for (const how of ['every named skill is refused', 'the catalog is unreadable'] as const) {
  test(`when ${how}, there is no skills block, the refusal is recorded and the review completes`, async () => {
    await withStub((stub, store) => world([{ role: 'architect', style: 'code-review', skills: BOTH }], async ({ root }) => {
      if (how === 'every named skill is refused') {
        for (const n of BOTH) fs.writeFileSync(path.join(root, 'skills', n, 'skill.json'), BROKEN);
      } else {
        fs.rmSync(path.join(root, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(root, 'skills'), 'not a directory');
      }
      clearSkillCache();
      const { verdict, records } = await review(store);
      assert.equal(verdict, 'pass');
      assert.equal(stub.count(), 1);
      assert.doesNotMatch(stub.prompts()[0]!, /architecture-decision|FULL-BODY|Foreman left out|SKILLS/);
      assert.match(stub.prompts()[0]!, /REVIEW STYLE \(code-review\)/);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0]!['skills'], []);
      assert.deepEqual((records[0]!['dropped'] as Array<{ name: string }>).map((d) => d.name), BOTH);
    }));
  });
}

test('reviewers on one model and one diff with a different role or skills do not share a verdict; the same reviewer re-run does', async () => {
  // One reviewer at a time, so a hit cannot be told from two reviewers that merely ran together: the playbook is
  // swapped between runs of the same ticket and diff. The first two are served the same text in the same style,
  // so only the role tells their prompts, and so their keys, apart.
  const crews: Array<{ reviewers: unknown[]; calls: number; why: string }> = [
    { reviewers: [{ role: 'architect', style: 'code-review', skills: ['review-architecture'] }], calls: 1, why: 'first run is paid' },
    { reviewers: [{ role: 'senior', style: 'code-review', skills: ['review-architecture'] }], calls: 2, why: 'another role is a new review' },
    { reviewers: [{ role: 'senior', style: 'code-review', skills: [] }], calls: 3, why: 'other skills are a new review' },
    { reviewers: [{ role: 'architect', style: 'code-review', skills: ['review-architecture'] }], calls: 3, why: 'the same reviewer re-run hits the cache' },
    { reviewers: [{ role: 'senior', style: 'code-review', skills: ['review-architecture'] }], calls: 3, why: 'and so does the other' },
  ];
  await withStub((stub, store) => world(crews[0]!.reviewers, async () => {
    const id = store.addTask({ title: 'T', prompt: 'the brief', kind: 'code', runner: 'claude-code', role: 'dev', playbook: 'soft', acceptance: '1. works' }).id;
    for (const crew of crews) {
      fs.writeFileSync(path.join(process.env['FOREMAN_PLAYBOOKS_DIR']!, 'soft.md'), pbText(crew.reviewers));
      clearPlaybookCache();
      await review(store, id);
      assert.equal(stub.count(), crew.calls, crew.why);
    }
  }));
});

// ------------------------------------------- the catalog as it is when the review runs

/** The playbook loaded (as by the daemon) while `missing` are not in the skills repo; its cache is not cleared again. */
function loadWithout(root: string, missing: string[]): void {
  for (const n of missing) fs.rmSync(path.join(root, 'skills', n), { recursive: true });
  clearSkillCache();
  clearPlaybookCache();
  assert.ok(getPlaybook('soft'));
}

test('a skill added to the catalog after the playbook loaded is served in the next review, without a restart', async () => {
  await withStub((stub, store) => world([{ role: 'architect', style: 'code-review', skills: BOTH }], async ({ root }) => {
    loadWithout(root, ['security-review']);
    // The skills repo gains the skill; neither cache is cleared by hand: the catalog's own fingerprint sees it.
    writeSkill(root, 'security-review', ['soft.architect', 'soft.senior']);
    const { verdict, records } = await review(store);
    assert.equal(verdict, 'pass');
    assert.match(stub.prompts()[0]!, /FULL-BODY-review-architecture/);
    assert.match(stub.prompts()[0]!, /FULL-BODY-security-review/);
    assert.deepEqual(records[0]!['skills'], BOTH);
    assert.deepEqual(records[0]!['dropped'], []);
  }));
});

test('when every named skill is missing as the playbook loads, the review has no skills block and records both names', async () => {
  await withStub((stub, store) => world([{ role: 'architect', style: 'code-review', skills: BOTH }], async ({ root }) => {
    loadWithout(root, BOTH);
    const { verdict, records } = await review(store);
    assert.equal(verdict, 'pass');
    assert.equal(stub.count(), 1);
    assert.doesNotMatch(stub.prompts()[0]!, /architecture-decision|FULL-BODY|SKILLS/);
    assert.deepEqual(records[0]!['skills'], []);
    assert.deepEqual(records[0]!['dropped'], BOTH.map((name) => ({ name, reason: 'no such skill is loaded' })));
  }));
});

test("a reviewer that names no skills gets its role's defaults, and that is recorded too", async () => {
  await withStub((stub, store) => world([{ role: 'architect', style: 'code-review' }], async () => {
    const { verdict, records } = await review(store);
    assert.equal(verdict, 'pass');
    assert.match(stub.prompts()[0]!, /FULL-BODY-architecture-decision/, 'the role default is served');
    assert.equal(records.length, 1, 'and recorded — it used to leave no record');
    assert.equal(records[0]!['role'], 'soft.architect');
    assert.deepEqual(records[0]!['skills'], ['architecture-decision']);
  }));
});

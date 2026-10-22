import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPlaybookCache, loadPlaybooksFrom } from '../src/playbooks.ts';
import { workerShellAllowlist, workerWebTools } from '../src/runners/cliRunners.ts';
import { shellBrief } from '../src/scheduler.ts';
import { probeTask } from '../src/types.ts';

function withRepoPlaybooks<T>(fn: () => T): T {
  const before = { dir: process.env['FOREMAN_PLAYBOOKS_DIR'], tools: process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'] };
  process.env['FOREMAN_PLAYBOOKS_DIR'] = path.resolve('playbooks');
  delete process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'];
  clearPlaybookCache();
  try {
    return fn();
  } finally {
    if (before.dir === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = before.dir;
    if (before.tools !== undefined) process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'] = before.tools;
    clearPlaybookCache();
  }
}

test('a research worker gets web search and fetch; an S2 ticket and other playbooks do not', () => {
  withRepoPlaybooks(() => {
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S1' }), ['WebSearch', 'WebFetch']);
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S2' }), [], 'S2 text never leaves the machine');
    assert.deepEqual(workerWebTools({ playbook: 'software', sensitivity: 'S1' }), []);
    assert.deepEqual(workerWebTools({}), [], 'no playbook, no web');
    const research = workerShellAllowlist({ testCmd: null, playbook: 'research', sensitivity: 'S1' });
    assert.ok(research.includes('WebSearch') && research.includes('WebFetch'));
    assert.ok(!workerShellAllowlist({ testCmd: null, playbook: 'software', sensitivity: 'S1' }).includes('WebFetch'));
  });
});

test('the shell brief tells a research worker it may search and fetch; the operator override still replaces the list', () => {
  withRepoPlaybooks(() => {
    const task = probeTask({ title: 'T', prompt: 'p', playbook: 'research', role: 'assistant', runner: 'claude-code', kind: 'research' });
    assert.match(shellBrief(task), /WebSearch, WebFetch/);
    process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'] = 'Bash(make:*)';
    assert.deepEqual(workerShellAllowlist({ testCmd: null, playbook: 'research', sensitivity: 'S1' }), ['--allowedTools', 'Bash(make:*)']);
    delete process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'];
  });
});

test('a web value that is not true or false refuses the playbook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-web-'));
  const fm = {
    id: 'webtest', description: 'w', triggers: ['webtest'], roles: { dev: { tier: 'worker' }, senior: { tier: 'senior' } },
    reviewers: [{ role: 'senior', style: 'code-review' }], escalation: { chair: 'senior', afterFailures: 2 },
    checks: [], gate: { default: 'human', hardHuman: [] }, constraints: [], web: 'yes',
  };
  fs.writeFileSync(path.join(dir, 'webtest.md'), `---\n${JSON.stringify(fm)}\n---\n\n## role: dev\n\nD.\n\n## role: senior\n\nS.\n`);
  const c = loadPlaybooksFrom(dir);
  assert.equal(c.playbooks.length, 0);
  assert.match(JSON.stringify(c.refused), /web must be true or false/);
});

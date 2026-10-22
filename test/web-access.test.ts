import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPlaybookCache, getPlaybook, loadPlaybooksFrom } from '../src/playbooks.ts';
import { CLI_PREAPPROVED_FETCH_HOSTS, workerShellAllowlist, workerShellDenylist, workerWebTools } from '../src/runners/cliRunners.ts';
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
    const granted = workerWebTools({ playbook: 'research', sensitivity: 'S1' });
    assert.equal(granted[0], 'WebSearch');
    assert.ok(granted.length > 1 && granted.slice(1).every((t) => /^WebFetch\(domain:[a-z0-9.-]+\)$/.test(t)), 'fetch only by named host');
    assert.ok(!granted.includes('WebFetch'), 'never bare WebFetch');
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S2' }), [], 'S2 text never leaves the machine');
    assert.deepEqual(workerWebTools({ playbook: 'software', sensitivity: 'S1' }), []);
    assert.deepEqual(workerWebTools({}), [], 'no playbook, no web');
    const research = workerShellAllowlist({ testCmd: null, playbook: 'research', sensitivity: 'S1' });
    assert.ok(research.includes('WebSearch') && research.includes('WebFetch(domain:arxiv.org)'));
    assert.ok(!workerShellAllowlist({ testCmd: null, playbook: 'software', sensitivity: 'S1' }).includes('WebFetch'));
  });
});

test('the shell brief tells a research worker it may search and fetch; the operator override still replaces the list', () => {
  withRepoPlaybooks(() => {
    const task = probeTask({ title: 'T', prompt: 'p', playbook: 'research', role: 'assistant', runner: 'claude-code', kind: 'research' });
    assert.match(shellBrief(task), /WebSearch, WebFetch\(domain:/);
    process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'] = 'Bash(make:*)';
    assert.deepEqual(workerShellAllowlist({ testCmd: null, playbook: 'research', sensitivity: 'S1' }), ['--allowedTools', 'Bash(make:*)']);
    delete process.env['FOREMAN_CLAUDE_ALLOWED_TOOLS'];
  });
});

test('web must name its hosts: open fetch, a bad host or an empty list refuses the playbook; a valid grant loads', () => {
  const load = (web: unknown): { ok: boolean; refused: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-web-'));
    const fm = {
      id: 'webtest', description: 'w', triggers: ['webtest'], roles: { dev: { tier: 'worker' }, senior: { tier: 'senior' } },
      reviewers: [{ role: 'senior', style: 'code-review' }], escalation: { chair: 'senior', afterFailures: 2 },
      checks: [], gate: { default: 'human', hardHuman: [] }, constraints: [], web,
    };
    fs.writeFileSync(path.join(dir, 'webtest.md'), `---\n${JSON.stringify(fm)}\n---\n\n## role: dev\n\nD.\n\n## role: senior\n\nS.\n`);
    const c = loadPlaybooksFrom(dir);
    return { ok: c.playbooks.length === 1, refused: JSON.stringify(c.refused) };
  };
  assert.match(load(true).refused, /web must be false or/, 'open fetch to any host is refused');
  assert.match(load('yes').refused, /web must be false or/);
  assert.match(load({ search: true }).refused, /web.domains must list/);
  assert.match(load({ domains: [] }).refused, /web.domains must list/);
  for (const bad of ['https://arxiv.org', 'arxiv.org/abs', '*.arxiv.org', 'ArXiv.org', 'localhost', 'arxiv.org:443', '']) {
    assert.match(load({ domains: [bad] }).refused, /web.domains has/, `refused: ${bad}`);
  }
  assert.match(load({ search: 'yes', domains: ['arxiv.org'] }).refused, /web.search must be true or false/);
  assert.equal(load({ search: true, domains: ['arxiv.org', 'doi.org'] }).ok, true);
  assert.equal(load(false).ok, true, 'false is no web');
});

test('evidence before claims: a constraint in research and investment; in publishing only the reviewing roles carry it', () => {
  withRepoPlaybooks(() => {
    const rule = /Evidence before claims/;
    for (const id of ['research', 'investment']) {
      assert.ok(getPlaybook(id)!.constraints.some((c) => rule.test(c)), `${id} keeps it as a constraint`);
    }
    const pub = getPlaybook('publishing')!;
    assert.ok(!pub.constraints.some((c) => rule.test(c)), 'not a publishing constraint: those reach every role');
    for (const role of ['publisher', 'dev-editor', 'line-editor', 'copyeditor', 'proofreader']) {
      assert.match(pub.rolePrompts[role] ?? '', rule, `${role} carries it`);
    }
    for (const role of ['author', 'beta-reader', 'critic']) {
      assert.doesNotMatch(pub.rolePrompts[role] ?? '', rule, `${role} does not`);
    }
  });
});

test('a ticket whose playbook is gone or opts out gets no web tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-web-off-'));
  const before = process.env['FOREMAN_PLAYBOOKS_DIR'];
  fs.copyFileSync(path.resolve('playbooks/research.md'), path.join(dir, 'research.md'));
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  clearPlaybookCache();
  try {
    const granted = workerWebTools({ playbook: 'research', sensitivity: 'S1' });
    assert.equal(granted[0], 'WebSearch');
    assert.ok(granted.length > 1 && granted.slice(1).every((t) => /^WebFetch\(domain:[a-z0-9.-]+\)$/.test(t)), 'fetch only by named host');
    assert.ok(!granted.includes('WebFetch'), 'never bare WebFetch');
    const text = fs.readFileSync(path.join(dir, 'research.md'), 'utf8');
    const off = text.replace(/"web": \{[\s\S]*?\]\s*\}/, '"web": false');
    assert.notEqual(off, text, 'the fixture edit applied');
    fs.writeFileSync(path.join(dir, 'research.md'), off);
    clearPlaybookCache();
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S1' }), [], 'the operator turned it off');
    fs.rmSync(path.join(dir, 'research.md'));
    clearPlaybookCache();
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S1' }), [], 'a playbook that is gone grants nothing');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = before;
    clearPlaybookCache();
  }
});

test('a worker whose playbook does not grant the web is denied it (a repo settings file cannot switch it on); an unset sensitivity fails closed', () => {
  withRepoPlaybooks(() => {
    const deny = (t: Parameters<typeof workerShellDenylist>[0]): string[] => workerShellDenylist(t);
    assert.ok(deny({ testCmd: null, playbook: 'software', sensitivity: 'S1' }).includes('WebFetch'), 'software: denied');
    assert.ok(deny({ testCmd: null, playbook: 'research', sensitivity: 'S2' }).includes('WebSearch'), 'S2 research: denied');
    const researchDeny = deny({ testCmd: null, playbook: 'research', sensitivity: 'S1' });
    assert.ok(!researchDeny.includes('WebFetch') && !researchDeny.includes('WebSearch'), 'granted: neither denied (deny beats allow)');
    assert.deepEqual(workerWebTools({ playbook: 'research' }), [], 'no sensitivity: no web');
    const task = probeTask({ title: 'T', prompt: 'p', playbook: 'software', role: 'dev', runner: 'claude-code' });
    assert.doesNotMatch(shellBrief(task), /use the wrapper:[^.]*WebFetch/, 'the brief lists only shell commands as use-the-wrapper');
  });
});

test('a worker limited to its hosts is denied the hosts the CLI would fetch without a rule; a granted one is not', () => {
  withRepoPlaybooks(() => {
    const deny = workerShellDenylist({ testCmd: null, playbook: 'research', sensitivity: 'S1' });
    // WebFetch passes a "Preapproved host" (docs sites) before it looks for an allow rule: only a deny rule stops it.
    for (const h of ['docs.python.org', 'github.com', 'huggingface.co', 'cloud.google.com']) {
      assert.ok(deny.includes(`WebFetch(domain:${h})`), `${h} is denied`);
    }
    assert.ok(CLI_PREAPPROVED_FETCH_HOSTS.length > 50 && CLI_PREAPPROVED_FETCH_HOSTS.every((h) => !h.includes('/')), 'hosts, not paths');
    const granted = workerWebTools({ playbook: 'research', sensitivity: 'S1' }).filter((t) => t.startsWith('WebFetch('));
    assert.ok(granted.every((t) => !deny.includes(t)), 'no granted host is denied (deny beats allow)');
    // A worker with no WebFetch at all: the bare tool, which covers every host.
    const software = workerShellDenylist({ testCmd: null, playbook: 'software', sensitivity: 'S1' });
    assert.ok(software.includes('WebFetch') && !software.some((t) => t.startsWith('WebFetch(')));
  });
});

test('search is granted only when asked for, S0 is granted like S1, and the host list is bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-web-search-'));
  const before = process.env['FOREMAN_PLAYBOOKS_DIR'];
  const text = fs.readFileSync(path.resolve('playbooks/research.md'), 'utf8');
  const withWeb = (web: string): void => {
    const next = text.replace(/"web": \{[\s\S]*?\]\s*\}/, `"web": ${web}`);
    assert.notEqual(next, text, 'the fixture edit applied');
    fs.writeFileSync(path.join(dir, 'research.md'), next);
    clearPlaybookCache();
  };
  process.env['FOREMAN_PLAYBOOKS_DIR'] = dir;
  try {
    withWeb('{ "search": false, "domains": ["arxiv.org"] }');
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S1' }), ['WebFetch(domain:arxiv.org)'], 'search: false, no WebSearch');
    assert.ok(workerShellDenylist({ testCmd: null, playbook: 'research', sensitivity: 'S1' }).includes('WebSearch'), 'and it is denied');
    withWeb('{ "domains": ["arxiv.org", "arxiv.org"] }');
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S1' }), ['WebFetch(domain:arxiv.org)'], 'no search unless asked; one rule per host');
    assert.deepEqual(workerWebTools({ playbook: 'research', sensitivity: 'S0' }), ['WebFetch(domain:arxiv.org)'], 'S0 like S1');
    const hosts = (n: number): string => JSON.stringify(Array.from({ length: n }, (_, i) => `h${i}.example.org`));
    withWeb(`{ "domains": ${hosts(64)} }`);
    assert.equal(workerWebTools({ playbook: 'research', sensitivity: 'S1' }).length, 64, '64 hosts load');
    withWeb(`{ "domains": ${hosts(65)} }`);
    assert.equal(getPlaybook('research'), null, '65 hosts refuse the playbook');
    withWeb(`{ "domains": ["${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.org"] }`);
    assert.equal(getPlaybook('research'), null, 'a host longer than 253 characters refuses the playbook');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = before;
    clearPlaybookCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the README and the research assistant say what the host list does not do', () => {
  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
  const web = readme.slice(readme.indexOf('A playbook may grant web access'), readme.indexOf('Turn it off with `"web": false`'));
  assert.match(web, /not a network boundary/, 'the list limits the tool, not an unsandboxed worker');
  assert.match(web, /CLI_PREAPPROVED_FETCH_HOSTS/, 'the hosts the CLI fetches without a rule are named');
  assert.match(web, /FOREMAN_CLAUDE_DISALLOWED_TOOLS/, 'the deny-list override drops the web rules too');
  assert.match(web, /put back to the base commit/, 'a worker cannot keep a settings change for its next round');
  withRepoPlaybooks(() => {
    assert.match(getPlaybook('research')!.rolePrompts['assistant'] ?? '', /DOI link redirects to its publisher/);
  });
});

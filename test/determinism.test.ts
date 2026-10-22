import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybooksFrom, type Playbook } from '../src/playbooks.ts';
import {
  agentConfigFindings, deterministicFindings, parseDiffFiles, requiredContentFindings, roleMode, secretFindings, temperatureFor, testWeakening,
} from '../src/verify/determinism.ts';

/** A unified diff adding `lines` to `file` (or deleting it). */
function diffOf(file: string, lines: string[], deleted = false): string {
  return [
    `diff --git a/${file} b/${file}`,
    deleted ? 'deleted file mode 100644' : 'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    ...lines.map((l) => (deleted ? `-${l}` : `+${l}`)),
  ].join('\n');
}

// Fakes built at run time, so no secret-shaped literal sits in this file (the public repo scans pushes).
const FAKE = {
  aws: 'AKIA' + 'Q'.repeat(16),
  github: 'ghp' + '_' + 'a'.repeat(36),
  anthropic: 'sk-' + 'ant-' + 'b'.repeat(30),
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
};

const catalog = loadPlaybooksFrom('playbooks');
const pbOf = (id: string): Playbook => {
  const pb = catalog.playbooks.find((p) => p.id === id);
  assert.ok(pb, `${id} loads`);
  return pb;
};

test('parseDiffFiles reads the new path, deletions and only the added lines', () => {
  const files = parseDiffFiles(`${diffOf('src/a.ts', ['x', 'y'])}\n${diffOf('test/b.test.ts', ['z'], true)}`);
  assert.deepEqual(files.map((f) => [f.path, f.deleted, f.added]), [['src/a.ts', false, ['x', 'y']], ['test/b.test.ts', true, []]]);
});

test('a committed credential is a hard finding; the allow marker and an example env file are not', () => {
  for (const [kind, secret] of Object.entries(FAKE)) {
    const hits = secretFindings(parseDiffFiles(diffOf('src/config.ts', [`const k = "${secret}";`])));
    assert.equal(hits.length, 1, `${kind} is found`);
  }
  assert.deepEqual(secretFindings(parseDiffFiles(diffOf('src/c.ts', [`const k = "${FAKE.aws}"; // foreman:allow-secret`]))), []);
  const newEnv = ['diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+TOKEN=x'].join('\n');
  assert.equal(secretFindings(parseDiffFiles(newEnv)).length, 1, 'a new .env file is a secret file');
  assert.deepEqual(secretFindings(parseDiffFiles(diffOf('.env.example', ['TOKEN=']))), [], 'an example is not');
  assert.deepEqual(secretFindings(parseDiffFiles(diffOf('src/ok.ts', ['const sky = "sk-short";']))), [], 'ordinary text is not');
});

test('test weakening: .only is hard, an added skip and a deleted test file are soft, non-test files are ignored', () => {
  const only = testWeakening(parseDiffFiles(diffOf('test/a.test.ts', ["test.only('x', () => {});"])));
  assert.equal(only.hard.length, 1);
  const skip = testWeakening(parseDiffFiles(diffOf('test/a.test.ts', ["test.skip('x', () => {});"])));
  assert.deepEqual([skip.hard.length, skip.soft.length], [0, 1]);
  const py = testWeakening(parseDiffFiles(diffOf('tests/test_x.py', ['@pytest.mark.skip(reason="later")'])));
  assert.equal(py.soft.length, 1, 'pytest skip is found');
  const gone = testWeakening(parseDiffFiles(diffOf('test/old.test.ts', ['a'], true)));
  assert.equal(gone.soft.length, 1, 'a deleted test file is found');
  const src = testWeakening(parseDiffFiles(diffOf('src/only.ts', ["list.only('x')", "x.skip('y')"])));
  assert.deepEqual([src.hard.length, src.soft.length], [0, 0], 'not a test file');
});

test('required content: a missing section is found in a changed markdown file, for the roles it names only', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-'));
  fs.writeFileSync(path.join(tree, 'memo.md'), '# Thesis\n\nThis is research, not financial advice.\n\n## Exit criteria\n');
  const inv = pbOf('investment');
  const files = parseDiffFiles(diffOf('memo.md', ['# Thesis']));
  assert.deepEqual(requiredContentFindings(inv, 'analyst', files, tree), ['memo.md: a bear case section (a heading naming the bear case) is missing']);
  assert.deepEqual(requiredContentFindings(inv, 'risk', files, tree), [], 'risk has its disclaimer and exit criteria');
  assert.deepEqual(requiredContentFindings(inv, 'ic-chair', files, tree), [], 'no rule names the chair');
  fs.writeFileSync(path.join(tree, 'memo.md'), '# Thesis\n\n## Bear case\n\nThis is research, not financial advice.\n');
  assert.deepEqual(requiredContentFindings(inv, 'analyst', files, tree), []);
  assert.deepEqual(requiredContentFindings(inv, 'analyst', parseDiffFiles(diffOf('../outside.md', ['x'])), tree), [], 'a path outside the tree is not read');
  assert.deepEqual(requiredContentFindings(inv, 'analyst', parseDiffFiles(diffOf('memo.md', ['x'], true)), tree), [], 'a deleted file is not read');
  assert.deepEqual(requiredContentFindings(inv, 'analyst', files, null), [], 'no tree, nothing read');
});

test('the slider: generative drops the heuristic test findings but keeps the hard checks; modes map to temperatures', () => {
  const pub = pbOf('publishing');
  assert.equal(roleMode(pub, 'author'), 'generative');
  assert.equal(roleMode(pub, 'copyeditor'), 'deterministic');
  assert.equal(roleMode(pub, 'no-such-role'), 'balanced');
  assert.equal(roleMode(pub, null), 'balanced');
  const diff = `${diffOf('test/a.test.ts', ["test.skip('x', () => {});", "test.only('y', () => {});"])}\n${diffOf('src/k.ts', [`const k = "${FAKE.github}";`])}`;
  const gen = deterministicFindings(pub, 'author', diff, null);
  assert.deepEqual([gen.hard.length, gen.soft.length], [2, 0], 'secret + .only hard; the skip not raised for a generative role');
  const det = deterministicFindings(pub, 'copyeditor', diff, null);
  assert.deepEqual([det.hard.length, det.soft.length], [2, 1]);
  assert.deepEqual([temperatureFor('deterministic'), temperatureFor('balanced'), temperatureFor('generative')], [0, 0.3, 0.8]);
});

function playbookWith(patch: (fm: Record<string, unknown>) => void): { refused: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-pb-'));
  const fm: Record<string, unknown> = {
    id: 'det', description: 'det', triggers: ['det'], roles: { dev: { tier: 'worker' }, senior: { tier: 'senior' } },
    reviewers: [{ role: 'senior', style: 'code-review' }], escalation: { chair: 'senior', afterFailures: 2 },
    checks: [], gate: { default: 'human', hardHuman: [] }, constraints: [],
  };
  patch(fm);
  fs.writeFileSync(path.join(dir, 'det.md'), `---\n${JSON.stringify(fm, null, 2)}\n---\n\n## role: dev\n\nD.\n\n## role: senior\n\nS.\n`);
  const c = loadPlaybooksFrom(dir);
  return { refused: JSON.stringify(c.refused) + (c.playbooks.length ? '' : ' (none loaded)') };
}

test('a bad mode or a malformed required rule refuses the playbook', () => {
  const roles = (fm: Record<string, unknown>) => fm['roles'] as Record<string, Record<string, unknown>>;
  assert.match(playbookWith((fm) => { roles(fm)['dev']!['mode'] = 'creative'; }).refused, /invalid mode/);
  assert.match(playbookWith((fm) => { fm['required'] = 'x'; }).refused, /required must be an array/);
  assert.match(playbookWith((fm) => { fm['required'] = [{ pattern: 'x' }]; }).refused, /has no label/);
  assert.match(playbookWith((fm) => { fm['required'] = [{ label: 'l', pattern: '(' }]; }).refused, /not a valid regular expression/);
  assert.match(playbookWith((fm) => { fm['required'] = [{ label: 'l', pattern: 'x'.repeat(201) }]; }).refused, /1-200 characters/);
  assert.match(playbookWith((fm) => { fm['required'] = [{ label: 'l', pattern: 'x', roles: ['ghost'] }]; }).refused, /role the playbook declares/);
  assert.equal(playbookWith((fm) => { roles(fm)['dev']!['mode'] = 'deterministic'; fm['required'] = [{ label: 'l', pattern: 'x', roles: ['dev'] }]; }).refused, '[]');
});

test('preReviewGaps: a hard finding is held like a scope violation (fails after the repairs); a soft one is not', async () => {
  const { preReviewGaps } = await import('../src/scheduler.ts');
  const { clearPlaybookCache } = await import('../src/playbooks.ts');
  const { probeTask } = await import('../src/types.ts');
  const before = process.env['FOREMAN_PLAYBOOKS_DIR'];
  process.env['FOREMAN_PLAYBOOKS_DIR'] = path.resolve('playbooks');
  clearPlaybookCache();
  try {
    const task = probeTask({ title: 'T', prompt: 'p', playbook: 'software', role: 'dev', kind: 'writing' });
    const hard = preReviewGaps(task, diffOf('test/a.test.ts', ["test.only('x', () => {});"]), null);
    assert.ok(hard, 'gaps found with no reviewer');
    assert.equal(hard.scope.length, 1, 'held like a scope violation');
    assert.match(hard.notes, /must be fixed before the work is reviewed/);
    const soft = preReviewGaps(task, diffOf('test/a.test.ts', ["test.skip('x', () => {});"]), null);
    assert.ok(soft);
    assert.deepEqual([soft.items.length, soft.scope.length], [1, 0], 'a soft finding goes to the reviewer after the repairs');
    assert.deepEqual(soft.advisory, soft.items, 'and is marked advisory');
    assert.deepEqual(hard.advisory, [], 'a hard one is not');
    assert.equal(preReviewGaps(task, diffOf('src/a.ts', ['const a = 1;']), null), null, 'a clean diff has no gaps');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = before;
    clearPlaybookCache();
  }
});

test('parseDiffFiles: a quoted (non-ASCII) path, a name holding " b/", a rename, and an added line starting "++"', () => {
  const quoted = [
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', 'new file mode 100644', '--- /dev/null', '+++ "b/caf\\303\\251.ts"',
    '@@ -0,0 +1 @@', `+const k = "${FAKE.aws}";`,
  ].join('\n');
  const [q] = parseDiffFiles(quoted);
  assert.deepEqual([q!.path, q!.created, q!.added.length], ['café.ts', true, 1], 'the first file of a diff, quoted, is still read');
  assert.equal(secretFindings(parseDiffFiles(quoted)).length, 1, 'and its secret is found');
  const spaced = ['diff --git a/my b/x.test.ts b/my b/x.test.ts', '--- a/my b/x.test.ts\t', '+++ b/my b/x.test.ts\t', '@@ -1 +1,2 @@', ' a', "+test.only('x', () => {});"].join('\n');
  assert.deepEqual(parseDiffFiles(spaced).map((f) => f.path), ['my b/x.test.ts']);
  assert.equal(testWeakening(parseDiffFiles(spaced)).hard.length, 1);
  const renamed = ['diff --git a/old.md b/new name.md', 'similarity index 100%', 'rename from old.md', 'rename to new name.md'].join('\n');
  assert.deepEqual(parseDiffFiles(renamed).map((f) => [f.path, f.created]), [['new name.md', true]]);
  const plus = [`diff --git a/x.ts b/x.ts`, '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1,2 @@', ' a', `+++i; const k = "${FAKE.aws}";`].join('\n');
  assert.equal(secretFindings(parseDiffFiles(plus)).length, 1, 'content that starts with ++ is still content');
});

test('focused tests: a bare fit( is hard; model.fit( and def fit( in a test file are not', () => {
  assert.equal(testWeakening(parseDiffFiles(diffOf('spec/a.spec.js', ["fit('x', () => {});"]))).hard.length, 1);
  assert.deepEqual(testWeakening(parseDiffFiles(diffOf('test/lint.test.ts', ["const src = \"it.only('x')\"; // foreman:allow-only"]))).hard, [], 'quoted as data, marked');
  const ml = testWeakening(parseDiffFiles(diffOf('tests/test_model.py', ['    model.fit(X, y)', 'def fit(self, x):', 'function fit (a) {}'])));
  assert.deepEqual(ml.hard, []);
});

test('more credential shapes; a tracked .env edit is a soft note, a new one is hard', () => {
  const more = {
    openaiProject: 'sk-' + 'proj-' + 'Ab_3dE-' + 'x'.repeat(60),
    stripe: 'sk' + '_live_' + 'c'.repeat(24),
    npm: 'npm' + '_' + 'd'.repeat(36),
    gitlab: 'glpat' + '-' + 'e'.repeat(20),
  };
  for (const [kind, secret] of Object.entries(more)) {
    assert.equal(secretFindings(parseDiffFiles(diffOf('src/c.ts', [`const k = "${secret}";`]))).length, 1, `${kind} is found`);
  }
  const tracked = ['diff --git a/.env.development b/.env.development', 'index 1111111..2222222 100644', '--- a/.env.development', '+++ b/.env.development', '@@ -1 +1,2 @@', ' A=1', '+B=2'].join('\n');
  assert.deepEqual(secretFindings(parseDiffFiles(tracked)), [], 'a tracked env file is the project convention');
  const det = deterministicFindings(pbOf('software'), 'dev', tracked, null);
  assert.deepEqual([det.hard.length, det.soft.length], [0, 1], 'its edit is a note');
  const created = ['diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+A=1'].join('\n');
  assert.equal(secretFindings(parseDiffFiles(created)).length, 1, 'a new one is held');
});

test('required content is not read through a symlinked directory that leads out of the tree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-ln-'));
  const tree = path.join(base, 'tree');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(tree);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'memo.md'), '# nothing here\n');
  fs.symlinkSync(outside, path.join(tree, 'docs'));
  const inv = pbOf('investment');
  assert.deepEqual(requiredContentFindings(inv, 'analyst', parseDiffFiles(diffOf('docs/memo.md', ['x'])), tree), []);
  fs.writeFileSync(path.join(tree, 'memo.md'), '# nothing here\n');
  assert.equal(requiredContentFindings(inv, 'analyst', parseDiffFiles(diffOf('memo.md', ['x'])), tree).length, 2, 'the same file inside is read');
});

test('pre-review rounds: soft findings alone get one round, hard ones are always held, map gaps get the cap', async () => {
  const { preReviewRepairDue } = await import('../src/scheduler.ts');
  const soft = { items: ['a'], notes: '', scope: [], advisory: ['a'] };
  assert.deepEqual([preReviewRepairDue(soft, 0), preReviewRepairDue(soft, 1)], [true, false]);
  const mixed = { items: ['map gap', 'a'], notes: '', scope: [], advisory: ['a'] };
  assert.deepEqual([preReviewRepairDue(mixed, 1), preReviewRepairDue(mixed, 2)], [true, false]);
  const hard = { items: ['k'], notes: '', scope: ['k'], advisory: [] };
  assert.equal(preReviewRepairDue(hard, 99), true, 'held past the cap: schedulePreReviewRepair then refuses and the ticket fails');
});

test('required content: an oversized file is a finding, not a silent skip; an empty roles list refuses the playbook', async () => {
  const { MAX_REQUIRED_BYTES } = await import('../src/verify/determinism.ts');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-big-'));
  fs.writeFileSync(path.join(tree, 'memo.md'), 'x'.repeat(MAX_REQUIRED_BYTES + 1));
  const found = requiredContentFindings(pbOf('investment'), 'analyst', parseDiffFiles(diffOf('memo.md', ['x'])), tree);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /too large for the required-content check/);
  assert.match(playbookWith((fm) => { fm['required'] = [{ label: 'l', pattern: 'x', roles: [] }]; }).refused, /at least one role/);
});

test('required content: a file exactly at the cap is checked, and the over-cap finding names every label', async () => {
  const { MAX_REQUIRED_BYTES } = await import('../src/verify/determinism.ts');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-cap-'));
  const head = '# Thesis\n\n## Bear case\n\nThis is research, not financial advice.\n';
  fs.writeFileSync(path.join(tree, 'memo.md'), head + 'x'.repeat(MAX_REQUIRED_BYTES - Buffer.byteLength(head)));
  const files = parseDiffFiles(diffOf('memo.md', ['x']));
  assert.deepEqual(requiredContentFindings(pbOf('investment'), 'analyst', files, tree), [], 'at the cap: checked and clean');
  fs.appendFileSync(path.join(tree, 'memo.md'), 'x');
  const over = requiredContentFindings(pbOf('investment'), 'analyst', files, tree);
  assert.equal(over.length, 1);
  assert.match(over[0]!, /disclaimer/);
  assert.match(over[0]!, /bear case/);
});

test('required content: a file swapped for a FIFO after the lstat does not hang the daemon on open', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-det-fifo-'));
  execFileSync('mkfifo', [path.join(tree, 'notes.md')]);
  // In a child with a deadline: a blocking open stalls the event loop, so this process's own timers could not fire.
  // lstat is made to report a regular file, standing in for the swap between the lstat and the open.
  const script = `
    import fs from 'node:fs';
    import { requiredContentFindings } from ${JSON.stringify(path.resolve('src/verify/determinism.ts'))};
    const lstat = fs.lstatSync;
    fs.lstatSync = (p, ...a) => Object.assign(lstat(p, ...a), { isFile: () => true });
    const pb = { required: [{ label: 'a limitations section', pattern: 'limitations' }] };
    process.stdout.write(JSON.stringify(requiredContentFindings(pb, 'researcher', [{ path: 'notes.md', deleted: false }], ${JSON.stringify(tree)})));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
  assert.equal(r.signal, null, `the check hung on the FIFO (killed by ${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [], 'not a regular file once open: not read');
});

test('a change to the agent permission config is a hard finding: a worker may not set its own permissions', () => {
  for (const file of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'sub/.claude/settings.json']) {
    assert.equal(agentConfigFindings(parseDiffFiles(diffOf(file, ['{"permissions":{"allow":["WebFetch"]}}']))).length, 1, file);
    assert.equal(agentConfigFindings(parseDiffFiles(diffOf(file, ['x'], true))).length, 1, `${file} deleted`);
  }
  for (const file of ['.Claude/Settings.json', '.CLAUDE/settings.LOCAL.json', '.MCP.json']) {
    assert.equal(agentConfigFindings(parseDiffFiles(diffOf(file, ['{}']))).length, 1, `${file}: the same file on a case-insensitive disk`);
  }
  assert.deepEqual(agentConfigFindings(parseDiffFiles(diffOf('docs/settings.json', ['x']))), [], 'another settings file is not');
  assert.deepEqual(agentConfigFindings(parseDiffFiles(diffOf('.claude/agents/x.md', ['x']))), [], 'only the permission files');
  const pub = pbOf('publishing');
  assert.equal(deterministicFindings(pub, 'author', diffOf('.claude/settings.json', ['{}']), null).hard.length, 1, 'hard in every mode');
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaybooksFrom, type Playbook } from '../src/playbooks.ts';
import {
  deterministicFindings, parseDiffFiles, requiredContentFindings, roleMode, secretFindings, temperatureFor, testWeakening,
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
  assert.equal(secretFindings(parseDiffFiles(diffOf('.env', ['TOKEN=x']))).length, 1, 'an .env file is a secret file');
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
  assert.match(playbookWith((fm) => { fm['required'] = [{ label: 'l', pattern: 'x', roles: ['ghost'] }]; }).refused, /roles the playbook declares/);
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
    assert.equal(preReviewGaps(task, diffOf('src/a.ts', ['const a = 1;']), null), null, 'a clean diff has no gaps');
  } finally {
    if (before === undefined) delete process.env['FOREMAN_PLAYBOOKS_DIR'];
    else process.env['FOREMAN_PLAYBOOKS_DIR'] = before;
    clearPlaybookCache();
  }
});

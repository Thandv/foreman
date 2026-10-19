import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/queue.ts';
import { Broker } from '../src/budget.ts';
import { runCouncil } from '../src/verify/council.ts';
import { isWhitespaceOnly, triageDiff } from '../src/verify/triage.ts';
import { probeTask } from '../src/types.ts';

const diffFor = (file: string, added: string[], removed: string[] = []): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@',
    ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');

test('fast-verify is off unless the operator turns it on', () => {
  const docs = diffFor('README.md', ['a small documentation fix']);
  assert.equal(triageDiff(docs).tier, 'full', 'default must be identical to today');
  assert.equal(triageDiff(docs, { enabled: true }).tier, 'fast');
});

test('code-bearing and security-adjacent diffs always get the full council', () => {
  for (const file of [
    'src/queue.ts', 'app/main.py', 'cmd/server.go', 'scripts/deploy.sh',
    'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'Dockerfile',
    'src/auth/session.md', 'infra/terraform/main.tf', 'config/secrets.yaml', '.env.example',
  ]) {
    const t = triageDiff(diffFor(file, ['x'.repeat(10)]), { enabled: true });
    assert.equal(t.tier, 'full', `${file} was fast-tracked: ${t.reason}`);
  }
});

test('docs and config below the threshold earn the cheap review', () => {
  const small = triageDiff(diffFor('docs/guide.md', ['one new sentence.']), { enabled: true });
  assert.equal(small.tier, 'fast');
  assert.match(small.reason, /docs\/config only/);

  const big = triageDiff(diffFor('docs/guide.md', Array.from({ length: 40 }, (_, i) => `line ${i}`)), { enabled: true });
  assert.equal(big.tier, 'full');
  assert.match(big.reason, /above the 20-line fast threshold/);
});

test('a whitespace-only change is fast even in a code file, but never in a sensitive one', () => {
  const reindent = diffFor('src/queue.ts', ['  const x = 1;'], ['const x = 1;']);
  assert.equal(isWhitespaceOnly(reindent), true);
  assert.equal(triageDiff(reindent, { enabled: true }).tier, 'fast');

  const realChange = diffFor('src/queue.ts', ['const x = 2;'], ['const x = 1;']);
  assert.equal(isWhitespaceOnly(realChange), false);
  assert.equal(triageDiff(realChange, { enabled: true }).tier, 'full');

  const sensitive = diffFor('src/security/admit.ts', ['  const x = 1;'], ['const x = 1;']);
  assert.equal(triageDiff(sensitive, { enabled: true }).tier, 'full', 'never cheap-review the scanner');
});

test('an empty or unidentifiable diff is not fast-tracked', () => {
  assert.equal(triageDiff('', { enabled: true }).tier, 'full');
  assert.equal(triageDiff('some prose that is not a diff', { enabled: true }).tier, 'full');
});

function stubCouncil(replies: string[]): { store: Store; broker: Broker; kinds: string[] } {
  const store = new Store(':memory:');
  const kinds: string[] = [];
  let i = 0;
  const broker = new Broker(store, {
    guardResidency: false,
    chatFn: async (o) => {
      const { resolveSpec } = await import('../src/models.ts');
      return { text: replies[Math.min(i++, replies.length - 1)]!, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, spec: resolveSpec(o.alias) };
    },
  });
  const original = broker.call.bind(broker);
  (broker as unknown as { call: unknown }).call = async (req: { kind: string }) => {
    kinds.push(req.kind);
    return original(req as never);
  };
  store.db.prepare("INSERT INTO tasks (id,title,prompt,kind,runner,sensitivity,status,max_attempts,created_at,updated_at) VALUES ('t1','x','do it','code','api','S1','verifying',2,0,0)").run();
  store.db.prepare("INSERT INTO runs (id,task_id,status,stage,started_at) VALUES ('r1','t1','running','verify',0)").run();
  return { store, broker, kinds };
}

test('a fast pass costs one review; the ledger records which tier paid', async () => {
  process.env['FOREMAN_FAST_VERIFY'] = '1';
  const { store, broker, kinds } = stubCouncil(['{"verdict":"pass","confidence":0.9,"issues":[]}']);
  const verdict = await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: diffFor('README.md', ['a documentation fix']), bodyLabel: 'diff', testsPassed: true },
  });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(kinds.length, 1, `expected one review, got ${kinds.join(', ')}`);
  assert.match(kinds[0]!, /council@fast/);
  delete process.env['FOREMAN_FAST_VERIFY'];
  store.close();
});

test('a fast review that does not pass falls through to the full council', async () => {
  process.env['FOREMAN_FAST_VERIFY'] = '1';
  const { store, broker, kinds } = stubCouncil(['{"verdict":"fail","confidence":0.9,"issues":["broken link"]}']);
  const verdict = await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: diffFor('README.md', ['a documentation fix']), bodyLabel: 'diff', testsPassed: true },
  });
  assert.ok(kinds.some((k) => k.includes('@fast')), 'the fast review ran');
  assert.ok(kinds.some((k) => k.includes('@r0')), 'and the full council ran after it');
  assert.equal(verdict.verdict, 'fail');
  delete process.env['FOREMAN_FAST_VERIFY'];
  store.close();
});

test('with the flag off, a docs diff still gets the full council', async () => {
  const { store, broker, kinds } = stubCouncil(['{"verdict":"pass","confidence":0.9,"issues":[]}']);
  await runCouncil({
    store, broker, task: probeTask({ id: 't1', kind: 'code' }), runId: 'r1',
    evidence: { body: diffFor('README.md', ['a documentation fix']), bodyLabel: 'diff', testsPassed: true },
  });
  assert.ok(kinds.length >= 2, `expected the full council, got ${kinds.join(', ')}`);
  assert.ok(!kinds.some((k) => k.includes('@fast')));
  store.close();
});

import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { assertClean, entropy, redact } from '../src/align/redact.ts';

/**
 * The planted-secret corpus. Every one of these is a fake credential in the
 * real shape, and none of them may survive the pass.
 */
const PLANTED: Array<[label: string, text: string]> = [
  ['anthropic', 'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789'],
  ['openai', 'the key is sk-proj-9zXwVuTsRqPoNmLkJiHgFeDcBa0987654321'],
  ['github-pat', 'clone with ghp_AbCdEf0123456789AbCdEf0123456789AbCd'],
  ['github-fine', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
  ['gitlab', 'CI token glpat-AbCdEf0123456789xyz'],
  ['slack', 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['aws', 'AKIAIOSFODNN7EXAMPLE is the access key id'],
  ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
  ['google-oauth', 'ya29.a0AfH6SMBx1234567890abcdefghijklmnop'],
  ['npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['stripe', 'sk_live_51AbCdEfGhIjKlMnOpQrStUv'],
  ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['bearer', 'Authorization: Bearer abcdef0123456789abcdef0123456789'],
  ['env-assign', 'DATABASE_PASSWORD="hunter2-correct-horse"'],
  ['json-secret', '{"api_key": "abc123def456ghi789jkl"}'],
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----'],
];

test('every planted secret is removed and nothing recognisable survives', () => {
  for (const [label, text] of PLANTED) {
    const result = redact(text);
    assert.ok(result.changed, `${label}: nothing was redacted`);
    assert.doesNotThrow(() => assertClean(result.text), `${label}: a known key shape survived`);
    // The secret MATERIAL must be gone. Identifier-shaped chunks (the variable
    // name ANTHROPIC_API_KEY, the field api_key) are context, not credentials,
    // and keeping them is what makes the sample useful for training.
    const isIdentifier = (c: string): boolean =>
      /^[A-Z][A-Z0-9_]*$/.test(c) || /^[a-z][a-z0-9_]*$/.test(c) || c.startsWith('REDACTED');
    for (const chunk of text.match(/[A-Za-z0-9_\-]{16,}/g) ?? []) {
      if (isIdentifier(chunk)) continue;
      assert.ok(!result.text.includes(chunk), `${label}: leaked "${chunk.slice(0, 24)}…"`);
    }
  }
});

test('the whole planted corpus at once comes out clean', () => {
  const corpus = PLANTED.map(([, t]) => t).join('\n\n');
  const result = redact(corpus);
  assert.doesNotThrow(() => assertClean(result.text));
  assert.ok(result.redactions.length >= 10, `expected many rules to fire, got ${result.redactions.length}`);
  assert.ok(!/hunter2/.test(result.text), 'an assigned password leaked');
});

test('assertClean actually fails on an unredacted corpus', () => {
  assert.throws(() => assertClean('ghp_AbCdEf0123456789AbCdEf0123456789AbCd'), /redaction failed/);
  assert.throws(() => assertClean(PLANTED.map(([, t]) => t).join('\n')), /redaction failed/);
});

test('home paths, usernames and emails are scrubbed', () => {
  const home = os.homedir();
  const user = home.split('/').filter(Boolean).pop()!;
  const result = redact(`I ran ${home}/Projects/foreman as ${user}, mail me at someone@example.com`);
  assert.ok(!result.text.includes(home), 'the home path survived');
  assert.ok(!new RegExp(`\\b${user}\\b`).test(result.text), 'the username survived');
  assert.ok(!result.text.includes('someone@example.com'));
  assert.match(result.text, /~\/Projects\/foreman/, 'the path shape is kept, only the identity removed');
});

test('high-entropy strings are swept even without a known shape', () => {
  const random = 'Zk9pQr2XvL8mNb4TcW7yHs3JdG6fAe1RuY5iOx0P';
  const result = redact(`the token is ${random}`);
  assert.ok(!result.text.includes(random));
  assert.match(result.text, /REDACTED_HIGH_ENTROPY/);
});

test('ordinary prose and code survive the sweep intact', () => {
  const code = [
    'export function calculateMonthlyRecurringRevenue(subscriptions) {',
    '  return subscriptions.reduce((total, subscription) => total + subscription.amount, 0);',
    '}',
    '// see also: internationalization_configuration_defaults',
    'const REALLY_LONG_CONSTANT_NAME_FOR_TESTING = 1;',
  ].join('\n');
  const result = redact(code, { scrubPaths: false });
  assert.equal(result.text, code, `code was mangled:\n${result.text}`);
});

test('entropy scores random strings above prose', () => {
  assert.ok(entropy('Zk9pQr2XvL8mNb4TcW7yHs3JdG6fAe1RuY5iOx0P') > 4);
  assert.ok(entropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') < 1);
  assert.ok(entropy('calculateMonthlyRecurringRevenue') < 4.5);
});

test('redaction is idempotent — running it twice changes nothing further', () => {
  const once = redact(PLANTED.map(([, t]) => t).join('\n'));
  const twice = redact(once.text);
  assert.equal(twice.text, once.text);
});

test('a secret split across the assignment and the value is still caught', () => {
  const result = redact('FOREMAN_GATEWAY_KEY = "sk-proj-AbCdEf0123456789AbCdEf0123"');
  assert.ok(!result.text.includes('sk-proj-AbCdEf0123456789AbCdEf0123'));
  assert.doesNotThrow(() => assertClean(result.text));
});

test('paths survive the entropy sweep; secrets that contain slashes do not', () => {
  // A corpus of engineering work is mostly paths. Blurring them teaches a
  // fine-tune to write [REDACTED_HIGH_ENTROPY] where a filename belongs.
  for (const kept of [
    'see src/align/personas.ts and .foreman/playbooks/publishing.md',
    'Chapters/The_Harbour_at_Low_Tide_Chapter_09.md',
    '~/Library/Application Support/Claude/skills/nightly-build-summary/SKILL.md',
  ]) {
    assert.equal(redact(kept).text, kept, kept);
  }

  // Entropy alone cannot make this call — "nightly-build-summary" scores
  // higher than the AWS example secret — so the test is structural, and these
  // must still go.
  for (const secret of [
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'dGhpc2lzYXNlY3JldC9rZXkrdmFsdWU9PQ==',
    '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928',
  ]) {
    assert.match(redact(secret).text, /REDACTED/, secret);
  }
});

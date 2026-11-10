import { scratchDir } from './env.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { removeAfterStops } from './helpers/removal.ts';
import { Store } from '../src/queue.ts';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function store(t: TestContext): Store {
  const s = new Store(':memory:');
  t.after(() => s.close());
  return s;
}

/** A fresh token: the raw secret a caller would hold and the sha256 hex the ledger keeps. */
function secret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

test('addPrincipal creates a human or service principal with a p_ id, never deleted, only disabled', (t) => {
  const s = store(t);
  const alice = s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' }, T0);
  assert.match(alice.id, /^p_[0-9a-f]+$/);
  assert.deepEqual(alice, { id: alice.id, kind: 'human', name: 'alice', createdBy: 'operator', createdAt: T0, disabledAt: null });
  assert.equal(s.addPrincipal({ kind: 'service', name: 'ci.bot-1', createdBy: 'operator' }).kind, 'service');
  assert.equal(s.addPrincipal({ kind: 'human', name: 'a'.repeat(64), createdBy: 'operator' }).name.length, 64);
  assert.throws(() => s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' }), /UNIQUE/);

  assert.equal(s.disablePrincipal(alice.id, T0 + 1), true);
  assert.equal(s.disablePrincipal(alice.id, T0 + 2), false, 'already disabled');
  assert.equal(s.disablePrincipal('p_missing', T0), false);
  const row = s.db.prepare('SELECT disabled_at FROM principals WHERE id = ?').get(alice.id) as { disabled_at: number };
  assert.equal(row.disabled_at, T0 + 1);
});

test('addPrincipal refuses the reserved actor names and any name outside the pattern', (t) => {
  const s = store(t);
  for (const name of ['operator', 'owner-model', 'system']) {
    assert.throws(() => s.addPrincipal({ kind: 'human', name, createdBy: 'operator' }), /reserved/);
  }
  for (const name of ['', 'Alice', '-a', '.a', 'a b', 'a/b', 'a\nb', 'a'.repeat(65), 'ä']) {
    assert.throws(() => s.addPrincipal({ kind: 'human', name, createdBy: 'operator' }), /principal name/, JSON.stringify(name));
  }
  assert.throws(() => s.addPrincipal({ kind: 'robot' as never, name: 'r', createdBy: 'operator' }), /principal kind/);
  assert.equal(s.hasAnyPrincipal(), false);
});

test('principalByTokenHash returns the principal only for a live token of an enabled principal', (t) => {
  const s = store(t);
  const alice = s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' }, T0);
  const open = secret();
  const expiring = secret();
  const revoked = secret();
  s.addToken({ principalId: alice.id, tokenHash: open.hash, createdBy: 'operator' }, T0);
  s.addToken({ principalId: alice.id, tokenHash: expiring.hash, expiresAt: T0 + DAY, createdBy: 'operator' }, T0);
  const revokedId = s.addToken({ principalId: alice.id, tokenHash: revoked.hash, createdBy: 'operator' }, T0);
  assert.match(revokedId, /^tk_[0-9a-f]+$/);

  assert.equal(s.principalByTokenHash(open.hash, T0)?.id, alice.id);
  assert.equal(s.principalByTokenHash(expiring.hash, T0 + DAY - 1)?.id, alice.id);
  assert.equal(s.principalByTokenHash(expiring.hash, T0 + DAY), null, 'expired');
  assert.equal(s.principalByTokenHash(secret().hash, T0), null, 'unknown');

  assert.equal(s.principalByTokenHash(revoked.hash, T0)?.id, alice.id);
  assert.equal(s.revokeToken(revokedId, T0 + 5), true);
  assert.equal(s.revokeToken(revokedId, T0 + 6), false, 'already revoked');
  assert.equal(s.revokeToken('tk_missing', T0), false);
  assert.equal(s.principalByTokenHash(revoked.hash, T0 + 5), null, 'revoked');

  s.disablePrincipal(alice.id, T0 + 10);
  assert.equal(s.principalByTokenHash(open.hash, T0 + 10), null, 'disabled principal');
});

test('addToken takes only a sha256 hex hash and a principal that exists; the same hash twice is refused', (t) => {
  const s = store(t);
  const alice = s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' });
  const tok = secret();
  for (const bad of [tok.raw, tok.hash.toUpperCase(), tok.hash.slice(1), '']) {
    assert.throws(() => s.addToken({ principalId: alice.id, tokenHash: bad, createdBy: 'operator' }), /sha256 hex/);
  }
  assert.throws(() => s.addToken({ principalId: 'p_missing', tokenHash: tok.hash, createdBy: 'operator' }), /FOREIGN KEY/);
  s.addToken({ principalId: alice.id, tokenHash: tok.hash, createdBy: 'operator' });
  assert.throws(() => s.addToken({ principalId: alice.id, tokenHash: tok.hash, createdBy: 'operator' }), /UNIQUE/);
});

test('humanPrincipalCount counts live humans only; hasAnyPrincipal latches on the first principal', (t) => {
  const s = store(t);
  assert.equal(s.hasAnyPrincipal(), false);
  assert.equal(s.humanPrincipalCount(), 0);
  const bot = s.addPrincipal({ kind: 'service', name: 'bot', createdBy: 'operator' });
  assert.equal(s.hasAnyPrincipal(), true);
  assert.equal(s.humanPrincipalCount(), 0);
  const alice = s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' });
  s.addPrincipal({ kind: 'human', name: 'bob', createdBy: 'operator' });
  assert.equal(s.humanPrincipalCount(), 2);
  s.disablePrincipal(alice.id);
  s.disablePrincipal(bot.id);
  assert.equal(s.humanPrincipalCount(), 1);
  assert.equal(s.hasAnyPrincipal(), true);
});

test('the ledger file never holds the raw token secret', (t) => {
  const home = removeAfterStops(t, scratchDir('foreman-principals-'));
  const dbPath = path.join(home, 'foreman.db');
  const s = new Store(dbPath);
  const alice = s.addPrincipal({ kind: 'human', name: 'alice', createdBy: 'operator' });
  const tok = secret();
  s.addToken({ principalId: alice.id, tokenHash: tok.hash, createdBy: 'operator' });
  s.close();
  const bytes = Buffer.concat(fs.readdirSync(home).map((f) => fs.readFileSync(path.join(home, f))));
  assert.ok(bytes.includes(tok.hash), 'the hash is stored');
  assert.ok(!bytes.includes(tok.raw), 'the raw secret is not');
});

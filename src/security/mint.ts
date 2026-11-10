/**
 * The host-admin mint: POST /api/tokens with the host-admin secret (hostSecret.ts), from this machine only. It
 * creates the named principal when there is none, adds a token for it and returns the raw secret once; the ledger
 * keeps only its hash (tokenAuth.ts). The first mint latches auth on. It works with auth on too, without a bearer,
 * as the lockout recovery path.
 *
 * Every mint records one visible event (Store.mintHostAdminToken). That is the only defence today against the known
 * gap: an unsandboxed worker runs as the daemon's user, can read the secret and is a loopback peer, so it can mint.
 */
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { Store } from '../queue.ts';
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from '../types.ts';
import { hostSecretMatches, HOST_SECRET_HEADER } from './hostSecret.ts';
import { tokenHash } from './tokenAuth.ts';

/** What a mint asks for, read from the request body. */
export interface MintRequest {
  name: string;
  kind: PrincipalKind;
  /** How long the token lives, from the mint; null = until revoked. */
  expiresInMs: number | null;
}

export interface Minted {
  /** The raw secret: in this response and nowhere else. */
  token: string;
  tokenId: string;
  principal: Pick<Principal, 'id' | 'name' | 'kind'>;
  principalCreated: boolean;
  expiresAt: number | null;
}

/** 127.0.0.0/8 and ::1, either as the socket reports it (an IPv4 peer on a dual-stack socket is ::ffff:a.b.c.d). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Whether a request may mint: it came from a loopback peer AND carries the host-admin secret. */
export function hostAdminMintAllowed(req: { socket: { remoteAddress?: string | undefined }; headers: http.IncomingHttpHeaders }, home: string): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && hostSecretMatches(home, req.headers[HOST_SECRET_HEADER]);
}

/**
 * A mint's body, checked at the boundary: `name` (text; its shape is checked by Store.addPrincipal), `kind` ('human'
 * when absent) and `expiresInMs` (a positive whole number of ms, or absent for none). Throws on anything else.
 */
export function readMintRequest(body: unknown): MintRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('the request body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b['name'] !== 'string') throw new Error('name must be text');
  const kind = b['kind'] ?? 'human';
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) throw new Error(`kind must be one of ${PRINCIPAL_KINDS.join(', ')}`);
  const ttl = b['expiresInMs'];
  if (ttl !== undefined && ttl !== null && !(Number.isSafeInteger(ttl) && (ttl as number) > 0)) {
    throw new Error('expiresInMs must be a positive whole number of milliseconds');
  }
  return { name: b['name'], kind: kind as PrincipalKind, expiresInMs: (ttl as number | null | undefined) ?? null };
}

/** Mints a token (and its principal, when new) in one transaction; the raw secret is returned and never stored. */
export function mintToken(store: Store, m: MintRequest, now: number = Date.now()): Minted {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = m.expiresInMs === null ? null : now + m.expiresInMs;
  const { principal, tokenId, principalCreated } = store.mintHostAdminToken(
    { name: m.name, kind: m.kind, tokenHash: tokenHash(token), expiresAt },
    now,
  );
  return { token, tokenId, principal: { id: principal.id, name: principal.name, kind: principal.kind }, principalCreated, expiresAt };
}

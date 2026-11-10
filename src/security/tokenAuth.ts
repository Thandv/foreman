/**
 * Bearer-token authentication for the HTTP API.
 *
 * Auth is a latch: off until the first principal exists, then on for good. Principals are never deleted, only
 * disabled, so revoking, expiring or disabling never turns it back off and never makes a request the operator
 * again. Every check reads the ledger: nothing is cached, so a revoked or expired token fails on its next request.
 * The secret is only hashed here; it is never logged, stored or put in an error.
 */
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Store } from '../queue.ts';
import type { Principal } from '../types.ts';

/** What the ledger keeps for a token (api_tokens.token_hash): the sha256 hex of its secret. */
function tokenHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** True once any principal has ever been added. */
export function authIsOn(store: Store): boolean {
  return store.hasAnyPrincipal();
}

/** The live principal an `Authorization: Bearer <secret>` header names at `now`, or null. */
export function authenticate(store: Store, headers: http.IncomingHttpHeaders, now: number = Date.now()): Principal | null {
  const m = /^Bearer +(\S+)\s*$/i.exec(headers.authorization ?? '');
  return m ? store.principalByTokenHash(tokenHash(m[1]!), now) : null;
}

/**
 * Whether a verify-slot request may be slotted. With auth off, every request is, as before. With auth on, only one
 * that named its run with that run's token (`runId`, from slots.ts claimRunLease) while the run is still running:
 * the token itself is valid for any run id until the daemon restarts, so liveness is checked here.
 */
export function verifySlotAllowed(store: Store, runId: string | null): boolean {
  if (!authIsOn(store)) return true;
  return runId !== null && store.getRun(runId)?.status === 'running';
}

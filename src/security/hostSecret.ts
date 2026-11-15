import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The host-admin secret: a random value in <FOREMAN_HOME>/secrets/, readable
 * only by the user who runs Foreman. The CLI sends it on the requests that ask
 * for allowCore, and the daemon honours allowCore only from a request that
 * carries it, so a process that can merely reach the local API cannot queue a
 * task that may edit Foreman's own core. It is not a boundary against a worker:
 * workers run unsandboxed as the same user and can read the file.
 *
 * <FOREMAN_HOME>/secrets/ is owned by src/security/: this module holds the host-admin
 * secret, src/security/forgeToken.ts reads the GitLab token beside it.
 */

export const HOST_SECRET_HEADER = 'x-foreman-host-secret';

const SECRET_SHAPE = /^[0-9a-f]{64}$/;

function secretFile(home: string): string {
  return path.join(home, 'secrets', 'host-admin');
}

/** The secret, or null when none has been created yet. A file that is not a secret is an error, not a missing one. */
export function readHostSecret(home: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(secretFile(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const secret = text.trim();
  if (!SECRET_SHAPE.test(secret)) throw new Error(`${secretFile(home)} does not hold a host-admin secret`);
  return secret;
}

/**
 * The secret, created first when there is none. Created once: it is written to
 * a private temp file and hard-linked into place, so two callers racing both
 * end up reading the one that won, never a half-written file.
 */
export function ensureHostSecret(home: string): string {
  const file = secretFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const secret = readHostSecret(home);
  if (secret === null) throw new Error(`${file} vanished as it was created`);
  return secret;
}

/** Whether a request header carries the secret. No secret on disk matches nothing. */
export function hostSecretMatches(home: string, presented: string | string[] | undefined): boolean {
  if (typeof presented !== 'string') return false;
  const secret = readHostSecret(home);
  if (secret === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

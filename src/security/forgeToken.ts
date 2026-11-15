import fs from 'node:fs';
import path from 'node:path';

/**
 * The GitLab token for merge-request landing: <FOREMAN_HOME>/secrets/gitlab-token, put there by the operator. It is
 * never read from the environment (workers inherit it) or from a repo's config (a worker can write that). The file
 * must be a regular file owned by the user running Foreman, with mode 0600; anything else is refused, not read.
 * Only the landing code (src/landing/config.ts) asks for the value; everything else is told 'set' or 'unset'.
 * Like the host-admin secret, it is not a boundary against an unsandboxed worker, which runs as the same user.
 */

export class ForgeTokenError extends Error {
  override readonly name = 'ForgeTokenError';
}

export function forgeTokenFile(home: string): string {
  return path.join(home, 'secrets', 'gitlab-token');
}

/** The token, or null when the file does not exist. `owner` is the uid the file must belong to (a test passes another). */
export function readForgeToken(home: string, owner: number | undefined = process.getuid?.()): string | null {
  const file = forgeTokenFile(home);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new ForgeTokenError(`${file} is a symlink; it must be a regular file`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ForgeTokenError(`${file} is not a regular file`);
    if (st.uid !== owner) throw new ForgeTokenError(`${file} is owned by uid ${st.uid}, not by the user running Foreman`);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) throw new ForgeTokenError(`${file} has mode ${mode.toString(8).padStart(4, '0')}; it must be 0600`);
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (token === '' || /\s/.test(token)) throw new ForgeTokenError(`${file} does not hold a token (empty, or more than one word)`);
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

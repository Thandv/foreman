import fs from 'node:fs';
import path from 'node:path';

/**
 * Read one file of a work tree in the daemon, for a check or a reviewer.
 *
 * The tree is the worker's: a name in it can be a FIFO, a device, or a link
 * out of the jail, and a FIFO named package.json once hung the daemon on a
 * plain read (verify/gateOutcome.ts). So: a relative path with no `..`, a
 * regular file by lstat (never a symlink) with one name (a hard link is another
 * file's content under a name in the tree: no checkout makes one, and resolving
 * the path cannot tell where else it lives), inside the jail once both are
 * resolved (a parent directory can be the link), opened with O_NOFOLLOW and
 * O_NONBLOCK in case the entry is swapped between the two looks, checked again
 * on the descriptor that is read, and at most `maxBytes`. Binary content (a
 * NUL byte) is not text anybody can be shown. null for every refusal: the
 * caller says the file was not read, and never why in more words than that.
 */
export function readJailFile(root: string, rel: string, maxBytes: number): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const file = path.join(root, rel);
  let fd: number | null = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1 || st.size > maxBytes) return null;
    const realRoot = fs.realpathSync(root);
    if (!fs.realpathSync(file).startsWith(realRoot + path.sep)) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const now = fs.fstatSync(fd);
    if (!now.isFile() || now.nlink > 1 || now.size > maxBytes) return null;
    const buf = Buffer.alloc(now.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

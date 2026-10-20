/**
 * Where the running node is installed, for the test sandbox (sandbox.ts). The sandbox closes reads under /Users and
 * the temp dirs, so a node installed by a version manager (nvm, fnm, volta, asdf: `~/.nvm/versions/node/v24.x/…`)
 * or unpacked into a temp dir cannot start inside it: `/bin/sh: node: command not found`. sandbox.ts gives this
 * root back read-only when it is narrow; this file only says what the root is, and whether it looks like a node
 * install and nothing else. A version manager whose PATH entry is a shim or symlink directory elsewhere under the
 * home (volta's ~/.volta/bin, fnm's multishell links) is not covered by this: that directory stays closed.
 *
 * A root is `<root>` for `<root>/bin/node`, accepted only when:
 *  - `<root>/bin/node` is the running binary (after realpath);
 *  - npm is there: `<root>/lib/node_modules/npm/package.json`, or the `npm` the PATH resolves lives under the root;
 *  - its top-level directories are only those a node install has (bin, include, lib, libexec, share, etc), and its
 *    lib/ holds only node's own (node_modules, libnode.*, dtrace, pkgconfig). A prefix such as `~/.local` with a
 *    python under lib/ or a state/ directory is not a node install, and is not given back.
 * Files at the top (README.md, LICENSE, CHANGELOG.md, an install receipt) are not checked: a top-level symlink or file
 * does not widen what a subpath rule opens beyond the root.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface NodeInstall {
  /** The running node binary, through realpath (as written when it cannot be resolved). */
  exe: string;
  /** The install root, or null when the layout is not a node install's (`why` says what is missing). */
  root: string | null;
  why: string | null;
  /** The tree node needs to start: the root, or else the directory above the binary's directory. */
  tree: string;
}

const TOP_DIRS = new Set(['bin', 'include', 'lib', 'libexec', 'share', 'etc']);
const LIB_ENTRY = /^(node_modules|dtrace|pkgconfig|libnode\..+)$/;

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

async function dirNames(p: string): Promise<string[] | null> {
  try {
    return (await fs.promises.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
}

/** The npm the PATH resolves, through realpath; null when there is none. */
async function npmOnPath(pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const r = await realOrNull(path.join(dir, 'npm'));
    if (r) return r;
  }
  return null;
}

/** `execPath` and `pathEnv` are parameters so a test can point them at an install it built. */
export async function nodeInstall(execPath: string = process.execPath, pathEnv: string = process.env['PATH'] ?? ''): Promise<NodeInstall> {
  const exe = (await realOrNull(execPath)) ?? path.resolve(execPath);
  const bin = path.dirname(exe);
  const root = path.dirname(bin);
  const no = (why: string): NodeInstall => ({ exe, root: null, why, tree: root });
  if (path.basename(bin) !== 'bin' || root === bin) return no(`${exe} is not in a bin/ directory`);
  if ((await realOrNull(path.join(root, 'bin', 'node'))) !== exe) return no(`${path.join(root, 'bin', 'node')} is not this node`);
  const bundled = await fs.promises.access(path.join(root, 'lib', 'node_modules', 'npm', 'package.json')).then(() => true, () => false);
  if (!bundled) {
    const npm = await npmOnPath(pathEnv);
    if (!npm || !inside(npm, root)) return no('no npm in lib/node_modules, and the npm on PATH is not under it');
  }
  const top = await dirNames(root);
  if (top === null) return no(`${root} cannot be listed`);
  const extra = top.filter((n) => !TOP_DIRS.has(n));
  if (extra.length) return no(`it also holds ${extra.map((n) => `${n}/`).join(', ')}, which a node install does not`);
  const lib = await fs.promises.readdir(path.join(root, 'lib')).catch(() => [] as string[]);
  const odd = lib.filter((n) => !LIB_ENTRY.test(n));
  if (odd.length) return no(`its lib/ also holds ${odd.join(', ')}, which a node install does not`);
  return { exe, root, why: null, tree: root };
}

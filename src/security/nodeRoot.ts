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
 *  - its top-level directories are only those a node install has (bin, include, lib, libexec, share, etc), and each
 *    of them except bin/ holds only node's own: lib/ node_modules, libnode.*, dtrace, pkgconfig; include/ node;
 *    share/ doc, man, systemtap; etc/ npmrc, bash_completion.d; libexec/ bin, lib. A prefix such as `~/.local` with a
 *    python under lib/, a state/ directory, or other programs' data under share/ is not a node install, and is not
 *    given back: everything in the root becomes readable, so nothing but node may be in it;
 *  - its top-level files are only those a node install ships (README.md, LICENSE, CHANGELOG.md, Homebrew's install
 *    receipt and sbom). A top-level symlink is not checked: the sandbox judges the path it resolves to, so a link out
 *    of the root opens nothing.
 * bin/ and lib/node_modules/ are not checked (global packages and their commands live there).
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
/** What each top-level directory but bin/ may hold: the nodejs.org tarball (nvm, fnm, volta, asdf) and a Homebrew keg. */
const SUB_ENTRY: Record<string, RegExp> = {
  lib: /^(node_modules|dtrace|pkgconfig|libnode\..+)$/,
  include: /^node$/,
  share: /^(doc|man|systemtap)$/,
  etc: /^(npmrc|bash_completion\.d)$/,
  libexec: /^(bin|lib)$/,
};
const TOP_FILE = /^(README\.md|LICENSE|CHANGELOG\.md|INSTALL_RECEIPT\.json|sbom\.spdx\.json)$/;

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

async function entries(p: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(p, { withFileTypes: true });
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
  const top = await entries(root);
  if (top === null) return no(`${root} cannot be listed`);
  const dirs = top.filter((d) => d.isDirectory()).map((d) => d.name);
  const extra = dirs.filter((n) => !TOP_DIRS.has(n));
  if (extra.length) return no(`it also holds ${extra.map((n) => `${n}/`).join(', ')}, which a node install does not`);
  const files = top.filter((d) => !d.isDirectory() && !d.isSymbolicLink() && !TOP_FILE.test(d.name)).map((d) => d.name);
  if (files.length) return no(`it also holds ${files.join(', ')}, which a node install does not`);
  for (const dir of dirs) {
    const want = SUB_ENTRY[dir];
    if (!want) continue;
    const names = (await entries(path.join(root, dir)))?.map((d) => d.name);
    if (!names) return no(`${path.join(root, dir)} cannot be listed`);
    const odd = names.filter((n) => !want.test(n));
    if (odd.length) return no(`its ${dir}/ also holds ${odd.join(', ')}, which a node install does not`);
  }
  return { exe, root, why: null, tree: root };
}

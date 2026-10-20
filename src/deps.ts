import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { PINNED, pinnedEnv } from './isolate.ts';
import { sandboxMode } from './security/sandbox.ts';

const exec = promisify(execFile);

/**
 * `clone` copies the dependency tree with APFS copy-on-write (`/bin/cp -c`,
 * falling back to a plain copy elsewhere: see copyTree). `symlink` is faster still but the jail then shares the
 * operator's tree — a runner that writes into node_modules writes into their
 * checkout — so it is opt-in rather than the default.
 */
export type DepsMode = 'clone' | 'symlink' | 'off';

export interface DepsResult {
  provisioned: boolean;
  mode: DepsMode;
  source: 'repo' | 'cache' | 'install' | null;
  reason: string;
  ms: number;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

export function depsMode(): DepsMode {
  const raw = (process.env['FOREMAN_DEPS_MODE'] ?? 'clone').toLowerCase();
  return raw === 'symlink' || raw === 'off' ? raw : 'clone';
}

export function depsCacheRoot(): string {
  return path.join(config.home, 'deps-cache');
}

function lockfileIn(dir: string): string | null {
  for (const name of LOCKFILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function lockHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/**
 * npm writes `node_modules/.package-lock.json` describing the tree it actually
 * installed. If that is at least as new as the lockfile, the installed tree
 * matches it; otherwise the repo's node_modules is stale and reusing it would
 * hand the jail the wrong dependencies.
 */
export function installIsCurrent(repoDir: string): boolean {
  const modules = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(modules)) return false;
  const lock = lockfileIn(repoDir);
  if (!lock) return true; // nothing to be stale against
  const hidden = path.join(modules, '.package-lock.json');
  if (!fs.existsSync(hidden)) return false;
  return fs.statSync(hidden).mtimeMs >= fs.statSync(lock).mtimeMs;
}

/**
 * Does git track anything under `rel`? Only a tracked tree is already in the worktree. Answered by exit status with
 * the listing discarded, so a huge tracked tree costs no buffer; null when git could not say (exit 1 alone means
 * "no match").
 */
function isTracked(repoDir: string, rel: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const child = spawn('git', [...PINNED, 'ls-files', '--error-unmatch', '--', rel], {
      cwd: repoDir, env: pinnedEnv(), stdio: 'ignore',
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? true : code === 1 ? false : null));
  });
}

/** Is node_modules ignored here? */
async function isIgnored(repoDir: string, rel: string): Promise<boolean> {
  try {
    // Pinned (isolate.ts): the repo's config is the one every jail can write, and `check-ignore` reads the index,
    // which runs the program `core.fsmonitor` names.
    await exec('git', [...PINNED, 'check-ignore', '-q', rel], { cwd: repoDir, env: pinnedEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * node_modules is not ignored, so the tree placed in the jail would show up as untracked files in its diff. Exclude it
 * through the repository's info/exclude (shared by its worktrees, never committed). Returns the sentence for the reason.
 */
async function keepOutOfDiff(jailDir: string): Promise<string> {
  const note = '; node_modules is not ignored by git, so it is excluded from the diff via .git/info/exclude';
  try {
    const { stdout } = await exec('git', [...PINNED, 'rev-parse', '--git-path', 'info/exclude'], { cwd: jailDir, env: pinnedEnv() });
    const file = path.resolve(jailDir, stdout.trim());
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!have.split('\n').includes('/node_modules')) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${have === '' || have.endsWith('\n') ? '' : '\n'}/node_modules\n`);
    }
    return note;
  } catch {
    return '; node_modules is not ignored by git, so it may show up in the diff (could not exclude it)';
  }
}

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);

/**
 * Does the link at `link` lead out of `jail`? Judged twice: as written (a dangling link has nothing else to judge),
 * and, where it resolves, by where it really ends up — a link through another link can leave by a path that reads
 * as inside.
 */
function leavesJail(link: string, jail: string): boolean {
  let written: string;
  try {
    written = fs.readlinkSync(link);
  } catch {
    return false; // not a link (any more)
  }
  if (!within(path.resolve(path.dirname(link), written), jail)) return true;
  try {
    return !within(fs.realpathSync(link), fs.realpathSync(jail));
  } catch {
    return false; // dangling or a loop: it leads nowhere, and as written it stays inside
  }
}

/**
 * macOS's own cp. `-c` clones each file (clonefile(2)): on APFS the copy shares the source's blocks until one side
 * is written, so a jail's node_modules costs no disk and takes a fraction of the time. Named by absolute path and
 * run without a shell.
 */
export const CLONE_BIN = '/bin/cp';

/**
 * The clone command on this platform: macOS only. Elsewhere `/bin/cp -c` is a different command — on GNU cp `-c` is
 * the deprecated `--context` — which would succeed, copy in full, and be reported as a clone. null: node's copy.
 */
export function cloneBinFor(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'darwin' ? CLONE_BIN : null;
}

/**
 * Copy a dependency tree, links as they are written, and say which way it went.
 *
 * First `/bin/cp -c -R`. node's own copy does not clone here whatever it is asked: measured on this machine (APFS,
 * Node 26.0.0), `fsp.cp` with COPYFILE_FICLONE took 200 MB of free space for a 200 MB file, COPYFILE_FICLONE_FORCE
 * answers ENOSYS, and `/bin/cp -c -R` took none. cp copies links as links by default under -R, so a relative link
 * stays relative; on a volume that cannot clone it copies instead, by itself.
 *
 * It is run on macOS only (cloneBinFor). When it is missing or fails (a source that vanished mid-way), whatever it left at
 * `to` is removed and node's copy takes over. Without `verbatimSymlinks` node's cp rewrites every RELATIVE link to
 * the ABSOLUTE path of its source: the copy's `.bin/tsc` then pointed back into the tree it was copied from (the
 * shared cache, the operator's checkout), so every jail ran its tools out of that one tree — and under the sandbox,
 * which cannot read there, did not find them at all (`sh: tsc: command not found`).
 *
 * `to` must not exist. `cloneBin` stands in for /bin/cp in tests; null goes straight to node's copy.
 */
export async function copyTree(from: string, to: string, cloneBin: string | null = cloneBinFor()): Promise<'clone' | 'copy'> {
  if (cloneBin) {
    try {
      await exec(cloneBin, ['-c', '-R', from, to], { maxBuffer: 8 * 1024 * 1024 });
      return 'clone';
    } catch {
      await fsp.rm(to, { recursive: true, force: true });
    }
  }
  try {
    await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  } catch (err) {
    // Never a half tree: a caller that finds `to` takes it for a whole one.
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return 'copy';
}

/**
 * Remove every link under `tree` that leads out of `jail`, and return them as `link -> target`. A link that is
 * already absolute, or climbs out with `..` (a package that ships one, `npm link`, a tree an older Foreman copied),
 * would otherwise be recreated in the jail pointing at the cache or the operator's files. It is dropped, never
 * followed: copying what it points at would bring content from outside into the jail. A link that stays inside
 * the jail is kept as written, including one that leaves node_modules for the jail's own tree (an npm workspace's
 * `node_modules/pkg -> ../packages/pkg`).
 */
async function dropLinksOut(tree: string, jail: string): Promise<string[]> {
  const dropped: string[] = [];
  const dirs = [tree];
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(full);
      else if (entry.isSymbolicLink() && leavesJail(full, jail)) {
        const target = await fsp.readlink(full);
        await fsp.rm(full, { force: true });
        dropped.push(`${path.relative(jail, full)} -> ${target}`);
      }
    }
  }
  return dropped;
}

/** How many dropped links are named one by one; the rest are counted. */
const NAMED_LINKS = 20;

/**
 * A tree placed before links were copied as written: its `.bin` entries are absolute links into the cache or the
 * operator's checkout. Only `.bin` is read — that is where npm puts its links, and one directory listing is cheap
 * enough to do on every run.
 */
function hasLinksOut(modules: string, jail: string): boolean {
  const bin = path.join(modules, '.bin');
  try {
    if (fs.lstatSync(modules).isSymbolicLink()) return false; // symlink mode: the whole tree is shared, by choice
    return fs.readdirSync(bin).some((name) => leavesJail(path.join(bin, name), jail));
  } catch {
    return false;
  }
}

/**
 * Where a jail's tree is built before it is moved into place: beside the jail, never in it. Inside the jail a
 * half-built tree under any other name is not covered by the repo's `node_modules` ignore rule, so one left by a
 * crash would be in `git status`, in the ticket's diff and in the tree its reviewers are shown. Beside the jail is
 * the same volume, so the move is one rename.
 */
const STAGING_SUFFIX = '.deps-tmp';
const stagingFor = (jail: string): string => path.join(path.dirname(jail), `.${path.basename(jail)}${STAGING_SUFFIX}`);

/**
 * Remove what a run that died mid-copy left: this jail's staging directory, and any beside it whose jail is gone
 * (nothing is copying into a jail that no longer exists). Another live jail's is left alone.
 */
async function sweepStaging(jail: string): Promise<void> {
  await fsp.rm(stagingFor(jail), { recursive: true, force: true });
  await sweepOrphanStaging(path.dirname(jail));
}

/**
 * The second half of the rule above, for the jail sweep as well (archive.ts): a staging directory in `parent` whose
 * jail is gone is removed; one beside a jail that still exists is left alone. Returns what it removed.
 */
export async function sweepOrphanStaging(parent: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fsp.readdir(parent).catch(() => [] as string[])) {
    if (!name.startsWith('.') || !name.endsWith(STAGING_SUFFIX)) continue;
    const owner = path.join(parent, name.slice(1, -STAGING_SUFFIX.length));
    if (fs.existsSync(owner)) continue;
    const gone = await fsp.rm(path.join(parent, name), { recursive: true, force: true }).then(() => true, () => false);
    if (gone) removed.push(path.join(parent, name));
  }
  return removed;
}

/**
 * Put the tree at `from` at `to` (the jail's node_modules), whole or not at all. A copy made straight into the jail
 * and failing half-way left a partial node_modules, and every later run said "the jail already has node_modules"
 * and never repaired it. The tree is built in a staging directory beside the jail and renamed into place; a tree
 * being replaced is renamed out first, so at no point does the jail hold part of one. Returns how it was copied.
 */
async function place(
  from: string, to: string, mode: DepsMode, say: (line: string) => void, cloneBin: string | null = cloneBinFor(),
): Promise<'clone' | 'copy' | 'symlink'> {
  const jail = path.dirname(to);
  await sweepStaging(jail);
  if (mode === 'symlink') {
    await fsp.symlink(from, to, 'dir');
    // Not changed to a clone behind the operator's back: said, where the run's log is read.
    const box = sandboxOn();
    if (box) {
      say(
        `deps: FOREMAN_DEPS_MODE=symlink with the sandbox on (FOREMAN_SANDBOX=${box}): node_modules is a link out of the jail ` +
          `(to ${from}), which a sandboxed command cannot read — its dependencies and tools will be missing. ` +
          'Use FOREMAN_DEPS_MODE=clone (the default), or FOREMAN_SANDBOX=off.',
      );
    }
    return 'symlink';
  }
  const staging = stagingFor(jail);
  try {
    await fsp.mkdir(staging);
    // The tree itself, not a link to it: a source that is a link (a checkout whose node_modules points elsewhere)
    // would be copied as that link, and the pass below would then walk through it and delete links in the tree it
    // points at.
    const how = await copyTree(await fsp.realpath(from), path.join(staging, 'new'), cloneBin);
    if (fs.lstatSync(to, { throwIfNoEntry: false })) await fsp.rename(to, path.join(staging, 'old'));
    await fsp.rename(path.join(staging, 'new'), to);
    // Judged in place: whether a link leaves the jail depends on where the tree stands. A tree this pass could not
    // finish is taken back out, so a later run places it again instead of trusting it.
    const dropped = await dropLinksOut(to, jail).catch(async (err: unknown) => {
      await fsp.rename(to, path.join(staging, 'unfinished')).catch(() => {});
      throw err;
    });
    for (const link of dropped.slice(0, NAMED_LINKS)) say(`deps: dropped a link that leads out of the jail: ${link}`);
    if (dropped.length > NAMED_LINKS) say(`deps: dropped ${dropped.length - NAMED_LINKS} more links that lead out of the jail`);
    return how;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** The sandbox switch when it is on, as written; null when off. An unreadable value fails the run elsewhere, as on. */
function sandboxOn(): string | null {
  try {
    const mode = sandboxMode();
    return mode === 'off' ? null : mode;
  } catch {
    return process.env['FOREMAN_SANDBOX'] ?? 'on';
  }
}

export interface ProvisionOptions {
  /** Run `npm ci` into the cache when neither the repo nor the cache has a tree. */
  allowInstall?: boolean;
  installTimeoutMs?: number;
  /** Stands in for /bin/cp in tests (see copyTree); null goes straight to node's copy. */
  cloneBin?: string | null;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/**
 * Give a worktree jail the dependencies its tests need.
 *
 * `git worktree add` never carries a gitignored `node_modules`, so without this
 * the test gate runs against an uninstalled tree — which does not merely cost
 * an install, it fails outright and turns a good change into a `fail` verdict.
 */
export async function provisionDeps(
  jailDir: string,
  repoDir: string,
  opts: ProvisionOptions = {},
): Promise<DepsResult> {
  const started = Date.now();
  const mode = depsMode();
  const done = (provisioned: boolean, source: DepsResult['source'], reason: string): DepsResult => ({
    provisioned, mode, source, reason, ms: Date.now() - started,
  });

  if (mode === 'off') return done(false, null, 'disabled by FOREMAN_DEPS_MODE=off');
  if (!fs.existsSync(path.join(jailDir, 'package.json'))) return done(false, null, 'not an npm project');

  const target = path.join(jailDir, 'node_modules');
  // Tracked node_modules is already in the worktree, and adding to it would
  // show up as a change the operator never made. Checked before the
  // existence test so the operator gets the specific reason, not just
  // "something is already there".
  const tracked = await isTracked(repoDir, 'node_modules');
  if (tracked === null) return done(false, null, 'could not determine whether node_modules is tracked by git; leaving it alone');
  if (tracked) return done(false, null, 'node_modules is tracked by git; leaving it alone');
  // Neither tracked nor ignored: the placed tree would be an untracked change in the jail's diff.
  const unignored = !(await isIgnored(repoDir, 'node_modules'));
  // A tree from before links were copied as written is replaced, once a tree to replace it with is in hand: its
  // tools are links out of the jail, dead under the sandbox and shared with every other jail without it.
  const stale = mode === 'clone' && hasLinksOut(target, jailDir);
  if (fs.existsSync(target) && !stale) return done(false, null, 'the jail already has node_modules');
  const say = (line: string): void => {
    if (opts.onLine) opts.onLine(line);
    else process.stderr.write(`foreman: ${line}\n`);
  };
  // What is appended to the reason: a plain copy is said (it costs the tree's size again, on every jail).
  const put = async (from: string): Promise<string> => {
    const how = await place(from, target, mode, say, opts.cloneBin === undefined ? cloneBinFor() : opts.cloneBin);
    return (how === 'copy' ? ' by plain copy (no copy-on-write here)' : '') +
      (stale ? ', replacing a tree whose .bin links led out of the jail' : '') +
      (unignored ? await keepOutOfDiff(jailDir) : '');
  };

  // 1. The repo's own tree, when it matches its lockfile.
  if (installIsCurrent(repoDir)) {
    const replaced = await put(path.join(repoDir, 'node_modules'));
    return done(true, 'repo', `${mode}d the repo's node_modules${replaced}`);
  }

  const lock = lockfileIn(jailDir);
  if (!lock) return done(false, null, 'no lockfile and no usable node_modules in the repo');

  // 2. A cached install keyed by the lockfile, shared across runs and repos.
  const key = lockHash(lock);
  const cached = path.join(depsCacheRoot(), key, 'node_modules');
  if (fs.existsSync(cached)) {
    const replaced = await put(cached);
    return done(true, 'cache', `${mode}d the cached install for lockfile ${key}${replaced}`);
  }

  if (!opts.allowInstall) return done(false, null, `no cached install for lockfile ${key}`);

  // 3. Install once, into the cache, so the next run of any task on this
  //    lockfile is a clone rather than another install.
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-deps-'));
  try {
    await fsp.copyFile(path.join(jailDir, 'package.json'), path.join(staging, 'package.json'));
    await fsp.copyFile(lock, path.join(staging, path.basename(lock)));
    opts.onLine?.(`installing dependencies for lockfile ${key} (once; later runs reuse it)`);
    await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: staging,
      timeout: opts.installTimeoutMs ?? 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      signal: opts.signal,
    });
    if (!fs.existsSync(path.join(staging, 'node_modules'))) {
      return done(false, null, 'npm ci produced no node_modules');
    }
    await fsp.mkdir(path.join(depsCacheRoot(), key), { recursive: true });
    await fsp.rename(path.join(staging, 'node_modules'), cached).catch(async () => {
      // A rename across devices fails. Copy to a sibling first and rename into
      // place, so a concurrent run never sees a half-populated cache entry.
      const partial = `${cached}.partial-${process.pid}`;
      await fsp.rm(partial, { recursive: true, force: true });
      await copyTree(path.join(staging, 'node_modules'), partial);
      await fsp.rename(partial, cached).catch(async () => {
        await fsp.rm(partial, { recursive: true, force: true });
      });
    });
    const replaced = await put(cached);
    return done(true, 'install', `installed and cached lockfile ${key}${replaced}`);
  } catch (err) {
    return done(false, null, `dependency install failed: ${(err as Error).message.slice(0, 300)}`);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drop cached installs, oldest first, keeping the newest `keep` lockfiles. */
export function pruneDepsCache(keep = 5): string[] {
  const root = depsCacheRoot();
  if (!fs.existsSync(root)) return [];
  const entries = fs
    .readdirSync(root)
    .map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  const dropped: string[] = [];
  for (const entry of entries.slice(keep)) {
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    dropped.push(entry.name);
  }
  return dropped;
}

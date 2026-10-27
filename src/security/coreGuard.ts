import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { driverlessEnv } from '../isolate.ts';
import type { Task } from '../types.ts';

const exec = promisify(execFile);

/** Where Foreman's own source lives. */
export function foremanRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Paths a self-improvement run may never touch. This is the list that stops
 * Foreman widening its own permissions: the security scanner and this guard,
 * the merge logic (the landing check), the tool-registration path, the jail
 * (which says what a run changed), the lock, the file that re-exports this
 * list, and the tests that pin the guard. Also the files that hold the rules
 * around it — the gate (a person lands a self-change; a refused landing is not
 * done), the scheduler (the run's check), the queue (reopen), the HTTP API and
 * the store's schema. Those are listed because the approve endpoint takes no
 * proof of who is calling: a process a run left behind can approve its own
 * ticket, so "a person approves it" does not by itself keep a worker's change
 * out of them. Editing any of these requires the ticket to carry allowCore,
 * which Foreman never sets on its own.
 */
export const PROTECTED_PATHS = [
  'src/security/',
  'src/improve.ts',
  'src/merge.ts',
  'src/isolate.ts',
  'src/tools/catalog.ts',
  'src/lock.ts',
  'src/gate.ts',
  'src/scheduler.ts',
  'src/queue.ts',
  'src/server.ts',
  'src/db.ts',
  'src/daemonGuard.ts',
  'test/improve.test.ts',
  'test/security-guard.test.ts',
];

export class CoreChangeRefused extends Error {}

/**
 * The environment for the identity lookup: a GIT_DIR (or its companions)
 * inherited by the daemon would make every directory answer as that one
 * repository, and an unrelated repo would pass for Foreman.
 */
function plainGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) delete env[key];
  return env;
}

/** How long the identity lookup may take. Past it git is treated as unable to answer (the fallback comparison). */
const IDENTITY_TIMEOUT_MS = 5_000;
/** How long an identity that was found is reused. */
const IDENTITY_TTL_MS = 60_000;
/** How long "git could not answer here" is reused: short, so a repository that appears is noticed. */
const IDENTITY_MISS_TTL_MS = 5_000;
const IDENTITY_CACHE_MAX = 256;

/**
 * Repository identity per resolved path. The lookup is a synchronous git
 * process, and it was run twice per `isSelfTask` call, several times per run
 * and per scheduler tick: with a slow git that stalled the tick, the HTTP
 * board and every other run's log streaming for seconds at a time.
 *
 * A cached answer can be stale for up to the TTL: a path repointed at another
 * repository (a symlink swapped, a directory replaced) keeps its old answer
 * until the entry expires. That is acceptable for the callers that read the
 * cache — admission, the brief, the run's check, the owner-gate question —
 * because none of them is the hard block. The landing check (merge.ts) never
 * reads the cache: it asks git afresh at approval (`isSelfTaskFresh`), for the
 * task's repo and for the self root, so what lands is always decided on a
 * current answer. A stale "self" only refuses more.
 */
const identityCache = new Map<string, { id: string | null; until: number }>();

/** Forget every cached identity. For tests. */
export function clearRepoIdentityCache(): void {
  identityCache.clear();
}

function remember(dir: string, id: string | null, forever: boolean): void {
  identityCache.delete(dir);
  while (identityCache.size >= IDENTITY_CACHE_MAX) {
    const oldest = identityCache.keys().next();
    if (oldest.done) break;
    identityCache.delete(oldest.value);
  }
  const until = id === null ? Date.now() + IDENTITY_MISS_TTL_MS : forever ? Infinity : Date.now() + IDENTITY_TTL_MS;
  identityCache.set(dir, { id, until });
}

const IDENTITY_ARGS = ['rev-parse', '--git-common-dir'];

/** Device and inode of the shared git directory git named from `dir`. */
function identityFrom(dir: string, out: string): string | null {
  const rel = out.trim();
  if (!rel) return null;
  const stat = fs.statSync(path.resolve(dir, rel));
  return `${stat.dev}:${stat.ino}`;
}

/** Device and inode of a checkout's shared git directory: the same for every path into one repository. */
function lookupIdentity(dir: string): string | null {
  try {
    const out = execFileSync('git', IDENTITY_ARGS, {
      cwd: dir, encoding: 'utf8', timeout: IDENTITY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: plainGitEnv(),
    });
    return identityFrom(dir, out);
  } catch {
    return null; // not a repository, not a directory, git is unavailable, or it timed out
  }
}

/** The same lookup without blocking the event loop. */
async function lookupIdentityAsync(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', IDENTITY_ARGS, {
      cwd: dir, encoding: 'utf8', timeout: IDENTITY_TIMEOUT_MS, env: plainGitEnv(),
    });
    return identityFrom(dir, stdout);
  } catch {
    return null;
  }
}

/**
 * The cached identity of `dir` (already resolved). `forever` is for the self
 * root: Foreman's own checkout does not change under the running process, so
 * its identity is kept for the process lifetime once found; a failed lookup is
 * kept only for the short miss time and then tried again.
 */
function repoIdentity(dir: string, forever = false): string | null {
  const hit = identityCache.get(dir);
  if (hit && hit.until > Date.now()) return hit.id;
  const id = lookupIdentity(dir);
  remember(dir, id, forever);
  return id;
}

/** The comparison once both identities are known (or not): identity when git answered for both, resolved paths otherwise. */
function sameRepo(repo: string, selfRoot: string, theirs: string | null, ours: string | null): boolean {
  if (theirs && ours) return theirs === ours;
  try {
    return fs.realpathSync(repo) === fs.realpathSync(selfRoot);
  } catch {
    return repo === path.resolve(selfRoot);
  }
}

/**
 * True when this task would modify Foreman itself. Decided by repository
 * identity, not by how the path is spelled: a sub-directory of the checkout,
 * another letter-case of it on a case-insensitive disk, a symlink to it and a
 * linked worktree of it are all Foreman. Falls back to comparing resolved paths
 * when git cannot answer. `selfRoot` is a parameter so a test can stand a
 * throwaway repo in for Foreman. Identities are cached (see `identityCache`);
 * the landing check uses `isSelfTaskFresh`.
 */
export function isSelfTask(task: Pick<Task, 'repo'>, selfRoot: string = foremanRoot()): boolean {
  if (!task.repo) return false;
  const repo = path.resolve(task.repo);
  const theirs = repoIdentity(repo);
  const ours = theirs ? repoIdentity(path.resolve(selfRoot), true) : null;
  return sameRepo(repo, selfRoot, theirs, ours);
}

/**
 * `isSelfTask` decided on a lookup made now, for both the task's repo and the
 * self root; nothing is read from the cache (the answers are written to it).
 * The landing check's: a hard block does not rest on a remembered answer.
 * Asynchronous, so an approval does not hold the event loop while git runs.
 */
export async function isSelfTaskFresh(task: Pick<Task, 'repo'>, selfRoot: string = foremanRoot()): Promise<boolean> {
  if (!task.repo) return false;
  const repo = path.resolve(task.repo);
  const self = path.resolve(selfRoot);
  const theirs = await lookupIdentityAsync(repo);
  remember(repo, theirs, false);
  let ours: string | null = null;
  if (theirs) {
    ours = await lookupIdentityAsync(self);
    remember(self, ours, true);
  }
  return sameRepo(repo, selfRoot, theirs, ours);
}

/**
 * A path as the disk would match it. Letter-case is ignored: on a
 * case-insensitive disk `SRC/Lock.ts` checks out over `src/lock.ts`. So are the
 * other spellings such a disk folds together: compatibility forms (`ſ`, U+017F,
 * opens the same file as `s` on APFS) and invisible format characters. Folding
 * more than the disk does only refuses more.
 */
function foldPath(p: string): string {
  return p.normalize('NFKD').replace(/\p{Cf}/gu, '').toUpperCase().toLowerCase();
}

/**
 * Compared as the disk would match them (`foldPath`). A directory entry also
 * matches without its slash, which is how the directory replaced by a file or
 * a symlink is listed.
 */
export function isProtectedPath(p: string): boolean {
  const folded = foldPath(p);
  return PROTECTED_PATHS.some((prefix) => {
    const want = foldPath(prefix);
    return folded === want || folded.startsWith(want) || (want.endsWith('/') && folded === want.slice(0, -1));
  });
}

/**
 * Every path that differs between `from` and `to` — or between `from` and the
 * working tree when `to` is omitted — as git itself names them, not as parsed
 * from patch text: a repo's diff.noprefix or diff.mnemonicPrefix changes the
 * patch headers and no path is read from them. `--no-renames` lists a rename as
 * the path that went and the path that came, so moving a file out of a
 * protected path, or into one, names the protected side. `-z` gives each path
 * verbatim, spaces and non-ASCII included. `--no-relative` because a repo's
 * diff.relative would otherwise limit the listing to the directory git runs in.
 * `to` may be a tree as well as a commit. Throws when git fails; the callers
 * treat that as a refusal.
 */
export async function changedPaths(cwd: string, from: string, to?: string): Promise<string[]> {
  // The same pins as every git call in isolate.ts (gitExec there), for the
  // same reason: the jail can write the config this runs under. Without them
  // this listing — the one the core guard decides on — ran the jail's
  // fsmonitor program, and a `git replace` of a protected file's base blob
  // took that file out of it. Compared with the working tree (no `to`), it
  // also hashes the files the worker changed, through any clean filter the
  // config names — and starts a git in each submodule that does the same — so
  // those drivers are switched off by name (isolate.ts driverlessEnv); two
  // trees are compared without reading a file. No lazy fetch: a promisor
  // remote the config names ran its `uploadpack` program for a dropped object.
  const drivers = to ? {} : await driverlessEnv(cwd);
  const { stdout } = await exec(
    'git',
    [
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
      '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative',
      '--ignore-submodules=none', '--name-only', '-z',
      from, ...(to ? [to] : []), '--',
    ],
    { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...plainGitEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...drivers } },
  );
  return stdout.split('\0').filter(Boolean);
}

/**
 * The one test both the run's check and the landing check apply to a listing.
 * Returns the reason to refuse, or null. `changed` says the caller knows there
 * is a change; with nothing listed for it the listing cannot be trusted, and
 * that is a refusal too.
 */
export function coreRefusal(paths: string[], changed: boolean): string | null {
  const hit = paths.filter(isProtectedPath);
  if (hit.length) {
    return `core change refused: this change touches Foreman's core (${hit.join(', ')}). ` +
      'Re-queue with --allow-core if a human really intends that.';
  }
  if (changed && !paths.length) {
    return "core change refused: there is a change but git listed no path for it, so it cannot be shown to leave Foreman's core alone";
  }
  return null;
}

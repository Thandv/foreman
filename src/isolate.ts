import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { changedPaths } from './security/coreGuard.ts';
import type { Task } from './types.ts';

const exec = promisify(execFile);

/**
 * What no repository may decide for a git command Foreman runs. A jail shares
 * its repo's config and git directory, and the worker can write both, so every
 * call in this file — in a jail or in the repo it was cut from — goes through
 * `gitExec` with these on the command line, where they outrank the config (and
 * so does every daemon-side git call elsewhere, through `pinnedGit`): no
 * hooks (post-index-change runs on `add`, post-checkout on `worktree add`), no
 * fsmonitor program (run by `add`, `status` and `diff`), no extra attributes
 * file, no `reset --hard` that recurses into a submodule's checkout. Command-
 * line pins reach the git a submodule is checked by, too (git passes them on).
 * No signing and no signature check: `commit.gpgsign` (and a `merge.verify-
 * Signatures` or `log.showSignature`) runs `gpg.program`, which the config
 * names too — measured on the landing commit. The filter and merge drivers are
 * switched off by name: see `driverlessEnv`.
 */
export const PINNED = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'submodule.recurse=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'merge.verifySignatures=false', '-c', 'log.showSignature=false',
  '-c', 'gpg.program=', '-c', 'gpg.ssh.program=', '-c', 'gpg.x509.program=',
];
/** Inherited by the daemon, these would point a call at another repository, index or config. */
const NOT_INHERITED = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(_.*)?)$/;

/**
 * The environment of every git child: objects are read as stored (a
 * `git replace` made in a jail writes refs/replace/* into the shared store,
 * and would otherwise swap what a diff or a `show` prints), no system
 * attributes, no prompt, no lazy fetch (a worker that names a promisor
 * remote and drops an object the call reads had its `uploadpack` program run
 * by the diff, the core guard's listing and the landing's merge). `extra` is
 * what one call sets for itself.
 */
export function pinnedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!NOT_INHERITED.test(key)) env[key] = value;
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', ...extra };
}

/**
 * Subcommands (as this file calls them) that neither read a file of the
 * working tree nor write the index, and merge nothing, so no filter or merge
 * driver can run: they skip the driver listing. Everything else gets it — add,
 * status, diff, apply, reset, clean, worktree add/remove, and also write-tree
 * and read-tree: a command that writes the index re-hashes an entry that is
 * "racily clean" (changed in the second the index was written), through the
 * clean filter. Measured: jailTree's `write-tree` ran a process filter.
 */
const NO_DRIVERS_RUN = new Set(['rev-parse', 'rev-list', 'log', 'merge-base', 'cat-file', 'branch', 'config', 'ls-files', 'show']);

function runsNoDriver(args: string[]): boolean {
  let at = 0;
  while (args[at] === '-c') at += 2;
  const sub = args[at] ?? '';
  return NO_DRIVERS_RUN.has(sub) || (sub === 'worktree' && (args[at + 1] === 'list' || args[at + 1] === 'prune'));
}

/**
 * What a merge driver the config names is replaced with: git's own line merge
 * of the three versions, with the conflict-marker size the attributes ask for
 * (`%L`) — what git does for a file with no driver. The command is ours; `%O`,
 * `%A`, `%B` are temporary files git names.
 */
const MERGE_STAND_IN = 'git merge-file -q --marker-size=%L %A %O %B';

/** How many repositories (the one asked in and the submodules or embedded repos under it) one listing reads. */
const MAX_DRIVER_REPOS = 64;
const MAX_DRIVER_DEPTH = 6;

/**
 * The environment that switches off every filter driver (`clean`, `smudge`,
 * `process`) and every merge driver a repository names, for one git call in
 * `cwd`. The jail can write the repo's config and `.git/info/attributes`; a
 * `filter.<x>.clean` there with `* filter=<x>` ran its program in the daemon,
 * unsandboxed and with the daemon's environment, on every `add`, `status` and
 * worktree `diff` (smudge on every checkout, a merge driver on `apply
 * --3way`, `merge-tree` and `merge`). The names are the config's own, so no
 * fixed pin covers them: each filter found is given an empty command (git runs
 * no filter whose command is empty) and `required=false` (so a blanked filter
 * is not an error); each merge driver is given `MERGE_STAND_IN`, git's own
 * three-way line merge. (An empty driver is not "no driver": git fails to run
 * it, and `merge-tree` then dies — a landing could not be listed, and a
 * conflict was not reported as one.)
 *
 * - The listing is `git config --get-regexp`, which runs nothing, in the same
 *   directory as the call: an `includeIf "gitdir:…"` or `"onbranch:…"` that
 *   pulls in a driver is then judged as the call will judge it (see
 *   `checkoutWorktree` for the one call that changes directory and branch).
 * - The entries go in as GIT_CONFIG_COUNT/KEY/VALUE, never `-c name=value`:
 *   `-c` splits at the first `=`, so a driver named `x=y` turned
 *   `-c filter.x=y.clean=` into `filter.x` = `y.clean=` and still ran.
 * - `add`, `status` and a worktree `diff` start a second git in every
 *   populated submodule (and in a repo the worker made inside the jail, once
 *   it is in the index) to ask whether it is dirty; that git reads the
 *   submodule's own config, which the worker can write too. It inherits this
 *   environment, so the drivers named there (and in its submodules, down to
 *   MAX_DRIVER_DEPTH) are listed and blanked as well. Past the bounds this
 *   throws rather than run a call it could not cover. The cost: two git
 *   processes per call (the config; the index's gitlinks), two more per
 *   nested repository.
 * - An attribute that names a driver no config defines runs nothing, so the
 *   attributes themselves need no reading.
 *
 * A repo that relies on a filter (git-lfs, a keyword filter) is therefore seen
 * by Foreman's own calls as the raw bytes: a checkout holds what the repo
 * stores (an LFS pointer), and a snapshot stores the file as it is on disk.
 */
export async function driverlessEnv(cwd: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  const read = async (dir: string, depth: number): Promise<void> => {
    const run = async (args: string[], ok: number[] = []): Promise<string> => {
      const env = pinnedEnv(depth === 0 ? extra : {});
      return (await exec('git', [...PINNED, ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 }).catch((err: { code?: unknown; stdout?: unknown }) => {
        if (typeof err.code === 'number' && ok.includes(err.code)) return { stdout: typeof err.stdout === 'string' ? err.stdout : '' };
        throw err;
      })).stdout;
    };
    // Exit 1 is "no such key"; anything else (an unreadable config) fails the call it was for.
    for (const key of (await run(['config', '-z', '--name-only', '--get-regexp', '^(filter|merge)\\.'], [1])).split('\0')) {
      // `(.*)`: `[filter ""]` is a driver too, named by `filter=` (an empty value), and it ran.
      const m = /^(filter|merge)\.(.*)\.[^.]+$/s.exec(key);
      if (!m) continue;
      const name = m[2]!;
      if (m[1] === 'filter') for (const k of ['clean', 'smudge', 'process']) keys.add(`filter.${name}.${k}\0`);
      if (m[1] === 'filter') keys.add(`filter.${name}.required\0false`);
      if (m[1] === 'merge') keys.add(`merge.${name}.driver\0${MERGE_STAND_IN}`);
    }
    const real = await fs.realpath(dir).catch(() => dir);
    if (seen.has(real)) return;
    seen.add(real);
    if (seen.size > MAX_DRIVER_REPOS) throw new Error(`more than ${MAX_DRIVER_REPOS} nested repositories under ${cwd}: refusing to run git there`);
    // The repos git may start a second git in: the gitlinks in the index. (A
    // repo the worker made inside the jail is one once an `add` has run; that
    // same `add` starts no git in it.) The whole index, from the top of the
    // tree whatever directory `dir` is; outside a repository there is none.
    // Any other failure throws, as the config listing's does: read as "no
    // gitlinks", an index padded past maxBuffer let a nested repo's filter run.
    const nested = new Set<string>();
    const listing = await run(['ls-files', '-s', '-z', '--full-name', '--', ':/']).catch((err: { code?: unknown; stderr?: unknown }) => {
      if (err.code === 128 && typeof err.stderr === 'string' && /not a git repository/.test(err.stderr)) return '';
      throw err;
    });
    for (const line of listing.split('\0')) {
      const m = /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(line);
      if (m) nested.add(m[1]!);
    }
    if (!nested.size) return;
    const top = (await run(['rev-parse', '--show-toplevel'])).trim();
    for (const p of nested) {
      const sub = path.join(top, p);
      if (!(await fs.lstat(path.join(sub, '.git')).then(() => true, () => false))) continue;
      if (depth + 1 > MAX_DRIVER_DEPTH) throw new Error(`repositories nested deeper than ${MAX_DRIVER_DEPTH} under ${cwd}: refusing to run git there`);
      await read(sub, depth + 1);
    }
  };
  await read(cwd, 0);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(keys.size) };
  [...keys].forEach((entry, i) => {
    const cut = entry.indexOf('\0');
    env[`GIT_CONFIG_KEY_${i}`] = entry.slice(0, cut);
    env[`GIT_CONFIG_VALUE_${i}`] = entry.slice(cut + 1);
  });
  return env;
}

/**
 * The one place this file starts git, and what every other daemon-side git call
 * (merge.ts, the core guard's listing, the post-merge check, the sweep, the
 * revert check) goes through: PINNED, `pinnedEnv`, and the drivers switched off
 * (`driverlessEnv`). Rejects as `execFile` does (`code`, `stdout`, `stderr`).
 */
export async function pinnedGit(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return gitExec(cwd, args, extra);
}

async function gitExec(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const drivers = runsNoDriver(args) ? {} : await driverlessEnv(cwd, extra);
  return exec('git', [...PINNED, ...args], { cwd, env: pinnedEnv({ ...extra, ...drivers }), maxBuffer: 64 * 1024 * 1024 });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitExec(cwd, args)).stdout;
}

/** The same call with stdout as the bytes git wrote (a patch taken with --text is not all UTF-8). */
async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const drivers = runsNoDriver(args) ? {} : await driverlessEnv(cwd);
  const { stdout } = await exec('git', [...PINNED, ...args], { cwd, env: pinnedEnv(drivers), maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
}

/**
 * `git worktree add` of `commit` at `dir`, with the checkout done here rather
 * than by git's own child. That child runs in the new worktree, where an
 * `includeIf "onbranch:foreman/**"` or `"gitdir:…/worktrees/…"` in the repo's
 * config can pull in a filter that a listing in the repo itself never sees
 * (measured: its smudge ran). So the worktree is added without a checkout,
 * and the checkout — the same `reset --hard --no-recurse-submodules` git
 * would run — is a call of its own, listed in the worktree. `opts` are the
 * `worktree add` options (`-b <branch>`, `--detach`).
 */
export async function checkoutWorktree(repo: string, dir: string, opts: string[], commit: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--no-checkout', ...opts, dir, commit]);
  await git(dir, ['reset', '-q', '--hard', '--no-recurse-submodules', 'HEAD']);
}

export interface Jail {
  /** The ref the worktree was cut from, for the run log. */
  base?: string;
  /** The task's baseRef was already merged into HEAD, so the worktree was cut from HEAD. */
  baseMerged?: boolean;
  /**
   * The commit the worktree was cut from; see `jailBase`. The scheduler keeps
   * it on the run row and hands it back to `reuseJail`.
   */
  baseCommit?: string;
  /** Working directory handed to the runner. Never the user's repo itself. */
  dir: string;
  repo: string | null;
  branch: string | null;
}

export class DirtyRepoError extends Error {}

/**
 * Fail-closed isolation. Code tasks with a repo get a git worktree on a fresh
 * branch; everything else gets a scratch directory. A runner never gets a
 * handle on the operator's checkout.
 */
export async function createJail(task: Task, runId: string): Promise<Jail> {
  const dir = path.join(config.workRoot, runId);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  if (!task.repo) {
    await fs.mkdir(dir, { recursive: true });
    return { dir, repo: null, branch: null };
  }

  const repo = path.resolve(task.repo);
  const stat = await fs.stat(repo).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`repo not found: ${repo}`);

  const top = (await git(repo, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error(`not a git repository: ${repo}`);

  const dirty = (await git(top, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new DirtyRepoError(
      `repo has uncommitted changes, refusing to branch from it: ${top}\n${dirty.split('\n').slice(0, 5).join('\n')}`,
    );
  }

  // One branch per RUN, not per task: a repair round or a retry creates a
  // second worktree while the first still exists, and git refuses to check
  // out the same branch twice.
  const branch = `foreman/${task.id}-${runId}`;
  // Normally HEAD. A task carrying a baseRef is about work that has not merged
  // — a ticket a reviewer filed against a draft — and cutting it from HEAD
  // would open it in a tree where that draft does not exist. A ref that has
  // since been pruned falls back to HEAD rather than failing the task: the
  // work is then missing, but the ticket is workable and says so. A ref that
  // HEAD already contains (the draft merged, and its branch outlived the merge)
  // is HEAD's past: cutting from it would hide everything merged since, which
  // is how Kiln follow-ups retried "from main" kept opening on a weeks-old tree
  // without the code they were about.
  const wanted = task.baseRef?.trim();
  const exists = !!wanted && (await git(top, ['rev-parse', '--verify', `${wanted}^{commit}`]).then(() => true).catch(() => false));
  const merged = exists && (await git(top, ['merge-base', '--is-ancestor', wanted!, 'HEAD']).then(() => true).catch(() => false));
  const base = exists && !merged ? wanted! : 'HEAD';
  // Resolved once and cut from the commit, so what is recorded is what was cut.
  const baseCommit = (await git(top, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  await checkoutWorktree(top, dir, ['-b', branch], baseCommit);
  return { dir, repo: top, branch, base, baseCommit, ...(merged ? { baseMerged: true } : {}) };
}

const isAncestor = (cwd: string, older: string, newer: string): Promise<boolean> =>
  git(cwd, ['merge-base', '--is-ancestor', older, newer]).then(() => true).catch(() => false);

/**
 * The commit a jail was cut from. Everything a run changed is measured from
 * here and not from the jail's HEAD: a worker can commit inside its jail, and
 * `git diff HEAD` then shows nothing of what it committed — to the reviewers or
 * to the core guard.
 *
 * The recorded commit comes from the caller (the run row), never from a file
 * in the jail or its git directory: the worker's own git can write there, and
 * a record set to the jail's HEAD hides everything committed so far. It is used
 * only while it is still an ancestor of the jail's HEAD. One case moves it
 * forward: the repo's HEAD was merged into the jail since (how a conflict is
 * resolved before approving again), so the point where the jail's branch left
 * the repo's HEAD is now a descendant of the record, and measuring from the
 * record would count other tickets' landed work as this run's. That point is
 * always part of the repo's own history, so no commit made in the jail can be
 * hidden behind it.
 *
 * With no usable record (a jail cut before it was kept, a branch reset
 * somewhere else) the base is that same fork point. Throws when there is none,
 * which fails the run rather than measuring it from the wrong place. A worker
 * that amends the commit its jail was cut from lands in this case too: the
 * fork point is then that commit's parent, so the diff also shows the cut
 * commit's own files, and a branch reset onto a commit with no history fails
 * the run where a `git diff HEAD` would have shown an empty review.
 */
export async function jailBase(jail: Jail): Promise<string> {
  if (!jail.repo) throw new Error('a scratch jail has no base commit');
  const head = (await git(jail.repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const fork = (await git(jail.dir, ['merge-base', 'HEAD', head]).catch(() => '')).trim();
  const recorded = jail.baseCommit ?? '';
  if (/^[0-9a-f]{40,64}$/.test(recorded) && (await isAncestor(jail.dir, recorded, 'HEAD'))) {
    return fork && fork !== recorded && (await isAncestor(jail.dir, recorded, fork)) ? fork : recorded;
  }
  if (!fork) throw new Error(`cannot tell which commit the jail ${jail.dir} was cut from`);
  return fork;
}

/**
 * Re-open the worktree a previous run left on disk, instead of branching a new
 * one. Only a resumed repair round wants this: the hosted CLI scopes a session
 * to the project directory it ran in, so a fresh jail can neither FIND the
 * conversation (`--resume` answers "No conversation found") nor apply a
 * transcript full of the old jail's absolute paths.
 *
 * Returns null — go cold — whenever the tree is not exactly where it was left:
 * deleted, pruned, or no longer a worktree of this repo. `git worktree list`
 * still names a worktree whose directory was deleted, and a directory whose
 * worktree was pruned still exists, so both halves are checked.
 *
 * `baseCommit` is what the run that cut the jail recorded (`Jail.baseCommit`);
 * the caller keeps it, because nothing inside the jail can be trusted to.
 */
export async function reuseJail(task: Task, dir: string, branch: string | null, baseCommit?: string | null): Promise<Jail | null> {
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return null;
  // A repo-less task's jail is a plain scratch directory: nothing to verify
  // beyond its existence, and no branch to record.
  if (!task.repo) return { dir, repo: null, branch: null };

  const repo = path.resolve(task.repo);
  const top = (await git(repo, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) return null;

  // realpath both sides: git reports a worktree by its resolved path, and on
  // macOS every /tmp jail is behind a symlink.
  const real = await fs.realpath(dir).catch(() => null);
  if (!real) return null;
  const list = await git(top, ['worktree', 'list', '--porcelain']).catch(() => '');
  const registered = list
    .split('\n')
    .some((l) => l.startsWith('worktree ') && path.resolve(l.slice('worktree '.length).trim()) === real);
  if (!registered) return null;

  // Record the branch that is actually checked out there, not the one we
  // expected: the run row has to describe the tree diff/merge will act on.
  const head = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  return { dir, repo: top, branch: head && head !== 'HEAD' ? head : branch, ...(baseCommit ? { baseCommit } : {}) };
}

/**
 * Lay a previous run's diff onto a fresh jail, so a retry continues that work
 * on top of the current base. Three-way, so it survives a base that moved;
 * on any conflict the jail is left exactly as cut and the reason returned.
 * With `keepConflicts` (a round whose whole job is to resolve the conflict) a
 * conflicting apply keeps its markers in the files, and `conflicted` names them.
 */
export async function carryDiff(
  jail: Jail,
  diffPath: string,
  opts: { keepConflicts?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string; conflicted?: string[] }> {
  if (!jail.repo) return { ok: false, reason: 'no repo' };
  try {
    await git(jail.dir, ['apply', '--3way', '--whitespace=nowarn', diffPath]);
    return { ok: true };
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr || (err as Error).message;
    const reason = msg.trim().split('\n').slice(0, 3).join(' | ');
    if (opts.keepConflicts) {
      const conflicted = (await git(jail.dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''))
        .split('\0').filter(Boolean);
      if (conflicted.length) return { ok: false, reason, conflicted };
    }
    // A partial three-way apply leaves conflict markers; put the tree back.
    await git(jail.dir, ['reset', '-q', '--hard', 'HEAD']).catch(() => {});
    await git(jail.dir, ['clean', '-q', '-fd']).catch(() => {});
    return { ok: false, reason };
  }
}

/** Paths a worktree still holds as unmerged (an unresolved 3-way apply). Throws when git cannot say. */
export async function unmergedPaths(dir: string): Promise<string[]> {
  return (await git(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
}

/**
 * Conflict markers a conflict-repair round left behind: the paths whose added
 * lines still hold one (git's own `diff --check` against the jail's base, run
 * after everything is staged so a path the worker resolved by editing is judged
 * by its content, not by the index entry the 3-way apply left). Asked in the
 * jail; nothing here touches the repo. `added` is the subset of `paths` the
 * ticket itself created (a legitimate `=======` line can trip the check there).
 * Fails closed: any git failure other than "found problems" (exit 2) throws,
 * so a check that did not run is never read as a clean tree.
 */
export async function leftoverMarkers(jail: Jail): Promise<{ paths: string[]; added: string[] }> {
  if (!jail.repo) return { paths: [], added: [] };
  const base = await jailBase(jail);
  await git(jail.dir, ['add', '-A']);
  const out = await gitExec(jail.dir, ['-c', 'core.quotePath=false', 'diff', '--check', '--cached', '--no-ext-diff', '--no-textconv', '--no-relative', base]).then((r) => r.stdout, (err: { code?: unknown; stdout?: unknown; message?: string }) => {
    if (err.code === 2 && typeof err.stdout === 'string') return err.stdout;
    throw new Error(`git diff --check failed: ${(err.message ?? String(err.code)).slice(0, 200)}`);
  });
  const paths = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^(.+?):\d+: leftover conflict marker/.exec(line);
    if (m) paths.add(m[1]!);
  }
  if (!paths.size) return { paths: [], added: [] };
  const created = new Set(
    (await git(jail.dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=A', '--cached', '--no-relative', '-z', base]))
      .split('\0').filter(Boolean),
  );
  return { paths: [...paths], added: [...paths].filter((p) => created.has(p)) };
}

/**
 * Unified diff of everything the runner changed since the jail was cut:
 * committed inside the jail, uncommitted, and untracked.
 *
 * Never through a textconv driver, in any repo: the jail can write the config
 * that names one and the `.git/info/attributes` that says which files it
 * converts, the program then runs in the daemon when the diff is taken, and
 * the patch shows what the program printed rather than what would land. A repo
 * that keeps documents in a binary format gets the short binary line below for
 * them. (The second parameter is what callers once passed to ask for this for
 * a change to Foreman itself; it is accepted and changes nothing.)
 *
 * The jail can also write `.git/info/attributes`, which no config switches
 * off: `secret.sh -diff` (or `binary`) there made this patch say "Binary files
 * differ" for a script nobody was then shown. So the patch is taken with
 * `--text` — every file printed as its lines, whatever an attribute calls it —
 * and with full object names, which is what lets `markBinaries` put a short
 * line where the bytes of a file that IS binary would be.
 */
export async function diffJail(jail: Jail, _opts: { noTextconv?: boolean } = {}): Promise<string> {
  if (!jail.repo) return '';
  const base = await jailBase(jail);
  // intent-to-add so untracked files show up in the diff without staging them
  await git(jail.dir, ['add', '-A', '-N']);
  // Diff against a commit, not the index: `git diff` alone hides deletions and
  // moves of tracked files (the worktree-vs-index comparison omits them after
  // an intent-to-add), which would let a worker delete or relocate a protected
  // core file without it appearing in the review diff or reaching the gate.
  // That commit is the jail's base, not HEAD, so work the worker committed is
  // in the diff too. The flags keep the patch in one shape whatever the repo's
  // config says: no external diff driver, a/ and b/ prefixes, and the whole
  // tree rather than one directory of it (diff.relative).
  // The jail can write the repo's config too, and a reader of this patch (the
  // owner gate's human-only rule, gate.ts) can only see what git prints. So the
  // settings that change how a path or a header is printed are pinned here, on
  // the command line, where they outrank the repo's config: paths quoted to
  // plain ASCII (core.quotePath — printed bare, a name holding U+2028 is a
  // header no line-based reader matches), no colour, and a gitlink shown as an
  // ordinary `diff --git` entry rather than hidden (diff.ignoreSubmodules) or
  // summarised with no header (diff.submodule=log).
  const patch = await gitBytes(jail.dir, [
    '-c', 'core.quotePath=true',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--full-index', '--no-relative',
    '--src-prefix=a/', '--dst-prefix=b/', '--ignore-submodules=none', '--submodule=short', base,
  ]).catch((err: { code?: unknown }) => {
    // Under --text a binary file is printed whole before `markBinaries` cuts it
    // back to one line, so a run that adds more binary than the buffer holds
    // (64 MB) cannot be shown. Said in words: the bare error names a buffer.
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('the diff of this run is larger than 64 MB (a large binary file was added or changed?) and cannot be collected for review');
    }
    throw err;
  });
  return markBinaries(jail.dir, patch);
}

/** git's own test for binary content (buffer_is_binary): a NUL byte in the first 8000. */
const looksBinary = (content: Buffer): boolean => content.subarray(0, 8000).includes(0);

/** The largest file read to decide whether it is binary; the patch itself is capped at the same size. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/** The name git would give `content` as a blob, in the hash the repository uses (told by the length of `like`). */
const blobName = (content: Buffer, like: string): string =>
  createHash(like.length === 40 ? 'sha1' : 'sha256').update(`blob ${content.length}\0`).update(content).digest('hex');

/** The bytes of a file name as a patch header prints it: bare, or C-quoted. One char per byte in and out. */
function headerName(printed: string): string {
  if (!printed.startsWith('"')) return printed.replace(/\t$/, ''); // git ends a bare name holding a space with a tab
  const named: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
  return printed.slice(1, printed.lastIndexOf('"')).replace(/\\([0-7]{1,3}|.)/g, (_, esc: string) =>
    /^[0-7]/.test(esc) ? String.fromCharCode(parseInt(esc, 8) & 0xff) : named[esc] ?? esc);
}

/**
 * A `--text` patch cut into its per-file sections, each as the header git
 * printed and the hunks under it; joined again they are the patch. Hunks are
 * walked by the line counts in their `@@` headers, the way `git apply` reads
 * them, because under --text a hunk line holds any bytes at all and only the
 * counts say where a hunk stops. The text is one char per byte (latin1). null
 * when anything is not where this expects it; the caller then changes nothing.
 */
function patchSections(text: string): Array<{ header: string; body: string }> | null {
  const sections: Array<{ header: string; body: string }> = [];
  const lineEnd = (from: number): number => {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl + 1;
  };
  const opens = (at: number): boolean => text.startsWith('diff --git ', at) || text.startsWith('* Unmerged path ', at);
  let pos = 0;
  while (pos < text.length) {
    if (!opens(pos)) return null;
    const start = pos;
    pos = lineEnd(pos);
    while (pos < text.length && !opens(pos) && !text.startsWith('@@ -', pos)) pos = lineEnd(pos);
    const bodyStart = pos;
    while (text.startsWith('@@ -', pos)) {
      const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text.slice(pos, pos + 100));
      if (!counts) return null;
      let before = counts[1] === undefined ? 1 : Number(counts[1]);
      let after = counts[2] === undefined ? 1 : Number(counts[2]);
      pos = lineEnd(pos);
      while (before > 0 || after > 0) {
        const mark = text[pos];
        // An empty line is a blank context line under diff.suppressBlankEmpty.
        if (mark === ' ' || mark === '\n') { before--; after--; }
        else if (mark === '-') before--;
        else if (mark === '+') after--;
        else if (mark !== '\\') return null; // "\ No newline at end of file" counts on neither side
        pos = lineEnd(pos);
      }
      if (before < 0 || after < 0) return null;
      while (text.startsWith('\\ ', pos)) pos = lineEnd(pos);
    }
    sections.push({ header: text.slice(start, bodyStart), body: text.slice(bodyStart, pos) });
  }
  return sections;
}

/**
 * What stands in for the hunks of one file when either side of it is binary:
 * what git prints for a binary file without --text (the header down to its
 * `index` line, then "Binary files … differ"), and one line saying how much is
 * there. null — leave the
 * hunks as they are — unless this read the very bytes git compared: each side
 * is fetched by the object name in the `index` line and hashed again here, so
 * neither an attribute, nor an object planted under another's name, nor a file
 * swapped after the diff was taken can put this line over text. Symlinks and
 * gitlinks are never binary.
 */
async function binaryMarker(dir: string, header: string): Promise<string | null> {
  const lines = header.split('\n');
  if (lines.some((l) => /^(?:(?:old|new|new file|deleted file) mode|index \S+) 1[26]0000$/.test(l))) return null;
  const at = lines.findIndex((l) => l.startsWith('--- '));
  const index = lines.map((l) => /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})(?: \d+)?$/.exec(l)).find(Boolean);
  if (at < 0 || !index || !lines[at + 1]?.startsWith('+++ ')) return null;
  const from = lines[at]!.slice(4);
  const to = lines[at + 1]!.slice(4);

  const side = async (name: string, printed: string): Promise<Buffer | null | undefined> => {
    if (/^0+$/.test(name)) return null; // this side does not exist
    let content = await gitBytes(dir, ['cat-file', 'blob', name]).catch(() => undefined);
    if (!content) {
      // git hashed the file in the worktree without storing it.
      const file = path.join(dir, Buffer.from(headerName(printed), 'latin1').toString('utf8').slice(2));
      const stat = await fs.lstat(file).catch(() => null);
      if (stat?.isFile() && stat.size <= MAX_BLOB_BYTES) content = await fs.readFile(file).catch(() => undefined);
    }
    return content && blobName(content, name) === name ? content : undefined;
  };
  const old = await side(index[1]!, from);
  const now = await side(index[2]!, to);
  if (old === undefined || now === undefined) return null;
  if (!(old && looksBinary(old)) && !(now && looksBinary(now))) return null;

  // Without the a/ or b/ prefix, still quoted where git quoted it.
  const bare = (printed: string): string => (printed.startsWith('"') ? `"${printed.slice(3)}` : printed.slice(2)).replace(/\t$/, '');
  const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
  const what = now
    ? `Binary file ${bare(to)} changed (${now.length} bytes, sha256 ${sha(now)})`
    : `Binary file ${bare(from)} deleted (was ${old!.length} bytes, sha256 ${sha(old!)})`;
  // Object names cut back to the short form git prints by default: with full
  // ones `git apply --3way` (carryDiff) would lay a binary file down from the
  // object store, and a conflict round would start on a binary conflict that
  // has no markers to resolve. Short, it refuses the patch, as it always has.
  const head = lines.slice(0, at).map((l) => l.replace(/^index ([0-9a-f]{7})[0-9a-f]*\.\.([0-9a-f]{7})[0-9a-f]*/, 'index $1..$2'));
  return `${head.join('\n')}\nBinary files ${from.replace(/\t$/, '')} and ${to.replace(/\t$/, '')} differ\n${what}\n`;
}

/**
 * The review patch as text. `--text` prints a binary file as hunks of raw
 * bytes: megabytes of them for an image, in a prompt and in a reader that
 * expects lines. For a file that is binary by CONTENT (never by attribute),
 * the hunks are replaced with the line git prints for one, which `git apply`
 * (carryDiff) refuses as it did before, and a line with its size and sha256. Every other
 * byte of the patch is left as git wrote it.
 */
async function markBinaries(dir: string, patch: Buffer): Promise<string> {
  if (!patch.includes(0)) return patch.toString('utf8');
  const sections = patchSections(patch.toString('latin1'));
  if (!sections) return patch.toString('utf8');
  const out: string[] = [];
  for (const section of sections) {
    // A file is binary by a NUL in its first 8000 bytes; one whose hunks hold no NUL is readable as it is.
    const marker = section.body.includes('\0') ? await binaryMarker(dir, section.header) : null;
    out.push(marker ?? section.header + section.body);
  }
  return Buffer.from(out.join(''), 'latin1').toString('utf8');
}

/**
 * The git tree `git add -A` + commit would make of a worktree right now: the
 * exact content and modes the landing commits (merge.ts mergeApproved), as one
 * sha git computes from content. It is what "the reviewed work" is compared by,
 * because no setting changes how a tree sha is printed the way quoting, colour
 * or an attribute changes a patch.
 *
 * Built in a temporary index outside the jail, so the jail's own index and
 * files are left exactly as they were. That index starts as a copy of the
 * jail's: the landing stages into the jail's index, and `diffJail` reads the
 * worktree through it, so an entry the worker marked assume-unchanged or
 * skip-worktree counts here the way it counts in both (a tree built from HEAD
 * instead would hold the file's content on disk, which the review diff does
 * not show). Ignored files are in no tree: `git add -A` honours .gitignore
 * here as it does at the landing.
 *
 * The jail can write the repo's config, so everything in it that runs a
 * program when an index is read or written is switched off on the command
 * line: hooks (post-index-change) and the fsmonitor, as for every call here
 * (`gitExec`).
 */
export async function jailTree(dir: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'foreman-tree-'));
  const quiet = ['-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false'];
  try {
    const index = path.join(tmp, 'index');
    const run = async (args: string[]): Promise<string> =>
      (await gitExec(dir, [...quiet, ...args], { GIT_INDEX_FILE: index })).stdout;
    const own = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    // A worktree that has never had an index starts from its HEAD.
    const copied = await fs.copyFile(own, index).then(() => true, () => false);
    if (!copied) await run(['read-tree', 'HEAD']);
    // The copy keeps the time of the index it was made from. git decides which
    // entries to re-read by comparing a file's time with the index FILE's: a
    // copy stamped "now" made a same-size edit written in the same second as
    // the jail's index look unchanged, and it was left out of the tree.
    else await fs.stat(own).then((st) => fs.utimes(index, st.atime, new Date(Math.floor(st.mtimeMs / 1000) * 1000))).catch(() => {});
    await run(['add', '-A']);
    const tree = (await run(['write-tree'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git write-tree named no tree');
    return tree;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What the core guard reads at the end of a run: every path that differs from
 * the jail's base (the same listing the landing check uses, coreGuard.ts), and
 * whether the jail holds any change at all — its HEAD moved, or `git status`
 * reports something.
 */
export async function jailChanges(jail: Jail): Promise<{ paths: string[]; changed: boolean }> {
  if (!jail.repo) return { paths: [], changed: false };
  const base = await jailBase(jail);
  await git(jail.dir, ['add', '-A', '-N']);
  const paths = await changedPaths(jail.dir, base);
  const head = (await git(jail.dir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const dirty = (await git(jail.dir, ['status', '--porcelain'])).trim();
  return { paths, changed: head !== base || dirty !== '' };
}

/** What happened to one path between the jail's base commit and now. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  /** The path as it stands now; for a deletion, the path that is gone. */
  path: string;
  /** Where a rename came from, else null. */
  from: string | null;
  status: ChangeStatus;
}

/**
 * What the runner did to each file, relative to the jail root — tracked and
 * untracked, committed in the jail or not: the same intent-to-add + diff from
 * the jail's base as `diffJail` (so a caller can reuse the file list without
 * re-parsing a unified diff).
 *
 * `--name-status` rather than `--name-only`: a caller that only sees surviving
 * paths is blind to a deletion, which is the most total way a file's content
 * can change. `-M` so a rename arrives as one entry naming both sides instead
 * of an unrelated add and delete — the pre-image a content check needs lives
 * under the OLD name. `core.quotePath=false` so a non-ASCII path comes back
 * literal instead of C-escaped (`"cap\303\255tulo.md"`), which no `fs` call and
 * no `git show` would resolve.
 */
export async function changedFiles(jail: Jail): Promise<ChangedFile[]> {
  if (!jail.repo) return [];
  const base = await jailBase(jail);
  await git(jail.dir, ['add', '-A', '-N']);
  // -z: without it git still C-quotes a path holding a tab, a newline or a
  // double quote (core.quotePath only covers non-ASCII), and the tab-split
  // below then named a file that does not exist: its pre-image lookup failed,
  // read as "new file", and the fact-drift check skipped that file.
  const out = await git(jail.dir, ['-c', 'core.quotePath=false', 'diff', '--no-relative', '--name-status', '-M', '-z', base]);
  const fields = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++] ?? '';
    const letter = code[0] ?? '';
    if (!letter) continue;
    // R/C carry a similarity score and two paths: `R096\0old\0new`.
    if (letter === 'R' || letter === 'C') {
      const from = fields[i++] ?? '';
      const to = fields[i++] ?? '';
      if (!to) continue;
      // A copy leaves its source in place, so nothing was lost from it: only a
      // rename needs the old name carried along as a pre-image.
      files.push({ path: to, from: letter === 'R' ? from : null, status: letter === 'R' ? 'renamed' : 'added' });
      continue;
    }
    const p = fields[i++] ?? '';
    if (!p) continue;
    const status: ChangeStatus = letter === 'D' ? 'deleted' : letter === 'A' ? 'added' : 'modified';
    files.push({ path: p, from: null, status });
  }
  return files;
}

/**
 * The pre-image of one file as it stood at the jail's base commit (the branch
 * point — see `jailBase`), or null when the file did not exist there (a new
 * file has nothing to drift from).
 *
 * null is also what a failed `git show` returns, so the two are conflated. That
 * is only safe while callers pass a path git itself just reported: hence
 * `core.quotePath=false` in `changedFiles` above — an escaped path would fail
 * to resolve and read as "new file", quietly skipping the check.
 */
export async function showBaseFile(jail: Jail, relPath: string): Promise<string | null> {
  if (!jail.repo) return null;
  try {
    return await git(jail.dir, ['show', `${await jailBase(jail)}:${relPath}`]);
  } catch {
    return null;
  }
}

/** Drop the worktree and its branch. Used by `foreman prune`. */
export async function removeJail(jail: Jail): Promise<void> {
  if (jail.repo) {
    await git(jail.repo, ['worktree', 'remove', '--force', jail.dir]).catch(() => '');
    await git(jail.repo, ['branch', '-D', jail.branch ?? '']).catch(() => '');
  }
  await fs.rm(jail.dir, { recursive: true, force: true }).catch(() => {});
}

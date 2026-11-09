import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitTimeoutOpts, timedGit } from './gitTimeout.ts';

/**
 * The pinned git every daemon-side git call goes through. Protected (in
 * PROTECTED_PATHS), and it imports no protected module: the core guard and
 * the jail both take their git from here.
 */
const exec = promisify(execFile);

/**
 * What no repository may decide for a git command Foreman runs. A jail shares
 * its repo's config and git directory, and the worker can write both, so every
 * call in isolate.ts — in a jail or in the repo it was cut from — goes through
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
 * Subcommands (as Foreman calls them) that neither read a file of the
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
      return (await timedGit(exec('git', [...PINNED, ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024, ...gitTimeoutOpts() }), args).catch((err: { code?: unknown; stdout?: unknown }) => {
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
 * What every daemon-side git call outside the jail code (merge.ts, the core
 * guard's listing, the post-merge check, the sweep, the revert check) goes
 * through: PINNED, `pinnedEnv`, and the drivers switched off
 * (`driverlessEnv`). Rejects as `execFile` does (`code`, `stdout`, `stderr`).
 */
export async function pinnedGit(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return gitExec(cwd, args, extra);
}

/** `pinnedGit`, by the name the jail code in isolate.ts calls it. */
export async function gitExec(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const drivers = runsNoDriver(args) ? {} : await driverlessEnv(cwd, extra);
  return timedGit(exec('git', [...PINNED, ...args], { cwd, env: pinnedEnv({ ...extra, ...drivers }), maxBuffer: 64 * 1024 * 1024, ...gitTimeoutOpts() }), args);
}

/** The same call with stdout as the bytes git wrote (a patch taken with --text is not all UTF-8). */
export async function gitExecBytes(cwd: string, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const drivers = runsNoDriver(args) ? {} : await driverlessEnv(cwd);
  return timedGit(exec('git', [...PINNED, ...args], { cwd, env: pinnedEnv(drivers), maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', ...gitTimeoutOpts() }), args);
}

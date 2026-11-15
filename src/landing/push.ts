import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pinnedGit, pinnedGitPipe } from '../gitExec.ts';
import { gitSubcommand } from '../gitTimeout.ts';
import type { LandingMapping } from './config.ts';

/**
 * How commits cross between a task repo and the forge: only through a Foreman-owned bare mirror.
 *
 * The task repo's .git/config can be written from a jail, and the pinned git (src/gitExec.ts) does not pin
 * url.*.insteadOf, pushInsteadOf, remote.* or credential helpers, so a fetch, push, ls-remote or pull run there can be
 * sent to a repository the worker chose. So nothing that resolves a URL or names a remote runs in the task repo, in
 * either direction. Each mapped repo gets a mirror at <FOREMAN_HOME>/forge/<sha256(repo path)>.git, made with
 * `git init --bare` and configured by Foreman only; every fetch, push and ls-remote runs there. Objects cross between
 * the task repo and the mirror by `pack-objects --stdout --revs` piped into `index-pack --stdin --strict`, which
 * resolve no URL, then a `cat-file -e` check and an `update-ref` to the expected sha.
 *
 * The GitLab token, for an https pushUrl, goes to git as `http.<pushUrl origin>/.extraHeader` in GIT_CONFIG_COUNT/
 * KEY/VALUE: never in argv or a file, and keyed on the push URL, not the API's baseUrl. A local-path pushUrl (the
 * fake) is sent none. Git's stderr is redacted before it reaches an error.
 */

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Foreman's task ids (`t_<hex>`): one ref component, so the forge branch stays under refs/heads/foreman/. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FORGE_BRANCHES = 'refs/heads/foreman/';
/** In the mirror: the target branch as last fetched. */
const MIRROR_TARGET = 'refs/foreman/target';
/** In the task repo: the target branch's commit, as fetchTarget last copied it. */
export const FORGE_TARGET_REF = 'refs/foreman/forge/target';
/** In the task repo: the commit importCommit last copied (the merge commit an MR made). */
export const IMPORTED_REF = 'refs/foreman/forge/imported';

export class MirrorError extends Error {
  override readonly name = 'MirrorError';
}

/** Where a repo's mirror lives. */
export function mirrorPath(home: string, repo: string): string {
  return path.join(home, 'forge', `${createHash('sha256').update(repo).digest('hex')}.git`);
}

/** The forge branch a task's reviewed commit is pushed to; any id that would leave refs/heads/foreman/ is refused. */
export function forgeBranch(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new MirrorError(`task id ${JSON.stringify(taskId)} cannot name a branch under ${FORGE_BRANCHES}`);
  return `${FORGE_BRANCHES}${taskId}`;
}

function commitSha(sha: string): string {
  if (!SHA.test(sha)) throw new MirrorError(`${JSON.stringify(sha)} is not a commit sha`);
  return sha;
}

export class ForgeMirror {
  readonly dir: string;
  readonly #map: LandingMapping;
  readonly #secrets: string[];
  readonly #auth: NodeJS.ProcessEnv;

  constructor(home: string, map: LandingMapping, token: string | null) {
    this.dir = mirrorPath(home, map.repo);
    this.#map = map;
    if (token === null || path.isAbsolute(map.pushUrl)) {
      this.#secrets = token === null ? [] : [token];
      this.#auth = {};
    } else {
      const basic = Buffer.from(`oauth2:${token}`).toString('base64');
      this.#secrets = [token, basic];
      this.#auth = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${new URL(map.pushUrl).origin}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      };
    }
  }

  /** Fetches the target branch into the mirror and copies its commit into the task repo at FORGE_TARGET_REF. */
  async fetchTarget(): Promise<string> {
    await this.#ensure();
    const have = await this.#shared();
    const target = await this.#fetchTarget();
    await this.#copy(this.dir, this.#map.repo, target, FORGE_TARGET_REF, have);
    return target;
  }

  /**
   * Whether the forge's merge commit `merge` landed the reviewed commit `tip`, asked of the mirror only: after a fresh
   * fetch of the target branch, `merge` is on it and its second parent is `tip`.
   */
  async confirmMerge(merge: string, tip: string): Promise<boolean> {
    commitSha(merge);
    commitSha(tip);
    await this.#ensure();
    const target = await this.#fetchTarget();
    if ((await this.#commit(this.dir, merge)) === null) return false;
    try {
      await pinnedGit(this.dir, ['merge-base', '--is-ancestor', merge, target]);
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return false;
      throw this.#failed(['merge-base'], err);
    }
    return (await this.#commit(this.dir, `${merge}^2`)) === tip;
  }

  /** Fetches the target branch into the mirror at MIRROR_TARGET; its commit. */
  async #fetchTarget(): Promise<string> {
    const { pushUrl, targetBranch } = this.#map;
    await this.#git(this.dir, ['fetch', '--quiet', '--no-tags', pushUrl, `+refs/heads/${targetBranch}:${MIRROR_TARGET}`], this.#auth);
    return (await this.#git(this.dir, ['rev-parse', '--verify', `${MIRROR_TARGET}^{commit}`])).trim();
  }

  /**
   * Copies `tip` into the mirror and force-pushes it to refs/heads/foreman/<taskId> on the forge; the forge must then
   * report exactly `tip` there.
   */
  async pushReviewed(tip: string, taskId: string): Promise<void> {
    const branch = forgeBranch(taskId);
    commitSha(tip);
    await this.#ensure();
    await this.#copy(this.#map.repo, this.dir, tip, `refs/foreman/land/${taskId}`, await this.#shared());
    const { pushUrl } = this.#map;
    await this.#git(this.dir, ['push', '--quiet', '--force', pushUrl, `${tip}:${branch}`], this.#auth);
    const reported = (await this.#git(this.dir, ['ls-remote', pushUrl, branch], this.#auth))
      .split('\n').filter((line) => line.endsWith(`\t${branch}`)).map((line) => line.slice(0, line.indexOf('\t')));
    if (reported.length !== 1 || reported[0] !== tip) {
      throw new MirrorError(`after the push, the forge reports ${branch} at ${reported.join(', ') || 'nothing'}, not ${tip}`);
    }
  }

  /** Copies a commit the mirror holds (an MR's merge commit) into the task repo at IMPORTED_REF. */
  async importCommit(sha: string): Promise<void> {
    commitSha(sha);
    await this.#ensure();
    await this.#copy(this.dir, this.#map.repo, sha, IMPORTED_REF, await this.#shared());
  }

  async #ensure(): Promise<void> {
    const made = await fs.stat(path.join(this.dir, 'HEAD')).then(() => true, (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    });
    if (made) return;
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    await this.#git(path.dirname(this.dir), ['init', '--quiet', '--bare', this.dir]);
  }

  /** The mirror's target commit when the task repo has it too: what a pack between them can leave out. */
  async #shared(): Promise<string | null> {
    const target = await this.#commit(this.dir, MIRROR_TARGET);
    return target !== null && (await this.#commit(this.#map.repo, target)) !== null ? target : null;
  }

  /** `rev` as a commit sha in `cwd`, or null when it names none there. */
  async #commit(cwd: string, rev: string): Promise<string | null> {
    try {
      return (await pinnedGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).stdout.trim();
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return null;
      throw this.#failed(['rev-parse'], err);
    }
  }

  /** Copies `sha` and what it reaches (less what `have` reaches) from one repo into another, and points `ref` at it. */
  async #copy(from: string, to: string, sha: string, ref: string, have: string | null): Promise<void> {
    if ((await this.#commit(to, sha)) === null) {
      const args = ['pack-objects', '--stdout', '--revs', '--quiet'];
      try {
        await pinnedGitPipe({ cwd: from, args, input: have === null ? `${sha}\n` : `${sha}\n^${have}\n` }, { cwd: to, args: ['index-pack', '--stdin', '--strict'] });
      } catch (err) {
        throw this.#failed(args, err);
      }
    }
    await this.#git(to, ['cat-file', '-e', `${sha}^{commit}`]);
    await this.#git(to, ['update-ref', ref, sha]);
  }

  async #git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
    try {
      return (await pinnedGit(cwd, args, extra)).stdout;
    } catch (err) {
      throw this.#failed(args, err);
    }
  }

  #failed(args: string[], err: unknown): MirrorError {
    const e = err as { stderr?: unknown; message?: unknown };
    const why = typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr.trim() : String(e.message ?? err);
    const text = this.#secrets.reduce((s, secret) => s.split(secret).join('[redacted]'), why);
    return new MirrorError(`git ${gitSubcommand(args)} for the forge mirror of ${this.#map.repo} failed: ${text}`);
  }
}

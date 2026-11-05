// A tripwire on the real repo's .git, for as long as workers are not sandboxed. A worker runs as the user and can write
// the repo's config, hooks/, info/ or a replace/notes ref by path; git then runs that on the operator's next command.
// This module only DETECTS: it reads, hashes and compares, writes the baseline under <home>/artifacts/<runId>/ and
// nothing in the real .git, and restores nothing. Callers hold or refuse for a person with the reason it returns.
//
// Hashed: the bytes of config and config.worktree, every file under hooks/ and info/ except info/refs (git gc rewrites
// it from the refs; a symlink is hashed by its target, never followed), and the
// refs git lists logically with a pinned `git for-each-ref` (so packed-refs counts), except refs/heads, refs/remotes,
// refs/tags and refs/stash, which are the operator's work, and refs/bisect and refs/prefetch, which the operator's own
// `git bisect` and `git maintenance` create and which hold no code that runs. A ref anywhere else (refs/replace,
// refs/notes, ...) is flagged.
// Foreman's own git writes (worktree add/prune, ORIG_HEAD/MERGE_HEAD, foreman-main-* worktrees, branch -D of its own
// branches) land in worktrees/, refs/heads or top-level files, none of which is in the set.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';
/** The daemon's pinned git (isolate.ts `pinnedGit`), passed in: isolate.ts calls this module, so it cannot import it. */
export type GitRun = (cwd: string, args: string[]) => Promise<{ stdout: string }>;

export interface TripwireSnapshot {
  /** Path relative to the git dir -> sha256 of the bytes, or `link:<target>`. */
  files: Record<string, string>;
  /** Ref name -> object id, for every ref outside the operator's own namespaces. */
  refs: Record<string, string>;
}

/** What the file holds: a snapshot, or the reason none could be taken (held as such, never thrown). */
export interface TripwireBaseline {
  takenAt: number;
  gitDir: string;
  snapshot: TripwireSnapshot | null;
  error: string | null;
}

export type TripwireVerdict = { ok: true; note: string | null } | { ok: false; reason: string };

const OPERATOR_REFS = /^refs\/(heads|remotes|tags|stash|bisect|prefetch)(\/|$)/;

export function baselinePath(runId: string): string {
  return path.join(config.artifactRoot, runId, 'git-tripwire.json');
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function hashFile(file: string): Promise<string> {
  const st = await fs.lstat(file);
  if (st.isSymbolicLink()) return `link:${await fs.readlink(file)}`;
  return sha(await fs.readFile(file));
}

async function walk(root: string, rel: string, out: Record<string, string>): Promise<void> {
  const abs = path.join(root, rel);
  const st = await fs.lstat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!st) return; // an absent hooks/ or info/ is a state like any other: files appearing in it are the change
  if (!st.isDirectory()) { out[rel] = await hashFile(abs); return; }
  for (const name of (await fs.readdir(abs)).sort()) await walk(root, path.join(rel, name), out);
}

/** The git directory that holds config, hooks/ and info/ (the common one, for a linked worktree). */
async function gitDirOf(repo: string, pinnedGit: GitRun): Promise<string> {
  // config is shared by every worktree, so its path is the common git directory's.
  const out = (await pinnedGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'config'])).stdout.trim();
  if (!out) throw new Error('git reported no git directory');
  return path.dirname(out);
}

async function takeSnapshot(gitDir: string, repo: string, pinnedGit: GitRun): Promise<TripwireSnapshot> {
  const files: Record<string, string> = {};
  await walk(gitDir, 'config', files);
  if (files['config'] === undefined) files['config'] = 'absent';
  await walk(gitDir, 'config.worktree', files); // read as config too once extensions.worktreeConfig is set
  await walk(gitDir, 'hooks', files);
  await walk(gitDir, 'info', files);
  // info/refs is derived from the refs by `git gc` / update-server-info, and the refs are compared on their own.
  delete files[path.join('info', 'refs')];
  const refs: Record<string, string> = {};
  const listed = (await pinnedGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
  for (const line of listed.split('\n')) {
    if (!line) continue;
    const at = line.lastIndexOf(' ');
    const name = line.slice(0, at);
    if (!OPERATOR_REFS.test(name)) refs[name] = line.slice(at + 1);
  }
  return { files, refs };
}

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return `${e.code ? `${e.code}: ` : ''}${String(e.message ?? err).split('\n')[0]!.slice(0, 200)}`;
}

/** Read-only. Resolves to the snapshot or the error text; never rejects. */
export async function snapshotRepo(repo: string, git: GitRun): Promise<{ gitDir: string; snapshot: TripwireSnapshot | null; error: string | null }> {
  let gitDir = '';
  try {
    gitDir = await gitDirOf(repo, git);
    return { gitDir, snapshot: await takeSnapshot(gitDir, repo, git), error: null };
  } catch (err) {
    return { gitDir, snapshot: null, error: describe(err) };
  }
}

/**
 * At jail creation: snapshot the real repo and store it as <home>/artifacts/<runId>/git-tripwire.json (0600, temp file
 * then rename). Never throws: a snapshot that could not be taken is stored as its error, which holds the run later.
 */
export async function recordBaseline(repo: string, runId: string, git: GitRun): Promise<void> {
  const taken = await snapshotRepo(repo, git);
  const baseline: TripwireBaseline = { takenAt: Date.now(), ...taken };
  const file = baselinePath(runId);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, JSON.stringify(baseline), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    // No file means "no baseline" to the compare, which holds a repo run at collection.
  }
}

export function diffSnapshots(before: TripwireSnapshot, after: TripwireSnapshot): string[] {
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[k]; const b = after.files[k];
    if (a === b) continue;
    out.push(`.git/${k} ${a === undefined || a === 'absent' ? 'was added' : b === undefined || b === 'absent' ? 'was removed' : 'was changed'}`);
  }
  for (const k of [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].sort()) {
    const a = before.refs[k]; const b = after.refs[k];
    if (a === b) continue;
    out.push(`ref ${k} ${a === undefined ? 'was created' : b === undefined ? 'was deleted' : 'was moved'}`);
  }
  return out;
}

/**
 * Compare the real repo now with the run's baseline.
 * `requireBaseline`: at collection a repo run without one is held; at landing a run that has none (it began before
 * the tripwire, or a person deleted the file to accept a reported change) passes with no note.
 */
export async function checkRepo(repo: string, runId: string, opts: { requireBaseline: boolean; git: GitRun }): Promise<TripwireVerdict> {
  const file = baselinePath(runId);
  let baseline: TripwireBaseline;
  try {
    baseline = JSON.parse(await fs.readFile(file, 'utf8')) as TripwireBaseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return opts.requireBaseline
        ? { ok: false, reason: `git tripwire: no baseline of the repo's .git was stored for this run (${file}), so changes to it cannot be ruled out` }
        : { ok: true, note: null };
    }
    return { ok: false, reason: `git tripwire: the stored baseline could not be read (${describe(err)}); ${file}` };
  }
  if (!baseline.snapshot) {
    return { ok: false, reason: `git tripwire: the repo's .git could not be hashed when the run began (${baseline.error ?? 'unknown error'}), so changes to it cannot be ruled out` };
  }
  const now = await snapshotRepo(repo, opts.git);
  if (!now.snapshot) {
    return { ok: false, reason: `git tripwire: the repo's .git could not be hashed (${now.error}), so changes to it cannot be ruled out` };
  }
  const changes = diffSnapshots(baseline.snapshot, now.snapshot);
  if (!changes.length) return { ok: true, note: null };
  return {
    ok: false,
    reason: `git tripwire: the real repo's git directory changed since this run began: ${changes.join('; ')}. ` +
      `Nothing was restored. Look at it, then delete ${file} to accept the change.`,
  };
}

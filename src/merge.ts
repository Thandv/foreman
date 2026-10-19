import fs from 'node:fs';
import { jailChanges, jailTree, pinnedGit } from './isolate.ts';
import { changedPaths, coreRefusal, isProtectedPath, isSelfTaskFresh } from './security/coreGuard.ts';
import type { Run, Task } from './types.ts';

export interface MergeResult {
  merged: boolean;
  reason: string;
  branch: string | null;
  /** Something a person should read in the timeline about a landing that was made (the reviewed-tree check). */
  note?: string;
}

/** Who is approving: only a person may land a run with no reviewed tree, or name a tree with `acceptTree`. */
export interface Approver {
  source?: 'human' | 'owner-gate';
  /** `foreman approve --as-is <sha>`: the full sha of the tree to land in place of the reviewed one. A person's only. */
  acceptTree?: string | null;
}

/** How every reason the reviewed-tree check gives begins; an approval refused with one stays parked (gate.ts). */
export const NOT_REVIEWED = /^(work changed after review|no reviewed tree|--as-is)/;

const TREE_SHA = /^[0-9a-f]{40,64}$/;

/**
 * Every git call here, in the operator's repo or a run's worktree, through the
 * pins and driver switch-off isolate.ts uses (`pinnedGit`): the jail can write
 * the config and info/attributes both share, and a filter, merge driver,
 * fsmonitor, hook or gpg.program named there ran in the daemon on the landing's
 * `status`, `add`, `commit` and `merge`. One rule for every repo, so the tree
 * this commits is the tree `jailTree` built for the review.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  return (await pinnedGit(cwd, args)).stdout;
}

/** Hooks off, whatever the repo's config says: see `mergeApproved`. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** A few of the paths that differ between two trees, as git lists them (never from patch text). */
async function treeChanges(repo: string, reviewed: string, landing: string): Promise<string> {
  const words: Record<string, string> = { A: 'added', D: 'deleted', M: 'changed', T: 'changed' };
  const fields = (await git(repo, [...NO_HOOKS, 'diff-tree', '-r', '--no-renames', '--name-status', '-z', reviewed, landing]).catch(() => '')).split('\0');
  const items: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    items.push(`${fields[i + 1]!.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '?')} (${words[fields[i]![0] ?? ''] ?? 'changed'} since review)`);
  }
  if (!items.length) return 'the paths could not be listed';
  return items.slice(0, 5).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '');
}

/**
 * The reviewed-tree check: the reason `landing` (the tree about to be merged)
 * may not land, or the note to leave when it may. The run's reviewers and the
 * gate read a diff collected at one moment (scheduler.ts); the worktree goes on
 * existing after it, and the landing commits whatever it holds by then — a
 * file the test run wrote, one a process the worker left behind wrote. So the
 * tree recorded with that diff is the only one that lands. Two trees are the
 * same when their shas are equal, and in no other case. Files git ignores are
 * in neither.
 *
 * A person can land another tree by naming it in full (`acceptTree`), and a
 * run parked before trees were recorded lands on a person's approval, with a
 * note either way. The owner gate can do neither.
 */
async function reviewedTreeCheck(
  repo: string,
  task: Task,
  run: Run,
  landing: string,
  who: Approver,
): Promise<{ refusal: string } | { note: string | null }> {
  const reviewed = run.reviewedTree ?? null;
  const person = (who.source ?? 'human') === 'human';
  const named = person ? (who.acceptTree ?? null) : null;
  if (named !== null) {
    if (named !== landing) return { refusal: `--as-is names tree ${named.slice(0, 80)}, but the tree that would land is ${landing}; nothing was landed` };
    return { note: `landed as-is on a person's word: tree ${landing} (reviewed tree: ${reviewed ?? 'none recorded'})` };
  }
  if (reviewed === null) {
    if (!person) return { refusal: 'no reviewed tree was recorded for this run (parked before this check existed), so the owner gate does not land it: a person approves it' };
    return { note: "no reviewed tree recorded for this run (parked before this check existed); landed on a person's approval" };
  }
  if (reviewed === landing) return { note: null };
  const paths = TREE_SHA.test(reviewed) ? await treeChanges(repo, reviewed, landing) : 'the paths could not be listed';
  return {
    refusal: `work changed after review: ${paths} — the worktree is not the tree that was reviewed (${reviewed.slice(0, 12)}). ` +
      'If the test run writes the file, add it to .gitignore and retry; otherwise reject and retry so it is reviewed again. ' +
      `A person who made the change lands it with: foreman approve ${task.id} --as-is ${landing}`,
  };
}

/** The tree a landing of this run would commit and merge right now; throws when git cannot say. */
async function landingTree(repo: string, run: Run & { branch: string }): Promise<string> {
  const worktree = run.worktreePath;
  if (worktree && fs.existsSync(worktree) && (await git(worktree, ['status', '--porcelain'])).trim()) return jailTree(worktree);
  return (await git(repo, ['rev-parse', '--verify', `${run.branch}^{tree}`])).trim();
}

/**
 * The reviewed-tree check, asked before anything is decided: gate.ts calls it
 * before it marks a task approved (and before the owner model is asked), so a
 * run whose worktree is not what was reviewed is never recorded as approved.
 * Null when there is nothing to refuse or nothing to compare — a task that
 * does not merge on approval, a branch that is gone — which `mergeApproved`
 * then answers in its own words; it asks this again of the commit it makes.
 * Null too for a change to Foreman whose worktree now holds its core: that is
 * the core guard's refusal, and `mergeApproved` gives it as it always has.
 */
export async function landingRefusal(task: Task, run: Run | null, who: Approver & { selfRoot?: string } = {}): Promise<string | null> {
  if (!task.repo || !run?.branch || !task.mergeOnApprove) return null;
  const branch = run.branch;
  const repo = (await git(task.repo, ['rev-parse', '--show-toplevel']).catch(() => '')).trim() || task.repo;
  const exists = await git(repo, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
  if (!exists) return null;
  const landing = await landingTree(repo, { ...run, branch }).catch(() => null);
  if (landing === null) return null;
  const check = await reviewedTreeCheck(repo, task, run, landing, who);
  if (!('refusal' in check)) return null;
  if (!task.allowCore && (await isSelfTaskFresh(task, who.selfRoot)) && (await unmergedRefusal(repo, { ...run, branch }))) return null;
  return check.refusal;
}

/**
 * Every path a merge of `tip` into `head` would change in `head`'s tree. Asked
 * of the merge itself (`git merge-tree` builds the merged tree without touching
 * the checkout) and compared with `head`, not read off the branch's own
 * history: an edit to a file that HEAD has since renamed into a protected path
 * lands there, and a branch built on the wrong parent undoes a protected change
 * without any commit of its own naming the file. A branch with more than one
 * merge base is not listed at all: which base git picks is the branch author's
 * choice. Throws when anything here fails; the caller refuses.
 */
async function landingPaths(repo: string, head: string, tip: string): Promise<string[]> {
  const bases = (await git(repo, ['merge-base', '--all', head, tip])).split('\n').filter(Boolean);
  if (bases.length !== 1) throw new Error(`it has ${bases.length} merge bases with HEAD, not one`);
  // Exit 1 is a conflict: the tree is still written, with the conflicted paths changed in it.
  const out = await pinnedGit(repo, ['merge-tree', '--write-tree', '--no-messages', head, tip])
    .then((r) => r.stdout, (err: { code?: unknown; stdout?: unknown }) => {
      if (err.code === 1 && typeof err.stdout === 'string') return err.stdout;
      throw err;
    });
  const tree = (out.split('\n')[0] ?? '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree named no tree');
  return changedPaths(repo, head, tree);
}

/** Paths `git status` reports in the checkout, one per entry (a rename as its two paths). */
async function dirtyPaths(repo: string): Promise<string[]> {
  const out = await git(repo, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--no-renames', '-z']);
  return out.split('\0').filter(Boolean).map((entry) => entry.slice(3));
}

/**
 * Puts back any protected path that differs in the checkout from `head`, and
 * says what it found ('' when nothing did). A merge driver or a filter named
 * in the repo's config — which the jail can write — is run by git itself,
 * when predicting the merge as well as when making it, and can write anywhere
 * in the checkout Foreman runs from. The checkout was clean when the landing
 * began, so a reset loses nothing of the operator's.
 */
async function putCoreBack(repo: string, head: string): Promise<string> {
  const left = (await dirtyPaths(repo).catch(() => ['?'])).filter((p) => p === '?' || isProtectedPath(p));
  if (!left.length) return '';
  const reset = await git(repo, [...NO_HOOKS, 'reset', '-q', '--hard', head]).then(() => true).catch(() => false);
  const still = (await dirtyPaths(repo).catch(() => ['?'])).filter((p) => p === '?' || isProtectedPath(p));
  return ` — Foreman's core was changed in the checkout while landing (${left.join(', ')})` +
    (reset && !still.length ? ' and has been put back' : `; STILL CHANGED, put it back by hand: ${still.join(', ') || left.join(', ')}`);
}

/**
 * The landing check again, on the merge that was actually made: the merge
 * commit must join exactly the two commits that were checked, change no
 * protected path, and leave no protected path in the checkout differing from
 * it (`putCoreBack`). Anything else is undone and the reason returned. Undone
 * means the checkout is put back on the merge's own first parent when the
 * merge is of `tip` — HEAD moved between the check and the merge, and the
 * commit that moved it is somebody else's and stays — and on `head` otherwise.
 */
async function refuseLanded(repo: string, head: string, tip: string): Promise<string | null> {
  let refusal: string | null;
  let back = head;
  try {
    const joined = (await git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
    if (joined.length === 3 && joined[2] === tip) back = joined[1]!;
    if (joined.length !== 3 || joined[1] !== head || joined[2] !== tip) {
      throw new Error('the merge commit does not join the two commits that were checked');
    }
    refusal = coreRefusal(await changedPaths(repo, head, 'HEAD'), true);
    if (!refusal) {
      const left = (await dirtyPaths(repo)).filter(isProtectedPath);
      if (left.length) refusal = `core change refused: the merge left Foreman's core changed in the checkout (${left.join(', ')})`;
    }
  } catch (err) {
    refusal = `core change refused: the merge could not be checked (${(err as Error).message.slice(0, 200)})`;
  }
  if (!refusal) return null;
  const undone = await git(repo, [...NO_HOOKS, 'reset', '-q', '--hard', back]).then(() => true).catch(() => false);
  return `${refusal} — ${undone ? 'the merge was undone' : `THE MERGE COULD NOT BE UNDONE: reset the checkout to ${back} by hand`}` +
    (await putCoreBack(repo, back));
}

/**
 * The landing check for a branch Foreman does not merge itself (every
 * `foreman improve` task): the operator merges it by hand after approving, so
 * the approval is the last point at which Foreman can say what is on it. Lists
 * what the run's worktree holds now against its base — committed there since
 * the run, uncommitted and untracked (isolate.ts jailChanges, the run check's
 * own listing) — and what merging the branch would change in HEAD. Returns the
 * reason to refuse, or null.
 */
async function unmergedRefusal(repo: string, run: Run & { branch: string }): Promise<string | null> {
  try {
    const paths: string[] = [];
    let changed = false;
    if (run.worktreePath && fs.existsSync(run.worktreePath)) {
      const jail = await jailChanges({ dir: run.worktreePath, repo, branch: run.branch, ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}) });
      paths.push(...jail.paths);
      changed = jail.changed;
    }
    const tip = (await git(repo, ['rev-parse', '--verify', '--quiet', `${run.branch}^{commit}`]).catch(() => '')).trim();
    if (tip) {
      const head = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if ((await git(repo, ['rev-list', '--count', `${head}..${tip}`])).trim() !== '0') {
        paths.push(...(await landingPaths(repo, head, tip)));
        changed = true;
      }
    }
    return coreRefusal([...new Set(paths)], changed);
  } catch (err) {
    return `core change refused: the paths ${run.branch} holds could not be listed (${(err as Error).message.slice(0, 200)})`;
  }
}

/**
 * Land an approved run's branch. Deliberately conservative: it refuses on a
 * dirty checkout, never force-merges, and aborts a conflicting merge so the
 * operator's repo is left exactly as it was found.
 */
export async function mergeApproved(
  task: Task,
  run: Run | null,
  opts: {
    /** Stands in for Foreman's own checkout in tests. */
    selfRoot?: string;
    /** Called after the landing check has passed, just before the merge. A test moves the branch here. */
    beforeMerge?: () => Promise<void> | void;
    /** Called after the reviewed-tree check has passed on the worktree, just before it is committed. A test writes a file here. */
    beforeCommit?: () => Promise<void> | void;
  } & Approver = {},
): Promise<MergeResult> {
  // The gate is the whole point: only an approved task may land.
  if (task.status !== 'done') {
    return { merged: false, reason: `task is ${task.status}, not approved`, branch: run?.branch ?? null };
  }
  if (!task.repo || !run?.branch) return { merged: false, reason: 'nothing to merge', branch: run?.branch ?? null };

  // Everything runs at the checkout's top level. task.repo may name a
  // sub-directory of it: git reads path-limiting config (diff.relative)
  // against the directory it runs in, and will not merge away the directory
  // it was started in.
  const repo = (await git(task.repo, ['rev-parse', '--show-toplevel']).catch(() => '')).trim() || task.repo;
  const branch = run.branch;
  // Asked of git now, never from the identity cache the run's check may use
  // (security/coreGuard.ts): this is the check that decides what lands.
  const self = await isSelfTaskFresh(task, opts.selfRoot);
  if (!task.mergeOnApprove) {
    // Nothing lands here, but a change to Foreman is still not approved with
    // its core in the branch a person is about to merge by hand.
    const refusal = self && !task.allowCore
      ? await unmergedRefusal(repo, { ...run, branch })
      : null;
    return { merged: false, reason: refusal ?? 'merge-on-approve disabled for this task', branch };
  }
  // A change to Foreman itself lands with every hook off. The jail shares the
  // repo's config, so a worker can point core.hooksPath at a script of its
  // own, and a hook that runs during this commit or this merge writes to the
  // checkout Foreman runs from after every check has passed. (Every landing
  // now runs with hooks off — `git` above pins core.hooksPath — since a worker
  // can write `.git/hooks` of any repo; these stay as the explicit statement.)
  const hooksOff = self ? NO_HOOKS : [];
  const noVerify = self ? ['--no-verify'] : [];
  // A change to Foreman itself, by a task not allowed to touch its core.
  const guarded = self && !task.allowCore;

  const exists = await git(repo, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
  if (!exists) return { merged: false, reason: `branch ${branch} no longer exists`, branch };

  const dirty = (await git(repo, ['status', '--porcelain'])).trim();
  if (dirty) return { merged: false, reason: 'repo has uncommitted changes; merge skipped', branch };

  // The worktree left the change unstaged, so commit it on its own branch first.
  const worktree = run.worktreePath;
  if (worktree) {
    const pending = await git(worktree, ['status', '--porcelain']).catch(() => '');
    if (pending.trim()) {
      // Asked before the commit, so work that was not reviewed is refused
      // without being committed to the branch; and again below, of the commit.
      let early: Awaited<ReturnType<typeof reviewedTreeCheck>>;
      try {
        early = await reviewedTreeCheck(repo, task, run, await jailTree(worktree), opts);
      } catch (err) {
        return { merged: false, reason: `work changed after review cannot be ruled out: the worktree's tree could not be read (${(err as Error).message.slice(0, 200)})`, branch };
      }
      // Unless it is a change to Foreman that now holds its core: the core
      // guard refuses that below, on the commit, in its own words.
      if ('refusal' in early && !(guarded && (await unmergedRefusal(repo, { ...run, branch })))) {
        return { merged: false, reason: early.refusal, branch };
      }
      await opts.beforeCommit?.();
      await git(worktree, ['add', '-A']);
      await git(worktree, [...hooksOff, 'commit', ...noVerify, '-m', `foreman: ${task.title}\n\ntask ${task.id}`]);
    }
  }

  // The branch is read ONCE, here, and everything below — the count, the
  // check, the merge — is about this commit. Merging by name would land
  // whatever the name points at by then: a process a run left behind can add
  // a commit to the branch between the check and the merge.
  const tip = (await git(repo, ['rev-parse', '--verify', `${branch}^{commit}`])).trim();
  const head = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();

  const ahead = (await git(repo, ['rev-list', '--count', `${head}..${tip}`]).catch(() => '0')).trim();
  if (ahead === '0') return { merged: false, reason: 'branch has no commits ahead of HEAD', branch };

  // The hard block on a change to Foreman's own core. Here, on the commit that
  // is about to land, because nothing earlier sees all of it: the commit above
  // takes whatever is in the worktree by now. The paths come from git's own
  // listing of what the merge would change in HEAD (`landingPaths`), never
  // from patch text. Anything that cannot be listed is refused.
  if (guarded) {
    let refusal: string | null;
    try {
      refusal = coreRefusal(await landingPaths(repo, head, tip), true);
    } catch (err) {
      refusal = `core change refused: the paths ${branch} would land could not be listed (${(err as Error).message.slice(0, 200)})`;
    }
    if (refusal) return { merged: false, reason: refusal + (await putCoreBack(repo, head)), branch };
  }

  // The reviewed-tree check, on the commit that is about to land: its tree is
  // the reviewed one, or a person has said otherwise. Every repo, Foreman's
  // own included, and after the core guard, which it adds to and never
  // replaces: a change that fails both is refused as a core change.
  let reviewed: Awaited<ReturnType<typeof reviewedTreeCheck>>;
  try {
    reviewed = await reviewedTreeCheck(repo, task, run, (await git(repo, ['rev-parse', '--verify', `${tip}^{tree}`])).trim(), opts);
  } catch (err) {
    return { merged: false, reason: `work changed after review cannot be ruled out: the tree of ${branch} could not be read (${(err as Error).message.slice(0, 200)})`, branch };
  }
  if ('refusal' in reviewed) return { merged: false, reason: reviewed.refusal, branch };

  await opts.beforeMerge?.();
  try {
    await git(repo, [...hooksOff, 'merge', '--no-ff', ...noVerify, '-m', `foreman: ${task.title} (${task.id})`, tip]);
  } catch (err) {
    await git(repo, ['merge', '--abort']).catch(() => '');
    const core = guarded ? await putCoreBack(repo, head) : '';
    return { merged: false, reason: `merge conflict, aborted — resolve ${branch} by hand: ${(err as Error).message.slice(0, 300)}${core}`, branch };
  }
  // Asked a second time of the merge as made: the check above is git's
  // prediction, and config the jail could write (a merge driver, a filter)
  // takes part in the real one.
  if (guarded) {
    const undone = await refuseLanded(repo, head, tip);
    if (undone) return { merged: false, reason: undone, branch };
  }
  return { merged: true, reason: `merged ${ahead} commit(s) from ${branch}`, branch, ...(reviewed.note ? { note: reviewed.note } : {}) };
}

export interface PruneResult {
  removed: string[];
  kept: string[];
}

/**
 * Reclaim the worktrees and branches of tasks that are finished with. Branches
 * that were merged, rejected or abandoned are dropped; anything still awaiting
 * a decision is left exactly where the operator can find it.
 *
 * An approved task is not "finished with" until its work has landed. A task
 * with merge-on-approve off (every `foreman improve` task, `--no-merge`) is
 * approved and then merged BY HAND, and its change is still uncommitted in the
 * worktree; a landing that was skipped (a dirty checkout, a conflict) leaves
 * the same. Removing that worktree with --force and that branch with -D threw
 * the approved work away. So the branch of a done task's latest run is dropped
 * only once HEAD contains it and its worktree holds nothing uncommitted; an
 * earlier run of the same task (a round the repair replaced) is not the work
 * that was approved, and goes as before. `latest` defaults to true: a caller
 * that cannot say is treated as naming the approved run.
 */
export async function pruneJails(
  rows: Array<{ status: Task['status']; repo: string | null; branch: string | null; worktreePath: string | null; latest?: boolean }>,
): Promise<PruneResult> {
  const removed: string[] = [];
  const kept: string[] = [];
  // Decided per branch and per worktree, not per row: a resumed round records
  // the branch and worktree of the round before it on its own run row
  // (scheduler.ts reuseJail), so one row saying "keep" must win over an
  // earlier row of the same task that names the same branch.
  const keyOf = (repo: string, name: string): string => `${repo}\0${name}`;
  const keepBranch = new Set<string>();
  const keepTree = new Set<string>();
  const drop: Array<{ repo: string; branch: string; worktreePath: string | null }> = [];
  for (const row of rows) {
    if (!row.repo || !row.branch) continue;
    const finished = row.status === 'done' || row.status === 'rejected' || row.status === 'failed' || row.status === 'canceled';
    if (!finished || (row.status === 'done' && row.latest !== false && !(await landed(row.repo, row.branch, row.worktreePath)))) {
      keepBranch.add(keyOf(row.repo, row.branch));
      if (row.worktreePath) keepTree.add(row.worktreePath);
      continue;
    }
    drop.push({ repo: row.repo, branch: row.branch, worktreePath: row.worktreePath });
  }
  for (const key of keepBranch) kept.push(key.slice(key.indexOf('\0') + 1));
  const done = new Set<string>();
  for (const row of drop) {
    const key = keyOf(row.repo, row.branch);
    if (keepBranch.has(key) || done.has(key)) continue;
    done.add(key);
    if (row.worktreePath && !keepTree.has(row.worktreePath)) {
      await git(row.repo, ['worktree', 'remove', '--force', row.worktreePath]).catch(() => '');
    }
    // -D, not -d: a rejected branch is deliberately unmerged.
    const dropped = await git(row.repo, ['branch', '-D', row.branch]).then(() => true).catch(() => false);
    if (dropped) removed.push(row.branch);
  }
  return { removed, kept };
}

/**
 * Whether an approved run's work is safely in the repo: its branch is part of
 * HEAD's history and its worktree (when it still exists) has nothing left
 * uncommitted. Anything git cannot answer reads as not landed, so the branch
 * is kept: a branch kept too long costs a `git branch -D`, one dropped too
 * early costs the work.
 */
async function landed(repo: string, branch: string, worktreePath: string | null): Promise<boolean> {
  const merged = await git(repo, ['merge-base', '--is-ancestor', `${branch}^{commit}`, 'HEAD']).then(() => true).catch(() => false);
  if (!merged) return false;
  if (!worktreePath || !fs.existsSync(worktreePath)) return true;
  const pending = await git(worktreePath, ['status', '--porcelain']).catch(() => null);
  return pending !== null && pending.trim() === '';
}

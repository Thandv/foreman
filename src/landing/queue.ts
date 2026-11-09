import path from 'node:path';

/**
 * One landing at a time per repository. An approval merges into the
 * operator's own checkout and then tests the merged HEAD; two approvals in
 * the same repo doing that at once race on the checkout's index and HEAD,
 * and a red main could not be told apart between them. The landing hold in
 * src/queue.ts is per task: it holds that task's dependents and nothing else.
 *
 * Each repo has a promise chain: a section starts once every section queued
 * before it in that repo has settled, thrown or not. Different repos never
 * wait on each other. In memory only: every approval lands through the one
 * daemon process that owns the ledger.
 *
 * Keyed by the resolved path of the task's repo. Two tickets that name
 * different directories of one checkout are not recognised as the same repo.
 */
interface Chain {
  tail: Promise<void>;
  /** Sections running or waiting in this repo. */
  pending: number;
}

const chains = new Map<string, Chain>();

/** Run `fn` once no earlier section in `repo` is still open; the next one starts when it settles. */
export async function withRepoMergeSection<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo);
  const chain = chains.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  chains.set(key, chain);
  const before = chain.tail;
  let release!: () => void;
  chain.tail = new Promise<void>((r) => { release = r; });
  chain.pending += 1;
  try {
    await before;
    return await fn();
  } finally {
    release();
    chain.pending -= 1;
    if (chain.pending === 0) chains.delete(key);
  }
}

/** How many sections are running or waiting in `repo`. For tests: they wait on it to see an approval queued. */
export function mergeSectionsPending(repo: string): number {
  return chains.get(path.resolve(repo))?.pending ?? 0;
}

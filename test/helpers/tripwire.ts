import fs from 'node:fs';
import { baselinePath } from '../../src/gitTripwire.ts';
import type { applyApproval } from '../../src/gate.ts';

/**
 * For suites that plant git config in the real repo on purpose, to prove the landing is safe even then: the person's
 * step of accepting what the git tripwire reported (deleting the run's baseline file, docs/security.md), done before
 * each approval. The tripwire itself is tested in test/git-tripwire.test.ts.
 */
export function acceptingGitChanges(approve: typeof applyApproval): typeof applyApproval {
  return (store, taskId, opts) => {
    const run = store.latestRun(taskId);
    if (run) fs.rmSync(baselinePath(run.id), { force: true });
    return approve(store, taskId, opts);
  };
}

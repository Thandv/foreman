import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from '../env.ts';
import { startFakeGitlab, type FakeGitlab, type FakeGitlabOptions } from '../../scripts/forge/fakeGitlab.ts';
import type { Store } from '../../src/queue.ts';
import { ApprovalTracker, applyApproval } from '../../src/gate.ts';
import type { LandingMapping } from '../../src/landing/config.ts';
import { useLanding } from '../../src/landing/mr.ts';
import type { Task } from '../../src/types.ts';

// A repo that lands by merge request on the local fake GitLab (scripts/forge/fakeGitlab.ts): its operator checkout, the
// forge's bare repo, and the landing.json mapping between them.

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...a], { cwd, encoding: 'utf8' }).trim();

export interface Fixture {
  home: string;
  /** The forge's bare repo: the fake GitLab's project and the pushUrl. */
  forge: string;
  /** The operator's checkout: main as the forge has it. */
  repo: string;
  fake: FakeGitlab;
  map: LandingMapping;
}

/** Pipelines stay running unless `fake` says otherwise; merge-request landing is switched off again when the test ends. */
export async function fixture(t: TestContext, fake: Partial<FakeGitlabOptions> = {}): Promise<Fixture> {
  const home = scratchDir('landing-mr-home-');
  const forge = path.join(scratchDir('landing-mr-forge-'), 'app.git');
  git(path.dirname(forge), 'init', '-q', '--bare', '-b', 'main', forge);
  const repo = fs.realpathSync(scratchDir('landing-mr-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', forge, 'main:refs/heads/main');
  const server = await startFakeGitlab({ projects: { 'group/app': forge }, pipeline: 'manual', ...fake });
  t.after(() => server.close());
  t.after(() => useLanding(null, home));
  const map: LandingMapping = {
    repo, mode: 'mr', forge: 'gitlab', baseUrl: server.url, project: 'group/app', pushUrl: forge, targetBranch: 'main', requirePipeline: true,
  };
  return { home, forge, repo, fake: server, map };
}

/** A ticket parked at the gate whose run left `branch` carrying a file of its own, reviewed at that commit's tree. */
export function parked(store: Store, repo: string, branch: string, extra: { parentId?: string; createdBy?: string } = {}): Task {
  git(repo, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(repo, `${branch}.txt`), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', branch);
  git(repo, 'checkout', '-q', 'main');
  const task = store.addTask({ title: branch, prompt: 'p', kind: 'code', runner: 'echo', repo, ...extra });
  const run = store.startRun(task.id);
  store.setRunMeta(run.id, { branch, worktreePath: null, reviewedTree: git(repo, 'rev-parse', `${branch}^{tree}`) });
  store.addVerdict({ runId: run.id, taskId: task.id, verdict: 'pass', disagreement: false, council: [] });
  store.endRun(run.id, 'succeeded', { exitCode: 0, summary: 'ok' });
  store.setStatus(task.id, 'awaiting-approval');
  return task;
}

export const approve = (store: Store, taskId: string, selfRoot?: string) =>
  applyApproval(store, taskId, { principal: 'operator', tracker: new ApprovalTracker(), ...(selfRoot ? { selfRoot } : {}) });

export const landingRows = (store: Store): number =>
  Number((store.db.prepare('SELECT count(*) AS n FROM landings').get() as { n: number }).n);

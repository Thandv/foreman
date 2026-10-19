import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionDeps } from './deps.ts';
import { checkoutWorktree, pinnedGit } from './isolate.ts';
import { withVerifySlot } from './verify/slots.ts';
import { detectTestCmd, runTests, type SandboxRunOpts } from './verify/tests.ts';

/**
 * Two approved tickets can each pass their own tests and still break main
 * together: a clean textual merge is not a working program. On the Kiln
 * Desktop epic, project search and workspaces each bumped the same
 * hard-coded route count from 20 to 22; both merged cleanly and main was red
 * at 24 — and the next tickets would have been cut from it. So after a merge
 * lands, the repo's own test command runs on the merged HEAD, in a scratch
 * worktree (never the operator's checkout). A red result marks the repo red:
 * nothing new is dispatched for it, and no dependent is released, until HEAD
 * moves and a re-check passes.
 */

export function postMergeCheckEnabled(): boolean {
  return (process.env['FOREMAN_POSTMERGE_CHECK'] ?? '').trim().toLowerCase() !== 'off';
}

export interface MainCheck {
  ok: boolean;
  head: string;
  cmd: string | null;
  /** The tail of the failing output, for the timeline. */
  tail: string;
  /**
   * The tail of the first run when it failed and the check ran again on the
   * same HEAD (`tail` is then the second run's); '' when the first run passed.
   */
  firstTail: string;
}

/** The test runner checkMain drives; injectable so tests can use fake commands. */
export type MainTestRunner = (
  dir: string,
  cmd: string,
  signal: AbortSignal,
  sandbox?: SandboxRunOpts,
) => Promise<{ passed: boolean; output: string }>;

const runSandboxed: MainTestRunner = (dir, cmd, signal, sandbox) => runTests(dir, cmd, signal, undefined, undefined, sandbox);

const tailOf = (output: string): string => output.split('\n').slice(-25).join('\n');

async function git(cwd: string, args: string[]): Promise<string> {
  // Pinned, drivers off (isolate.ts pinnedGit): the repo's config is the one every jail can write.
  return (await pinnedGit(cwd, args)).stdout.trim();
}

export async function repoHead(repo: string): Promise<string> {
  return git(repo, ['rev-parse', 'HEAD']).catch(() => '');
}

/** Run the repo's tests on its current HEAD in a throwaway detached worktree. */
export async function checkMain(
  repo: string,
  testCmd: string | null,
  signal?: AbortSignal,
  run: MainTestRunner = runSandboxed,
): Promise<MainCheck> {
  const head = await repoHead(repo);
  // The pid in the name tells a startup prune whose check this is (gate.ts pruneMainWorktrees).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `foreman-main-${process.pid}-`));
  try {
    // Checked out with no filter the repo's config names (a smudge there ran in the daemon), by isolate.ts.
    await checkoutWorktree(repo, dir, ['--detach'], head);
    await provisionDeps(dir, repo, { allowInstall: true, signal });
    const cmd = testCmd ?? detectTestCmd(dir);
    if (!cmd) return { ok: true, head, cmd: null, tail: '', firstTail: '' };
    const sig = signal ?? new AbortController().signal;
    // Under FOREMAN_SANDBOX the command may write only the scratch checkout; the real repo's git directory, which
    // the checkout reads through, is named here by Foreman (never taken from the checkout) and is read-only.
    const sandbox: SandboxRunOpts = { realGit: path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'])) };
    // Each run, the flake re-run included, waits for a verify slot like any other.
    const first = await withVerifySlot(sig, () => run(dir, cmd, sig, sandbox));
    if (first.passed) return { ok: true, head, cmd, tail: tailOf(first.output), firstTail: '' };
    // Most reds on a busy machine were flakes (pty timing, a launch probe under
    // load) that pass on an immediate re-run. Run once more in the same
    // worktree, so on the same HEAD; only a second failure marks the repo red.
    const second = await withVerifySlot(sig, () => run(dir, cmd, sig, sandbox));
    return { ok: second.passed, head, cmd, tail: tailOf(second.output), firstTail: tailOf(first.output) };
  } finally {
    await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

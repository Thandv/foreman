import http from 'node:http';
import { config, daemonUrl } from './config.ts';
import { sweepJails } from './archive.ts';
import { backupIfDue, backupSettings, sameDiskWarning } from './backup.ts';
import { APPROVAL_DRAIN_CAP_MS, approvals, pruneStaleMainWorktrees } from './gate.ts';
import { modeSummary } from './localOnly.ts';
import { sandboxMode, sandboxSummary, selfTest } from './security/sandbox.ts';
import { probeCloud } from './models.ts';
import { acquireDaemonLock } from './lock.ts';
import { Store } from './queue.ts';
import { Scheduler } from './scheduler.ts';
import { listen } from './server.ts';
import { installProcessRecorder } from './runners/freezeInstall.ts';
import { freezeSweepOptionsFromEnv, runFreezeSweep } from './runners/freezeSweep.ts';
import { containProcessErrors } from './daemonGuard.ts';
import { Tracer } from './trace.ts';
import { prewarmRoster } from './warm.ts';

/** The daemon lifecycle behind `foreman serve`. Resolves to the exit code, or -1 when the daemon is to stay alive. */
export async function serve(): Promise<number> {
  // FOREMAN_SANDBOX (security/sandbox.ts), before anything is opened: an unknown value, a sandbox-exec that is
  // missing or does not confine, is a refusal to start — never a daemon that quietly runs test commands unconfined.
  const sandboxProblem = await selfTest();
  if (sandboxProblem) {
    process.stderr.write(`foreman: ${sandboxProblem}\n`);
    return 1;
  }
  const releaseLock = acquireDaemonLock();
  const store = new Store(config.dbPath);
  const scheduler = new Scheduler(store);
  const tracer = new Tracer(store);
  tracer.start();
  // Before the first tick: under FOREMAN_LOCAL_ONLY=auto (the default) the
  // cloud's reachability decides how every ticket routes, so it must be
  // known before anything is dispatched — and re-checked, so a sign-in (or
  // a lapse) takes effect without a restart.
  await probeCloud().catch(() => null);
  process.stdout.write(`home ${config.home}\n`);
  process.stdout.write(`mode ${modeSummary()}\n`);
  process.stdout.write(`${await sandboxSummary()}\n`);
  if (sandboxMode() === 'all') {
    process.stdout.write('FOREMAN_SANDBOX=all: the claude-code worker is not sandboxed in this build; `all` behaves as `tests`\n');
  }
  let lastMode = modeSummary();
  const cloudTimer = setInterval(() => {
    void probeCloud().catch(() => null).then(() => {
      if (modeSummary() !== lastMode) {
        lastMode = modeSummary();
        process.stdout.write(`${new Date().toLocaleTimeString()} mode changed: ${lastMode}\n`);
      }
    });
  }, 5 * 60_000);
  cloudTimer.unref();
  // A crash mid post-merge check leaves its foreman-main-* worktree
  // registered; nothing of ours is running yet, so any left is stale.
  let closing = false;
  const staleMain = await pruneStaleMainWorktrees(store).catch(() => []);
  if (staleMain.length) process.stdout.write(`pruned ${staleMain.length} stale post-merge check worktree(s)\n`);
  // Landed work's worktrees are just disk once it is a few days old; reclaim
  // them on the hour, a bounded batch at a time (see sweepJails).
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping || closing) return;
    sweeping = true;
    void sweepJails(store)
      .then((r) => {
        if (r.removed.length) {
          process.stdout.write(`${new Date().toLocaleTimeString()} reclaimed ${r.removed.length} finished worktree(s)\n`);
        }
        // A failed task's worktree past its bound that could not go: said, so a work directory that keeps growing has a reason.
        if (r.keptNoDiff.length) {
          process.stdout.write(
            `${new Date().toLocaleTimeString()} kept ${r.keptNoDiff.length} old worktree(s) of failed tasks: no diff artifact to recover the work from ` +
            '(`foreman prune` drops them by hand)\n',
          );
        }
      })
      .catch(() => {})
      .finally(() => { sweeping = false; });
  };
  const jailTimer = setInterval(sweep, 3_600_000);
  jailTimer.unref();
  const firstSweep = setTimeout(sweep, 60_000);
  firstSweep.unref();
  // The database is the only copy of memory, receipts, verdicts and run
  // decisions. One verified archive a day; the hourly tick is a no-op once
  // today's exists. The first check comes a minute in, not an hour, so a
  // daemon that is restarted often still gets its backup.
  const backup = backupSettings();
  const sameDisk = backup.enabled ? sameDiskWarning(backup) : null;
  if (sameDisk) process.stdout.write(`${sameDisk}\n`);
  let backingUp = false;
  const backupTick = (): void => {
    if (backingUp || closing || !backup.enabled) return;
    backingUp = true;
    void backupIfDue({
      dbPath: config.dbPath,
      dir: backup.dir,
      copyDir: backup.copyDir,
      record: (type, message) => {
        store.record({ type, message });
        process.stdout.write(`${new Date().toLocaleTimeString()} ${message}\n`);
      },
    }).finally(() => { backingUp = false; });
  };
  const backupTimer = setInterval(backupTick, 3_600_000);
  backupTimer.unref();
  const firstBackup = setTimeout(backupTick, 60_000);
  firstBackup.unref();
  // Groups a dead process left stopped (<home>/frozen): ended before anything is dispatched. Bounded and
  // contained (a failure or an overrun is logged here and serve goes on).
  await runFreezeSweep(freezeSweepOptionsFromEnv(config.home, (line) => process.stdout.write(`${line}\n`)));
  await installProcessRecorder(config.home);
  // The server does not exist until listen() resolves, and a persona spawn 'error' can fire before that:
  // shutdown closes it only once it is listening.
  let server: http.Server | undefined;
  let exitCode = 0;
  const shutdown = async (code: number): Promise<void> => {
    // A second call while closing (an uncaught exception during a signal's drain) only raises the code.
    if (closing) {
      exitCode = Math.max(exitCode, code);
      return;
    }
    closing = true;
    exitCode = code;
    process.stdout.write('\nstopping…\n');
    try {
      clearInterval(jailTimer);
      clearTimeout(firstSweep);
      clearInterval(backupTimer);
      clearTimeout(firstBackup);
      if (server?.listening) server.close();
      // Claim nothing more: the drain below can take a minute, and a worker
      // started now would only be aborted by stop() at its end.
      scheduler.pauseDispatch();
      // No new approvals; post-merge checks aborted (and recorded as such);
      // a merge already under way is let finish, up to a hard cap, so the
      // operator's repo is never left mid-merge.
      const stuck = await approvals.shutdown();
      if (stuck) {
        process.stdout.write(`${stuck} approval(s) still landing after the shutdown cap; exiting anyway — check \`git status\` in their repos\n`);
      }
      let capTimer: NodeJS.Timeout | undefined;
      const capped = new Promise<'capped'>((r) => { capTimer = setTimeout(() => r('capped'), APPROVAL_DRAIN_CAP_MS); });
      try {
        if ((await Promise.race([scheduler.stop(), capped])) === 'capped') {
          process.stderr.write(`shutdown: the scheduler did not stop within ${APPROVAL_DRAIN_CAP_MS}ms; exiting anyway\n`);
          // stop() ends by killing the groups of runs that never settled; it did not get there, so that is done here.
          store.killLiveRunGroups();
        }
      } finally {
        clearTimeout(capTimer);
      }
    } catch (err) {
      process.stderr.write(`shutdown: ${(err as Error).message}\n`);
    } finally {
      // Last, so the stop's own events reach the trace before its final flush;
      // and always, so a failed step still leaves the trace and the lock settled.
      tracer.stop();
      try {
        store.close();
      } catch {
        /* already closed or never usable; the lock still goes */
      }
      releaseLock();
      process.exit(exitCode);
    }
  };
  // After the recorder and before anything that can spawn: a stray rejection is recorded and survived, an uncaught
  // exception ends the daemon in order (exit 1). No signal or 'exit' listener, so the freeze registry is untouched.
  containProcessErrors({
    record: (type, message) => void store.record({ type, message }),
    shutdown,
    now: Date.now,
    write: (line) => void process.stderr.write(line),
  });
  scheduler.start();
  // Warm rung-0 in the background: the first review otherwise pays a cold
  // load for both advisors, serialised by the VRAM guard.
  void prewarmRoster({ onLine: (line) => process.stdout.write(`${line}\n`) }).catch(() => {});
  // Before the "foreman up" line: whoever waits for it may signal at once, and a signal with no listener kills the
  // process outright. shutdown() is safe before the server listens (it closes it only when listening).
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  // A hangup (the terminal or the app that started the daemon went away) ends it the same orderly way: without a
  // listener SIGHUP would kill it outright, skipping the lock release, the trace flush and the 'exit' handlers.
  process.on('SIGHUP', () => void shutdown(0));
  server = await listen(store, scheduler);
  process.stdout.write(
    `foreman up — board ${daemonUrl(config.host, config.port)}  db ${config.dbPath}  workers ${config.maxWorkers}\n` +
      `trace ${tracer.path}\n`,
  );
  return -1; // stay alive
}

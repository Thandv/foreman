import { installFreezeRecorder, type InstallResult } from './freezeRecord.ts';
import { snapshotProcs, type ProcRow } from './proctree.ts';

/**
 * Install this process's freeze recorder for `home` (see freezeRecord.ts): the entry points of Foreman's own processes
 * (cli.ts, verify/testSlot.ts) call this once. This process's identity is its pid and its start as proctree reads it
 * (the zone-free ps lstart, or /proc on Linux); if that cannot be read, the recorder is installed FAILED, and the
 * reaper then sends TERM without freezing. A recorder that cannot write (a sandboxed worker's testSlot: Foreman's
 * home is closed to a jail) is the same state, and is said once on stderr, because it changes how leftovers are ended.
 */
export async function installProcessRecorder(
  home: string,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  snapshot: () => Promise<ProcRow[] | null> = snapshotProcs,
): Promise<InstallResult> {
  const rows = await snapshot();
  const row = rows?.find((r) => r.pid === process.pid);
  const result = installFreezeRecorder(home, { pid: process.pid, start: row?.start ?? '' });
  if (!result.ok) {
    log(
      `foreman: freeze recorder not installed (${row ? result.error : "this process's start time could not be read"}); ` +
        'leftover process groups of commands run here are ended with SIGTERM and SIGKILL without being frozen first',
    );
  }
  return result;
}

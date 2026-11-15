// The shell worker the pipeline benches give each ticket. Imported after ./env.ts.
import { testSlotCommand } from '../../src/runners/cliRunners.ts';

/**
 * A bench worker that follows its brief: it writes its file, and under `suite` full runs the suite once through the
 * slot wrapper against the daemon on `port`, counting the run in `leases` only when the wrapper says it was granted a
 * slot. Its suite is a stand-in that takes suiteMs and counts nothing; the gate's runs count themselves.
 */
export function workerCommand(i: number, o: { suite: 'full' | 'targeted'; port: number; tmp: string; leases: string; suiteMs: number }): string {
  const write = `printf '${i}\\n' > ticket-${i}.txt`;
  if (o.suite === 'targeted') return write;
  const env = `FOREMAN_PORT=${o.port} TMPDIR='${o.tmp}' FOREMAN_WORKER_TEST_CMD='sleep ${o.suiteMs / 1000}'`;
  const granted = `$(${env} ${testSlotCommand()} 2>&1 | grep -c '^testSlot: slot held')`;
  return `${write} && if [ "${granted}" = 1 ]; then printf 'x\\n' >> '${o.leases}'; fi`;
}

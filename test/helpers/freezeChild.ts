import { spawn } from 'node:child_process';
import { installFreezeRecorder } from '../../src/runners/freezeRecord.ts';
import { snapshotProcs } from '../../src/runners/proctree.ts';

// A stand-in recorder for test/freezeSweep.test.ts: installs the freeze recorder for FOREMAN_HOME, starts a detached
// group (argv[2] "ignore": it ignores SIGTERM; "obey": it does not), records it, SIGSTOPs it and prints "frozen <pgid>".
const home = process.env['FOREMAN_HOME']!;
const rows = (await snapshotProcs())!;
const self = rows.find((r) => r.pid === process.pid)!;
const inst = installFreezeRecorder(home, { pid: self.pid, start: self.start });
if (!inst.ok) throw new Error(inst.error);
const script = process.argv[2] === 'ignore' ? 'trap "" TERM; sleep 60; sleep 60' : 'sleep 60';
const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
child.unref();
await new Promise((r) => child.once('spawn', r));
const now = (await snapshotProcs())!;
const member = now.find((r) => r.pid === child.pid)!;
const out = inst.recorder.record([{ pgid: child.pid!, members: [[member.pid, member.start]] }]);
if (!out.ok) throw new Error(out.error);
process.kill(-child.pid!, 'SIGSTOP');
process.stdout.write(`frozen ${child.pid}\n`);
setInterval(() => {}, 1000);

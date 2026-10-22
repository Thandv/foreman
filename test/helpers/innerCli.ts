import '../env.ts';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { testHome } from '../env.ts';

// A stand-in for "a test of the suite run through testSlot that starts the CLI" (test/freezeInstall.test.ts). It
// loads test/env.ts as every test file does, so its FOREMAN_HOME is a fresh temp one whatever it was started with,
// and runs `foreman stop` against a daemon.pid naming a process that ignores SIGTERM, which keeps the CLI waiting
// (and its presence marker in place). argv[2] is a control directory: this writes `home` (its own home) and
// `ready` (the CLI's marker is there), waits for `go`, then lets the CLI finish and exits.
const ctrl = process.argv[2]!;
fs.writeFileSync(path.join(ctrl, 'home'), testHome);
const holder = spawn('sh', ['-c', 'trap "" TERM; exec sleep 60'], { stdio: 'ignore' });
fs.writeFileSync(path.join(testHome, 'daemon.pid'), String(holder.pid));
const cli = spawn(process.execPath, [path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts'), 'stop'], { env: process.env, stdio: 'ignore' });
const exited = new Promise<number | null>((r) => cli.on('exit', (code) => r(code)));
const markerSeen = (): boolean => {
  try {
    return fs.readdirSync(path.join(testHome, 'frozen')).some((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
};
const wait = (cond: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      }
    }, 20);
  });
await wait(markerSeen);
fs.writeFileSync(path.join(ctrl, 'ready'), '');
await wait(() => fs.existsSync(path.join(ctrl, 'go')));
holder.kill('SIGKILL');
process.exit((await exited) === 0 ? 0 : 1);

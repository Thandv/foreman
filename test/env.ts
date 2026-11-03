// Imported first by every test file so src/config.ts reads a sandboxed HOME.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// The homes that are not the sandbox, as this process started, for test/helpers/procguard.ts to watch: the FOREMAN_HOME
// it was started with, the default ~/.foreman, and FOREMAN_TEST_REAL_HOME when it names a path (as a flag, '1', it
// means the real HOME, whose ~/.foreman is already listed). Read before the clearing below.
const testRealHome = process.env['FOREMAN_TEST_REAL_HOME'];
export const realHomes: string[] = [
  ...new Set(
    [process.env['FOREMAN_HOME'], testRealHome && path.isAbsolute(testRealHome) ? testRealHome : undefined, path.join(os.homedir(), '.foreman')]
      .filter((h): h is string => !!h)
      .map((h) => path.resolve(h)),
  ),
];

// The suites run with a known configuration, not the caller's: a Foreman test stage runs them with the daemon's own
// environment (FOREMAN_FAILED_JAIL_RETAIN_DAYS, FOREMAN_SKILLS_DIR, ...), and every default a test pins would then
// read the daemon's tuning instead. A test that needs a setting sets it itself.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('FOREMAN_')) delete process.env[name];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
process.env['FOREMAN_HOME'] = dir;
process.env['FOREMAN_ECHO_STEP_MS'] = '5';
process.env['FOREMAN_TICK_MS'] = '5';
process.env['FOREMAN_PORT'] = '0';
// The OS sandbox (src/security/sandbox.ts) is off for the suites: their stand-in test commands and shell tickets
// write markers wherever the test put its temp dir, which is exactly what the sandbox stops. test/sandbox.test.ts
// turns it back on, per test, and is where the sandboxed paths are exercised.
process.env['FOREMAN_SANDBOX'] = 'off';
// A worker running this suite carries its own run id (src/runners/cliRunners.ts workerEnv). The slot wrappers the
// tests start are not that run's: inherited, they would all be held to its one suite run at a time.
delete process.env['FOREMAN_RUN_ID'];

export const testHome = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

// Temp dirs a test makes under os.tmpdir() (the "foreman-*" ones) are removed when the test process exits, so a full
// run leaves nothing behind (scripts/verify.sh counts them and fails). Use this in place of
// fs.mkdtempSync(path.join(os.tmpdir(), prefix)); a test that needs the dir gone sooner (a stopped scheduler's dir,
// say) removes it itself with test/helpers/removal.ts.
const scratch = new Set<string>();
export function scratchDir(prefix: string): string {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.add(made);
  return made;
}
/**
 * Point this process's TMPDIR (so os.tmpdir(), and every child that inherits the environment) at a fresh dir that goes
 * at exit. For a file that runs the slot wrapper (src/verify/testSlot.ts): it keeps its saved output in a
 * `foreman-suite-output` folder of the temp dir, on purpose, and that folder would otherwise stay in the shared one.
 */
export function privateTmpdir(): string {
  const dir = scratchDir('ft-private-');
  process.env['TMPDIR'] = dir;
  privateDirs.push(dir);
  return dir;
}
const privateDirs: string[] = [];
process.on('exit', () => {
  // The saved-output folder and the dirs scratchDir tracks are the only things allowed in a private temp dir; any
  // other foreman-* entry is a leak that moving the temp dir would hide, so it is named (scripts/leak-scan.ts reads this).
  for (const dir of privateDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('foreman-') && name !== 'foreman-suite-output' && !scratch.has(path.join(dir, name))) {
          process.stderr.write(`foreman-tmp-leak: ${name}\n`);
        }
      }
    } catch {
      /* already gone */
    }
  }
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});

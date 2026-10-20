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

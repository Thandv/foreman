import { scratchDir } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// scripts/demo/mr-landing.ts signs in two people on a throwaway daemon and lands through the local fake GitLab in three
// passes. --check is its mode for the suite: a pipeline that answers at once and no pauses. The script runs with a TMPDIR
// of its own, so what it leaves behind is countable whatever else is in the shared one.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function demo(...args: string[]): Promise<{ stdout: string; tmp: string }> {
  const tmp = scratchDir('foreman-demo-tmp-');
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'scripts', 'demo', 'mr-landing.ts'), '--check', ...args], {
    cwd: root, env: { ...process.env, TMPDIR: tmp }, timeout: 120_000,
  });
  return { stdout, tmp };
}

test('--check prints the steps of all three passes, including the refused self-approval and the main check run at the merge commit, and leaves nothing behind', async () => {
  const { stdout, tmp } = await demo();
  const lines = stdout.split('\n');
  const at = (re: RegExp): number => {
    const i = lines.findIndex((l) => re.test(l));
    assert.notEqual(i, -1, `no line matches ${re}:\n${stdout}`);
    return i;
  };
  const order = [
    /^pass 1: /, /^ {2}1\. alice approves her own ticket \S+: refused \(403\)/, /^ {2}2\. bob approves \S+: mr-opened, !1 head [0-9a-f]{7} is the reviewed commit/,
    /^ {2}3\. pipeline success: merged !1 at ([0-9a-f]{7}), checkout synced, main check green at \1, dependent \S+ released/,
    /^pass 2: /, /^ {2}1\. bob approves \S+: mr-opened, !2 /, /^ {2}2\. pipeline failed: \S+ is back at the gate \(awaiting-approval\)/,
    /^pass 3: /, /^ {2}1\. bob approves \S+: mr-opened, !3 /, /^ {2}2\. head moved to [0-9a-f]{7} and its pipeline passed: the merge at the reviewed sha was refused \(409\)/,
    /^ {2}3\. \S+ is back at the gate \(awaiting-approval\)/,
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the steps come in order');
  assert.deepEqual(fs.readdirSync(tmp), [], 'every temp dir the demo made is gone');
});

test('--keep leaves its directories, and no token appears in the output', async () => {
  const { stdout, tmp } = await demo('--keep');
  const kept = [...stdout.matchAll(/^kept: (.+)$/gm)].map((m) => m[1]!);
  assert.ok(kept.length > 0 && kept.every((d) => fs.existsSync(d)), stdout);
  const tokens = kept.flatMap((d) => (fs.existsSync(path.join(d, 'secrets', 'gitlab-token')) ? [fs.readFileSync(path.join(d, 'secrets', 'gitlab-token'), 'utf8').trim()] : []));
  assert.equal(tokens.length, 1, 'the daemon home holds the GitLab token file');
  assert.ok(tokens[0]!.length >= 16 && !stdout.includes(tokens[0]!), 'the GitLab token is not printed');
  assert.ok(fs.readdirSync(tmp).length > 0);
});

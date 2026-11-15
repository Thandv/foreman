import { scratchDir, testHome } from './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getTool, recordUse, registerTool, setQuarantine, ToolError } from '../src/tools/catalog.ts';

const STATE = path.join(testHome, 'tool-state.json');
const LOCK = `${STATE}.lock`;
const CATALOG = path.join(import.meta.dirname, '..', 'src', 'tools', 'catalog.ts');

/** A fresh catalog holding minimal tools, with no state file and no lock. */
function catalogWith(...names: string[]): string {
  const dir = scratchDir('foreman-tools-');
  process.env['FOREMAN_TOOLS_DIR'] = dir;
  fs.rmSync(STATE, { force: true });
  fs.rmSync(LOCK, { force: true });
  for (const name of names) {
    const src = scratchDir('foreman-src-');
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ name, description: `the ${name} tool`, entry: 'tool.js' }));
    fs.writeFileSync(path.join(src, 'tool.js'), 'process.stdout.write("{}");\n');
    registerTool({ sourceDir: src });
  }
  return dir;
}

test('a truncated tool-state.json keeps a quarantined tool quarantined and refuses the next write', () => {
  catalogWith('held-tool', 'other-tool');
  setQuarantine('held-tool', true, 'operator hold');
  const full = fs.readFileSync(STATE, 'utf8');
  fs.writeFileSync(STATE, full.slice(0, Math.floor(full.length / 2))); // a torn write

  assert.throws(
    () => recordUse('other-tool', true),
    (err: unknown) => err instanceof ToolError && err.message.includes(STATE) && /mv .*tool-state\.json .*tool-state\.json\.corrupt/.test(err.message),
  );
  assert.equal(fs.readFileSync(STATE, 'utf8'), full.slice(0, Math.floor(full.length / 2)), 'the corrupt file is left for the operator');
  assert.equal(getTool('held-tool')!.quarantined, true, 'the quarantine survives a corrupt state file');
  assert.equal(getTool('other-tool')!.quarantined, true, 'unreadable state is treated as quarantined');
  assert.match(getTool('other-tool')!.quarantineReason!, /tool-state\.json/);
});

test('a missing tool-state.json still means no state', () => {
  catalogWith('fresh-tool');
  fs.rmSync(STATE);
  assert.equal(getTool('fresh-tool')!.quarantined, false);
  assert.equal(recordUse('fresh-tool', true)!.stats.calls, 1);
});

test('a lock left by a dead process is reclaimed', () => {
  catalogWith('lock-tool');
  const gone = spawnSync(process.execPath, ['-e', '']);
  assert.ok(gone.pid);
  fs.writeFileSync(LOCK, `${gone.pid}\n`);
  assert.equal(recordUse('lock-tool', true)!.stats.calls, 1);
  assert.equal(fs.existsSync(LOCK), false, 'the lock is released after the write');
});

test('a lock older than 30 s is reclaimed even when its pid is alive', () => {
  catalogWith('old-lock-tool');
  fs.writeFileSync(LOCK, `${process.ppid}\n`);
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(LOCK, old, old);
  assert.equal(recordUse('old-lock-tool', true)!.stats.calls, 1);
});

/** One child that records `n` uses of `name` once the parent says go. */
function recorder(name: string, n: number): { ready: Promise<void>; done: Promise<number | null>; go: () => void; stderr: () => string } {
  const script =
    `const { recordUse } = await import(${JSON.stringify(CATALOG)});\n` +
    'process.stdout.write("ready\\n");\n' +
    'process.stdin.once("data", () => {\n' +
    `  for (let i = 0; i < ${n}; i++) recordUse(${JSON.stringify(name)}, true);\n` +
    '  process.exit(0);\n' +
    '});\n';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`recorder exited ${code} before ready: ${err}`)));
  });
  const done = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { ready, done, go: () => child.stdin.end('go\n'), stderr: () => err };
}

test('two processes recording 50 uses each lose no update and leave no partial file', async () => {
  catalogWith('busy-tool');
  const a = recorder('busy-tool', 50);
  const b = recorder('busy-tool', 50);
  await Promise.all([a.ready, b.ready]);
  a.go();
  b.go();
  assert.deepEqual(await Promise.all([a.done, b.done]), [0, 0], `${a.stderr()}${b.stderr()}`);
  assert.equal(getTool('busy-tool')!.stats.calls, 100);
  assert.deepEqual(fs.readdirSync(testHome).filter((f) => f.startsWith('tool-state.json') && f !== 'tool-state.json'), [], 'no temp or lock file left behind');
});

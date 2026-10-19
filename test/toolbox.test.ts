// Generic toolbox integration harness. Deliberately does not hardcode tool
// names: multiple hand-added and forged tools may land in toolbox/ over
// time, so this discovers directories the same way the real catalog loader
// does (src/tools/catalog.ts's NAME_RE + manifest.json presence) and holds
// every one of them to the same bar — manifest loads clean through the real
// loader, ships a README and a test/ directory, and its own tests pass.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getTool, listTools, toolsDir, rescanToolSources } from '../src/tools/catalog.ts';

/** Mirrors catalog.ts's NAME_RE without importing a private symbol. */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * This harness itself runs under `node --test`, which sets NODE_TEST_CONTEXT
 * in its own environment. spawnSync inherits that by default, and a `node
 * --test` child that sees NODE_TEST_CONTEXT already set treats itself as a
 * recursive invocation and silently skips running any files at all — exit
 * 0, empty stdout, no TAP output — which would make every per-tool test run
 * below a no-op rather than a real check. Stripping it for the child is
 * what makes it actually run.
 */
function subprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

function discoverToolDirs(): string[] {
  const dir = toolsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME_RE.test(n) && fs.existsSync(path.join(dir, n, 'manifest.json')))
    .sort();
}

const names = discoverToolDirs();

test('the toolbox has at least one tool to check', () => {
  assert.ok(names.length > 0, `expected at least one tool under ${toolsDir()}`);
});

test('listTools() (the "foreman tools ls" data source) sees every discovered tool', () => {
  const seen = new Set(listTools().map((t) => t.name));
  for (const name of names) assert.ok(seen.has(name), `listTools() is missing '${name}'`);
  assert.equal(listTools().length, names.length, 'listTools() count must match the directories on disk');
});

for (const name of names) {
  const dir = path.join(toolsDir(), name);

  test(`${name}: manifest loads through the real catalog loader, unquarantined, with zero admission findings`, () => {
    const tool = getTool(name);
    assert.ok(tool, `getTool('${name}') returned null`);
    assert.equal(tool!.name, name);
    assert.ok(tool!.description.length > 0, `${name} needs a non-empty description`);
    assert.ok(tool!.input && typeof tool!.input === 'object', `${name} needs an input schema`);
    assert.ok(tool!.output && typeof tool!.output === 'object', `${name} needs an output schema`);
    assert.equal(tool!.runtime === 'node' || tool!.runtime === 'python', true, `${name} has an unrecognised runtime`);
    assert.ok(fs.existsSync(path.join(dir, tool!.entry)), `${name}'s entry file '${tool!.entry}' is missing on disk`);
    assert.equal(tool!.quarantined, false, `${name} is quarantined: ${tool!.quarantineReason ?? 'unknown reason'}`);
    assert.deepEqual(
      tool!.admit.findings,
      [],
      `${name} has admission findings: ${JSON.stringify(tool!.admit.findings)}`,
    );
  });

  test(`${name}: a FRESH admission scan of its current sources on disk finds nothing (not just the manifest's self-declared findings)`, () => {
    // The check above trusts tool.admit.findings, which is frozen into the
    // manifest at registration time. Nothing stops a hand-added or
    // hand-edited manifest from simply declaring "findings: []" regardless
    // of what its source actually contains — this re-runs the real scan
    // registerTool() uses, against the source as it sits on disk right now,
    // so a stale or forged self-report can't hide anything from the harness.
    const fresh = rescanToolSources(name);
    assert.deepEqual(
      fresh,
      [],
      `${name} has admission findings under a fresh scan of its current source: ${JSON.stringify(fresh)}`,
    );
  });

  test(`${name}: ships a README.md and a test/ directory`, () => {
    assert.ok(fs.existsSync(path.join(dir, 'README.md')) && fs.statSync(path.join(dir, 'README.md')).isFile(), `${name} is missing README.md`);
    const testDir = path.join(dir, 'test');
    assert.ok(fs.existsSync(testDir) && fs.statSync(testDir).isDirectory(), `${name} is missing test/`);
  });

  test(`${name}: its own tests pass under node --test`, () => {
    const testDir = path.join(dir, 'test');
    if (!fs.existsSync(testDir)) {
      assert.fail(`${name} has no test/ directory to run`);
    }
    const files = fs
      .readdirSync(testDir)
      .filter((f) => /\.test\.(js|mjs|cjs|ts)$/.test(f))
      .map((f) => path.join(testDir, f));
    assert.ok(files.length > 0, `${name} ships no *.test.js files under test/`);

    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      encoding: 'utf8', cwd: dir, env: subprocessEnv(),
    });
    assert.equal(
      res.status,
      0,
      `${name}'s own test suite failed (exit ${res.status}):\n${res.stdout.slice(-4000)}\n${res.stderr.slice(-2000)}`,
    );

    // Exit 0 alone is not proof anything was actually tested: `node --test`
    // exits 0 on a file with zero test() calls in it too. Parse the TAP
    // summary line ("# tests N") and require a real minimum, so an empty or
    // near-empty stub test file fails the harness instead of quietly
    // counting as "passing".
    const testCount = tapTestCount(res.stdout);
    assert.ok(
      testCount !== null,
      `${name}: could not find a test-count summary line in node --test output:\n${res.stdout.slice(-2000)}`,
    );
    assert.ok(
      testCount >= 3,
      `${name}: its test suite only ran ${testCount} test(s) (want >= 3) — too few to trust as real coverage`,
    );
  });
}

/**
 * How many tests a `node --test` run actually ran.
 *
 * The count is read from the reporter's summary, and which summary that is
 * depends on the node version: the TAP reporter prints `# tests N`, the spec
 * reporter (the default on a non-TTY since node 26) prints `ℹ tests N`. The
 * harness pins `--test-reporter=tap` so the first form is what it should see,
 * and still reads the second, so this check keeps working on whatever node the
 * operator has rather than reporting every tool as untested.
 */
export function tapTestCount(stdout: string): number | null {
  const m = stdout.match(/^(?:# |ℹ )tests (\d+)$/m);
  return m ? Number(m[1]) : null;
}

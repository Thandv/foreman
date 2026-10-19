// Validates the toolbox harness's own defenses added alongside this file
// (see test/toolbox.test.ts): a manifest that self-declares zero admission
// findings must not be trusted at face value, and a test suite that reports
// exit 0 must not be trusted at face value either — `node --test` exits 0
// on a file with zero actual test() calls in it.
//
// test/toolbox.test.ts fixes its list of tools to check at MODULE IMPORT
// TIME (from whatever toolsDir() resolves to right then), so it can't be
// redirected at a fake toolbox after the fact within the same process. This
// file instead points catalog.ts's FOREMAN_TOOLS_DIR redirection (see
// toolsDir() in src/tools/catalog.ts) at a throwaway "fakebox" holding one
// hand-forged, hostile tool, then exercises the exact same primitives the
// real harness now uses — rescanToolSources() and the TAP '# tests N'
// parse — directly against that fixture, proving both catch what a
// manifest's/exit-code's self-report would have missed.
import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getTool, toolDir, rescanToolSources } from '../src/tools/catalog.ts';
import { tapTestCount } from './toolbox.test.ts';

function makeFakebox(): { boxDir: string; name: string } {
  const boxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fakebox-'));
  const name = 'hostile-tool';
  const dir = path.join(boxDir, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name,
        description: 'a hand-added tool that lies about its own admission scan',
        entry: 'tool.js',
        runtime: 'node',
        version: 1,
        input: { type: 'object' },
        output: { type: 'object' },
        provenance: { taskId: null, runId: null, model: null, date: new Date().toISOString() },
        // Self-declared clean — exactly the claim a hostile hand-added tool
        // would make. The harness must not take this at face value.
        admit: { scannedAt: new Date().toISOString(), findings: [] },
      },
      null,
      2,
    ),
  );

  // A real admission rule (the 'network' note-rule in src/security/admit.ts,
  // which fires on a literal "fetch(") is present in this source. A fresh
  // scan of the file must catch it even though the manifest above claims
  // zero findings.
  fs.writeFileSync(
    path.join(dir, 'tool.js'),
    ["// pretend this later calls fetch('https://example.com') to phone home", "process.stdout.write('{}');", ''].join('\n'),
  );

  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);

  // An empty test file: it imports node:test but registers zero actual
  // test() cases. `node --test` still exits 0 for it — Node wraps a file
  // with no test() calls as one implicit test (the file itself), so the
  // TAP summary shows "# tests 1", not the 3+ a real suite should have —
  // the exact shape that used to sail through the harness undetected as
  // long as only the exit code was checked.
  fs.writeFileSync(path.join(dir, 'test', 'tool.test.js'), "import 'node:test';\n");

  return { boxDir, name };
}

/** See the matching helper/comment in test/toolbox.test.ts: this harness
 *  itself runs under `node --test`, and a nested `node --test` child needs
 *  NODE_TEST_CONTEXT stripped from its environment or it silently no-ops. */
function subprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

function withFakebox<T>(fn: (name: string) => T): T {
  const { boxDir, name } = makeFakebox();
  const prev = process.env['FOREMAN_TOOLS_DIR'];
  process.env['FOREMAN_TOOLS_DIR'] = boxDir;
  try {
    return fn(name);
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_TOOLS_DIR'];
    else process.env['FOREMAN_TOOLS_DIR'] = prev;
    fs.rmSync(boxDir, { recursive: true, force: true });
  }
}

test('toolbox harness: a fresh admission scan catches a hand-forged tool that self-declares zero findings', () => {
  withFakebox((name) => {
    const tool = getTool(name);
    assert.ok(tool, 'fixture tool should load through the real catalog loader');
    // The manifest's own self-declared findings are (falsely) empty — the
    // whole point of the fixture, and what the OLD harness trusted outright.
    assert.deepEqual(tool!.admit.findings, []);

    // The fix: a fresh re-scan of the tool's actual source must disagree.
    const fresh = rescanToolSources(name);
    assert.ok(
      fresh.length > 0,
      'a fresh scan of the hostile fixture must find something the stale/forged manifest missed',
    );
  });
});

test('toolbox harness: an empty test file is caught by the TAP test-count check, not just exit code 0', () => {
  withFakebox((name) => {
    const testDir = path.join(toolDir(name), 'test');
    const files = fs
      .readdirSync(testDir)
      .filter((f) => /\.test\.(js|mjs|cjs|ts)$/.test(f))
      .map((f) => path.join(testDir, f));
    assert.ok(files.length > 0);

    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      encoding: 'utf8', cwd: toolDir(name), env: subprocessEnv(),
    });

    // The bug this guards against: node --test exits 0 on a file with zero
    // tests in it, so exit-code-only checking passes a suite that tests
    // nothing at all.
    assert.equal(res.status, 0, 'sanity: an empty test file still exits 0 under node --test');

    const testCount = tapTestCount(res.stdout);
    assert.ok(testCount !== null, `expected a test-count summary line:\n${res.stdout}`);
    // Node's test runner wraps a file with zero test() calls as a single
    // implicit "test" (the file itself), so this reports 1, not 0 — but
    // either way it is nowhere near real coverage.
    assert.ok(testCount < 3, `sanity: the fixture registers no real test() cases (got ${testCount})`);

    // The fix: the harness additionally requires testCount >= 3, which this
    // fixture — by construction — fails.
    assert.ok(testCount < 3, 'a suite with under 3 tests must fail the harness N >= 3 requirement');
  });
});

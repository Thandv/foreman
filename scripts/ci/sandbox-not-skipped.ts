// Fails when the captured output of a `node --test` run shows a sandbox test skipped. The sandbox tests skip, by
// design, wherever sandbox-exec cannot be exercised (not macOS, no sandbox-exec, or already inside a sandbox, as in
// Foreman's own post-merge check), so a green suite alone does not prove they ran. The macOS CI job runs this over
// its suite output to make sure they did. Not a scripts/checks/ check for that reason: verify runs those under the
// post-merge check too, where these skips are expected.
// Usage: node scripts/ci/sandbox-not-skipped.ts <file holding the node --test output>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every sandbox test's skip reason names the sandbox ("the sandbox cannot be exercised here: …").
const SANDBOX_REASON = /sandbox/i;
// The spec reporter: "﹣ name (0.05ms) # reason"; the TAP reporter: "ok 2 - name # SKIP reason".
const SPEC_SKIP = /^\s*﹣ (.*?) \([\d.]+m?s\)(?: # (.*))?$/;
const TAP_SKIP = /^\s*(?:not )?ok \d+ - (.*?) # SKIP\s*(.*)$/;
// The run's own count, the last one printed: "ℹ skipped 3" (spec) or "# skipped 3" (TAP).
const SKIPPED_COUNT = /^(?:ℹ|#) skipped (\d+)$/;

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Why `output` fails: each skipped sandbox test, or why the skips cannot all be read. Empty when it passes. */
export function sandboxSkipProblems(output: string): string[] {
  const lines = plain(output).split('\n');
  const counted = lines.map((l) => SKIPPED_COUNT.exec(l)?.[1]).filter((n) => n !== undefined).at(-1);
  if (counted === undefined) return ['no "skipped" count in the output: the suite did not run, or its output was not captured'];
  const skips = lines.flatMap((l) => {
    const m = SPEC_SKIP.exec(l) ?? TAP_SKIP.exec(l);
    return m ? [{ name: m[1] ?? '', reason: m[2] ?? '' }] : [];
  });
  if (skips.length < Number(counted)) {
    return [`the run counts ${counted} skipped but only ${skips.length} skip line(s) could be read, so none can be ruled out as a sandbox test`];
  }
  return skips.filter((s) => SANDBOX_REASON.test(s.reason)).map((s) => `skipped: ${s.name} — ${s.reason}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/ci/sandbox-not-skipped.ts <node --test output file>');
    process.exit(2);
  }
  const problems = sandboxSkipProblems(fs.readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(`sandbox-not-skipped: FAIL — the sandbox tests did not all run\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('sandbox-not-skipped: ok');
}

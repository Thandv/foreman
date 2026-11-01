// Fails when src/ reads a FOREMAN_* variable docs/configuration.md does not list, or the doc lists one src/ never
// reads. Usage: node scripts/checks/config-truth.ts [root-dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exempt in both directions, each with its reason. Add only after checking the read site in src/.
const ALLOW: Record<string, string> = {
  FOREMAN_ECHO_STEP_MS: 'echo runner (src/runners/echo.ts) is a test stub; the step delay is only set by tests',
  FOREMAN_FREEZE_SWEEP_FAULT: 'fault injection for tests (src/runners/freezeSweep.ts): hang|throw',
  FOREMAN_WORKER_TEST_CMD: 'set by Foreman for a worker run (src/verify/testSlot.ts), never by an operator',
  FOREMAN_RUN_ID: 'set by Foreman for a worker run (src/cli.ts, src/verify/testSlot.ts), never by an operator',
};
// Exempt while docs/configuration.md is still the moved prose section: one name per line, '#' comments. The ticket
// that writes the table deletes the lines.
const PENDING_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config-truth-pending.txt');

const QUOTED = /["'`](FOREMAN_[A-Z0-9_]+)["'`]/g;
const ENV = /process\.env\.(FOREMAN_[A-Z0-9_]+)/g;

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

/** name -> files reading it. Comments are blanked first, so a name only in a comment is not a read. */
export function readNames(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of tsFiles(path.join(root, 'src'))) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const rel = path.relative(root, file);
    for (const m of [...code.matchAll(QUOTED), ...code.matchAll(ENV)]) {
      const files = out.get(m[1]) ?? [];
      if (!files.includes(rel)) files.push(rel);
      out.set(m[1], files);
    }
  }
  return out;
}

/** First-column backticked names of the table rows in docs/configuration.md. */
export function documentedNames(root: string): Set<string> {
  const file = path.join(root, 'docs', 'configuration.md');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  return new Set(lines.flatMap((l) => /^\|\s*`(FOREMAN_[A-Z0-9_]+)`/.exec(l)?.[1] ?? []));
}

export function checkConfigTruth(root: string): { problems: string[]; summary: string } {
  const pending = fs.readFileSync(PENDING_FILE, 'utf8').split('\n').filter((l) => /^FOREMAN_/.test(l));
  const allowed = new Set([...Object.keys(ALLOW), ...pending]);
  const read = readNames(root);
  const doc = documentedNames(root);
  const problems = [
    ...[...read].filter(([n]) => !doc.has(n) && !allowed.has(n)).map(([n, f]) => `undocumented: ${n} (read in ${f.join(', ')})`),
    ...[...doc].filter((n) => !read.has(n) && !allowed.has(n)).map((n) => `stale: ${n} (documented, never read in src/)`),
  ];
  const D = [...read.keys()].filter((n) => doc.has(n)).length;
  return { problems, summary: `read ${read.size} = documented ${D} + allow-listed ${read.size - D}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const { problems, summary } = checkConfigTruth(root);
  for (const [n, f] of readNames(root)) console.log(`${n}  ${f.join(', ')}`);
  if (problems.length) {
    console.error(`config-truth: FAIL\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`config-truth: ok — ${summary}`);
}

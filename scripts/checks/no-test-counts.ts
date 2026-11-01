// Fails when README.md or a docs/**/*.md file carries a hand-typed test count. Such a number is wrong the day a
// test is added; `npm run verify` prints the real one. Usage: node scripts/checks/no-test-counts.ts [root-dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// '~2,600 tests', '2600 tests', '2600 tests passing', '2600 tests pass', '2598/2600 tests'. Digits only: prose such
// as 'two tests' or 'the next ten' is not a count and is not matched.
const COUNT = /(?:~\s*)?\d[\d,]*(?:\s*\/\s*\d[\d,]*)?\s+tests\b/gi;

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, 'README.md'))) out.push('README.md');
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, 'docs'))) walk('docs');
  return out.sort();
}

/** Every test count under `root`, as `file:line: text`. */
export function findTestCounts(root: string): string[] {
  const found: string[] = [];
  for (const file of markdownFiles(root)) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(COUNT)) found.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findTestCounts(path.resolve(process.argv[2] ?? process.cwd()));
  if (found.length) {
    console.error(`no-test-counts: FAIL — a hand-typed test count goes stale; remove it\n${found.join('\n')}`);
    process.exit(1);
  }
  console.log('no-test-counts: ok');
}

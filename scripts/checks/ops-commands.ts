// Fails when docs/OPERATING.md or docs/commands.md shows a `foreman <cmd>` that the CLI does not have.
// Usage: node scripts/checks/ops-commands.ts [root-dir]
//
// The CLI is never run here: it is refused inside a worker run, and every command writes under FOREMAN_HOME.
// The names are what `foreman help` prints, read from src/cli.ts as text: the `USAGE` table's lines that start with
// two spaces and `foreman <cmd>`, and `help` itself. Only the top-level command is checked; a subcommand or flag after
// it (`approve --as-is`) is not. test/ops-commands.test.ts pins this parse to the real `foreman help` output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = ['docs/OPERATING.md', 'docs/commands.md'];

/** The commands `foreman help` names, from the USAGE table in cli.ts source text, and `help`. */
export function commandNames(cliSource: string): Set<string> {
  return new Set(['help', ...[...cliSource.matchAll(/^ {2}foreman ([a-z][a-z-]*)/gm)].map((m) => m[1]!)]);
}

/** Each `foreman <cmd>` written as code in a markdown text: inside a fence, or inside an inline `code span`. */
export function documentedCommands(md: string): Array<{ line: number; cmd: string }> {
  const out: Array<{ line: number; cmd: string }> = [];
  let fenced = false;
  md.split('\n').forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    const code = fenced ? [text] : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    for (const c of code) {
      for (const m of c.matchAll(/(?<![\w/.-])foreman\s+([a-z][a-z-]*)/g)) out.push({ line: i + 1, cmd: m[1]! });
    }
  });
  return out;
}

/** Every unknown command, as `file:line: foreman <cmd>`. Throws when src/cli.ts is missing. */
export function findUnknownCommands(root: string): string[] {
  const known = commandNames(fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8'));
  const bad: string[] = [];
  for (const file of DOCS) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const { line, cmd } of documentedCommands(fs.readFileSync(p, 'utf8'))) {
      if (!known.has(cmd)) bad.push(`${file}:${line}: foreman ${cmd}`);
    }
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  try {
    const bad = findUnknownCommands(root);
    if (bad.length) {
      console.error(`ops-commands: FAIL — a command the CLI does not have\n${bad.join('\n')}`);
      process.exit(1);
    }
    console.log('ops-commands: ok');
  } catch (e) {
    console.error(`ops-commands: FAIL — ${(e as Error).message}`);
    process.exit(1);
  }
}

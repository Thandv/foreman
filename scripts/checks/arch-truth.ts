// Fails when docs/ARCHITECTURE.md says something the tree contradicts: a backticked repo path that does not exist, a
// src file over 500 lines the doc never names, or state-diagram names that differ from the unions in src/types.ts.
// Usage: node scripts/checks/arch-truth.ts [root-dir]   (default: the current directory)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = 'docs/ARCHITECTURE.md';
const BIG = 500;
// `<FOREMAN_HOME>/...` paths start with '<', so they never match; a glob is a pattern, not a path.
const REPO_PATH = /`((?:src|test|scripts|board|playbooks|toolbox)\/[^`\s]*)`/g;

function srcFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, 'src'))) walk('src');
  return out.sort();
}

function lineCount(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** The quoted names of a union: the text from the end of `start` to the next `;`. */
function unionNames(source: string, start: RegExp): string[] | null {
  const m = start.exec(source);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = source.indexOf(';', from);
  const body = source.slice(from, end === -1 ? undefined : end);
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/**
 * The state names a mermaid stateDiagram uses: both ends of every `A --> B`, and `state X` lines. [*] is not a state.
 * A `state "name" as id` line stands `id` in for `name` (a state id cannot hold a hyphen), and counts as `name`.
 */
function diagramStates(block: string): Set<string> {
  const lines = block.split('\n').map((raw) => raw.replace(/%%.*$/, '').trim());
  const alias = new Map<string, string>();
  for (const line of lines) {
    const a = /^state\s+"([^"]+)"\s+as\s+(\S+)/.exec(line);
    if (a) alias.set(a[2]!, a[1]!);
  }
  const names = new Set<string>(alias.values());
  for (const line of lines) {
    const arrow = /^(\S+)\s*-->\s*([^\s:]+)/.exec(line);
    if (arrow) for (const n of [arrow[1]!, arrow[2]!]) if (n !== '[*]') names.add(alias.get(n) ?? n);
    const decl = /^state\s+([^\s"]+)/.exec(line);
    if (decl) names.add(alias.get(decl[1]!) ?? decl[1]!);
  }
  return names;
}

function compare(have: Set<string>, want: string[]): { missing: string[]; extra: string[] } {
  const w = new Set(want);
  return { missing: want.filter((x) => !have.has(x)), extra: [...have].filter((x) => !w.has(x)) };
}

/** Every way the doc under `root` disagrees with the tree, one message each. */
export function checkArchitecture(root: string): string[] {
  const docFile = path.join(root, DOC);
  if (!fs.existsSync(docFile)) return [`${DOC} does not exist`];
  const doc = fs.readFileSync(docFile, 'utf8');
  const problems: string[] = [];

  const named = new Set<string>();
  doc.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(REPO_PATH)) {
      const p = m[1]!;
      if (p.includes('*')) continue;
      named.add(p.replace(/\/$/, ''));
      if (!fs.existsSync(path.join(root, p))) problems.push(`${DOC}:${i + 1}: \`${p}\` does not exist`);
    }
  });

  for (const f of srcFiles(root)) {
    const n = lineCount(path.join(root, f));
    if (n > BIG && !named.has(f)) problems.push(`${f} has ${n} lines (over ${BIG}) and ${DOC} does not name it`);
  }

  const blocks = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const runBlock = blocks.find((b) => /^\s*%% runs\s*$/m.test(b));
  const taskBlock = blocks.find((b) => /^\s*stateDiagram/m.test(b) && b !== runBlock);
  const typesFile = path.join(root, 'src/types.ts');
  const types = fs.existsSync(typesFile) ? fs.readFileSync(typesFile, 'utf8') : '';
  const taskUnion = unionNames(types, /export type TaskStatus\s*=/);
  // Run's own `status:` field: no `}` before it, so the match cannot run on into a later interface.
  const runUnion = unionNames(types, /export interface Run \{[^}]*?\n {2}status:/);

  if (!taskUnion) problems.push('src/types.ts has no `export type TaskStatus` union to compare with');
  else if (!taskBlock) problems.push(`${DOC} has no task-status mermaid stateDiagram`);
  else {
    const d = compare(diagramStates(taskBlock), taskUnion);
    if (d.missing.length) problems.push(`task-status diagram lacks: ${d.missing.join(', ')} (TaskStatus in src/types.ts)`);
    if (d.extra.length) problems.push(`task-status diagram has names not in TaskStatus: ${d.extra.join(', ')}`);
  }

  if (runUnion) {
    if (!runBlock) problems.push(`${DOC} has no run-status mermaid stateDiagram (marked with a \`%% runs\` line)`);
    else {
      const d = compare(diagramStates(runBlock), runUnion);
      if (d.missing.length) problems.push(`run-status diagram lacks: ${d.missing.join(', ')} (Run.status in src/types.ts)`);
      if (d.extra.length) problems.push(`run-status diagram has names not in Run.status: ${d.extra.join(', ')}`);
    }
  } else if (runBlock) {
    problems.push(`${DOC} has a run-status diagram, but no \`status\` union of \`export interface Run {\` was found in src/types.ts to compare it with`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkArchitecture(path.resolve(process.argv[2] ?? process.cwd()));
  if (problems.length) {
    console.error(`arch-truth: FAIL — ${DOC} disagrees with the tree\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('arch-truth: ok');
}

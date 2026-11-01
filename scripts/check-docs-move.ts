// Proves the README -> docs/ move is verbatim.
//   npm run check:docs-move -- [parent=HEAD] [tree=.] [--undo-links]
// parent: the commit whose README.md is the source (read with `git show <parent>:README.md`).
// tree:   a directory holding README.md and docs/*.md (the checkout at commit 1, or the working tree).
// --undo-links: put back, in memory, the in-place link fixes that belong to commit 2 (UNDO below), so the
//               current tree can be compared as if it were commit 1.
// Prints, for every moved block, its heading, target file and byte count. Exits 1 on any mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const undo = args.includes('--undo-links');
const [parent = 'HEAD', tree = '.'] = args.filter((a) => !a.startsWith('--'));

/** commit-2 link edits made inside moved blocks: [file, text in commit 2, text in commit 1]. */
const UNDO: [string, string, string][] = [
  ['crews.md', '(see [The sandbox](security.md#the-sandbox-foreman_sandbox))', '(see [The sandbox](#the-sandbox-foreman_sandbox))'],
  ['configuration.md', '[The revert check, per test](security.md#the-revert', '[The revert check, per test](#the-revert'],
  ['configuration.md', '[The sandbox](security.md#the-sandbox', '[The sandbox](#the-sandbox'],
  ['license-and-contributing.md', '[Apache License 2.0](../LICENSE) (see also [NOTICE](../NOTICE))', '[Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE))'],
  ['license-and-contributing.md', '[CONTRIBUTING.md](../CONTRIBUTING.md)', '[CONTRIBUTING.md](CONTRIBUTING.md)'],
  ['license-and-contributing.md', '[SECURITY.md](../SECURITY.md)', '[SECURITY.md](SECURITY.md)'],
];

const problems: string[] = [];
const fail = (m: string): void => void problems.push(m);

const parentReadme = execFileSync('git', ['show', `${parent}:README.md`], { maxBuffer: 1 << 28 }).toString('utf8');
const lines = parentReadme.split(/(?<=\n)/);

// Blocks: from each `## ` line (outside code fences) to the next one. Block 0 is Quick start (stays in README).
const blocks: { heading: string; text: string }[] = [];
const headings: string[] = []; // every ## and ### line, outside fences
let fence = false;
for (const l of lines) {
  if (/^```/.test(l)) fence = !fence;
  if (!fence && /^###? /.test(l)) headings.push(l.replace(/\n$/, ''));
  const m = !fence && /^## (.*)\n?$/.exec(l);
  if (m) blocks.push({ heading: m[1]!, text: l });
  else if (blocks.length) blocks[blocks.length - 1]!.text += l;
}
if (blocks[0]?.heading !== 'Quick start') throw new Error('first ## section of the parent README is not Quick start');
const moved = blocks.slice(1);

const docsDir = path.join(tree, 'docs');
const docs = new Map<string, string>();
for (const f of fs.readdirSync(docsDir).filter((x) => x.endsWith('.md')).sort()) {
  let text = fs.readFileSync(path.join(docsDir, f), 'utf8');
  if (undo) for (const [file, now, was] of UNDO) if (file === f) {
    if (!text.includes(now)) fail(`--undo-links: ${f} does not contain the commit-2 text ${JSON.stringify(now)}`);
    text = text.split(now).join(was);
  }
  docs.set(f, text);
}

// 1. each moved block, byte for byte, in exactly one docs file; each docs file is nothing but its blocks.
const perFile = new Map<string, string[]>();
for (const b of moved) {
  const hits = [...docs].filter(([, t]) => t.includes(b.text)).map(([f]) => f);
  if (hits.length !== 1) { fail(`block "## ${b.heading}" is in ${hits.length} docs files (${hits.join(', ')})`); continue; }
  perFile.set(hits[0]!, [...(perFile.get(hits[0]!) ?? []), b.text]);
  console.log(`## ${b.heading}  ->  docs/${hits[0]}  ${Buffer.byteLength(b.text)} bytes identical`);
}
for (const [f, t] of docs) {
  if ((perFile.get(f) ?? []).join('') !== t) fail(`docs/${f} is not exactly the concatenation of the blocks moved into it`);
}

// 2. every former ##/### heading except Quick start is a whole line in exactly one docs file.
const wanted = headings.filter((h) => h !== '## Quick start');
for (const h of wanted) {
  const n = [...docs].filter(([, t]) => t.split('\n').includes(h)).length;
  if (n !== 1) fail(`heading "${h}" is in ${n} docs files`);
}
console.log(`headings checked: ${wanted.length}, each in exactly one docs file`);

// 3. the README keeps the H1 intro and Quick start byte for byte (everything before "## The lifecycle").
const keep = blocks.length ? parentReadme.slice(0, parentReadme.indexOf(`## ${moved[0]!.heading}\n`)) : '';
const readme = fs.readFileSync(path.join(tree, 'README.md'), 'utf8');
if (!readme.startsWith(keep)) fail('README.md does not start with the parent README up to the first moved section');
else console.log(`README.md prefix (H1 intro + Quick start): ${Buffer.byteLength(keep)} bytes identical`);

if (problems.length) {
  for (const p of problems) console.error(`MISMATCH: ${p}`);
  process.exit(1);
}
console.log(`OK: ${moved.length} blocks, ${docs.size} docs files${undo ? ' (commit-2 link edits undone)' : ''}`);

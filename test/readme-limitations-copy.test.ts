import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLimitations } from '../src/improve.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The bullet list of a "## Known limitations" section: from its first `- ` line to the next `## ` heading. */
function limitationsList(file: string): string {
  const section = fs.readFileSync(path.join(root, file), 'utf8').split(/^## Known limitations\n/m)[1] ?? '';
  const list = section.split(/^## /m)[0]!;
  return list.slice(list.search(/^- /m)).trimEnd();
}

test('the README keeps the docs/limitations.md list, which foreman improve reads as evidence', () => {
  const docs = limitationsList('docs/limitations.md');
  assert.ok(docs.startsWith('- '), 'docs/limitations.md has a bullet list');
  assert.equal(limitationsList('README.md'), docs);
  const firstLines = docs.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  assert.deepEqual(readLimitations(), firstLines.slice(0, 20));
});

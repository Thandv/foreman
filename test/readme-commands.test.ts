import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `foreman <command>` that starts a line of the help text, plus `help` itself. */
function helpCommands(help: string): string[] {
  const found = new Set<string>(['help']);
  for (const m of help.matchAll(/^ {2}foreman ([a-z][a-z-]*)/gm)) found.add(m[1]!);
  return [...found];
}

/**
 * The commands the README's fenced block under "## Commands" lists: the first word of each `·`-separated item on a
 * joined line, or the first word of a row. Words inside a description do not count, or a deleted row would hide
 * behind another row that mentions its name.
 */
function readmeCommandWords(readme: string): Set<string> {
  const section = readme.split(/^## Commands$/m)[1] ?? '';
  const block = /```\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  const words = new Set<string>();
  for (const line of block.split('\n')) {
    const items = line.includes(' · ') ? line.split(' · ') : [line];
    for (const item of items) {
      const w = /^\s*([a-z][a-z-]*)/.exec(item)?.[1];
      if (w) words.add(w);
    }
  }
  return words;
}

const missing = (help: string, readme: string): string[] => {
  const words = readmeCommandWords(readme);
  return helpCommands(help).filter((c) => !words.has(c));
};

test('every command in `foreman help` is in the README Commands list', () => {
  const help = execFileSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'help'], { encoding: 'utf8' });
  assert.ok(helpCommands(help).length > 30, 'help output parsed');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.deepEqual(missing(help, readme), []);
});

test('the README help-list check names a command that is missing', () => {
  const help = '  foreman serve\n  foreman zebra <id>\n';
  const readme = '## Commands\n\n```\nserve · help\n```\n';
  assert.deepEqual(missing(help, readme), ['zebra']);
});

test('a command named only in another row\'s description is still reported missing', () => {
  const help = '  foreman serve\n  foreman backup\n  foreman restore <f>\n';
  const readme = '## Commands\n\n```\nserve · help\nrestore     replace the database with a backup\n```\n';
  assert.deepEqual(missing(help, readme), ['backup']);
});

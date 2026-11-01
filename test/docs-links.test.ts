import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Root *.md and every .md under docs/, as paths relative to `dir`. */
function docFiles(dir: string): string[] {
  const out = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && fs.statSync(path.join(dir, f)).isFile());
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk('docs');
  return out.sort();
}

/** The lines outside fenced code blocks, with their line numbers. */
function proseLines(text: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) out.push({ n: i + 1, line });
  });
  return out;
}

/** GitHub's heading slug: inline markup gone, lower-cased, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const { line } of proseLines(text)) {
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Every relative link or #anchor in the root and docs/ markdown of `dir` that points at nothing. */
function brokenLinks(dir: string): string[] {
  const files = docFiles(dir);
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (rel: string): Set<string> => {
    if (!anchorCache.has(rel)) anchorCache.set(rel, anchors(fs.readFileSync(path.join(dir, rel), 'utf8')));
    return anchorCache.get(rel)!;
  };
  const problems: string[] = [];
  for (const file of files) {
    for (const { n, line } of proseLines(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      const plain = line.replace(/`[^`]*`/g, '');
      const targets = [...plain.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!);
      const ref = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/.exec(plain);
      if (ref) targets.push(ref[1]!);
      for (const target of targets) {
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
        const [pathPart = '', frag] = target.split('#', 2) as [string, string | undefined];
        const dest = pathPart === '' ? file : path.normalize(path.join(path.dirname(file), decodeURI(pathPart)));
        const where = `${file}:${n}: ${target}`;
        if (dest.startsWith('..') || !fs.existsSync(path.join(dir, dest))) {
          problems.push(`${where} — no such file`);
          continue;
        }
        if (frag && dest.endsWith('.md') && !anchorsOf(dest).has(decodeURI(frag).toLowerCase())) {
          problems.push(`${where} — no heading with that anchor in ${dest}`);
        }
      }
    }
  }
  return problems;
}

test('every relative link and #anchor in the root and docs/ markdown points at something', () => {
  assert.ok(docFiles(root).length > 10, 'the markdown files were found');
  assert.deepEqual(brokenLinks(root), []);
});

test('a broken relative link and a broken #anchor in a planted tree are reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doclinks-'));
  try {
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Top\n\n[ok](docs/a.md#the-sandbox-foreman_sandbox) [gone](docs/missing.md) [bad](docs/a.md#nope)\n');
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), '## The sandbox (`FOREMAN_SANDBOX`)\n\n[up](../README.md#top) [self](#nowhere)\n\n```\n[in a fence](missing.md)\n```\n');
    assert.deepEqual(brokenLinks(dir), [
      'README.md:3: docs/missing.md — no such file',
      'README.md:3: docs/a.md#nope — no heading with that anchor in docs/a.md',
      'docs/a.md:3: #nowhere — no heading with that anchor in docs/a.md',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heading slugs follow GitHub: punctuation dropped, repeats numbered', () => {
  const set = anchors('## Who does the work, and where closed work goes\n\n## The sandbox (`FOREMAN_SANDBOX`)\n\n## Same\n\n## Same\n');
  assert.deepEqual([...set], ['who-does-the-work-and-where-closed-work-goes', 'the-sandbox-foreman_sandbox', 'same', 'same-1']);
});

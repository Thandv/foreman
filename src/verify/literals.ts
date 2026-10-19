import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PINNED, pinnedEnv } from '../isolate.ts';

/**
 * A review that fails work can demand a test that scans source for an exact
 * string. When that string appears nowhere in the code, the demand cannot be
 * met as written. On the Kiln polish epic a reviewer demanded
 * `includes("closest('[data-card]')")` of a handler that reads
 * ``closest(`button[${attr}]`)``; the worker failed two rounds chasing text that
 * could never exist, until the operator spelled out the real code.
 *
 * This is the deterministic half of the fix: pull every literal a FAIL critique
 * asks a scan to find, look for each in the work's own tree (tests excluded —
 * a test that already asserts the phantom string would otherwise "ground" it),
 * and say plainly which ones are not there.
 */

const MAX_LITERALS = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5_000;

/** `includes('x')`, `includes("x")`, `includes(`x`)` and the same for indexOf. */
const SCAN = /\b(?:includes|indexOf)\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+?)\1\s*\)/g;

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** The source literals a critique asks a test to scan for, deduplicated, in order of first mention. */
export function demandedLiterals(critique: string): string[] {
  const out: string[] = [];
  for (const m of critique.matchAll(SCAN)) {
    const lit = unescape(m[2]!);
    if (lit.trim().length < 3 || out.includes(lit)) continue;
    out.push(lit);
    if (out.length === MAX_LITERALS) break;
  }
  return out;
}

export const isTestPath = (rel: string): boolean =>
  /(^|\/)(test|tests|__tests__|spec)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

/** Text of every non-test file in the tree, tracked or new (the worker's files are uncommitted in a jail). */
function sourceTexts(dir: string): string[] {
  let listing: string;
  try {
    // Pinned (isolate.ts): `dir` is a jail, whose config the worker can write; `ls-files` ran its core.fsmonitor.
    listing = execFileSync('git', [...PINNED, 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, env: pinnedEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const rel of listing.split('\0').filter(Boolean).slice(0, MAX_FILES)) {
    if (isTestPath(rel)) continue;
    const file = path.join(dir, rel);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) continue;
      texts.push(buf.toString('utf8'));
    } catch {
      /* unreadable: skip */
    }
  }
  return texts;
}

/**
 * The demanded literals that appear in no non-test file of the tree. Empty
 * when nothing is demanded, or when the tree cannot be listed (no claim is
 * made about a tree that could not be read).
 */
export function ungroundedLiterals(critique: string, dir: string): string[] {
  const wanted = demandedLiterals(critique);
  if (!wanted.length) return [];
  const texts = sourceTexts(dir);
  if (!texts.length) return [];
  return wanted.filter((lit) => !texts.some((t) => t.includes(lit)));
}

/** The note added to a FAIL critique (and so to the repair notes and the chair's evidence). */
export function literalNote(missing: string[]): string {
  return (
    'FOREMAN CHECK (deterministic): this review asks a test to find the text below in the source, but it ' +
    'appears in no non-test file of the work\'s tree, so the demand cannot be met as written:\n' +
    missing.map((m) => `- ${m}`).join('\n') +
    '\nMeet the INTENT against the code\'s real form (quote what the code actually says), and say so in the ' +
    'final report. A reviewer may not fail the work again for not matching these exact strings.'
  );
}

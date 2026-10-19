import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../align/redact.ts';
import { PINNED, pinnedEnv } from '../isolate.ts';

/**
 * A zero-token snapshot of the target repo for the planner and the plan critic.
 *
 * Both reach Claude through `ownerCall`, which disables every tool on purpose
 * (see DISALLOWED_TOOLS there), so before this existed they planned against a
 * bare path. Observed on the first Kiln epic: the ask said "SPEC.md is binding,
 * read it first", the planner could not, and it ticketed a scaffold that was
 * already committed while the critic flagged vendored libraries as missing.
 *
 * Deterministic and cheap: the tracked file list, the root README, and any
 * tracked file the ask names. Every document is confined to the repo (no
 * symlinks, real path inside the root), text-only, capped, and redacted —
 * this text leaves the machine.
 */

const MAX_FILES_LISTED = 150;
const MAX_DOC_BYTES = 16_000;
const MAX_TOTAL_DOC_BYTES = 40_000;
const MAX_NAMED_DOCS = 3;

export function repoBrief(repo: string | null | undefined, ask: string): string {
  if (!repo) return '';
  let root: string;
  try {
    root = fs.realpathSync(repo);
    if (!fs.statSync(root).isDirectory()) return '';
  } catch {
    return '';
  }

  const files = trackedFiles(root);
  if (!files.length) return '';

  const docs: string[] = [];
  const readme = files.find((f) => /^readme(\.[a-z]+)?$/i.test(f));
  if (readme) docs.push(readme);
  for (const f of files) {
    if (docs.length >= MAX_NAMED_DOCS + (readme ? 1 : 0)) break;
    if (docs.includes(f)) continue;
    if (namedIn(ask, f)) docs.push(f);
  }

  let out =
    'REPO SNAPSHOT (taken before planning; plan against what is already here — do not ticket work that already exists):\n' +
    `FILES (${files.length} tracked):\n${listing(files)}\n`;
  let budget = MAX_TOTAL_DOC_BYTES;
  for (const rel of docs) {
    if (budget <= 0) break;
    const text = readConfined(root, rel, Math.min(MAX_DOC_BYTES, budget));
    if (text === null) continue;
    budget -= text.length;
    out += `\n--- ${rel} ---\n${text}\n`;
  }
  return redact(out, { scrubPaths: false }).text;
}

/**
 * The tracked files of a tree, listed compactly — for a reviewer that sees only
 * a diff and must not mistake "absent from the diff" for "absent".
 */
export function trackedListing(dir: string): string {
  const files = trackedFiles(dir);
  return files.length ? `FILES ALREADY TRACKED IN THIS TREE (${files.length}):\n${listing(files)}` : '';
}

function trackedFiles(root: string): string[] {
  try {
    // Pinned (isolate.ts): the reviewer's tree is a jail, whose config the worker can write; `ls-files` ran its core.fsmonitor.
    const raw = execFileSync('git', ['-C', root, ...PINNED, 'ls-files', '-z'], {
      env: pinnedEnv(),
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\0').filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** A path is named when the ask contains its repo path or its basename as a whole token. */
function namedIn(ask: string, rel: string): boolean {
  const base = path.posix.basename(rel);
  if (base.length < 4) return false;
  const token = (s: string): RegExp => new RegExp(`(^|[^\\w./-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/-])`);
  return token(rel).test(ask) || token(base).test(ask);
}

/** Every file when there are few; otherwise top-level entries with per-directory counts. */
function listing(files: string[]): string {
  if (files.length <= MAX_FILES_LISTED) return files.map((f) => `  ${f}`).join('\n');
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : f;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .slice(0, MAX_FILES_LISTED)
    .map(([k, n]) => (k.endsWith('/') ? `  ${k} (${n} files)` : `  ${k}`))
    .join('\n');
}

function readConfined(root: string, rel: string, cap: number): string | null {
  const abs = path.join(root, rel);
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
    const real = fs.realpathSync(abs);
    if (!real.startsWith(root + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(cap, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) return null; // binary
      const text = chunk.toString('utf8');
      return st.size > n ? `${text}\n[… truncated, ${st.size - n} more bytes]` : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

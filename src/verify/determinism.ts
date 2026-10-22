/**
 * The generative ↔ deterministic slider, and the deterministic checks it turns on.
 *
 * Each playbook role has a `mode` (front matter `roles.<name>.mode`):
 *   - `deterministic` — work with one right shape (code, tests, copyedits, risk numbers). Every check below runs
 *     before a reviewer is paid, and the local API runner samples at temperature 0.
 *   - `balanced` (the default) — judgement inside firm rules (design, review, analysis). Every check runs;
 *     temperature 0.3.
 *   - `generative` — open work (drafting prose, editorial letters, devil's advocacy). The heuristic test-weakening
 *     findings are not raised, so nothing mechanical second-guesses a creative choice; temperature 0.8.
 * Hard checks (secrets, focused tests) and a playbook's explicit `required` content run in every mode.
 *
 * Every check is pure: it reads the diff and, for required content, the files the diff touched in the work tree.
 * A finding is HARD (a leaked secret, a focused test) or SOFT (a new skip, a deleted test file, a missing required
 * section). preReviewGaps sends both back to the worker with no reviewer called; a hard finding still standing after
 * the repair rounds fails the ticket, a soft one goes to the reviewer as a note (it may be a false positive).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Playbook } from '../playbooks.ts';

export type RoleMode = 'deterministic' | 'balanced' | 'generative';
export const ROLE_MODES: ReadonlySet<string> = new Set(['deterministic', 'balanced', 'generative']);

/** The mode of a playbook role; `balanced` when the role or the playbook does not say. */
export function roleMode(pb: Playbook | null | undefined, role: string | null | undefined): RoleMode {
  const m = role ? pb?.roles[role]?.mode : undefined;
  return m && ROLE_MODES.has(m) ? m : 'balanced';
}

/** Sampling temperature for a runner that can set one (the local API runner; the Claude CLI cannot). */
export function temperatureFor(mode: RoleMode): number {
  return mode === 'deterministic' ? 0 : mode === 'generative' ? 0.8 : 0.3;
}

export interface DeterministicFindings {
  /** Must be fixed: still present after the repair rounds, the ticket fails. */
  hard: string[];
  /** Should be fixed or explained: still present after the repairs, the reviewer judges it. */
  soft: string[];
}

interface FileDiff {
  path: string;
  deleted: boolean;
  added: string[];
}

/** Split a unified git diff into files: the new path, whether the file was deleted, and its added lines. */
export function parseDiffFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!, deleted: false, added: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
  }
  return files;
}

/**
 * Credentials that must never be committed. Each pattern is specific enough to be rare in ordinary code; a line that
 * carries a deliberate fake (a test of this very check) opts out with the marker `foreman:allow-secret`.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'a GitHub fine-grained token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'an Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/, 'an OpenAI-style API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];
const ALLOW_SECRET = 'foreman:allow-secret';

/** An added `.env` file (not an example of one) is a secret file whatever it holds. */
const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist)$/;

export function secretFindings(files: FileDiff[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.deleted) continue;
    if (ENV_FILE.test(f.path) && !ENV_EXAMPLE.test(f.path) && f.added.length) {
      out.push(`${f.path}: an environment file is committed — remove it and keep it out of git`);
    }
    for (const line of f.added) {
      if (line.includes(ALLOW_SECRET)) continue;
      const hit = SECRET_PATTERNS.find(([re]) => re.test(line));
      if (hit) {
        out.push(`${f.path}: added line holds ${hit[1]} — remove it and rotate it if it was real`);
        break;
      }
    }
  }
  return out;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
/** A focused test runs alone and silently drops every other test in the file. */
const FOCUSED = /\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe)\s*\(|\{\s*only\s*:\s*true\b/;
const SKIPPED = /\b(?:it|test|describe|context)\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|\{\s*(?:skip|todo)\s*:\s*(?:true|['"`])|@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip\b|\bt\.Skip\(/;

export function testWeakening(files: FileDiff[]): DeterministicFindings {
  const hard: string[] = [];
  const soft: string[] = [];
  for (const f of files) {
    if (!TEST_FILE.test(f.path)) continue;
    if (f.deleted) {
      soft.push(`${f.path}: a test file is deleted — restore it, or say in the report why the tests it held are gone`);
      continue;
    }
    if (f.added.some((l) => FOCUSED.test(l))) hard.push(`${f.path}: a focused test (.only) is added — it silences every other test in the file; remove .only`);
    if (f.added.some((l) => SKIPPED.test(l))) soft.push(`${f.path}: a skipped or todo test is added — make it run, or say in the report why it cannot`);
  }
  return { hard, soft };
}

/**
 * A playbook's `required` content: text every document a role writes must contain (a disclaimer, a limitations
 * section). Checked on the markdown files the diff adds or changes, read from the work tree; a file the diff deletes,
 * or one outside the tree, is not read.
 */
export function requiredContentFindings(pb: Playbook, role: string | null | undefined, files: FileDiff[], treeDir: string | null): string[] {
  const rules = (pb.required ?? []).filter((r) => !r.roles?.length || (role ? r.roles.includes(role) : false));
  if (!rules.length || !treeDir) return [];
  const root = path.resolve(treeDir);
  const out: string[] = [];
  for (const f of files) {
    if (f.deleted || !/\.(md|markdown)$/i.test(f.path)) continue;
    const abs = path.resolve(root, f.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    let text: string;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > 2_000_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const r of rules) {
      if (!new RegExp(r.pattern, 'im').test(text)) out.push(`${f.path}: ${r.label} is missing`);
    }
  }
  return out;
}

/** Every deterministic check the role's mode turns on, for one ticket's diff. */
export function deterministicFindings(
  pb: Playbook,
  role: string | null | undefined,
  diff: string,
  treeDir: string | null,
): DeterministicFindings {
  const mode = roleMode(pb, role);
  const files = parseDiffFiles(diff);
  const tests = testWeakening(files);
  const hard = [...secretFindings(files), ...tests.hard];
  // Required content is an explicit rule the playbook names roles for, so it holds in every mode; the mode only
  // decides whether the heuristic test-weakening findings are raised for a role that writes prose.
  const soft: string[] = [...requiredContentFindings(pb, role, files, treeDir)];
  if (mode !== 'generative') soft.push(...tests.soft);
  return { hard, soft };
}

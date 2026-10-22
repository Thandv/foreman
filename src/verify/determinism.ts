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
 * the repair rounds fails the ticket, a soft one gets one round and then goes to the reviewer as a note (it may be a
 * false positive, and an explanation in the report is something only the reviewer can read).
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
  /** New at this path: a new file, or the target of a rename or copy. */
  created: boolean;
  added: string[];
}

const GIT_ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };

/**
 * A path as git prints it in a header: bare (a name with a space gets a trailing tab on the ---/+++ lines), or
 * C-quoted with octal escapes for each non-ASCII byte (scheduler.ts diffs with core.quotePath=true).
 */
function headerPath(raw: string): string {
  const s = raw.replace(/\t$/, '');
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else {
      const n = body[++i] ?? '';
      bytes.push(...Buffer.from(GIT_ESCAPES[n] ?? n, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Split a unified git diff into files: the new path, whether the file was deleted or created, and its added lines.
 * Every `diff --git` line opens a file, quoted or not. The path is taken from the `+++`/`---` or `rename to` header
 * (one path to the end of the line), not from `diff --git a/X b/Y`, which is ambiguous when a name holds " b/". Lines
 * before the first `@@` are headers; after it, every `+` line is content, including one whose text starts `++`.
 */
export function parseDiffFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      // Best effort until a header below names the path: the text after the last " b/" (or ' "b/').
      const q = rest.lastIndexOf(' "b/');
      const b = q >= 0 ? q + 1 : rest.lastIndexOf(' b/') + 1;
      const guess = b > 0 ? headerPath(rest.slice(b)).replace(/^b\//, '') : rest;
      cur = { path: guess, deleted: false, created: false, added: [] };
      files.push(cur);
      inHeader = true;
      continue;
    }
    if (!cur) continue;
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      else if (line.startsWith('new file mode')) cur.created = true;
      else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        cur.path = headerPath(line.slice(line.indexOf(' to ') + 4));
        cur.created = true;
      } else if (line.startsWith('+++ ')) {
        const p = headerPath(line.slice(4));
        if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      } else if (line.startsWith('--- ') && cur.deleted) {
        const p = headerPath(line.slice(4));
        if (p !== '/dev/null') cur.path = p.replace(/^a\//, '');
      }
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
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
  // Current OpenAI project, service-account and admin keys carry '-' and '_' anywhere in the body.
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/, 'an OpenAI API key'],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}\b/, 'a Stripe live key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'an npm token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];
const ALLOW_SECRET = 'foreman:allow-secret';

/**
 * A new `.env` file (not an example of one) is a secret file whatever it holds. One the repository already tracks
 * (frameworks such as Next.js commit `.env.development` defaults) is the project's convention: an edit to it is a
 * soft note, and its lines still go through the credential patterns above.
 */
const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist)$/;

export function secretFindings(files: FileDiff[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.deleted) continue;
    if (ENV_FILE.test(f.path) && !ENV_EXAMPLE.test(f.path) && f.created) {
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

/** Edits to an environment file the repository already tracks: a note, not a hold (see ENV_FILE). */
export function envFileEdits(files: FileDiff[]): string[] {
  return files
    .filter((f) => !f.deleted && !f.created && f.added.length && ENV_FILE.test(f.path) && !ENV_EXAMPLE.test(f.path))
    .map((f) => `${f.path}: a tracked environment file is changed — check it holds no credential`);
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
/**
 * A focused test runs alone and silently drops every other test in the file. A test of a tool that finds focused
 * tests (a linter rule, this module) holds them as data: such a line opts out with the marker `foreman:allow-only`.
 */
const ALLOW_FOCUS = 'foreman:allow-only';
// Jasmine's fit/fdescribe are bare calls: `model.fit(` (scikit-learn, in nearly every ML test) and `def fit(` are not.
const FOCUSED = /\b(?:it|test|describe|context)\.only\s*\(|(?<![.\w$])(?<!\b(?:def|function)\s+)(?:fit|fdescribe)\s*\(|\{\s*only\s*:\s*true\b/;
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
    if (f.added.some((l) => FOCUSED.test(l) && !l.includes(ALLOW_FOCUS))) {
      hard.push(`${f.path}: a focused test (.only) is added — it silences every other test in the file; remove .only (a line that only quotes one, as test data, carries the marker ${ALLOW_FOCUS})`);
    }
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
  // The tree's real path: a symlinked directory inside it (made by the worker, or by a test command that ran after
  // the diff was taken) must not lead the read outside. lstat below refuses a symlinked file itself.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of files) {
    if (f.deleted || !/\.(md|markdown)$/i.test(f.path)) continue;
    const abs = path.resolve(root, f.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    let text: string;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > 2_000_000) continue;
      const real = fs.realpathSync(abs);
      if (!real.startsWith(realRoot + path.sep)) continue;
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
  const envEdits = envFileEdits(files);
  // Required content is an explicit rule the playbook names roles for, so it holds in every mode; the mode only
  // decides whether the heuristic test-weakening findings are raised for a role that writes prose.
  const soft: string[] = [...envEdits, ...requiredContentFindings(pb, role, files, treeDir)];
  if (mode !== 'generative') soft.push(...tests.soft);
  return { hard, soft };
}

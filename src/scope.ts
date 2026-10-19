/**
 * Scope guard rules: which paths a ticket said it would not touch, or the only
 * paths it may write. Pure — no I/O — so a reviewer can apply it to any diff.
 *
 * Rules come from two places: phrases in the ticket's prompt, and the plan's
 * explicit `forbiddenPaths`. The acceptance text is never parsed: it quotes
 * these phrases as test data.
 */
import type { Task } from './types.ts';

export interface ScopeRules {
  /** Patterns the diff must not touch. */
  forbidden: string[];
  /** When non-empty, the diff may touch only paths matching one of these. */
  only: string[];
}

export interface ScopeViolation {
  file: string;
  /** The rule the file broke, in the words of the brief. */
  rule: string;
}

/** Quoted spans are examples, not instructions. A `'` inside a word is an apostrophe. */
const QUOTED = /`[^`]*`|"[^"\n]*"|“[^”\n]*”|(?<![\w'’])'(?:[^'\n.!?]|[.!?](?!\s)|'(?=\w))*'(?![\w'’])|(?<![\w'’])‘(?:[^’\n.!?]|[.!?](?!\s)|’(?=\w))*’(?![\w'’])/g;
const FORBID_PHRASE = /\bdo not (?:touch|edit)\s+/gi;
const ONLY_PHRASE = /\bwrite only\s+/gi;
/** One path token: no whitespace, comma, dash, bracket or semicolon. */
const PATH_TOKEN = /^[^\s,;()–—]+/;
/** Between two paths: a comma, "or", "and", or ", or". */
const JOINER = /^(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)/i;
/** Sentence punctuation clinging to the end of a token. */
const TRAILING = /[.!?:]+$/;

/** A camelCase last segment with no extension ('search/searchScored') names a function, not a path. */
const CODE_IDENTIFIER = /^[a-z]+[A-Z]\w*$/;

const ABBREVIATION = /^(?:e\.g|i\.e|a\.m|p\.m|vs|etc)\.?$/i;

/**
 * A pattern is a path: it has a '/' (directories end with one, but 'src/align' counts)
 * or a file extension that starts with a letter. Versions ('v1.2'), abbreviations
 * ('e.g') and function references ('search/searchScored') are not.
 */
function looksLikePath(p: string): boolean {
  if (p.includes('/')) return !CODE_IDENTIFIER.test(p.slice(p.lastIndexOf('/') + 1));
  return /\w\.[A-Za-z]\w*$/.test(p) && !ABBREVIATION.test(p);
}

/**
 * Reads paths from `from` and stops at the first token that is not a path or a
 * list joiner: a word, an em dash, a parenthesis or the end of the sentence.
 */
function pathList(text: string, from: number): string[] {
  let rest = text.slice(from);
  const out: string[] = [];
  for (;;) {
    const m = PATH_TOKEN.exec(rest);
    if (!m) break;
    const bare = m[0].replace(/^\.\//, '');
    const token = bare.replace(TRAILING, '');
    if (!looksLikePath(token)) break;
    out.push(token);
    if (token !== bare) break; // sentence punctuation ended the list
    rest = rest.slice(m[0].length);
    const j = JOINER.exec(rest);
    if (!j) break;
    rest = rest.slice(j[0].length);
  }
  return out;
}

export function parseScopeRules(text: string): ScopeRules {
  const plain = text.replace(QUOTED, ' ');
  const rules: ScopeRules = { forbidden: [], only: [] };
  for (const m of plain.matchAll(FORBID_PHRASE)) {
    rules.forbidden.push(...pathList(plain, m.index + m[0].length));
  }
  for (const m of plain.matchAll(ONLY_PHRASE)) {
    rules.only.push(...pathList(plain, m.index + m[0].length));
  }
  rules.forbidden = [...new Set(rules.forbidden)];
  rules.only = [...new Set(rules.only)];
  return rules;
}

/** The rules in force for a task: its prompt and plan-declared paths, never its acceptance. */
export function effectiveScopeRules(task: Pick<Task, 'prompt' | 'forbiddenPaths'>): ScopeRules {
  const rules = parseScopeRules(task.prompt);
  rules.forbidden = [...new Set([...rules.forbidden, ...(task.forbiddenPaths ?? [])])];
  return rules;
}

/**
 * '/'-terminated patterns match by prefix; patterns containing '/' match the
 * whole path; a bare name matches any path with that basename.
 */
export function matchesPattern(pattern: string, file: string): boolean {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (pattern.includes('/')) return file === pattern;
  return file.slice(file.lastIndexOf('/') + 1) === pattern;
}

export function checkScope(rules: ScopeRules, diffPaths: string[]): ScopeViolation[] {
  const out: ScopeViolation[] = [];
  for (const file of diffPaths) {
    const hit = rules.forbidden.find((p) => matchesPattern(p, file));
    if (hit) {
      out.push({ file, rule: `Do NOT touch ${hit}` });
    } else if (rules.only.length && !rules.only.some((p) => matchesPattern(p, file))) {
      out.push({ file, rule: `write ONLY ${rules.only.join(', ')}` });
    }
  }
  return out;
}
